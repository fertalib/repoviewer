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
 * Stream-parse `git log --name-status -M` output.
 * Uses only tree objects (no blobs) so it's instant on blobless clones.
 *
 * name-status format per file:
 *   "A\tfilename"            (added)
 *   "M\tfilename"            (modified)
 *   "D\tfilename"            (deleted)
 *   "R100\told\tnew"         (renamed)
 */
function parseGitLogNameStatus(proc, expectedTotal, onProgress) {
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
      if (line.startsWith(DELIM_PREFIX)) {
        flushCommit();
        headerLines = [];
        return;
      }
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
      if (!line.trim()) return;

      const parts = line.split('\t');
      if (parts.length < 2) return;

      const statusCode = parts[0];
      let filename, previous_filename = null, status;

      if (statusCode === 'A') {
        status = 'added';
        filename = parts[1];
      } else if (statusCode === 'D') {
        status = 'removed';
        filename = parts[1];
      } else if (statusCode === 'M') {
        status = 'modified';
        filename = parts[1];
      } else if (statusCode.startsWith('R')) {
        status = 'renamed';
        previous_filename = parts[1];
        filename = parts[2];
      } else if (statusCode.startsWith('C')) {
        status = 'added'; // copy = new file
        filename = parts[2] || parts[1];
      } else {
        return; // T, U, X, etc.
      }

      if (isBinaryPath(filename) || isBinaryPath(previous_filename)) return;

      // additions/deletions will be filled in later from tree sizes
      current.files.push({
        filename,
        previous_filename,
        status,
        additions: 0,
        deletions: 0,
        patch: null,
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
 * Typical line counts by extension. Deterministic, offline, zero-network.
 * Avoids the GitHub Trees API call which OOMs on huge JSON responses from
 * asset-heavy repos (openclaw, game repos, monorepos).
 */
const EXT_LINE_ESTIMATES = {
  // source code (rich files)
  js: 200, jsx: 200, ts: 200, tsx: 200, mjs: 200, cjs: 200,
  py: 200, rb: 200, go: 200, rs: 200, swift: 200, kt: 200, kts: 200,
  java: 250, scala: 250, c: 250, cc: 250, cpp: 250, cxx: 250,
  h: 120, hpp: 120, hxx: 120,
  cs: 200, fs: 200, m: 200, mm: 200,
  php: 200, pl: 150, lua: 150, r: 120, jl: 120,
  dart: 180, ex: 150, exs: 150, erl: 150, clj: 150, hs: 120, ml: 120,
  sh: 80, bash: 80, zsh: 80, fish: 80, ps1: 100,
  sql: 100, graphql: 80, gql: 80,
  // markup / styles (medium)
  html: 100, htm: 100, vue: 150, svelte: 150, astro: 150,
  css: 120, scss: 120, sass: 120, less: 120, styl: 120,
  // docs / text (short)
  md: 50, mdx: 80, txt: 50, rst: 60, adoc: 60, tex: 120,
  // data / config (small)
  json: 30, yml: 30, yaml: 30, toml: 30, ini: 20, cfg: 20, conf: 20,
  xml: 50, csv: 40, tsv: 40,
  // build
  dockerfile: 30, makefile: 40, cmake: 60, gradle: 60,
};

function estimateLinesForPath(p) {
  if (!p) return 50;
  // Match by basename for special files with no extension
  const base = p.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return EXT_LINE_ESTIMATES.dockerfile;
  if (base === 'makefile' || base === 'gnumakefile') return EXT_LINE_ESTIMATES.makefile;
  if (base === 'cmakelists.txt') return EXT_LINE_ESTIMATES.cmake;
  const dot = p.lastIndexOf('.');
  if (dot < 0) return 50;
  const ext = p.slice(dot + 1).toLowerCase();
  return EXT_LINE_ESTIMATES[ext] || 100;
}

/**
 * Build Map<path, estimatedLines> from the already-loaded file tree.
 * Replaces the GitHub Trees API call — no network, no OOM.
 */
function buildFileSizeMap(files) {
  const map = new Map();
  for (const f of files) {
    map.set(f.path, estimateLinesForPath(f.path));
  }
  return map;
}

/**
 * Enrich commits with estimated line counts from file size map.
 * For "added" files: additions = estimated lines from tree.
 * For "removed" files: deletions = last known size.
 * For "modified": small delta (1 add, 1 del) to show activity.
 */
function enrichWithLineCounts(commits, fileSizeMap) {
  // Track known file sizes as we go
  const knownSizes = new Map();
  const sizeFor = (p) => fileSizeMap.get(p) ?? estimateLinesForPath(p);

  for (const commit of commits) {
    for (const file of commit.files) {
      if (file.status === 'added') {
        const est = sizeFor(file.filename);
        file.additions = est;
        knownSizes.set(file.filename, est);
      } else if (file.status === 'removed') {
        file.deletions = knownSizes.get(file.filename) ?? sizeFor(file.filename);
        knownSizes.delete(file.filename);
      } else if (file.status === 'renamed') {
        const old = knownSizes.get(file.previous_filename) ?? sizeFor(file.previous_filename);
        knownSizes.delete(file.previous_filename);
        knownSizes.set(file.filename, old);
        // No line changes for renames
      } else {
        // modified: small delta to show activity
        file.additions = 1;
        file.deletions = 1;
      }
    }
  }
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

    // File tree via local ls-tree (tree objects are in the blobless clone).
    // Sizes will come from REST API later in enrichment.
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

    // Use --name-status (not --numstat or -p) because blobless clone has no
    // blob data. --name-status uses only tree objects and is instant even on
    // repos with 29k+ commits. Line counts are estimated from tree sizes via
    // a single REST API call (see enrichWithLineCounts below).
    const fmt = `${DELIM_PREFIX}%n%H%n%ct%n%an%n%s`;
    const logArgs = [
      '-c', 'diff.renameLimit=2000',
      'log', '-M', '--name-status',
      `-n`, String(MAX_COMMITS), `--format=format:${fmt}`, 'HEAD',
    ];
    const proc = spawnGitStream(logArgs, { cwd: cloneDir });
    const rawCommits = await parseGitLogNameStatus(proc, effectiveLimit, (count) => {
      if (count % 50 === 0 || count === effectiveLimit) {
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

    // Estimate per-file line counts from extension heuristics. Deterministic,
    // offline, instant — replaces a Trees API call that OOM'd JSON.parse on
    // asset-heavy repos (e.g. openclaw with thousands of assets).
    log({ stage: 'tree', message: 'Estimating file sizes...' });
    const fileSizeMap = buildFileSizeMap(files);
    enrichWithLineCounts(mergedCommits, fileSizeMap);

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
