import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { REPO_CACHE_DIR, TIMEOUTS } from '../config';
import { assertInside } from '../lib/fsSafe';
import { buildGitEnv } from './sandboxEnv';
import { runTrackedCommand } from './processManager';

export type GitErrorCode =
  | 'INVALID_URL'
  | 'INVALID_BRANCH'
  | 'NOT_FOUND'
  | 'BRANCH_NOT_FOUND'
  | 'NETWORK'
  | 'CLONE_FAILED'
  | 'CANCELLED';

export class GitServiceError extends Error {
  constructor(public code: GitErrorCode, message: string, public status = 400) {
    super(message);
    this.name = 'GitServiceError';
  }
}

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  /** Canonical https clone URL. */
  url: string;
}

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?$|^[A-Za-z0-9_]$/;

/**
 * Accepts only `https://github.com/<owner>/<repo>[.git]`. No other host, no
 * ssh/git/file protocols, no credentials, ports, queries or fragments.
 */
export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const raw = (input ?? '').trim();
  if (!raw) throw new GitServiceError('INVALID_URL', 'Repository URL is required.');
  if (raw.length > 300 || /[\s\0]/.test(raw)) {
    throw new GitServiceError('INVALID_URL', 'Repository URL is malformed.');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GitServiceError('INVALID_URL', 'Not a valid URL. Expected https://github.com/<owner>/<repository>.git');
  }
  if (u.protocol !== 'https:') {
    throw new GitServiceError('INVALID_URL', 'Only public HTTPS GitHub URLs are supported (https://github.com/<owner>/<repository>).');
  }
  if (u.hostname.toLowerCase() !== 'github.com' || u.port) {
    throw new GitServiceError('INVALID_URL', 'Only github.com repositories are supported.');
  }
  if (u.username || u.password) {
    throw new GitServiceError('INVALID_URL', 'Do not include credentials in the URL. Private repositories are not supported yet.');
  }
  if (u.search || u.hash) {
    throw new GitServiceError('INVALID_URL', 'Remove query strings / fragments from the repository URL.');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new GitServiceError('INVALID_URL', 'URL must point at a repository root: https://github.com/<owner>/<repository>.git');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new GitServiceError('INVALID_URL', 'Owner or repository name contains unsupported characters.');
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export function validateBranch(branch: string): string {
  const b = (branch ?? '').trim();
  if (!b) throw new GitServiceError('INVALID_BRANCH', 'Branch name is required.');
  if (
    b.length > 200 ||
    !/^[A-Za-z0-9._\-/]+$/.test(b) ||
    b.startsWith('-') ||
    b.startsWith('/') ||
    b.endsWith('/') ||
    b.endsWith('.') ||
    b.endsWith('.lock') ||
    b.includes('..') ||
    b.includes('//') ||
    b.includes('@{')
  ) {
    throw new GitServiceError('INVALID_BRANCH', `"${b.slice(0, 60)}" is not a valid branch name.`);
  }
  return b;
}

export function makeRepoId(owner: string, repo: string, branch: string): string {
  const key = `${owner}/${repo}@${branch}`.toLowerCase();
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 6);
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';
  return `gh-${slug}-${hash}`;
}

export function repoCacheDir(repoId: string): string {
  if (!/^[a-z0-9-]+$/.test(repoId)) throw new Error('Invalid repository id');
  return assertInside(REPO_CACHE_DIR, path.join(REPO_CACHE_DIR, repoId));
}

interface GitResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type GitOutput = (chunk: string, stream: 'stdout' | 'stderr') => void;

/** Runs git with an argument array (no shell), a sanitized env and a timeout. */
async function git(
  args: string[],
  opts: { cwd?: string; timeoutMs: number; trackId: string; onOutput?: GitOutput }
): Promise<GitResult> {
  let stdout = '';
  let stderr = '';
  fs.mkdirSync(REPO_CACHE_DIR, { recursive: true });
  const res = await runTrackedCommand({
    runId: opts.trackId,
    label: `git:${args[0]}`,
    command: 'git',
    args: [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'core.fsmonitor=false',
      ...args,
    ],
    cwd: opts.cwd || REPO_CACHE_DIR,
    env: buildGitEnv(),
    timeoutMs: opts.timeoutMs,
    onOutput: (chunk, stream) => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      opts.onOutput?.(chunk, stream);
    },
  }).catch((err: NodeJS.ErrnoException) => {
    throw new GitServiceError(
      'CLONE_FAILED',
      err.code === 'ENOENT' ? 'git is not installed or not on PATH.' : `Could not run git: ${err.message}`,
      500
    );
  });
  return { exitCode: res.exitCode, timedOut: res.timedOut, stdout, stderr };
}

function classifyGitFailure(res: GitResult, fallback: GitErrorCode = 'CLONE_FAILED'): GitServiceError {
  const text = `${res.stderr}\n${res.stdout}`;
  const short = text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
  if (res.timedOut || /could not resolve host|unable to access|failed to connect|timed out|connection (?:reset|refused)|network is unreachable|early eof|tls|ssl/i.test(text)) {
    return new GitServiceError('NETWORK', `Could not reach GitHub (${res.timedOut ? 'timed out' : short || 'network error'}).`, 502);
  }
  if (/repository not found|not found|authentication failed|could not read username|terminal prompts disabled|invalid username or password|403|401/i.test(text)) {
    return new GitServiceError(
      'NOT_FOUND',
      'Repository not found, or it is private. Only public GitHub repositories are supported.',
      404
    );
  }
  if (/remote branch .* not found|couldn't find remote ref/i.test(text)) {
    return new GitServiceError('BRANCH_NOT_FOUND', 'The requested branch does not exist in this repository.', 404);
  }
  return new GitServiceError(fallback, `Git operation failed: ${short || 'unknown error'}`, 502);
}

/**
 * Verifies, without cloning, that the repository is reachable and has the branch.
 * Throws GitServiceError (NOT_FOUND / BRANCH_NOT_FOUND / NETWORK).
 */
export async function probeRemote(url: string, branch: string): Promise<string> {
  const res = await git(['ls-remote', '--exit-code', '--heads', url, `refs/heads/${branch}`], {
    timeoutMs: TIMEOUTS.gitProbeMs,
    trackId: 'repo-probe',
  });
  if (res.exitCode === 0) {
    const sha = res.stdout.trim().split(/\s+/)[0] || '';
    return sha;
  }
  if (res.exitCode === 2 && !res.timedOut) {
    // Repo exists but the branch does not: list a few real branches to help the user.
    const all = await git(['ls-remote', '--heads', url], { timeoutMs: TIMEOUTS.gitProbeMs, trackId: 'repo-probe' });
    const names = all.stdout
      .split('\n')
      .map((l) => l.split('refs/heads/')[1])
      .filter(Boolean)
      .slice(0, 6);
    throw new GitServiceError(
      'BRANCH_NOT_FOUND',
      `Branch "${branch}" does not exist in this repository.${names.length ? ` Available branches: ${names.join(', ')}.` : ''}`,
      404
    );
  }
  throw classifyGitFailure(res, 'NETWORK');
}

export async function headSha(dir: string): Promise<string> {
  const res = await git(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 15_000, trackId: 'repo-meta' });
  const sha = res.stdout.trim();
  if (res.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitServiceError('CLONE_FAILED', 'Could not determine the checked-out commit.', 500);
  }
  return sha;
}

export interface GitOpOptions {
  /** Track the git process under this id so a cancelled run kills it. */
  trackId?: string;
  onOutput?: GitOutput;
}

/** Shallow single-branch clone into the platform repo cache. Returns the commit SHA. */
export async function cloneRepo(
  repoId: string,
  url: string,
  branch: string,
  opts: GitOpOptions = {}
): Promise<string> {
  const dest = repoCacheDir(repoId);
  fs.mkdirSync(REPO_CACHE_DIR, { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  const res = await git(
    ['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', branch, '--', url, dest],
    { timeoutMs: TIMEOUTS.cloneMs, trackId: opts.trackId || `repo-${repoId}`, onOutput: opts.onOutput }
  );
  if (res.exitCode !== 0) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw classifyGitFailure(res);
  }
  return headSha(dest);
}

/** Fetches the latest tip of `branch` into the cache clone and hard-resets to it. Returns the SHA. */
export async function fetchRepo(
  repoId: string,
  url: string,
  branch: string,
  opts: GitOpOptions = {}
): Promise<string> {
  const dir = repoCacheDir(repoId);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return cloneRepo(repoId, url, branch, opts);
  }
  const trackId = opts.trackId || `repo-${repoId}`;
  const fetched = await git(['fetch', '--depth', '1', '--no-tags', url, `+refs/heads/${branch}`], {
    cwd: dir,
    timeoutMs: TIMEOUTS.cloneMs,
    trackId,
    onOutput: opts.onOutput,
  });
  if (fetched.exitCode !== 0) throw classifyGitFailure(fetched);
  const reset = await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, timeoutMs: 60_000, trackId, onOutput: opts.onOutput });
  if (reset.exitCode !== 0) throw classifyGitFailure(reset);
  await git(['clean', '-fdx'], { cwd: dir, timeoutMs: 60_000, trackId });
  return headSha(dir);
}

/**
 * Writes the exact committed tree (no .git, no untracked files) of the cache
 * clone into `dest` using `git checkout-index` (clone is at `sha` after fetch).
 */
export async function exportCheckout(repoId: string, sha: string, dest: string, trackId?: string): Promise<void> {
  const dir = repoCacheDir(repoId);
  const head = await headSha(dir);
  if (head !== sha) {
    throw new GitServiceError('CLONE_FAILED', 'Repository cache moved to a different commit during the run; aborting.', 409);
  }
  fs.mkdirSync(dest, { recursive: true });
  const res = await git(['checkout-index', '-a', '-f', `--prefix=${dest}${path.sep}`], {
    cwd: dir,
    timeoutMs: 120_000,
    trackId: trackId || `repo-${repoId}`,
  });
  if (res.exitCode !== 0) throw classifyGitFailure(res);
}

export function removeRepoCache(repoId: string): void {
  const dir = repoCacheDir(repoId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
