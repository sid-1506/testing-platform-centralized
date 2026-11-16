import fs from 'fs';
import path from 'path';
import { PLATFORM_DIR, REPO_REGISTRY_FILE } from '../config';
import { ExternalRepo } from '../types';

/**
 * Persistent registry of external GitHub repositories (separate from the
 * read-only apps.registry.json of local applications).
 *
 * All mutations are synchronous read-modify-write cycles on one in-memory
 * snapshot and each is flushed with write-to-temp + atomic rename, so concurrent
 * HTTP requests within the process are serialized by the event loop and a crash
 * can never leave a half-written file.
 */
interface RegistryFile {
  version: 1;
  repos: ExternalRepo[];
}

let cache: ExternalRepo[] | null = null;

function load(): ExternalRepo[] {
  if (cache) return cache;
  if (!fs.existsSync(REPO_REGISTRY_FILE)) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(REPO_REGISTRY_FILE, 'utf8')) as RegistryFile;
    cache = Array.isArray(parsed.repos) ? parsed.repos : [];
  } catch {
    // Corrupt file: keep a copy for forensics and start clean rather than crash.
    const backup = `${REPO_REGISTRY_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(REPO_REGISTRY_FILE, backup);
      console.error(`[REPO REGISTRY] repos.json was unreadable; moved to ${path.basename(backup)}`);
    } catch {
      // ignore
    }
    cache = [];
  }
  return cache;
}

function flush(): void {
  fs.mkdirSync(PLATFORM_DIR, { recursive: true });
  const payload: RegistryFile = { version: 1, repos: load() };
  const tmp = `${REPO_REGISTRY_FILE}.${process.pid}.tmp`;
  // 0600: the file may hold target credentials entered as repository environment variables.
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, REPO_REGISTRY_FILE);
}

export function listRepos(): ExternalRepo[] {
  return load().map((r) => ({ ...r }));
}

export function getRepo(id: string): ExternalRepo | undefined {
  if (!/^[a-z0-9-]+$/.test(id)) return undefined;
  const found = load().find((r) => r.id === id);
  return found ? { ...found } : undefined;
}

export function findRepoByKey(owner: string, repo: string, branch: string): ExternalRepo | undefined {
  const key = `${owner}/${repo}@${branch}`.toLowerCase();
  return load().find((r) => `${r.owner}/${r.repo}@${r.branch}`.toLowerCase() === key);
}

export function addRepo(record: ExternalRepo): ExternalRepo {
  const repos = load();
  if (repos.some((r) => r.id === record.id)) throw new Error(`Repository ${record.id} already exists`);
  repos.push(record);
  flush();
  return { ...record };
}

export function updateRepo(id: string, patch: Partial<ExternalRepo> | ((r: ExternalRepo) => void)): ExternalRepo | undefined {
  const repos = load();
  const target = repos.find((r) => r.id === id);
  if (!target) return undefined;
  if (typeof patch === 'function') patch(target);
  else Object.assign(target, patch);
  flush();
  return { ...target };
}

export function removeRepo(id: string): boolean {
  const repos = load();
  const idx = repos.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  repos.splice(idx, 1);
  flush();
  return true;
}

/** Repositories left in `connecting` by a previous process can never finish; surface that as an error. */
export function recoverInterruptedRepos(): number {
  let n = 0;
  const repos = load();
  for (const r of repos) {
    if (r.status === 'connecting') {
      r.status = 'error';
      r.statusMessage = 'The backend restarted while this repository was being connected. Use "Fetch" to retry.';
      n += 1;
    }
  }
  if (n > 0) flush();
  return n;
}
