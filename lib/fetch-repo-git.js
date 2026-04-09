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
// Memory-constrained pack config. Cloud Run defaults to 512MiB and
// `git index-pack` gets OOM-killed on large repos without these limits.
const LOW_MEM_PACK_CFG = [
  '-c', 'pack.threads=1',
  '-c', 'pack.windowMemory=16m',
  '-c', 'pack.deltaCacheSize=16m',
  '-c', 'pack.packSizeLimit=100m',
  '-c', 'core.packedGitWindowSize=8m',
  '-c', 'core.packedGitLimit=64m',
  '-c', 'core.bigFileThreshold=1m',
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

// Per-file patch cap (bytes). Anything over this (usually generated or vendored
// files) is dropped to avoid ballooning memory on huge repos.
const MAX_PATCH_BYTES = 64 * 1024;

// Hard cap on commits retained. Beyond this the visualization becomes
// unreadable and the payload unshippable to the browser, so we keep only
// the most recent MAX_COMMITS and flag the data as truncated.
const MAX_COMMITS = Number(process.env.REPOVIEWER_MAX_COMMITS) || 2000;

// Common binary / vendored file extensions excluded from git log output via
// pathspecs. Keeps memory usage sane on game/asset-heavy repos.
const BINARY_EXT_EXCLUDES = [
  // images
  'png','jpg','jpeg','gif','bmp','tiff','ico','webp','psd','ai','eps','svg',
  // audio/video
  'mp3','wav','ogg','flac','aac','m4a','mp4','mov','avi','mkv','webm','wmv',
  // fonts
  'ttf','otf','woff','woff2','eot',
  // archives
  'zip','tar','gz','bz2','xz','7z','rar','jar','war','ear','apk','aar','ipa',
  // binaries
  'exe','dll','so','dylib','bin','dat','obj','o','a','lib','class','pyc','wasm','node',
  // docs/media
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  // 3d/game assets
  'fbx','blend','dae','3ds','max','gltf','glb','bsp','wad','pak','iwad','vmt','vtf','bik','rwd','xwb','xsb',
  // lockfiles / large generated
  'lock','min.js','min.css','map',
];

const BINARY_EXT_RE = new RegExp(`\\.(${BINARY_EXT_EXCLUDES.map(e => e.replace(/\./g, '\\.')).join('|')})$`, 'i');
function isBinaryPath(p) { return !!p && BINARY_EXT_RE.test(p); }

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
        // If patch exceeded cap, drop it (keep add/del counts for context)
        if (currentFile._oversized) {
          currentFile.patch = null;
        }
        delete currentFile._oversized;
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
        const fn = newPath || oldPath;
        // Skip binary/vendored files entirely — no entry in commit.files.
        if (isBinaryPath(fn) || isBinaryPath(oldPath)) {
          currentFile = null;
          inPatch = false;
          return;
        }
        currentFile = {
          filename: fn,
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
        if (!currentFile._oversized) {
          currentFile.patch += (currentFile.patch ? '\n' : '') + line;
          if (currentFile.patch.length > MAX_PATCH_BYTES) currentFile._oversized = true;
        }
        return;
      }
      if (inPatch) {
        if (line.startsWith('+')) currentFile.additions++;
        else if (line.startsWith('-')) currentFile.deletions++;
        if (!currentFile._oversized) {
          currentFile.patch += '\n' + line;
          if (currentFile.patch.length > MAX_PATCH_BYTES) currentFile._oversized = true;
        }
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
    } else {
      // Cap history depth at MAX_COMMITS to bound memory/CPU on huge repos.
      cloneArgs.push(`--depth=${MAX_COMMITS}`);
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
    const binaryExtRe = new RegExp(`\\.(${BINARY_EXT_EXCLUDES.map(e => e.replace(/\./g, '\\.')).join('|')})$`, 'i');
    const files = treeRaw.split('\n').filter(Boolean).map((line) => {
      const tabIdx = line.indexOf('\t');
      const meta = line.slice(0, tabIdx).split(/\s+/);
      const size = Number(meta[3]) || 0;
      const p = line.slice(tabIdx + 1);
      return { path: p, size };
    }).filter(f => !binaryExtRe.test(f.path));

    // Estimate total commits for progress (approximate — rev-list --count)
    let totalCommits = 0;
    try {
      const countRaw = await runGit(['rev-list', '--count', 'HEAD'], { cwd: cloneDir });
      totalCommits = Number(countRaw.trim()) || 0;
    } catch {}

    // After shallow clone with --depth, totalCommits is already ≤ MAX_COMMITS.
    // But if the server refused the depth (huge repos can reject), we still
    // cap via -n below.
    const effectiveLimit = Math.min(totalCommits || MAX_COMMITS, MAX_COMMITS);
    log({ stage: 'commits-detail', current: 0, total: effectiveLimit, message: `Parsing ${effectiveLimit} commits...` });

    // Stream git log with unified diff. --reverse gives oldest first, but
    // when we cap we want the most recent N. So we use -n without --reverse
    // to take the last N, then reverse in JS.
    const fmt = `${DELIM_PREFIX}%n%H%n%ct%n%an%n%s`;
    const logArgs = [
      '-c', 'diff.renameLimit=2000',
      'log', '-M', '-p', `-n`, String(MAX_COMMITS), `--format=format:${fmt}`, 'HEAD',
    ];
    const proc = spawnGitStream(logArgs, { cwd: cloneDir });
    const rawCommits = await parseGitLog(proc, (c, count) => {
      if (count % 10 === 0 || count === effectiveLimit) {
        log({
          stage: 'commits-detail',
          current: count,
          total: effectiveLimit,
          message: `Parsing commit ${count}/${effectiveLimit}...`,
        });
      }
    });

    // git log without --reverse produced newest-first; flip to oldest-first
    // so the viz timeline runs forward.
    const newCommits = rawCommits.reverse();
    const truncated = totalCommits > MAX_COMMITS;

    // Merge with existing (incremental)
    let mergedCommits = newCommits;
    if (existing?.commits?.length && lastCachedSha) {
      const existingShas = new Set(existing.commits.map((c) => c.sha));
      const trulyNew = newCommits.filter((c) => !existingShas.has(c.sha));
      mergedCommits = [...existing.commits, ...trulyNew];
      // Re-cap if merge pushed us over the limit
      if (mergedCommits.length > MAX_COMMITS) {
        mergedCommits = mergedCommits.slice(mergedCommits.length - MAX_COMMITS);
      }
    }

    // PRs via REST (single endpoint, cheap)
    const prs = await fetchPRs(owner, repo, token, log);

    log({ stage: 'done', message: 'Done.' });
    return {
      repo: {
        owner,
        name: repo,
        defaultBranch: branch,
        totalCommits: totalCommits || mergedCommits.length,
        truncated,
        shownCommits: mergedCommits.length,
      },
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
