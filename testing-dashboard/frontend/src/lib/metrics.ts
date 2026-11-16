import type { ExternalRepo, NormalizedTestCase, NormalizedTestRun, NormalizedTestSuite, RegisteredApp, RunSummary, TestLayer } from '../types';

/**
 * Pure helpers that derive dashboard numbers from the persisted run history.
 * Nothing here invents data: every value is computed from `NormalizedTestRun`s
 * returned by the backend, and returns null / empty when there is no basis.
 */

export const LAYERS: TestLayer[] = ['unit', 'integration', 'e2e'];

export const LAYER_LABEL: Record<TestLayer, string> = {
  unit: 'Unit Testing',
  integration: 'Integration Testing',
  e2e: 'E2E Testing',
};

export const LAYER_SHORT: Record<TestLayer, string> = {
  unit: 'Unit',
  integration: 'Integration',
  e2e: 'E2E',
};

export interface Counts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Tests whose execution errored (not assertion failures). */
  errors: number;
}

/** failed + timed out + interrupted: assertion-level failures. Errors are counted separately. */
export function failedLike(s: { failed: number; timedOut?: number; interrupted?: number }): number {
  return s.failed + (s.timedOut ?? 0) + (s.interrupted ?? 0);
}

/** Everything that is not a pass, a skip or an in-flight test: failed + errors. */
export function notPassing(s: { failed: number; errors?: number; timedOut?: number; interrupted?: number }): number {
  return failedLike(s) + (s.errors ?? 0);
}

export function toCounts(s: { total: number; passed: number; failed: number; skipped: number; errors?: number; timedOut?: number; interrupted?: number }): Counts {
  return { total: s.total, passed: s.passed, failed: failedLike(s), skipped: s.skipped, errors: s.errors ?? 0 };
}

/** The layer a test belongs to: its own layer, else the layer of the suite that holds it (runs recorded before per-test layers). */
export function caseLayer(c: NormalizedTestCase, suite: NormalizedTestSuite): TestLayer {
  return c.layer ?? suite.layer;
}

/** Per-layer totals of a run, taken from each test's own layer. Null when the run executed no test in that layer. */
export function layerBreakdown(run: NormalizedTestRun): Record<TestLayer, Counts | null> {
  const out: Record<TestLayer, Counts | null> = { unit: null, integration: null, e2e: null };
  for (const suite of run.suites) {
    for (const tc of suite.cases) {
      const layer = caseLayer(tc, suite);
      const c = (out[layer] ||= { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 });
      c.total += 1;
      if (tc.status === 'passed') c.passed += 1;
      else if (tc.status === 'skipped') c.skipped += 1;
      else if (tc.status === 'error') c.errors += 1;
      else c.failed += 1; // failed / timedOut / interrupted
    }
  }
  return out;
}

export function summaryTotals(summary: RunSummary): Counts {
  return toCounts(summary);
}

export interface Bucket {
  key: string;
  label: string;
  title: string;
  passed: number;
  failed: number;
  runs: number;
}

export function byNewest(runs: NormalizedTestRun[]): NormalizedTestRun[] {
  return [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function isActive(run: NormalizedTestRun | null | undefined): boolean {
  return run?.status === 'running' || run?.status === 'queued';
}

/** A run that finished and actually executed tests. */
export function hasResults(run: NormalizedTestRun): boolean {
  return !isActive(run) && run.summary.total > 0;
}

/**
 * Counts for one layer inside a run. A layer-scoped run reports its own summary;
 * a run-all run is split using the per-suite test cases.
 */
export function layerCounts(run: NormalizedTestRun, layer: TestLayer): Counts | null {
  if (isActive(run)) return null;
  // Always derived from each test's own layer, never from the run's declared scope.
  const c = layerBreakdown(run)[layer];
  if (c) return c;
  // Runs without parsed cases (local runs record their summary only): trust a layer-scoped summary.
  if (run.layer === layer && run.summary.total > 0 && run.suites.every((x) => x.cases.length === 0)) return toCounts(run.summary);
  return null;
}

export function passRate(c: Pick<Counts, 'total' | 'passed'> | null | undefined): number | null {
  if (!c || c.total <= 0) return null;
  return Math.round((c.passed / c.total) * 100);
}

export interface LayerPoint {
  runId: string;
  counts: Counts;
  rate: number;
}

/**
 * Chronological (oldest -> newest) points for one layer. Single-suite runs are
 * skipped so every point covers the whole layer and the trend compares like with like.
 */
export function layerSeries(runs: NormalizedTestRun[], layer: TestLayer, limit = 12): LayerPoint[] {
  const points: LayerPoint[] = [];
  for (const run of byNewest(runs)) {
    if (run.suiteId) continue;
    const counts = layerCounts(run, layer);
    if (!counts) continue;
    points.push({ runId: run.runId, counts, rate: passRate(counts) ?? 0 });
    if (points.length >= limit) break;
  }
  return points.reverse();
}

export function shortRunId(runId: string): string {
  const parts = runId.split('_');
  return `#${parts[parts.length - 1] || runId}`;
}

export function shortAppName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim() || name;
}

export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatShortDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${date}, ${formatTime(iso)}`;
}

/** Human label for what a run executed. */
export function runScopeLabel(run: NormalizedTestRun, apps: RegisteredApp[]): string {
  if (run.kind === 'external') {
    const layers = Object.entries(layerBreakdown(run)).filter(([, c]) => c).map(([l]) => LAYER_SHORT[l as TestLayer]);
    const what = layers.length > 1 ? 'All layers' : layers.length === 1 ? `${layers[0]} tests` : 'Test run';
    return `${what}${run.repo?.branch ? ` · ${run.repo.branch}` : ''}`;
  }
  if (run.suiteId) {
    const suite = apps.flatMap((a) => a.suites).find((s) => s.id === run.suiteId);
    return suite?.name ?? run.suiteId;
  }
  if (run.layer === 'all') return 'All layers';
  return LAYER_LABEL[run.layer];
}

export function repoLabel(run: NormalizedTestRun, apps: RegisteredApp[]): string {
  if (run.repo) return run.repo.name;
  const app = apps.find((a) => a.id === run.appId);
  return app ? shortAppName(app.name) : run.appId;
}

/** One bucket per calendar day for the last `days` days (oldest -> today). */
export function dayBuckets(runs: NormalizedTestRun[], days = 7, now = new Date()): Bucket[] {
  const buckets: Bucket[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
    let passed = 0;
    let failed = 0;
    let count = 0;
    for (const run of runs) {
      if (!hasResults(run)) continue;
      const t = Date.parse(run.startedAt);
      if (t >= start.getTime() && t < end.getTime()) {
        passed += run.summary.passed;
        failed += notPassing(run.summary);
        count += 1;
      }
    }
    buckets.push({
      key: start.toISOString(),
      label: start.toLocaleDateString('en-US', { weekday: 'short' }),
      title: start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
      passed,
      failed,
      runs: count,
    });
  }
  return buckets;
}

/** One bucket per finished run for the latest `count` runs (oldest -> newest). */
export function runBuckets(runs: NormalizedTestRun[], count = 12): Bucket[] {
  return byNewest(runs)
    .filter(hasResults)
    .slice(0, count)
    .reverse()
    .map((run) => ({
      key: run.runId,
      label: formatTime(run.startedAt),
      title: `${shortRunId(run.runId)} · ${run.suiteId ?? run.layer} · ${formatShortDateTime(run.startedAt)}`,
      passed: run.summary.passed,
      failed: notPassing(run.summary),
      runs: 1,
    }));
}

export function runsBetween(runs: NormalizedTestRun[], fromMs: number, toMs: number): number {
  return runs.filter((r) => {
    const t = Date.parse(r.startedAt);
    return t >= fromMs && t < toMs;
  }).length;
}

export function averageDuration(runs: NormalizedTestRun[]): { ms: number; samples: number } | null {
  const finished = runs.filter((r) => !isActive(r) && typeof r.durationMs === 'number');
  if (finished.length === 0) return null;
  const sum = finished.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);
  return { ms: Math.round(sum / finished.length), samples: finished.length };
}

export interface SuiteResult {
  runId: string;
  startedAt: string;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
}

/** Latest recorded result for a single suite, matched on its target file name. */
export function latestSuiteResult(
  runs: NormalizedTestRun[],
  suiteId: string,
  targetFile: string
): SuiteResult | null {
  for (const run of byNewest(runs)) {
    if (isActive(run)) continue;
    const match = run.suites.find((s) => s.name === targetFile && s.cases.length > 0);
    if (!match) continue;
    // Only trust runs that actually targeted this suite (directly or via its layer/all).
    if (run.suiteId && run.suiteId !== suiteId) continue;
    const passed = match.cases.filter((c) => c.status === 'passed').length;
    const failed = match.cases.filter((c) => c.status === 'failed' || c.status === 'error').length;
    return {
      runId: run.runId,
      startedAt: run.startedAt,
      passed,
      failed,
      total: match.cases.length,
      durationMs: match.durationMs,
    };
  }
  return null;
}

/** Runs belonging to one project (local app id or external repository id). */
export function runsForApp(runs: NormalizedTestRun[], appId: string | null | undefined): NormalizedTestRun[] {
  if (!appId) return [];
  return runs.filter((r) => r.appId === appId);
}

export interface AppKpis {
  totalRuns: number;
  finishedRuns: number;
  passedRuns: number;
  failedRuns: number;
  /** Test-level pass rate across runs that executed tests; null without a basis. */
  passRate: number | null;
  avgDurationMs: number | null;
  passedTests: number;
  failedTests: number;
  errorTests: number;
  skippedTests: number;
}

/** KPI figures derived purely from the given runs (pass them already filtered by project). */
export function appKpis(runs: NormalizedTestRun[]): AppKpis {
  const finished = runs.filter((r) => !isActive(r));
  const withResults = finished.filter((r) => r.summary.total > 0);
  const passedTests = withResults.reduce((a, r) => a + r.summary.passed, 0);
  const totalTests = withResults.reduce((a, r) => a + r.summary.total, 0);
  const skippedTests = withResults.reduce((a, r) => a + r.summary.skipped, 0);
  const timed = finished.filter((r) => typeof r.durationMs === 'number');
  return {
    totalRuns: runs.length,
    finishedRuns: finished.length,
    passedRuns: finished.filter((r) => r.status === 'passed').length,
    failedRuns: finished.filter((r) => r.status === 'failed' || r.status === 'error').length,
    passRate: totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : null,
    avgDurationMs: timed.length ? Math.round(timed.reduce((a, r) => a + (r.durationMs ?? 0), 0) / timed.length) : null,
    passedTests,
    failedTests: withResults.reduce((a, r) => a + failedLike(r.summary), 0),
    errorTests: withResults.reduce((a, r) => a + (r.summary.errors ?? 0), 0),
    skippedTests,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Static estimate recorded by detection (regex scan). Labelled as an estimate wherever it is shown. */
export function staticEstimate(repo: ExternalRepo | undefined): number | null {
  const d = repo?.detection;
  return d ? d.staticDeclarationCount ?? d.testCount ?? null : null;
}

/** Runtime discovery is only trustworthy for the commit it was made on. */
export function currentDiscovery(repo: ExternalRepo | undefined) {
  const disc = repo?.discovery;
  if (!disc) return null;
  return { ...disc, stale: !!repo?.commitSha && disc.commitSha !== repo.commitSha };
}

export interface RepoLayerInfo {
  /** The repository has (or is expected to have) tests in this layer. */
  applicable: boolean;
  /** Can this layer be run on its own (TEST_LAYER / test:<layer> script)? */
  canRunAlone: boolean;
  /** What the most recent run actually executed in this layer. */
  executed: Counts | null;
  /** Runtime discovery (e.g. Playwright --list) for this layer; null when the layer was not discovered. */
  discovered: number | null;
  discoveredStale: boolean;
}

/** Everything the dashboard may say about one layer of an external repository, split by how trustworthy each number is. */
export function repoLayerInfo(repo: ExternalRepo | undefined, layer: TestLayer): RepoLayerInfo {
  const det = repo?.detection;
  const last = repo?.lastExecution?.byLayer?.[layer];
  const disc = currentDiscovery(repo);
  const discovered = disc?.byLayer?.[layer];
  const detLayers = det?.layers ?? [];
  return {
    applicable: detLayers.includes(layer) || !!last || discovered !== undefined,
    canRunAlone:
      !!det?.supportsLayerSelection ||
      (detLayers.length === 1 && detLayers[0] === layer) ||
      (!!disc && !disc.stale && !!disc.details?.[layer]?.runnable),
    executed: last ? toCounts(last) : null,
    discovered: discovered ?? null,
    discoveredStale: !!disc?.stale,
  };
}
