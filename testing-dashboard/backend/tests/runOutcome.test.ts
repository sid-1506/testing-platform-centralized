import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRunOutcome, OutcomeInput } from '../src/services/runOutcome';

const zero = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, timedOut: 0, interrupted: 0, flaky: 0 };
const base = (over: Partial<OutcomeInput> = {}): OutcomeInput => ({
  cancelled: false,
  headedViolation: null,
  stageError: null,
  testTimedOut: false,
  testTimeoutSeconds: 1800,
  exitCode: 0,
  summary: { ...zero, total: 3, passed: 3 },
  infraErrors: [],
  outputTail: '',
  ...over,
});

describe('classifyRunOutcome', () => {
  it('passes only with results, exit code 0 and no failures', () => {
    assert.equal(classifyRunOutcome(base()).status, 'passed');
  });

  it('reports a crash before any test (0/0, exit 1) as an infrastructure error carrying the real output', () => {
    const o = classifyRunOutcome(base({ exitCode: 1, summary: zero, outputTail: 'Error: listen EINVAL: invalid argument /x/tsx-501/1.pipe' }));
    assert.equal(o.status, 'error');
    assert.equal(o.failureKind, 'infrastructure');
    assert.match(o.errorMessage ?? '', /exited with code 1 before any test result/);
    assert.match(o.errorDetail ?? '', /listen EINVAL/);
  });

  it('never treats 0/0 with exit 0 as a pass', () => {
    const o = classifyRunOutcome(base({ exitCode: 0, summary: zero }));
    assert.equal(o.status, 'error');
    assert.equal(o.failureKind, 'infrastructure');
  });

  it('keeps real counts but marks the run as an infrastructure error when a layer reported runnerError', () => {
    const o = classifyRunOutcome(base({ exitCode: 2, summary: { ...zero, total: 10, passed: 10 }, infraErrors: ['e2e: [EXECUTION] browser missing'] }));
    assert.equal(o.status, 'error');
    assert.match(o.errorMessage ?? '', /browser missing/);
  });

  it('keeps ordinary assertion failures as failed (not infra)', () => {
    const o = classifyRunOutcome(base({ exitCode: 1, summary: { ...zero, total: 5, passed: 4, failed: 1 } }));
    assert.equal(o.status, 'failed');
    assert.equal(o.failureKind, undefined);
  });

  it('classifies pipeline stage failures, timeouts, cancellation', () => {
    const stage = classifyRunOutcome(base({ stageError: { stage: 'installing', message: 'npm ci failed', timedOut: false } }));
    assert.deepEqual([stage.status, stage.failureKind, stage.failureStage], ['error', 'infrastructure', 'installing']);
    assert.equal(classifyRunOutcome(base({ testTimedOut: true })).timedOut, true);
    assert.equal(classifyRunOutcome(base({ cancelled: true, exitCode: null, summary: zero })).status, 'cancelled');
  });

  it('flags exit != 0 with all-green results instead of passing', () => {
    assert.equal(classifyRunOutcome(base({ exitCode: 3 })).status, 'failed');
  });

  it('counts ERROR test cases and execution issues as a failed run, never as a pass', () => {
    assert.equal(classifyRunOutcome(base({ summary: { ...zero, total: 3, passed: 2, errors: 1 } })).status, 'failed');
    const o = classifyRunOutcome(base({ executionIssues: 1 }));
    assert.equal(o.status, 'failed');
    assert.match(o.errorMessage ?? '', /execution error/);
  });
});
