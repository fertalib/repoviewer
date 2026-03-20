import fs from 'fs';
import { execSync } from 'child_process';

// Get GitHub token from environment or gh CLI
function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No GITHUB_TOKEN env var and gh CLI not authenticated');
  }
}

const TOKEN = getToken();
const API = 'https://api.github.com';
const owner = process.argv[2] || 'fertalib';
const repo = process.argv[3] || 'fullfeel';

async function gh(path) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${path}\n${text}`);
  }
  return res.json();
}

async function fetchAllPages(path) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

async function main() {
  console.log(`Fetching data for ${owner}/${repo}...`);

  // Repo info
  const repoInfo = await gh(`/repos/${owner}/${repo}`);
  const branch = repoInfo.default_branch;
  console.log(`Default branch: ${branch}`);

  // File tree at HEAD
  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
  const files = tree.tree.filter(t => t.type === 'blob');
  console.log(`${files.length} files in tree`);

  // All commits (oldest first)
  const commits = await fetchAllPages(`/repos/${owner}/${repo}/commits?sha=${branch}`);
  commits.reverse();
  console.log(`${commits.length} commits`);

  // Commit details with patches
  const commitDetails = [];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    process.stdout.write(`\rFetching commit details ${i + 1}/${commits.length}...`);
    const detail = await gh(`/repos/${owner}/${repo}/commits/${c.sha}`);
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
  console.log('\nCommit details fetched.');

  // Merged PRs
  const prs = (await fetchAllPages(`/repos/${owner}/${repo}/pulls?state=closed`))
    .filter(pr => pr.merged_at)
    .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));
  console.log(`${prs.length} merged PRs`);

  // Build output
  const output = {
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

  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  const outPath = `./data/${repo}.json`;
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Saved to ${outPath}`);
  console.log(`  ${files.length} files, ${commitDetails.length} commits, ${prs.length} PRs`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
