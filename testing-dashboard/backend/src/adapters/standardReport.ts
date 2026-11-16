import { stripAnsi } from '../lib/ansi';
import { NormalizedTestCase, NormalizedTestSuite, RunIssue, TestLayer } from '../types';

/**
 * "Standard layer report": one `<reportDir>/<layer>/results.json` per test layer
 * (unit | integration | e2e), `schemaVersion: 1`, upper-case test statuses and an
 * explicit `runnerError` that is set ONLY when the runner (not a test) hit an
 * infrastructure problem. Repositories that wrap vitest/Playwright in their own
 * layer runner publish this format. It is detected structurally, never by repository name.
 */
export const STANDARD_LAYERS: readonly TestLayer[] = ['unit', 'integration', 'e2e'];

export interface StandardTest {
  name: string;
  file: string | null;
  status: 'PASSED' | 'FAILED' | 'SKIPPED' | 'ERROR';
  startTime?: string;
  endTime?: string;
  durationMs: number;
  errorMessage: string | null;
  stackTrace: string | null;
}

export interface StandardReport {
  schemaVersion: 1;
  runId: string;
  projectId?: string;
  layer: TestLayer;
  status: 'PASSED' | 'FAILED' | 'ERROR';
  durationMs: number;
  summary: { total: number; passed: number; failed: number; skipped: number; errors: number };
  runnerError: { kind: string; message: string } | null;
  tests: StandardTest[];
}

const TEST_STATUSES = new Set(['PASSED', 'FAILED', 'SKIPPED', 'ERROR']);

export function isStandardReport(raw: unknown): raw is StandardReport {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<StandardReport>;
  return (
    r.schemaVersion === 1 &&
    typeof r.layer === 'string' &&
    (STANDARD_LAYERS as readonly string[]).includes(r.layer) &&
    Array.isArray(r.tests) &&
    r.tests.every((t) => t && typeof t.name === 'string' && TEST_STATUSES.has(t.status)) &&
    !!r.summary &&
    typeof r.summary === 'object'
  );
}

export interface StandardParseResult {
  layer: TestLayer;
  suite: NormalizedTestSuite;
  /** Set when the repository's runner reported an infrastructure problem for this layer. */
  runnerError: { kind: string; message: string } | null;
  reportStatus: StandardReport['status'];
  /** Counts as written by the repository (for cross-checking against what was parsed). */
  declared: StandardReport['summary'];
  /** Placeholder entries ([global]/[module]/[unhandled]/[runner]) that were not counted as tests. */
  ignoredSynthetic: number;
  /** The placeholder entries, kept verbatim (never counted as passed/failed tests). */
  issues: RunIssue[];
  /**
   * True when this layer produced no real test result and only placeholders: the runner/environment failed before
   * valid results existed. Distinct from tests that failed.
   */
  layerInfraFailure: boolean;
}

const PLACEHOLDER_RE = /^\[(global|module|unhandled|runner)\](?:\s|$)/;

export function placeholderKind(name: string): RunIssue['kind'] | null {
  const m = name.match(PLACEHOLDER_RE);
  return m ? (m[1] as RunIssue['kind']) : null;
}

/**
 * Normalises one layer report.
 *
 *  PASSED -> passed | FAILED -> failed (assertion) | SKIPPED -> skipped | ERROR -> error (execution broke around the test).
 *
 * Reporter placeholders are NOT tests. `[global]` (Playwright setup / worker / run-level error), `[module]` (test file
 * failed to load), `[unhandled]` (unhandled error during the run) and `[runner]` (layer runner problem) become
 * `issues` with the original message and stack. They never inflate failed/passed/total. If a layer has placeholders but
 * not a single real test result, the layer is flagged as an infrastructure failure.
 */
export function parseStandardReport(report: StandardReport, sanitize: (s: string) => string = (s) => s): StandardParseResult {
  const cases: NormalizedTestCase[] = [];
  const issues: RunIssue[] = [];
  let ignoredSynthetic = 0;
  const clean = (t: string) => sanitize(stripAnsi(t));
  for (const t of report.tests) {
    const kind = placeholderKind(t.name);
    if (kind) {
      ignoredSynthetic += 1;
      issues.push({
        layer: report.layer,
        kind,
        name: clean(t.name),
        message: clean(t.errorMessage || `${t.status} (no message recorded)`),
        stack: t.stackTrace ? clean(t.stackTrace) : undefined,
        file: t.file ?? undefined,
        infrastructure: kind === 'runner',
      });
      continue;
    }
    const status: NormalizedTestCase['status'] =
      t.status === 'PASSED' ? 'passed' : t.status === 'SKIPPED' ? 'skipped' : t.status === 'FAILED' ? 'failed' : 'error';
    const tc: NormalizedTestCase = {
      name: clean(t.name.split(' › ').slice(-1)[0] || t.name),
      fullTitle: clean(t.name),
      layer: report.layer,
      status,
      durationMs: Math.max(0, Math.round(Number(t.durationMs) || 0)),
      file: t.file ? clean(t.file) : undefined,
      originalStatus: t.status,
    };
    if (status === 'failed' || status === 'error') {
      const message = clean(t.errorMessage || `${t.status} (no message recorded)`);
      tc.error = { message, stack: t.stackTrace ? clean(t.stackTrace) : undefined };
    }
    cases.push(tc);
  }
  const layerInfraFailure = cases.length === 0 && issues.length > 0 && !report.runnerError;
  if (layerInfraFailure) for (const i of issues) i.infrastructure = true;
  return {
    layer: report.layer,
    suite: {
      name: report.layer,
      layer: report.layer,
      durationMs: Math.max(0, Math.round(Number(report.durationMs) || 0)),
      cases,
    },
    runnerError: report.runnerError ?? null,
    reportStatus: report.status,
    declared: report.summary,
    ignoredSynthetic,
    issues,
    layerInfraFailure,
  };
}
