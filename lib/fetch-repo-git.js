import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';

const API = 'https://api.github.com';

// ===== REST helpers (only for metadata not available via git) =====
async function gh(urlPath, token) {
  const url = urlPath.startsWith('http') ? urlPath : `${API}${urlPath}`;
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
    if (res.status === 404) throw new Error(`Not found: ${urlPath}`);
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${urlPath}${text ? ' — ' + text.slice(0, 200) : ''}`);
  }
  return res.json();
}

async function fetchAllPages(urlPath, token) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = urlPath.includes('?') ? '&' : '?';
    const data = await gh(`${urlPath}${sep}per_page=100&page=${page}`, token);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ===== Git process helpers =====
// Memory-constrained pack config. Containers often have 256–512MB RAM and
// `git index-pack` gets OOM-killed on large repos without these limits.
const LOW_MEM_PACK_CFG = [
  '-c', 'pack.threads=1',
  '-c', 'pack.windowMemory=32m',
  '-c', 'pack.deltaCacheSize=32m',
  '-c', 'core.packedGitWindowSize=16m',
  '-c', 'core.packedGitLimit=128m',
];

function runGit(args, { cwd, token } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const authArgs = token
      ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
      : [];
    const baseArgs = [...authArgs, ...LOW_MEM_PACK_CFG, ...args];
    const proc = spawn('git', baseArgs, { cwd, env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function spawnGitStream(args, { cwd, token } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const authArgs = token
    ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
    : [];
  const baseArgs = [...authArgs, ...LOW_MEM_PACK_CFG, ...args];
  return spawn('git', baseArgs, { cwd, env });
}

async function mkTmpDir() {
  const suffix = crypto.randomBytes(6).toString('hex');
  const dir = path.join(os.tmpdir(), `repoviewer-${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function rmDir(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
}

// ===== git log parser =====
// Uses a unique delimiter line to separate commits, then parses unified diff bodies.
const DELIM_PREFIX = '___REPOVIEWER_COMMIT___';

/**
 * Stream-parse `git log -p -M` output. Calls onCommit for each completed commit.
 * Returns array of all parsed commits.
 */
function parseGitLog(proc, onCommit) {
  return new Promise((resolve, reject) => {
    const commits = [];
    let current = null;       // current commit being built
    let headerLines = null;   // header lines array when collecting after delimiter
    let currentFile = null;   // current file diff being parsed
    let inPatch = false;      // whether we're inside a hunk (collect patch text)

    const rl = readline.createInterface({ input: proc.stdout });

    function flushFile() {
      if (currentFile) {
        current.files.push(currentFile);
        currentFile = null;
      }
    }
    function flushCommit() {
      flushFile();
      if (current) {
        commits.push(current);
        if (onCommit) onCommit(current, commits.length);
        current = null;
      }
    }

    rl.on('line', (line) => {
      // Delimiter = start of new commit
      if (line.startsWith(DELIM_PREFIX)) {
        flushCommit();
        headerLines = [];
        return;
      }
      // Header mode: collect 4 fields
      if (headerLines && headerLines.length < 4) {
        headerLines.push(line);
        if (headerLines.length === 4) {
          const [sha, ts, author, subject] = headerLines;
          current = {
            sha,
            message: subject,
            date: new Date(Number(ts) * 1000).toISOString(),
            author,
            files: [],
          };
          headerLines = null;
        }
        return;
      }
      if (!current) return; // waiting for first delimiter

      // Diff parsing
      if (line.startsWith('diff --git ')) {
        flushFile();
        const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
        const oldPath = m ? m[1] : null;
        const newPath = m ? m[2] : null;
        currentFile = {
          filename: newPath || oldPath,
          previous_filename: null,
          status: 'modified',
          additions: 0,
          deletions: 0,
          patch: '',
          _oldPath: oldPath,
        };
        inPatch = false;
        return;
      }
      if (!currentFile) return;

      if (line.startsWith('new file mode')) {
        currentFile.status = 'added';
        return;
      }
      if (line.startsWith('deleted file mode')) {
        currentFile.status = 'removed';
        currentFile.filename = currentFile._oldPath || currentFile.filename;
        return;
      }
      if (line.startsWith('rename from ')) {
        currentFile.previous_filename = line.slice('rename from '.length);
        currentFile.status = 'renamed';
        return;
      }
      if (line.startsWith('rename to ')) {
        currentFile.filename = line.slice('rename to '.length);
        currentFile.status = 'renamed';
        return;
      }
      if (line.startsWith('Binary files ')) {
        // no patch for binary
        return;
      }
      if (line.startsWith('index ') || line.startsWith('similarity index') ||
          line.startsWith('dissimilarity index') || line.startsWith('old mode') ||
          line.startsWith('new mode') || line.startsWith('copy from ') ||
          line.startsWith('copy to ')) {
        return;
      }
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        return;
      }
      if (line.startsWith('@@')) {
        inPatch = true;
        currentFile.patch += (currentFile.patch ? '\n' : '') + line;
        return;
      }
      if (inPatch) {
        currentFile.patch += '\n' + line;
        if (line.startsWith('+')) currentFile.additions++;
        else if (line.startsWith('-')) currentFile.deletions++;
      }
    });

    rl.on('close', () => {
      flushCommit();
      // Clean up internal fields
      for (const c of commits) for (const f of c.files) delete f._oldPath;
      resolve(commits);
    });
    rl.on('error', reject);

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`git log failed (${code}): ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * Fetch repo data via ephemeral git clone.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} token - GitHub access token (used for HTTPS clone + REST PR fetch)
 * @param {(p: {stage: string, current?: number, total?: number, message?: string}) => void} [onProgress]
 * @param {object} [options]
 * @param {object} [options.existing] - Previously cached repoData for incremental merge
 * @returns {Promise<object>}
 */
export async function fetchRepoDataViaGit(owner, repo, token, onProgress, { existing } = {}) {
  const log = onProgress || (() => {});
  const tmpDir = await mkTmpDir();
  const cloneDir = path.join(tmpDir, 'repo.git');

  try {
    // Determine incremental cutoff
    const lastCachedDate = existing?.commits?.length
      ? existing.commits[existing.commits.length - 1].date
      : null;
    const lastCachedSha = existing?.commits?.length
      ? existing.commits[existing.commits.length - 1].sha
      : null;

    log({ stage: 'clone', message: lastCachedDate ? 'Cloning new commits...' : 'Cloning repository...' });

    // NOTE: don't use --filter=blob:none — git log -p needs blob contents
    // and would lazy-fetch every blob (extremely slow).
    const cloneArgs = ['clone', '--bare', '--no-tags'];
    if (lastCachedDate) {
      // Shallow-since: only commits newer than our last cached commit
      cloneArgs.push(`--shallow-since=${lastCachedDate}`);
    }
    cloneArgs.push(`https://github.com/${owner}/${repo}.git`, cloneDir);

    try {
      await runGit(cloneArgs, { token });
    } catch (err) {
      // shallow-since may fail if nothing new or if server rejects; fall back to full
      if (lastCachedDate && /shallow|no commits|Remote branch|empty/i.test(err.message)) {
        log({ stage: 'clone', message: 'Incremental clone empty — using cache as-is.' });
        // No new commits; just refresh PRs and return cached data
        const prs = await fetchPRs(owner, repo, token, log);
        return {
          ...existing,
          pullRequests: prs,
          fetchedAt: new Date().toISOString(),
        };
      }
      throw err;
    }

    // Determine default branch
    log({ stage: 'tree', message: 'Reading file tree...' });
    const headRefRaw = await runGit(['symbolic-ref', 'HEAD'], { cwd: cloneDir }).catch(() => '');
    let branch = headRefRaw.trim().replace(/^refs\/heads\//, '');
    if (!branch) {
      // Fallback: find via show-ref
      const refs = await runGit(['show-ref', '--heads'], { cwd: cloneDir }).catch(() => '');
      const firstRef = refs.split('\n')[0];
      branch = firstRef ? firstRef.split(' ')[1]?.replace(/^refs\/heads\//, '') : 'main';
    }

    // File tree (ls-tree at HEAD). Format: mode SP type SP sha TAB path
    const treeRaw = await runGit(['ls-tree', '-r', '--long', 'HEAD'], { cwd: cloneDir });
    const files = treeRaw.split('\n').filter(Boolean).map((line) => {
      // "100644 blob <sha> <size>\t<path>"
      const tabIdx = line.indexOf('\t');
      const meta = line.slice(0, tabIdx).split(/\s+/);
      const size = Number(meta[3]) || 0;
      const p = line.slice(tabIdx + 1);
      return { path: p, size };
    });

    // Estimate total commits for progress (approximate — rev-list --count)
    let totalCommits = 0;
    try {
      const countRaw = await runGit(['rev-list', '--count', 'HEAD'], { cwd: cloneDir });
      totalCommits = Number(countRaw.trim()) || 0;
    } catch {}

    log({ stage: 'commits-detail', current: 0, total: totalCommits, message: `Parsing ${totalCommits} commits...` });

    // Stream git log with unified diff
    const fmt = `${DELIM_PREFIX}%n%H%n%ct%n%an%n%s`;
    const logArgs = ['log', '--reverse', '-M', '-p', `--format=format:${fmt}`, 'HEAD'];
    const proc = spawnGitStream(logArgs, { cwd: cloneDir });
    const newCommits = await parseGitLog(proc, (c, count) => {
      if (count % 5 === 0 || count === totalCommits) {
        log({
          stage: 'commits-detail',
          current: count,
          total: totalCommits || count,
          message: `Parsing commit ${count}${totalCommits ? '/' + totalCommits : ''}...`,
        });
      }
    });

    // Merge with existing (incremental)
    let mergedCommits = newCommits;
    if (existing?.commits?.length && lastCachedSha) {
      // Drop any newCommits that we already had (in case shallow-since overlaps)
      const existingShas = new Set(existing.commits.map((c) => c.sha));
      const trulyNew = newCommits.filter((c) => !existingShas.has(c.sha));
      mergedCommits = [...existing.commits, ...trulyNew];
    }

    // PRs via REST (single endpoint, cheap)
    const prs = await fetchPRs(owner, repo, token, log);

    log({ stage: 'done', message: 'Done.' });
    return {
      repo: { owner, name: repo, defaultBranch: branch },
      files,
      commits: mergedCommits,
      pullRequests: prs,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    await rmDir(tmpDir);
  }
}

async function fetchPRs(owner, repo, token, log) {
  log({ stage: 'prs', message: 'Fetching merged PRs...' });
  const prs = (await fetchAllPages(`/repos/${owner}/${repo}/pulls?state=closed`, token))
    .filter((pr) => pr.merged_at)
    .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    mergedAt: pr.merged_at,
    mergeCommitSha: pr.merge_commit_sha,
  }));
}
