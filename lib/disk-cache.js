import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

function keyToFile(owner, repo) {
  // Sanitize to avoid path traversal; encodeURIComponent keeps it safe.
  return path.join(CACHE_DIR, `${encodeURIComponent(owner)}__${encodeURIComponent(repo)}.json`);
}

export async function readDiskCache(owner, repo) {
  try {
    const file = keyToFile(owner, repo);
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(`[disk-cache] Failed to read ${owner}/${repo}:`, err.message);
    return null;
  }
}

export async function writeDiskCache(owner, repo, data) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const file = keyToFile(owner, repo);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  } catch (err) {
    console.warn(`[disk-cache] Failed to write ${owner}/${repo}:`, err.message);
  }
}
