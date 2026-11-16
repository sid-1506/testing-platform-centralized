import { stripAnsi } from '../lib/ansi';
import { NormalizedTestSuite, RunEventType, RunProgress, TestLayer } from '../types';
import { AttemptRecord, PlaywrightProgressTracker, QueueItem } from './playwrightProgress';

type Emit = (
  type: RunEventType,
  payload: { test?: { index?: number; title: string; project?: string; durationMs?: number }; message?: string; progress?: RunProgress }
) => void;

const LAYER_MARKER_RE = /^\s*▶\s*Layer:\s*(unit|integration|e2e)\b/;
// Vitest default reporter, one line per finished file:  " ✓ tests/unit/a.test.ts (44 tests) 14ms"  /  " ❯ tests/a.test.ts (5 tests | 1 failed | 1 skipped) 20ms"
const VITEST_FILE_RE = /^\s*([✓✔❯×✗✘↓])\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+) tests?((?:\s*\|\s*\d+\s+\w+)*)\)/;
const VITEST_TESTS_SUMMARY_RE = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/;
const VITEST_FILES_SUMMARY_RE = /^\s*Test Files\s+(.+?)\s+\((\d+)\)\s*$/;
// Jest: "PASS tests/a.test.js" / "FAIL tests/b.test.js"  and  "Tests:       1 failed, 3 passed, 4 total"
const JEST_FILE_RE = /^\s*(PASS|FAIL)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/;
const JEST_TESTS_SUMMARY_RE = /^\s*Tests:\s+(.+?),\s*(\d+)\s+total\s*$/;
const REPORT_LINE_RE = /^\[report\]\s+(unit|integration|e2e):/;

function countOf(text: string, word: string): number {
  const m = text.match(new RegExp(`(\\d+)\\s+${word}`));
  return m ? Number(m[1]) : 0;
}

export interface FlakyObservation {
  file?: string;
  fullKey: string;
  failedAttempts: Array<{ attempt: number; durationMs?: number }>;
  finalOutcome: 'passed' | 'failed' | 'skipped';
}

/**
 * Layer-aware live progress built ONLY from what the runner prints.
 *
 *  - `▶ Layer: <x>` markers (layer runners) switch the current layer.
 *  - Vitest/Jest print one line per finished test FILE: those become "N files / M tests finished" updates. The total
 *    number of tests is unknown until the runner prints its summary, so no total is shown before that.
 *  - Playwright's list output drives the per-test events; its total is known from `playwright test --list`.
 * Nothing is estimated. When no line can be understood the caller keeps showing the current stage.
 */
export class LayerProgressTracker {
  private buffer = '';
  private layer: TestLayer | null = null;
  private filesDone = 0;
  private testsDone = 0;
  private failedSoFar = 0;
  private pw: PlaywrightProgressTracker | null = null;
  private pwStarted = false;
  private seenLayerMarker = false;
  private readonly attempts = new Map<string, FlakyObservation>();

  constructor(
    queue: QueueItem[],
    private readonly emit: Emit,
    private readonly opts: { playwrightOnly: boolean; initialLayer?: TestLayer }
  ) {
    this.layer = opts.initialLayer ?? null;
    if (queue.length > 0) {
      this.pw = new PlaywrightProgressTracker(queue, (type, payload) => this.emit(type, payload));
      this.pw.onAttempt = (a) => this.recordAttempt(a);
    }
  }

  /** Called when the test command starts. */
  start(): void {
    if (this.opts.playwrightOnly) this.startPlaywright();
    else this.emitStage('Running the test command (waiting for the first layer to report progress)');
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = stripAnsi(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
    // A partial final line without newline never matters for progress.
  }

  /** Observed retries, for runs where the repository's report does not keep earlier attempts. */
  flakyObservations(): FlakyObservation[] {
    return Array.from(this.attempts.values()).filter((o) => o.failedAttempts.length > 0);
  }

  get currentLayer(): TestLayer | null {
    return this.layer;
  }

  private startPlaywright(): void {
    if (this.pwStarted || !this.pw) return;
    this.pwStarted = true;
    this.pw.start();
    this.emitPlaywrightProgress();
  }

  private emitPlaywrightProgress(): void {
    if (!this.pw) return;
    this.emit('layer_progress', {
      progress: {
        layer: 'e2e',
        stage: 'e2e: running tests',
        testsDone: this.pw.doneCount,
        testsTotal: this.pw.totalCount,
        failedSoFar: this.failedSoFar,
      },
    });
  }

  private emitStage(stage: string, extra: Partial<RunProgress> = {}): void {
    this.emit('layer_progress', { progress: { layer: this.layer ?? undefined, stage, ...extra }, message: stage });
  }

  private recordAttempt(a: AttemptRecord): void {
    const obs = this.attempts.get(a.fullKey) ?? { file: a.file, fullKey: a.fullKey, failedAttempts: [], finalOutcome: a.outcome };
    if (a.outcome === 'failed') {
      obs.failedAttempts.push({ attempt: obs.failedAttempts.length, durationMs: a.durationMs });
      this.failedSoFar += 1;
    }
    obs.finalOutcome = a.outcome;
    this.attempts.set(a.fullKey, obs);
  }

  private handleLine(line: string): void {
    const marker = line.match(LAYER_MARKER_RE);
    if (marker) {
      this.layer = marker[1] as TestLayer;
      this.seenLayerMarker = true;
      this.filesDone = 0;
      this.testsDone = 0;
      this.failedSoFar = 0;
      this.emit('layer_started', { progress: { layer: this.layer, stage: `${this.layer}: started` }, message: `Layer ${this.layer} started` });
      if (this.layer === 'e2e') this.startPlaywright();
      return;
    }

    const vf = line.match(VITEST_FILE_RE);
    if (vf) {
      const n = Number(vf[3]);
      const failed = countOf(vf[4] || '', 'failed');
      this.filesDone += 1;
      this.testsDone += n;
      this.failedSoFar += failed;
      this.emitStage(`${this.layer ?? 'tests'}: ${this.filesDone} file(s) finished, ${this.testsDone} test(s) run`, {
        filesDone: this.filesDone,
        testsDone: this.testsDone,
        failedSoFar: this.failedSoFar,
      });
      return;
    }
    const jf = line.match(JEST_FILE_RE);
    if (jf) {
      this.filesDone += 1;
      if (jf[1] === 'FAIL') this.failedSoFar += 0; // per-test counts only arrive with the summary
      this.emitStage(`${this.layer ?? 'tests'}: ${this.filesDone} file(s) finished`, { filesDone: this.filesDone });
      return;
    }
    const vt = line.match(VITEST_TESTS_SUMMARY_RE) || line.match(JEST_TESTS_SUMMARY_RE);
    if (vt && !this.pwActive()) {
      const total = Number(vt[2]);
      this.testsDone = total;
      this.emitStage(`${this.layer ?? 'tests'}: finished — ${total} test(s) ran`, {
        filesDone: this.filesDone || undefined,
        testsDone: total,
        testsTotal: total,
        failedSoFar: countOf(vt[1], 'failed') || undefined,
      });
      return;
    }
    if (VITEST_FILES_SUMMARY_RE.test(line)) return;
    const rep = line.match(REPORT_LINE_RE);
    if (rep) {
      this.emitStage(`${rep[1]}: report written`);
      return;
    }

    if (this.pw && (this.pwStarted || !this.seenLayerMarker)) {
      // Before any layer marker (a plain `playwright test` script) Playwright lines are fed directly.
      if (!this.pwStarted && !this.opts.playwrightOnly) return;
      const before = this.pw.doneCount;
      const failedBefore = this.failedSoFar;
      this.pw.feed(`${line}\n`);
      // Emitted after the line was handled so the counters include it.
      if (this.pw.doneCount !== before || this.failedSoFar !== failedBefore) this.emitPlaywrightProgress();
    }
  }

  private pwActive(): boolean {
    return this.layer === 'e2e' && this.pwStarted;
  }
}

/**
 * Merges observed retries into parsed cases that carry no attempt history (the repository's own report keeps only the
 * last attempt). Only observations that match a real test case are applied; nothing is invented.
 */
export function applyFlakyObservations(suites: NormalizedTestSuite[], observations: FlakyObservation[]): number {
  let applied = 0;
  for (const obs of observations) {
    for (const suite of suites) {
      const c = suite.cases.find((x) => x.fullTitle === obs.fullKey || (!!obs.file && x.file === obs.file && obs.fullKey.endsWith(` › ${x.name}`)));
      if (!c || c.previousAttempts?.length) continue;
      // The last failed attempt of a test that still ended failed IS its final result, not an earlier attempt.
      const earlier = obs.finalOutcome === 'failed' ? obs.failedAttempts.slice(0, -1) : obs.failedAttempts;
      if (earlier.length === 0) break;
      c.retries = Math.max(c.retries ?? 0, earlier.length);
      c.previousAttempts = earlier.map((a) => ({ attempt: a.attempt, status: 'failed', durationMs: a.durationMs }));
      if (c.status === 'passed' && obs.finalOutcome === 'passed') c.flaky = true;
      applied += 1;
      break;
    }
  }
  return applied;
}
