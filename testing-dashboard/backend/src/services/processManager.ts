import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import { forgetPid, recordPid } from './pidRegistry';

interface TrackedProcess {
  pid: number;
  label: string;
  child: ChildProcess;
}

const trackedByRun = new Map<string, TrackedProcess[]>();

/**
 * Checks whether a port is currently in use on localhost (IPv4 or IPv6).
 * Returns true if occupied, false if free.
 */
function isPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, 'localhost');
  });
}

export async function findOccupiedPorts(ports: number[]): Promise<number[]> {
  const checks = await Promise.all(
    ports.map(async (p) => ((await isPortOccupied(p)) ? p : null))
  );
  return checks.filter((p): p is number => p !== null);
}

export async function waitForHealthUrls(
  urls: string[],
  timeoutMs: number,
  isCancelled: () => boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled()) {
      throw new Error('Run cancelled while waiting for application health endpoints.');
    }
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1500);
          const res = await fetch(url, { signal: ctrl.signal });
          clearTimeout(t);
          return res.status === 200;
        } catch {
          return false;
        }
      })
    );
    if (results.every(Boolean)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for health endpoints: ${urls.join(', ')}`);
}

export type OutputStream = 'stdout' | 'stderr';
export type OutputHandler = (chunk: string, stream: OutputStream) => void;

/**
 * Spawns a process (never through a shell) in its own process group and tracks it
 * for the run so it can be cancelled/cleaned up. stdout and stderr are reported
 * separately; legacy callers may ignore the `stream` argument.
 */
export function spawnTrackedProcess(
  runId: string,
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  onOutput: OutputHandler
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.pid) {
    const list = trackedByRun.get(runId) || [];
    list.push({ pid: child.pid, label, child });
    trackedByRun.set(runId, list);
    recordPid(child.pid, label, runId);
    const pid = child.pid;
    child.once('close', () => {
      // Leader exited. Keep the record only if group members might remain (long-lived app processes are cleaned by cleanupRunProcesses).
      forgetPid(pid);
    });
  }

  child.stdout?.on('data', (d) => onOutput(d.toString(), 'stdout'));
  child.stderr?.on('data', (d) => onOutput(d.toString(), 'stderr'));

  return child;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited
    }
  }
}

/**
 * Runs a command to completion with a hard timeout. On timeout the whole
 * process group is terminated (SIGTERM, then SIGKILL) so browsers spawned by
 * the test runner do not outlive it. Resolves once stdio has fully drained.
 */
export function runTrackedCommand(opts: {
  runId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  onOutput: OutputHandler;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawnTrackedProcess(opts.runId, opts.label, opts.command, opts.args, opts.cwd, opts.env, opts.onOutput);
    } catch (err) {
      reject(err);
      return;
    }

    const pid = child.pid;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) {
        killGroup(pid, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), 3000);
      }
    }, opts.timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      untrackProcess(opts.runId, pid);
      // Make sure no grandchild (e.g. a browser) survives the main process.
      if (pid) killGroup(pid, 'SIGKILL');
      resolve({ exitCode: code, signal, timedOut });
    });
  });
}

/** Stops tracking a process that exited (prevents killing a recycled PID later). */
function untrackProcess(runId: string, pid: number | undefined): void {
  if (!pid) return;
  const list = trackedByRun.get(runId);
  if (!list) return;
  const next = list.filter((p) => p.pid !== pid);
  if (next.length === 0) trackedByRun.delete(runId);
  else trackedByRun.set(runId, next);
}

/**
 * Terminates ONLY processes spawned by the platform for the given runId.
 * Never kills pre-existing or external processes.
 */
export async function cleanupRunProcesses(runId: string): Promise<void> {
  const list = trackedByRun.get(runId) || [];
  trackedByRun.delete(runId);

  for (const proc of list) {
    try {
      // Negative PID targets the detached process group
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try {
        proc.child.kill('SIGTERM');
      } catch {
        // Already exited
      }
    }
  }

  if (list.length > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const proc of list) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Already exited
      }
    }
  }
}

export async function cleanupAllTrackedProcesses(): Promise<void> {
  const runIds = Array.from(trackedByRun.keys());
  for (const id of runIds) {
    await cleanupRunProcesses(id);
  }
}
