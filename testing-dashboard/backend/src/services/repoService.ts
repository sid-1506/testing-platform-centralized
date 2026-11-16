import fs from 'fs';
import path from 'path';
import { DEPS_DIR } from '../config';
import { assertInside } from '../lib/fsSafe';
import { ExternalRepo, RepoDetection } from '../types';
import { SettingsError, applySettingsPatch } from './repoSettings';
import { isRepoBusy } from './externalExecutor';
import {
  GitServiceError,
  fetchRepo,
  makeRepoId,
  parseGitHubUrl,
  probeRemote,
  removeRepoCache,
  repoCacheDir,
  validateBranch,
} from './gitService';
import { detectRepository } from './repoDetector';
import { describeDetection } from './repoStatus';
import { addRepo, findRepoByKey, getRepo, removeRepo, updateRepo } from './repoRegistry';

export class RepoServiceError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'RepoServiceError';
  }
}

const inFlight = new Set<string>();

export { describeDetection };

/** Trust is bound to one commit: a repository that moved to another commit must be reviewed and trusted again. */
function revokeTrustIfCommitChanged(id: string, sha: string): void {
  const r = getRepo(id);
  if (r?.trustedAt && r.trustedSha !== sha) {
    updateRepo(id, (x) => {
      delete x.trustedAt;
      delete x.trustedSha;
    });
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validates + registers a GitHub repository. Reachability and branch existence
 * are verified synchronously (so the form gets an immediate error); cloning and
 * detection continue in the background and are reported through `status`.
 */
export async function registerRepository(urlInput: string, branchInput: string): Promise<ExternalRepo> {
  let parsed;
  let branch: string;
  try {
    parsed = parseGitHubUrl(urlInput);
    branch = validateBranch(branchInput || 'main');
  } catch (err) {
    if (err instanceof GitServiceError) throw new RepoServiceError(400, err.message, err.code);
    throw err;
  }

  const existing = findRepoByKey(parsed.owner, parsed.repo, branch);
  if (existing) {
    throw new RepoServiceError(409, `${parsed.owner}/${parsed.repo} (branch ${branch}) is already connected.`, 'DUPLICATE');
  }

  try {
    await probeRemote(parsed.url, branch);
  } catch (err) {
    if (err instanceof GitServiceError) throw new RepoServiceError(err.status, err.message, err.code);
    throw err;
  }

  // Re-check after the await: another request may have registered the same repo meanwhile.
  if (findRepoByKey(parsed.owner, parsed.repo, branch)) {
    throw new RepoServiceError(409, `${parsed.owner}/${parsed.repo} (branch ${branch}) is already connected.`, 'DUPLICATE');
  }

  const id = makeRepoId(parsed.owner, parsed.repo, branch);
  const record: ExternalRepo = {
    id,
    name: parsed.repo,
    url: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    registeredAt: new Date().toISOString(),
    status: 'connecting',
    statusMessage: 'Cloning repository…',
    location: path.posix.join('repos', id),
  };
  addRepo(record);
  void connect(id);
  return record;
}

/** Clone/fetch + static framework detection. Never executes repository code. */
async function connect(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const repo = getRepo(id);
    if (!repo) return;
    updateRepo(id, { status: 'connecting', statusMessage: 'Fetching repository…' });
    const sha = await fetchRepo(id, repo.url, repo.branch, { trackId: `repo-${id}` });
    const latest = getRepo(id);
    if (!latest) {
      // Removed while cloning.
      removeRepoCache(id);
      return;
    }
    const detection = detectRepository(repoCacheDir(id), latest.settings);
    revokeTrustIfCommitChanged(id, sha);
    updateRepo(id, {
      commitSha: sha,
      lastFetchedAt: new Date().toISOString(),
      detection,
      status: detection.supported ? 'ready' : 'unsupported',
      statusMessage: describeDetection(detection, { ...latest, commitSha: sha }),
    });
  } catch (err) {
    updateRepo(id, { status: 'error', statusMessage: describeError(err) });
  } finally {
    inFlight.delete(id);
  }
}

export function requireRepo(id: string): ExternalRepo {
  const repo = getRepo(id);
  if (!repo) throw new RepoServiceError(404, `Repository '${id}' not found.`);
  return repo;
}

export function refetchRepository(id: string): ExternalRepo {
  const repo = requireRepo(id);
  if (isRepoBusy(id)) throw new RepoServiceError(409, 'A test run is in progress for this repository.');
  if (inFlight.has(id)) throw new RepoServiceError(409, 'This repository is already being fetched.');
  updateRepo(id, { status: 'connecting', statusMessage: 'Fetching latest changes…' });
  void connect(id);
  return requireRepo(id);
}

/** Re-runs static detection on the current checkout (no network, no code execution). */
export function inspectRepository(id: string): ExternalRepo {
  const repo = requireRepo(id);
  if (repo.status === 'connecting') throw new RepoServiceError(409, 'Repository is still connecting.');
  const dir = repoCacheDir(id);
  if (!fs.existsSync(dir)) throw new RepoServiceError(409, 'Repository has not been cloned yet. Use Fetch.');
  const detection = detectRepository(dir, repo.settings);
  return (
    updateRepo(id, {
      detection,
      status: detection.supported ? 'ready' : 'unsupported',
      statusMessage: describeDetection(detection, repo),
    }) || repo
  );
}

export function deleteRepository(id: string): void {
  const repo = requireRepo(id);
  if (isRepoBusy(id)) throw new RepoServiceError(409, 'Cannot remove a repository while a test run is in progress. Cancel the run first.');
  removeRepo(id);
  try {
    removeRepoCache(id);
    const depsDir = assertInside(DEPS_DIR, path.join(DEPS_DIR, repo.id));
    fs.rmSync(depsDir, { recursive: true, force: true });
  } catch {
    // Cache cleanup is best effort; the registration itself is gone.
  }
}

export function trustRepository(id: string): ExternalRepo {
  const repo = requireRepo(id);
  if (repo.status !== 'ready') throw new RepoServiceError(409, 'Only a ready, supported repository can be trusted.');
  if (!repo.commitSha) throw new RepoServiceError(409, 'The repository has no fetched commit yet. Fetch it first, then trust that commit.');
  return updateRepo(id, { trustedAt: new Date().toISOString(), trustedSha: repo.commitSha }) || repo;
}

export function revokeTrust(id: string): ExternalRepo {
  requireRepo(id);
  return updateRepo(id, (r) => {
    delete r.trustedAt;
    delete r.trustedSha;
  }) as ExternalRepo;
}

export function updateRepositorySettings(id: string, input: unknown): ExternalRepo {
  const repo = requireRepo(id);
  if (isRepoBusy(id)) throw new RepoServiceError(409, 'A test run is in progress for this repository; change its settings afterwards.');
  let settings;
  try {
    settings = applySettingsPatch(repo.settings, (input ?? {}) as Record<string, unknown>, repo.detection?.scripts);
  } catch (err) {
    if (err instanceof SettingsError) throw new RepoServiceError(400, err.message, 'INVALID_SETTINGS');
    throw err;
  }
  // Runtime discovery depends on the run configuration (target URL, layer, script): it is void after any settings change.
  updateRepo(id, (r) => {
    r.settings = settings;
    delete r.discovery;
  });
  return inspectRepository(id);
}
