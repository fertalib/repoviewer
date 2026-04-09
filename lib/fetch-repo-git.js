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
 * Stream-parse `git log --numstat -M` output. Much lighter than -p: no patch
 * content, just additions/deletions/filename per file per commit.
 *
 * numstat format per file: "<add>\t<del>\t<filename>" (binary shows "-\t-\t<file>")
 * Renames with -M show: "<add>\t<del>\t<old>{...}<new>" or "<add>\t<del>\t<old>\t<new>"
 */
function parseGitLogNumstat(proc, expectedTotal, onProgress) {
  return new Promise((resolve, reject) => {
    const commits = [];
    let current = null;
    let headerLines = null;

    const rl = readline.createInterface({ input: proc.stdout });

    function flushCommit() {
      if (current) {
        commits.push(current);
        if (onProgress) onProgress(commits.length);
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
      // Header: 4 lines (sha, timestamp, author, subject)
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
      if (!current) return;

      // Empty line separates header from numstat block — skip
      if (!line.trim()) return;

      // numstat line: "add\tdel\tfilename" or "add\tdel\told\tnew" (rename)
      const parts = line.split('\t');
      if (parts.length < 3) return;

      const adds = parts[0] === '-' ? 0 : Number(parts[0]) || 0;
      const dels = parts[1] === '-' ? 0 : Number(parts[1]) || 0;

      // Binary file (shows - - filename) — skip
      if (parts[0] === '-' && parts[1] === '-') return;

      let filename = parts.slice(2).join('\t');
      let previous_filename = null;
      let status = 'modified';

      // Detect rename: git -M numstat shows "add\tdel\told => new" or
      // "add\tdel\t{prefix/}{old => new}/suffix" or "add\tdel\told\tnew"
      if (parts.length === 4 && parts[2] !== parts[3]) {
        // Simple rename: old\tnew as separate columns
        previous_filename = parts[2];
        filename = parts[3];
        status = 'renamed';
      } else {
        const renameMatch = filename.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
        if (renameMatch) {
          const [, prefix, oldPart, newPart, suffix] = renameMatch;
          previous_filename = prefix + oldPart + suffix;
          filename = prefix + newPart + suffix;
          status = 'renamed';
        }
      }

      // Skip binary-extension files
      if (isBinaryPath(filename) || isBinaryPath(previous_filename)) return;

      // Heuristic for added/removed: if a file has only additions and 0
      // deletions in its first appearance, it's likely "added". We rely on
      // --diff-filter=ADMR so git only emits these statuses.
      // Without full diff headers we approximate:
      if (dels === 0 && adds > 0 && !previous_filename) status = 'added';
      if (adds === 0 && dels > 0 && !previous_filename) status = 'removed';

      current.files.push({
        filename,
        previous_filename,
        status,
        additions: adds,
        deletions: dels,
        patch: null, // no patch data in blobless mode
      });
    });

    rl.on('close', () => {
      flushCommit();
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

    // Blobless clone: only download commit + tree objects, no file content.
    // This makes clones tiny and prevents OOM on asset-heavy repos.
    // Trade-off: we use --numstat instead of -p (no patches, but the viz
    // handles patch=null gracefully via applyPatch fallback).
    const cloneArgs = ['clone', '--bare', '--no-tags', '--filter=blob:none'];
    if (lastCachedDate) {
      cloneArgs.push(`--shallow-since=${lastCachedDate}`);
    } else {
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

    // File tree. In blobless clone, ls-tree -r still lists paths (tree objects
    // are present). --long may show "-" for size since blobs aren't local, so
    // we just use 0 as size (the viz derives line counts from commit diffs).
    const treeRaw = await runGit(['ls-tree', '-r', 'HEAD'], { cwd: cloneDir });
    const files = treeRaw.split('\n').filter(Boolean).map((line) => {
      const tabIdx = line.indexOf('\t');
      const p = line.slice(tabIdx + 1);
      return { path: p, size: 0 };
    }).filter(f => !BINARY_EXT_RE.test(f.path));

    // Estimate total commits for progress (approximate — rev-list --count)
    let totalCommits = 0;
    try {
      const countRaw = await runGit(['rev-list', '--count', 'HEAD'], { cwd: cloneDir });
      totalCommits = Number(countRaw.trim()) || 0;
    } catch {}

    const effectiveLimit = Math.min(totalCommits || MAX_COMMITS, MAX_COMMITS);
    log({ stage: 'commits-detail', current: 0, total: effectiveLimit, message: `Parsing ${effectiveLimit} commits...` });

    // Use --numstat (not -p) because blobless clone has no blob data.
    // --numstat gives us additions/deletions/filename per file without
    // needing blob content. Patches will be null; the viz handles this
    // gracefully in applyPatch (marks all lines as same-age).
    const fmt = `${DELIM_PREFIX}%n%H%n%ct%n%an%n%s`;
    const logArgs = [
      '-c', 'diff.renameLimit=2000',
      'log', '-M', '--numstat',
      `-n`, String(MAX_COMMITS), `--format=format:${fmt}`, 'HEAD',
    ];
    const proc = spawnGitStream(logArgs, { cwd: cloneDir });
    const rawCommits = await parseGitLogNumstat(proc, effectiveLimit, (count) => {
      if (count % 20 === 0 || count === effectiveLimit) {
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
