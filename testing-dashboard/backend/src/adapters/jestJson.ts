import path from 'path';
import { stripAnsi } from '../lib/ansi';
import { NormalizedTestCase, NormalizedTestSuite, RunIssue, TestLayer } from '../types';

/**
 * Parser for the JSON reporter shared by Vitest (`--reporter=json`) and Jest (`--json`). Both write the
 * Jest "aggregated result" shape:
 *   { numTotalTests, testResults: [{ name, status, message, assertionResults: [{ fullName, title, status, duration, failureMessages }] }] }
 */
interface JestAssertion {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
  location?: { line?: number; column?: number } | null;
}
interface JestFileResult {
  name?: string;
  status?: string;
  message?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: JestAssertion[];
}
export interface JestJsonReport {
  numTotalTests?: number;
  testResults?: JestFileResult[];
}

export function isJestStyleReport(raw: unknown): raw is JestJsonReport {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as JestJsonReport;
  return Array.isArray(r.testResults) && r.testResults.every((f) => f && typeof f === 'object' && (f.assertionResults === undefined || Array.isArray(f.assertionResults)));
}

const LAYER_DIR_RE = /(?:^|[\\/._-])(unit|integration|e2e)(?:[\\/._-]|$)/i;

/** Layer of a test file from its path (`tests/unit/a.test.ts`, `api.integration.test.ts`); `fallback` when it says nothing. */
export function inferLayerFromPath(file: string | undefined, fallback: TestLayer): TestLayer {
  const m = (file || '').match(LAYER_DIR_RE);
  return m ? (m[1].toLowerCase() as TestLayer) : fallback;
}

/** Assertion failures are FAILED; anything else that broke a test (timeouts, network, crashes, setup) is ERROR. */
export function classifyFailureMessage(message: string): 'failed' | 'error' {
  const text = stripAnsi(message);
  if (/\bAssertionError\b|\bAssertionError\s*\[|expect\([^)\n]*\)(?:\.\w+)*\.(?:to[A-Z]\w*|resolves|rejects|not)|\bExpected\b[\s\S]{0,200}\bReceived\b/.test(text)) return 'failed';
  return 'error';
}

export interface JestParseOptions {
  /** Absolute root used to make file names repository-relative. */
  rootDir?: string;
  defaultLayer: TestLayer;
  /** Forces every test to this layer (an explicitly selected layer or a layer-scoped run). */
  forceLayer?: TestLayer;
  sanitize?: (s: string) => string;
}

export function parseJestStyleJson(raw: JestJsonReport, opts: JestParseOptions): { suites: NormalizedTestSuite[]; issues: RunIssue[] } {
  const sanitize = opts.sanitize || ((s: string) => s);
  const clean = (s: string) => sanitize(stripAnsi(s));
  const byLayer = new Map<TestLayer, NormalizedTestSuite>();
  const issues: RunIssue[] = [];
  const suiteFor = (layer: TestLayer): NormalizedTestSuite => {
    let s = byLayer.get(layer);
    if (!s) {
      s = { name: layer, layer, durationMs: 0, cases: [] };
      byLayer.set(layer, s);
    }
    return s;
  };

  for (const f of raw.testResults || []) {
    const abs = f.name || '';
    const file = opts.rootDir && abs.startsWith(opts.rootDir) ? path.relative(opts.rootDir, abs) : abs;
    const layer = opts.forceLayer ?? inferLayerFromPath(file, opts.defaultLayer);
    const suite = suiteFor(layer);
    const assertions = f.assertionResults || [];
    if (assertions.length === 0 && f.status === 'failed') {
      // The file never produced a test: it failed to load/collect.
      issues.push({
        layer,
        kind: 'module',
        name: `[module] ${file}`,
        message: clean(f.message || 'Test file failed to load'),
        file,
        infrastructure: false,
      });
      continue;
    }
    if (f.endTime && f.startTime) suite.durationMs += Math.max(0, Math.round(f.endTime - f.startTime));
    for (const a of assertions) {
      const messages = (a.failureMessages || []).filter(Boolean);
      let status: NormalizedTestCase['status'];
      if (a.status === 'passed') status = 'passed';
      else if (a.status === 'failed') status = classifyFailureMessage(messages.join('\n'));
      else status = 'skipped'; // pending / todo / skipped / disabled
      const fullName = a.fullName || [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' ') || 'Unnamed test';
      suite.cases.push({
        name: clean(a.title || fullName),
        fullTitle: clean([file, ...(a.ancestorTitles || []), a.title].filter(Boolean).join(' › ')),
        layer,
        status,
        durationMs: Math.max(0, Math.round(Number(a.duration) || 0)),
        file,
        line: a.location?.line ?? undefined,
        column: a.location?.column ?? undefined,
        originalStatus: a.status,
        ...(status === 'failed' || status === 'error'
          ? { error: { message: clean((messages[0] || 'Test failed').split('\n')[0]), stack: messages.length ? clean(messages.join('\n---\n')) : undefined } }
          : {}),
      });
    }
  }
  return { suites: Array.from(byLayer.values()).filter((s) => s.cases.length > 0), issues };
}
