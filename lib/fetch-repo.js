const API = 'https://api.github.com';

async function gh(path, token) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining === '0' && reset) {
        const resetMin = Math.ceil((Number(reset) * 1000 - Date.now()) / 60000);
        throw new Error(`GitHub API rate limit exceeded. Resets in ~${resetMin} min.`);
      }
    }
    if (res.status === 404) throw new Error(`Not found: ${path}`);
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${path}${text ? ' — ' + text.slice(0, 200) : ''}`);
  }
  return res.json();
}

async function fetchAllPages(path, token) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await gh(`${path}${sep}per_page=100&page=${page}`, token);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

/**
 * Fetch all repository data from GitHub API.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} token - GitHub access token
 * @param {(p: {stage: string, current?: number, total?: number, message?: string}) => void} [onProgress] - Optional progress callback
 * @returns {Promise<object>} Repository data in repoviewer format
 */
export async function fetchRepoData(owner, repo, token, onProgress) {
  const log = onProgress || (() => {});

  log({ stage: 'repo-info', message: `Fetching repo info for ${owner}/${repo}...` });
  const repoInfo = await gh(`/repos/${owner}/${repo}`, token);
  const branch = repoInfo.default_branch;

  log({ stage: 'tree', message: `Fetching file tree (branch: ${branch})...` });
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token);
  const files = tree.tree.filter(t => t.type === 'blob');

  log({ stage: 'commits-list', message: `Fetching commits...` });
  const commits = await fetchAllPages(`/repos/${owner}/${repo}/commits?sha=${branch}`, token);
  commits.reverse();

  log({ stage: 'commits-detail', current: 0, total: commits.length, message: `Fetching commit details (0/${commits.length})...` });
  const commitDetails = new Array(commits.length);
  let completed = 0;
  const CONCURRENCY = 8;
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= commits.length) return;
      const c = commits[i];
      const detail = await gh(`/repos/${owner}/${repo}/commits/${c.sha}`, token);
      commitDetails[i] = {
        sha: c.sha,
        message: c.commit.message.split('\n')[0],
        date: c.commit.author.date,
        author: c.commit.author.name,
        files: (detail.files || []).map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch || null,
          previous_filename: f.previous_filename || null,
        })),
      };
      completed++;
      log({ stage: 'commits-detail', current: completed, total: commits.length, message: `Fetching commit details (${completed}/${commits.length})...` });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, commits.length) }, () => worker()));

  log({ stage: 'prs', message: `Fetching merged PRs...` });
  const prs = (await fetchAllPages(`/repos/${owner}/${repo}/pulls?state=closed`, token))
    .filter(pr => pr.merged_at)
    .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));

  log({ stage: 'done', message: 'Done.' });
  return {
    repo: { owner, name: repo, defaultBranch: branch },
    files: files.map(f => ({ path: f.path, size: f.size })),
    commits: commitDetails,
    pullRequests: prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      mergedAt: pr.merged_at,
      mergeCommitSha: pr.merge_commit_sha,
    })),
    fetchedAt: new Date().toISOString(),
  };
}
