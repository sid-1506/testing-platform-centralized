import fs from 'fs';
import path from 'path';
import { LogStream, NormalizedTestRun } from '../types';
import { RUNS_DIR } from '../config';

export const RESERVED_RUN_FILES = new Set([
  'result.json',
  'run.log',
  'stdout.log',
  'stderr.log',
  'stream.jsonl',
]);

export interface LogEntry {
  stream: LogStream;
  text: string;
}

function ensureRunsDir(): void {
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  }
}

export function isValidRunId(runId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(runId);
}

/** Directory of an existing or new run. Only creates the directory when `create` is true. */
export function getRunDir(runId: string, create = true): string {
  if (!isValidRunId(runId)) {
    throw new Error('Invalid runId');
  }
  const dir = path.join(RUNS_DIR, runId);
  if (create) {
    ensureRunsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function runDirExists(runId: string): boolean {
  if (!isValidRunId(runId)) return false;
  return fs.existsSync(path.join(RUNS_DIR, runId));
}

export function saveRunResult(run: NormalizedTestRun): void {
  const dir = getRunDir(run.runId);
  const target = path.join(dir, 'result.json');
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Appends sanitized output to run.log (combined, human readable), to
 * stdout.log / stderr.log (per stream) and to stream.jsonl (structured replay).
 */
export function appendRunLog(runId: string, text: string, stream: LogStream = 'platform'): string {
  const dir = getRunDir(runId);
  const logPath = path.join(dir, 'run.log');
  fs.appendFileSync(logPath, text, 'utf8');
  if (stream === 'stdout' || stream === 'stderr') {
    fs.appendFileSync(path.join(dir, `${stream}.log`), text, 'utf8');
  }
  fs.appendFileSync(path.join(dir, 'stream.jsonl'), JSON.stringify({ s: stream, d: text }) + '\n', 'utf8');
  return logPath;
}

export function readRunLog(runId: string): string {
  if (!runDirExists(runId)) return '';
  const logPath = path.join(getRunDir(runId, false), 'run.log');
  if (!fs.existsSync(logPath)) return '';
  return fs.readFileSync(logPath, 'utf8');
}

/** Structured log entries (stream-tagged). Returns null for runs recorded before stream capture existed. */
export function readRunEntries(runId: string): LogEntry[] | null {
  if (!runDirExists(runId)) return null;
  const file = path.join(getRunDir(runId, false), 'stream.jsonl');
  if (!fs.existsSync(file)) return null;
  const entries: LogEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { s: LogStream; d: string };
      entries.push({ stream: parsed.s, text: parsed.d });
    } catch {
      // Skip a torn final line.
    }
  }
  return entries;
}

export function getRunResult(runId: string): NormalizedTestRun | null {
  if (!isValidRunId(runId)) return null;
  const resultPath = path.join(RUNS_DIR, runId, 'result.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as NormalizedTestRun;
  } catch {
    return null;
  }
}

export function listRunResults(): NormalizedTestRun[] {
  ensureRunsDir();
  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true });
  const runs: NormalizedTestRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = getRunResult(entry.name);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Marks runs that were left in running/queued state by a previous backend
 * process as failed so the UI never waits on a run nobody is executing.
 */
export function recoverStaleRuns(): number {
  let recovered = 0;
  for (const run of listRunResults()) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    const finishedAt = new Date().toISOString();
    run.status = 'error';
    run.finishedAt = finishedAt;
    run.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(run.startedAt));
    run.phase = 'done';
    run.errorMessage = 'The backend restarted while this run was in progress; the run was interrupted and marked as failed.';
    try {
      saveRunResult(run);
      appendRunLog(run.runId, `\n[PLATFORM ERROR] ${run.errorMessage}\n`, 'platform');
      recovered += 1;
    } catch {
      // Best effort.
    }
  }
  return recovered;
}
