import path from 'path';
import { stripAnsi } from '../lib/ansi';
import { AttachmentKind, LayerSummary, NormalizedTestCase, NormalizedTestSuite, RunSummary, TestAttachment, TestLayer, TestStatus } from '../types';

/* ---------------------------------------------------------------------------
 * Playwright JSON reporter model (only the fields we read)
 * ------------------------------------------------------------------------- */
interface PwError {
  message?: string;
  stack?: string;
  value?: string;
}
interface PwAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}
interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: PwError;
  errors?: PwError[];
  attachments?: PwAttachment[];
}
interface PwTest {
  projectName?: string;
  projectId?: string;
  expectedStatus?: string;
  status?: 'expected' | 'unexpected' | 'flaky' | 'skipped' | string;
  results?: PwResult[];
  annotations?: Array<{ type?: string; description?: string }>;
}
interface PwSpec {
  id?: string;
  title?: string;
  file?: string;
  line?: number;
  column?: number;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PwJsonReport {
  suites?: PwSuite[];
  errors?: PwError[];
}

export interface ParseOptions {
  layer: TestLayer;
  /** Maps an attachment's absolute path to a run-relative served path, or null to drop it. */
  mapAttachment?: (absPath: string) => string | null;
  /** Redaction hook applied to every message/stack. */
  sanitize?: (text: string) => string;
}

export interface ParsedReport {
  suites: NormalizedTestSuite[];
  /** Run-level errors (config/import/global-setup failures) that are not tied to a test. */
  globalErrors: string[];
}

// Matches IDs like TC-ILPDF-001, TEST_12, E2E-AUTH-003 at the start of a title (optionally in [] ), followed by : - – or space.
const TEST_ID_RE = /^\s*\[?([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_]\d+)\]?\s*(?:[:\-–—]\s*|\s+)/;

export function deriveTestId(title: string, specId?: string, annotations?: PwTest['annotations']): { id: string; name: string } {
  const ann = annotations?.find((a) => a.type?.toLowerCase() === 'id' || a.type?.toLowerCase() === 'testid');
  if (ann?.description) return { id: ann.description, name: title };
  const m = title.match(TEST_ID_RE);
  if (m) return { id: m[1], name: title.slice(m[0].length).trim() || title };
  // JUnit-style names carry the describe prefix ("Suite TC-1: title"): look for an `ID:` token anywhere.
  const inner = title.match(/(?:^|[\s›>])([A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*[-_]\d+):\s+/);
  if (inner && inner.index !== undefined) {
    return { id: inner[1], name: title.slice(inner.index + inner[0].length).trim() || title };
  }
  return { id: specId ? specId.slice(0, 10) : '', name: title };
}

function attachmentKind(a: PwAttachment): AttachmentKind {
  const name = (a.name || '').toLowerCase();
  const type = (a.contentType || '').toLowerCase();
  const file = (a.path || '').toLowerCase();
  if (name === 'trace' || file.endsWith('trace.zip')) return 'trace';
  if (type.startsWith('image/') || name === 'screenshot') return 'screenshot';
  if (type.startsWith('video/') || name === 'video') return 'video';
  if (/\.(pdf|csv|xlsx?|docx?|zip|json|txt)$/.test(file) && !file.endsWith('trace.zip')) return 'download';
  return 'other';
}

function finalStatus(test: PwTest, last: PwResult | undefined): { status: TestStatus; flaky: boolean } {
  const raw = last?.status;
  if (test.status === 'skipped' || raw === 'skipped') return { status: 'skipped', flaky: false };
  if (test.status === 'flaky') return { status: 'passed', flaky: true };
  if (test.status === 'expected') return { status: 'passed', flaky: false };
  // 'unexpected' or unknown: preserve the exact failure flavour.
  if (raw === 'timedOut') return { status: 'timedOut', flaky: false };
  if (raw === 'interrupted') return { status: 'interrupted', flaky: false };
  if (raw === 'passed') return { status: 'passed', flaky: false };
  return { status: 'failed', flaky: false };
}

function collect(
  suite: PwSuite,
  titles: string[],
  fileOf: string | undefined,
  opts: ParseOptions,
  out: Map<string, NormalizedTestCase[]>
): void {
  const here = suite.title && suite.title !== fileOf ? [...titles, suite.title] : titles;
  const file = suite.file || fileOf;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const last = results[results.length - 1];
      const { status, flaky } = finalStatus(test, last);
      const { id, name } = deriveTestId(spec.title || 'Unnamed test', spec.id, test.annotations);
      const sanitize = opts.sanitize || ((s: string) => s);

      // Prefer the error of the last failing attempt.
      const failing = [...results].reverse().find((r) => r.status && r.status !== 'passed' && r.status !== 'skipped');
      const errSource = status === 'passed' || status === 'skipped' ? undefined : failing?.error || failing?.errors?.[0] || last?.error;
      const flakyErr = flaky ? results.find((r) => r.status && r.status !== 'passed')?.error : undefined;
      const err = errSource || flakyErr;

      const attachments: TestAttachment[] = [];
      results.forEach((r, attempt) => {
        for (const a of r.attachments || []) {
          if (!a.path) continue;
          const mapped = opts.mapAttachment ? opts.mapAttachment(a.path) : null;
          if (!mapped) continue;
          attachments.push({
            name: a.name || path.basename(a.path),
            contentType: a.contentType,
            path: mapped,
            kind: attachmentKind(a),
            attempt,
          });
        }
      });

      const projectName = test.projectName || undefined;
      const caseFile = spec.file || file || '';
      const tc: NormalizedTestCase = {
        name: sanitize(name),
        id: id || undefined,
        layer: opts.layer,
        fullTitle: sanitize([...here, spec.title || ''].filter(Boolean).join(' › ')),
        status,
        durationMs: Math.round(results.reduce((acc, r) => acc + (r.duration || 0), 0) || 0),
        file: caseFile || undefined,
        line: spec.line,
        column: spec.column,
        project: projectName,
        retries: Math.max(0, results.length - 1),
        flaky: flaky || undefined,
        ...(results.length > 1
          ? {
              previousAttempts: results
                .slice(0, -1)
                .map((r, attempt) => ({
                  attempt,
                  status: r.status || 'unknown',
                  message: r.error?.message ? sanitize(stripAnsi(r.error.message)).slice(0, 2000) : undefined,
                  durationMs: Math.round(r.duration || 0),
                }))
                .filter((a) => a.status !== 'passed'),
            }
          : {}),
        originalStatus: last?.status || test.status,
        attachments: attachments.length ? attachments : undefined,
        ...(err
          ? {
              error: {
                message: sanitize(stripAnsi(err.message || err.value || 'Test failed')),
                stack: err.stack ? sanitize(stripAnsi(err.stack)) : undefined,
              },
            }
          : {}),
      };
      const key = caseFile || '(unknown file)';
      const list = out.get(key) || [];
      list.push(tc);
      out.set(key, list);
    }
  }
  for (const child of suite.suites || []) collect(child, here, file, opts, out);
}

/** Parses Playwright's JSON reporter output, preserving retries, flaky tests, and non-pass statuses. */
export function parsePlaywrightJson(raw: PwJsonReport, opts: ParseOptions): ParsedReport {
  const byFile = new Map<string, NormalizedTestCase[]>();
  for (const root of raw.suites || []) collect(root, [], root.file, opts, byFile);
  const suites: NormalizedTestSuite[] = [];
  for (const [file, cases] of byFile) {
    suites.push({
      name: file,
      layer: opts.layer,
      durationMs: cases.reduce((a, c) => a + c.durationMs, 0),
      cases,
    });
  }
  const sanitize = opts.sanitize || ((s: string) => s);
  const globalErrors = (raw.errors || []).map((e) => sanitize(stripAnsi(e.message || e.value || 'Unknown error')));
  return { suites, globalErrors };
}

/* ---------------------------------------------------------------------------
 * JUnit XML fallback (dependency-free, tolerant parser)
 * ------------------------------------------------------------------------- */
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

export function parseJUnitXml(xml: string, opts: ParseOptions): ParsedReport {
  const byFile = new Map<string, NormalizedTestCase[]>();
  const sanitize = opts.sanitize || ((s: string) => s);
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(caseRe)) {
    const a = attrs(m[1]);
    const body = m[2] || '';
    const title = a.name || 'Unnamed test';
    const { id, name } = deriveTestId(title);
    let status: TestStatus = 'passed';
    let error: NormalizedTestCase['error'];
    const fail = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    if (fail) {
      // JUnit distinguishes <failure> (assertion) from <error> (execution problem).
      status = fail[1] === 'error' ? 'error' : 'failed';
      const fa = attrs(fail[2]);
      const detail = decodeXml(fail[3] || '').trim();
      const message = stripAnsi(fa.message || detail.split('\n')[0] || 'Test failed');
      error = { message: sanitize(message), stack: detail ? sanitize(stripAnsi(detail)) : undefined };
      if (status === 'failed' && /timeout|timed out/i.test(message)) status = 'timedOut';
    } else if (/<skipped\b/.test(body)) {
      status = 'skipped';
    }
    const file = a.file || a.classname || '(unknown file)';
    const tc: NormalizedTestCase = {
      name,
      id: id || undefined,
      layer: opts.layer,
      fullTitle: title,
      status,
      durationMs: Math.round(Number(a.time || 0) * 1000),
      file: a.file || undefined,
      originalStatus: status,
      ...(error ? { error } : {}),
    };
    const list = byFile.get(file) || [];
    list.push(tc);
    byFile.set(file, list);
  }
  const suites: NormalizedTestSuite[] = [];
  for (const [file, cases] of byFile) {
    suites.push({ name: file, layer: opts.layer, durationMs: cases.reduce((x, c) => x + c.durationMs, 0), cases });
  }
  return { suites, globalErrors: [] };
}

export function emptyLayerSummary(): LayerSummary {
  return { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, timedOut: 0, interrupted: 0, flaky: 0 };
}

function addCase(s: LayerSummary, c: NormalizedTestCase): void {
  s.total += 1;
  if (c.status === 'passed') s.passed += 1;
  else if (c.status === 'failed') s.failed += 1;
  else if (c.status === 'skipped') s.skipped += 1;
  else if (c.status === 'error') s.errors += 1;
  else if (c.status === 'timedOut') s.timedOut = (s.timedOut ?? 0) + 1;
  else if (c.status === 'interrupted') s.interrupted = (s.interrupted ?? 0) + 1;
  if (c.flaky) s.flaky = (s.flaky ?? 0) + 1;
}

/** Makes every case carry its own layer (falls back to the owning suite's layer). Idempotent. */
export function stampLayers(suites: NormalizedTestSuite[]): NormalizedTestSuite[] {
  for (const suite of suites) for (const c of suite.cases) if (!c.layer) c.layer = suite.layer;
  return suites;
}

/** Totals plus a per-layer split, computed from each test case's own layer (never from the run's scope). */
export function summarizeSuites(suites: NormalizedTestSuite[]): RunSummary {
  const total = emptyLayerSummary();
  const byLayer: Partial<Record<TestLayer, LayerSummary>> = {};
  for (const suite of suites) {
    for (const c of suite.cases) {
      const layer = c.layer ?? suite.layer;
      addCase(total, c);
      addCase((byLayer[layer] ||= emptyLayerSummary()), c);
    }
  }
  return { ...total, byLayer };
}
