import fs from 'fs';
import path from 'path';
import { RUNS_DIR } from '../config';
import { NormalizedTestRun } from '../types';
import { listRepos } from './repoRegistry';
import { getActiveRun } from './runRegistry';
import { getRunResult, isValidRunId } from './runStore';

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** Keep at most this many finished runs (0 = unlimited). */
export const RETENTION_MAX_RUNS = envInt('PLATFORM_RETENTION_MAX_RUNS', 500);
/** Delete finished runs older than this many days (0 = keep forever). */
export const RETENTION_MAX_AGE_DAYS = envInt('PLATFORM_RETENTION_MAX_AGE_DAYS', 90);

export interface RetentionPlanInput {
  runs: Array<Pick<NormalizedTestRun, 'runId' | 'status' | 'startedAt'>>;
  /** Run ids that must never be removed (active, or referenced as a repository's last run). */
  protectedIds: Set<string>;
  maxRuns: number;
  maxAgeDays: number;
  now?: number;
}

/**
 * Pure decision function: which finished runs to delete. Runs that are queued/running, protected, or unreadable are never
 * candidates, and the newest `maxRuns` finished runs are always kept.
 */
export function planRetention(input: RetentionPlanInput): string[] {
  const now = input.now ?? Date.now();
  const finished = input.runs
    .filter((r) => r.status !== 'running' && r.status !== 'queued' && !input.protectedIds.has(r.runId))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const doomed = new Set<string>();
  if (input.maxRuns > 0) for (const r of finished.slice(input.maxRuns)) doomed.add(r.runId);
  if (input.maxAgeDays > 0) {
    const cutoff = now - input.maxAgeDays * 86_400_000;
    for (const r of finished) {
      const t = Date.parse(r.startedAt);
      if (Number.isFinite(t) && t < cutoff) doomed.add(r.runId);
    }
  }
  return Array.from(doomed);
}

/** Applies the retention policy to `.runs/`. Never throws and never touches an active run. Returns the removed run ids. */
export function pruneRunHistory(): string[] {
  try {
    if (!fs.existsSync(RUNS_DIR)) return [];
    const protectedIds = new Set<string>();
    for (const repo of listRepos()) if (repo.lastRun?.runId) protectedIds.add(repo.lastRun.runId);
    const runs: NormalizedTestRun[] = [];
    for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
      if (getActiveRun(entry.name)) {
        protectedIds.add(entry.name);
        continue;
      }
      const run = getRunResult(entry.name);
      if (run) runs.push(run);
    }
    const doomed = planRetention({ runs, protectedIds, maxRuns: RETENTION_MAX_RUNS, maxAgeDays: RETENTION_MAX_AGE_DAYS });
    const removed: string[] = [];
    for (const id of doomed) {
      if (getActiveRun(id)) continue; // re-check: it may have started meanwhile
      try {
        fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true });
        removed.push(id);
      } catch {
        // leave it for the next pass
      }
    }
    return removed;
  } catch {
    return [];
  }
}
