import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * Short, private temporary directory for every spawned test process.
 *
 * WHY THIS EXISTS: tools such as `tsx` create a Unix-domain socket under
 * `os.tmpdir()` (`<tmp>/tsx-<uid>/<pid>.pipe`). `bind(2)` rejects socket paths
 * longer than `sun_path` (104 bytes on macOS/BSD, 108 on Linux) with EINVAL. The
 * platform used to point TMPDIR into the per-run workspace
 * (`<dashboard>/.platform/workspaces/<runId>/tmp`), which easily exceeds that
 * limit, so `tsx` crashed with `listen EINVAL` before any test started.
 *
 * The temporary directory is therefore NOT placed inside the workspace. It is a
 * freshly created 0700 directory directly below a short base (the OS temp dir
 * when it is short enough, else /tmp) and is removed when the run ends.
 */

export const RUN_TMP_PREFIX = 'tp-';
export const RUN_TMP_MARKER = '.platform-run-tmp.json';

/** Usable characters of a Unix socket path (sun_path minus the terminating NUL). Infinity where named pipes are used. */
export function socketPathLimit(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return Number.POSITIVE_INFINITY;
  if (platform === 'linux' || platform === 'android') return 107;
  return 103; // darwin, *BSD
}

/** Longest `/tsx-<uid>/<pid>.pipe` style suffix (32-bit uid, 10-digit pid) plus a safety margin for similar tools. */
export const SOCKET_SUFFIX_RESERVE = 40;

/** Length of the directory we create below the base: `/tp-XXXXXX`. */
const RUN_DIR_LENGTH = 1 + RUN_TMP_PREFIX.length + 6;

/** Highest base-directory length that still leaves room for `<base>/tp-XXXXXX` + a socket file name. */
export function maxBaseLength(platform: NodeJS.Platform = process.platform): number {
  return socketPathLimit(platform) - SOCKET_SUFFIX_RESERVE - RUN_DIR_LENGTH;
}

function usableDir(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    const real = fs.realpathSync(dir); // /var -> /private/var on macOS: measure what tools will actually see
    const st = fs.statSync(real);
    if (!st.isDirectory()) return null;
    fs.accessSync(real, fs.constants.W_OK | fs.constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/** Ordered candidate base directories (first one that is writable and short enough wins). */
export function candidateBases(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const list: Array<string | undefined> = [env.PLATFORM_TMP_BASE, os.tmpdir()];
  if (platform !== 'win32') list.push('/tmp', '/var/tmp');
  return list.filter((c): c is string => !!c);
}

export function pickTmpBase(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const limit = maxBaseLength(platform);
  const tried: string[] = [];
  for (const candidate of candidateBases(env, platform)) {
    const real = usableDir(candidate);
    if (!real) {
      tried.push(`${candidate} (not writable)`);
      continue;
    }
    if (real.length <= limit) return real;
    tried.push(`${real} (${real.length} chars > ${limit})`);
  }
  throw new Error(
    `No writable temporary directory short enough for Unix-domain sockets was found (limit ${limit} characters). Tried: ${tried.join('; ') || 'none'}. Set PLATFORM_TMP_BASE to a short writable directory such as /tmp.`
  );
}

export interface RunTmpInfo {
  dir: string;
  base: string;
  /** Characters left for a socket file name below `dir` before bind(2) would fail (Infinity on Windows). */
  socketHeadroom: number;
}

/** Creates a private (0700) temporary directory for one run and verifies it can host a socket path. */
export function createRunTmpDir(runId: string, opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): RunTmpInfo {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const base = pickTmpBase(env, platform);
  const dir = fs.mkdtempSync(path.join(base, RUN_TMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    path.join(dir, RUN_TMP_MARKER),
    JSON.stringify({ runId, pid: process.pid, createdAt: new Date().toISOString() }),
    { encoding: 'utf8', mode: 0o600 }
  );
  const headroom = socketPathLimit(platform) - dir.length;
  if (headroom < SOCKET_SUFFIX_RESERVE) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Temporary directory ${dir} is too long for Unix-domain sockets (${dir.length} characters, limit ${socketPathLimit(platform)}).`);
  }
  return { dir, base, socketHeadroom: headroom };
}

function isPlatformRunTmp(dir: string): boolean {
  try {
    if (!path.basename(dir).startsWith(RUN_TMP_PREFIX)) return false;
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    const marker = fs.lstatSync(path.join(dir, RUN_TMP_MARKER));
    return marker.isFile() && !marker.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes a directory previously returned by createRunTmpDir. Refuses anything that is not
 * a platform-created run directory (prefix + marker file + owned by this user + not a symlink),
 * so a bad path can never delete unrelated data.
 */
export function removeRunTmpDir(dir: string): { removed: boolean; reason?: string } {
  if (!fs.existsSync(dir)) return { removed: true };
  if (!isPlatformRunTmp(dir)) return { removed: false, reason: `refusing to delete ${dir}: not a platform-created run temp directory` };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return fs.existsSync(dir) ? { removed: false, reason: `${dir} still exists after removal` } : { removed: true };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Startup housekeeping: deletes run temp directories left behind by a backend that was killed
 * without cleanup. Directories whose owning backend process is still alive are kept.
 */
export function sweepStaleRunTmpDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): number {
  let removed = 0;
  const seen = new Set<string>();
  for (const candidate of candidateBases(env, platform)) {
    const base = usableDir(candidate);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base).filter((n) => n.startsWith(RUN_TMP_PREFIX));
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(base, name);
      if (!isPlatformRunTmp(dir)) continue;
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(dir, RUN_TMP_MARKER), 'utf8')) as { pid?: number };
        if (typeof marker.pid === 'number' && pidAlive(marker.pid)) continue; // includes this process: its runs may be active
      } catch {
        // unreadable marker: treat as stale
      }
      if (removeRunTmpDir(dir).removed) removed += 1;
    }
  }
  return removed;
}

/**
 * Proves the directory can host a Unix-domain socket by binding one. Catches EINVAL (path too long),
 * ENAMETOOLONG, EACCES, or a noexec/odd filesystem up front, with the real error, instead of letting a
 * runner such as tsx crash after the pipeline has started. No-op on Windows (named pipes).
 */
export function probeSocketSupport(dir: string, platform: NodeJS.Platform = process.platform): Promise<{ ok: boolean; error?: string }> {
  if (platform === 'win32') return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    const sock = path.join(dir, `probe-${process.pid}.sock`);
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      fs.rmSync(sock, { force: true });
      resolve({ ok: false, error: `${err.code ?? 'ERROR'}: ${err.message} (socket path ${sock.length} characters)` });
    });
    server.listen(sock, () => {
      server.close(() => {
        fs.rmSync(sock, { force: true });
        resolve({ ok: true });
      });
    });
  });
}
