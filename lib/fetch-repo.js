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
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${path}\n${text}`);
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
 * @param {(msg: string) => void} [onProgress] - Optional progress callback
 * @returns {Promise<object>} Repository data in repoviewer format
 */
export async function fetchRepoData(owner, repo, token, onProgress) {
  const log = onProgress || (() => {});

  log(`Fetching repo info for ${owner}/${repo}...`);
  const repoInfo = await gh(`/repos/${owner}/${repo}`, token);
  const branch = repoInfo.default_branch;

  log(`Fetching file tree (branch: ${branch})...`);
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token);
  const files = tree.tree.filter(t => t.type === 'blob');

  log(`Fetching commits...`);
  const commits = await fetchAllPages(`/repos/${owner}/${repo}/commits?sha=${branch}`, token);
  commits.reverse();

  log(`Fetching commit details (0/${commits.length})...`);
  const commitDetails = [];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    log(`Fetching commit details (${i + 1}/${commits.length})...`);
    const detail = await gh(`/repos/${owner}/${repo}/commits/${c.sha}`, token);
    commitDetails.push({
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
    });
  }

  log(`Fetching merged PRs...`);
  const prs = (await fetchAllPages(`/repos/${owner}/${repo}/pulls?state=closed`, token))
    .filter(pr => pr.merged_at)
    .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));

  log('Done.');
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
