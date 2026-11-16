import type { NormalizedTestRun } from '../types';

/** Client-side JSON export of the persisted runs currently held in memory. */
export function exportRuns(runs: NormalizedTestRun[], filenamePrefix = 'test-runs'): void {
  const blob = new Blob([JSON.stringify(runs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
