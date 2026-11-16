import { stripAnsi } from '../lib/ansi';
import { RunEventType } from '../types';

export interface QueueItem {
  file: string;
  line: number;
  title: string;
  project?: string;
  allowedAttempts: number;
}

export interface ProgressEmit {
  (type: RunEventType, payload: { test: { index?: number; title: string; project?: string; durationMs?: number }; message?: string }): void;
}

// "  ✓  1 [chromium] › tests/a.spec.ts:3:3 › Group › title (308ms)"  /  "  ✘  2 tests/a.spec.ts:4:3 › ... (retry #1) (5ms)"  /  "  -  4 ..."
const LINE_RE = /^\s*([✓✔✘✕×±-])\s+(\d+)\s+(.+?)\s*$/;
const DURATION_RE = /\s+\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
const RETRY_RE = /\s+\((retry #\d+|repeat #\d+)\)\s*$/;
const LOCATION_RE = /([^\s›]+?\.[cm]?[jt]sx?):(\d+):\d+/;

function toMs(value: number, unit: string): number {
  return Math.round(unit === 'ms' ? value : unit === 's' ? value * 1000 : value * 60_000);
}

/**
 * Turns Playwright `list`-reporter output (real process stdout) into structured
 * test events. The list reporter prints a line only when a test *finishes*, so
 * "current test" is derived from the repository's own `playwright test --list`
 * ordering and each test's allowed attempts (retries + 1).
 */
export interface AttemptRecord {
  /** Repo-relative file as printed by the list reporter (`tests/e2e/a.spec.ts`). */
  file?: string;
  /** `<file> › <describe> › <title>` — the same shape the standard report uses as a test's full title. */
  fullKey: string;
  outcome: 'passed' | 'failed' | 'skipped';
  isRetry: boolean;
  durationMs?: number;
}

export class PlaywrightProgressTracker {
  private buffer = '';
  /** Called for every finished attempt (including failed attempts that are retried). Used for flaky tracking. */
  public onAttempt?: (a: AttemptRecord) => void;
  private attempts = new Map<string, number>();
  private done = new Set<string>();
  private currentKey: string | null = null;
  public current: string | null = null;

  /** Tests that reached their final outcome so far. */
  get doneCount(): number {
    return this.done.size;
  }
  get totalCount(): number {
    return this.queue.length;
  }

  constructor(private queue: QueueItem[], private emit: ProgressEmit) {}

  start(): void {
    this.announceNext();
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(stripAnsi(line));
    }
  }

  private qkey(i: number): string {
    return `q${i}`;
  }

  /** First not-yet-finished queue entry at this location (stdout paths are repo-relative, list paths testDir-relative). */
  private match(file: string, line: number, project?: string): number {
    return this.queue.findIndex(
      (q, i) =>
        !this.done.has(this.qkey(i)) &&
        q.line === line &&
        (file.endsWith(q.file) || q.file.endsWith(file)) &&
        (!project || !q.project || q.project === project)
    );
  }

  private handleLine(line: string): void {
    const m = line.match(LINE_RE);
    if (!m) return;
    const marker = m[1];
    let rest = m[3];

    let durationMs: number | undefined;
    const d = rest.match(DURATION_RE);
    if (d) {
      durationMs = toMs(Number(d[1]), d[2]);
      rest = rest.replace(DURATION_RE, '');
    }
    const isRetry = RETRY_RE.test(rest);
    rest = rest.replace(RETRY_RE, '');

    const segments = rest.split(' › ');
    const locIdx = segments.findIndex((seg) => LOCATION_RE.test(seg));
    const loc = locIdx >= 0 ? segments[locIdx].match(LOCATION_RE) : null;
    const title = (locIdx >= 0 ? segments.slice(locIdx + 1) : segments).join(' › ') || rest;
    const project = rest.match(/^\[([^\]]+)\]/)?.[1];
    const qi = loc ? this.match(loc[1], Number(loc[2]), project) : -1;
    const key = qi >= 0 ? this.qkey(qi) : rest;
    const testInfo = { index: Number(m[2]), title: title + (isRetry ? ' (retry)' : ''), project, durationMs };

    const attempt = (this.attempts.get(key) || 0) + 1;
    this.attempts.set(key, attempt);
    this.onAttempt?.({
      file: loc?.[1],
      fullKey: [loc?.[1], title].filter(Boolean).join(' › ') || rest,
      outcome: marker === '✓' || marker === '✔' || marker === '±' ? 'passed' : marker === '-' ? 'skipped' : 'failed',
      isRetry,
      durationMs,
    });
    const queued = qi >= 0 ? this.queue[qi] : undefined;

    if (marker === '✓' || marker === '✔') {
      this.emit('test_passed', { test: testInfo, message: isRetry ? 'passed on retry' : undefined });
      this.done.add(key);
    } else if (marker === '±') {
      this.emit('test_passed', { test: testInfo, message: 'flaky: passed after retry' });
      this.done.add(key);
    } else if (marker === '-') {
      this.emit('test_skipped', { test: testInfo });
      this.done.add(key);
    } else {
      this.emit('test_failed', { test: testInfo });
      if (!queued || attempt >= queued.allowedAttempts) this.done.add(key);
    }
    this.announceNext();
  }

  private announceNext(): void {
    const i = this.queue.findIndex((_q, idx) => !this.done.has(this.qkey(idx)));
    if (i < 0) {
      this.current = null;
      this.currentKey = null;
      return;
    }
    const next = this.queue[i];
    const key = this.qkey(i);
    const retrying = (this.attempts.get(key) || 0) > 0;
    if (this.currentKey === key && !retrying) return;
    this.currentKey = key;
    this.current = next.title;
    this.emit('test_started', {
      test: { title: next.title, project: next.project },
      message: retrying ? 'retrying' : 'next in suite order',
    });
  }
}

/** Builds the ordered execution queue from `playwright test --list --reporter=json` output. */
export function queueFromListJson(json: unknown): QueueItem[] {
  const report = json as {
    config?: { projects?: Array<{ name?: string; retries?: number }> };
    suites?: any[];
  };
  const retriesByProject = new Map<string, number>();
  for (const p of report.config?.projects || []) retriesByProject.set(p.name || '', p.retries ?? 0);
  const out: QueueItem[] = [];
  const walk = (suite: any, titles: string[]) => {
    const here = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const retries = retriesByProject.get(t.projectName || '') ?? 0;
        out.push({
          file: String(spec.file || ''),
          line: Number(spec.line || 0),
          title: [...here, spec.title].filter(Boolean).join(' › '),
          project: t.projectName || undefined,
          allowedAttempts: retries + 1,
        });
      }
    }
    for (const c of suite.suites || []) walk(c, here);
  };
  for (const s of report.suites || []) walk(s, []);
  return out;
}
