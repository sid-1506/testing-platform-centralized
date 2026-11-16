import { NormalizedTestRun } from '../types';

/** In-memory state shared by the local and external executors. */
const activeRuns = new Map<string, NormalizedTestRun>();
const cancelledRuns = new Set<string>();

export function trackActiveRun(run: NormalizedTestRun): void {
  activeRuns.set(run.runId, run);
}

export function untrackActiveRun(runId: string): void {
  activeRuns.delete(runId);
  cancelledRuns.delete(runId);
}

export function getActiveRun(runId: string): NormalizedTestRun | undefined {
  return activeRuns.get(runId);
}

export function listActiveRuns(): NormalizedTestRun[] {
  return Array.from(activeRuns.values());
}

export function markCancelled(runId: string): void {
  cancelledRuns.add(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}
