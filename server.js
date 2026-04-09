import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRepoData } from './lib/fetch-repo.js';
import { fetchRepoDataViaGit } from './lib/fetch-repo-git.js';
import { readDiskCache, writeDiskCache } from './lib/disk-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cookieParser());

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// In-memory cache: key -> { data, expiresAt }
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
// Disk cache TTL: 24 hours. Beyond this we still reuse as incremental base.
const DISK_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

async function loadRepo(owner, repo, token, onProgress) {
  const cacheKey = `${owner}/${repo}`;
  // Memory cache
  const mem = cache.get(cacheKey);
  if (mem && mem.expiresAt > Date.now()) return mem.data;

  // Disk cache (fresh → return as-is; stale → use as incremental base)
  const disk = await readDiskCache(owner, repo);
  const diskFresh = disk && disk.fetchedAt && (Date.now() - new Date(disk.fetchedAt).getTime()) < DISK_CACHE_FRESH_MS;
  if (diskFresh) {
    cache.set(cacheKey, { data: disk, expiresAt: Date.now() + CACHE_TTL });
    return disk;
  }

  // Fetch via git (ephemeral clone + parse), incremental if we have prior data
  let data;
  try {
    data = await fetchRepoDataViaGit(owner, repo, token, onProgress, { existing: disk || undefined });
  } catch (err) {
    console.warn(`[${cacheKey}] git fetch failed, falling back to REST: ${err.message}`);
    onProgress?.({ stage: 'clone', message: `Git clone failed (${err.message.slice(0, 80)}) — falling back to REST...` });
    data = await fetchRepoData(owner, repo, token, onProgress);
  }
  await writeDiskCache(owner, repo, data);
  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL });
  return data;
}

// --- Auth middleware ---
function authMiddleware(req, _res, next) {
  const token = req.cookies?.session;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.githubToken = payload.githubToken;
      req.githubUser = payload.login;
      req.githubAvatar = payload.avatar;
    } catch { /* invalid token, ignore */ }
  }
  next();
}
app.use(authMiddleware);

// --- OAuth routes ---
app.get('/auth/github', (_req, res) => {
  if (!GITHUB_CLIENT_ID) return res.status(500).send('GITHUB_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope: 'repo read:org',
    redirect_uri: `${process.env.BASE_URL || 'http://localhost:' + PORT}/auth/callback`,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter');

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) return res.status(400).send(tokenData.error_description);

  // Get user info
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const user = await userRes.json();

  // Set JWT cookie
  const sessionToken = jwt.sign(
    { githubToken: tokenData.access_token, login: user.login, avatar: user.avatar_url },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('session', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.redirect('/');
});

app.get('/auth/logout', (_req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

// --- API: current user info ---
app.get('/api/me', (req, res) => {
  if (!req.githubToken) return res.json({ authenticated: false });
  res.json({ authenticated: true, login: req.githubUser, avatar: req.githubAvatar });
});

// --- API: list user repos (including org repos) ---
app.get('/api/repos', async (req, res) => {
  if (!req.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  const headers = { Authorization: `Bearer ${req.githubToken}`, Accept: 'application/vnd.github.v3+json' };
  try {
    // Fetch user repos and orgs in parallel
    const [userReposRes, orgsRes] = await Promise.all([
      fetch('https://api.github.com/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member', { headers }),
      fetch('https://api.github.com/user/orgs?per_page=100', { headers }),
    ]);
    if (!userReposRes.ok) throw new Error(`GitHub API ${userReposRes.status}`);
    const userRepos = await userReposRes.json();
    const orgs = orgsRes.ok ? await orgsRes.json() : [];
    console.log(`[repos] User repos: ${userRepos.length}, Orgs: ${orgs.length} (${orgs.map(o => o.login).join(', ')})`);

    // Fetch repos for each org in parallel
    const orgRepoResults = await Promise.all(
      orgs.map(async (org) => {
        try {
          const r = await fetch(`https://api.github.com/orgs/${org.login}/repos?sort=pushed&per_page=30`, { headers });
          return r.ok ? await r.json() : [];
        } catch { return []; }
      })
    );

    const orgReposFlat = orgRepoResults.flat();
    console.log(`[repos] Org repos fetched: ${orgReposFlat.length}`);

    // Merge and dedupe
    const allRepos = [...userRepos, ...orgReposFlat];
    const seen = new Set();
    const deduped = allRepos.filter(r => {
      if (seen.has(r.full_name)) return false;
      seen.add(r.full_name);
      return true;
    });

    // Sort by most recently pushed
    deduped.sort((a, b) => new Date(b.pushed_at || b.updated_at) - new Date(a.pushed_at || a.updated_at));

    res.json(deduped.slice(0, 100).map(r => ({
      full_name: r.full_name,
      description: r.description,
      updated_at: r.updated_at,
      private: r.private,
      owner: r.full_name.split('/')[0],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: fetch repo data ---
app.get('/api/repo/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  const token = req.githubToken || process.env.GITHUB_TOKEN;
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please login with GitHub.' });

  const cacheKey = `${owner}/${repo}`;

  try {
    const data = await loadRepo(owner, repo, token, (p) => {
      process.stdout.write(`\r[${cacheKey}] ${p.message || p.stage}`);
    });
    console.log(`\n[${cacheKey}] Served (${data.commits.length} commits)`);
    res.json(data);
  } catch (err) {
    console.error(`\n[${cacheKey}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- API: stream repo data via SSE with progress events ---
app.get('/api/repo/:owner/:repo/stream', async (req, res) => {
  const { owner, repo } = req.params;
  const token = req.githubToken || process.env.GITHUB_TOKEN;
  if (!token) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keepalive every 15s to prevent proxy/browser timeout on slow fetches
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepalive));

  const cacheKey = `${owner}/${repo}`;

  try {
    const data = await loadRepo(owner, repo, token, (p) => {
      send('progress', p);
      process.stdout.write(`\r[${cacheKey}] ${p.message || p.stage}`);
    });
    console.log(`\n[${cacheKey}] Served (${data.commits.length} commits)`);
    send('done', data);
  } catch (err) {
    console.error(`\n[${cacheKey}] Error:`, err.message);
    send('fail', { message: err.message });
  }
  clearInterval(keepalive);
  res.end();
});

// --- Serve viz page for /viz/:owner/:repo ---
app.get('/viz/:owner/:repo', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viz.html'));
});

// --- Serve compare page ---
app.get('/compare/:ownerA/:repoA/:ownerB/:repoB', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'compare.html'));
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Repoviewer running on http://localhost:${PORT}`);
  if (!GITHUB_CLIENT_ID) console.log('  ⚠ No GITHUB_CLIENT_ID set — OAuth disabled, using GITHUB_TOKEN env var for API calls');
});
