import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PLATFORM_DIR } from '../config';

/**
 * Remembers the process groups the platform spawned so that, if the backend is
 * killed without cleanup (kill -9, crash, power loss), the next start can
 * terminate the orphans. A pid is only killed if its start time still matches
 * the recorded one (protects against PID reuse).
 */
const PID_DIR = path.join(PLATFORM_DIR, 'pids');

function startTime(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function recordPid(pid: number, label: string, runId: string): void {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    const started = startTime(pid);
    if (!started) return;
    fs.writeFileSync(path.join(PID_DIR, `${pid}.json`), JSON.stringify({ pid, label, runId, started }), 'utf8');
  } catch {
    // Best effort: never break a run because of bookkeeping.
  }
}

export function forgetPid(pid: number): void {
  try {
    fs.rmSync(path.join(PID_DIR, `${pid}.json`), { force: true });
  } catch {
    // ignore
  }
}

/** Kills process groups left behind by a previous backend process. Returns how many were terminated. */
export function reapOrphanedProcesses(): number {
  if (!fs.existsSync(PID_DIR)) return 0;
  let killed = 0;
  for (const file of fs.readdirSync(PID_DIR)) {
    const full = path.join(PID_DIR, file);
    try {
      const rec = JSON.parse(fs.readFileSync(full, 'utf8')) as { pid: number; started: string; label: string };
      const now = startTime(rec.pid);
      if (now && now === rec.started) {
        try {
          process.kill(-rec.pid, 'SIGKILL');
        } catch {
          process.kill(rec.pid, 'SIGKILL');
        }
        killed += 1;
        console.log(`[TESTING-PLATFORM BACKEND] Terminated orphaned process group ${rec.pid} (${rec.label}) from a previous backend process.`);
      }
    } catch {
      // unreadable or already gone
    }
    fs.rmSync(full, { force: true });
  }
  return killed;
}
