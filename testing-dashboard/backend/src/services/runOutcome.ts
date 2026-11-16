import { RunPhase, RunStatus, RunSummary } from '../types';

export interface OutcomeInput {
  cancelled: boolean;
  headedViolation: string | null;
  stageError: { stage: RunPhase; message: string; timedOut: boolean } | null;
  testTimedOut: boolean;
  testTimeoutSeconds: number;
  exitCode: number | null;
  summary: RunSummary;
  /** Infrastructure problems the repository's own runner reported (e.g. a layer report with `runnerError`). */
  infraErrors: string[];
  /** Sanitized tail of the test process output, used to show the real error for crashes. */
  outputTail: string;
  /** Non-test, non-infrastructure execution issues (`[module]`, `[unhandled]`, `[global]`) — they make the run fail, never pass. */
  executionIssues?: number;
}

export interface Outcome {
  status: RunStatus;
  errorMessage?: string;
  failureStage?: RunPhase;
  failureKind?: 'infrastructure';
  timedOut?: boolean;
  errorDetail?: string;
}

/**
 * Decides the final status of an external run. `error` is the platform's INFRA_ERROR: the pipeline or the
 * runner could not produce a verdict. A run that produced no test results at all is never an ordinary
 * test failure and is never a pass.
 */
export function classifyRunOutcome(i: OutcomeInput): Outcome {
  const s = i.summary;
  const failedLike = s.failed + (s.errors || 0) + (s.timedOut || 0) + (s.interrupted || 0) + (i.executionIssues || 0);
  if (i.cancelled) return { status: 'cancelled', errorMessage: 'Run cancelled by user.' };
  if (i.headedViolation) {
    return {
      status: 'error',
      errorMessage: 'Aborted: a headed (visible) browser was detected. External suites must run headlessly.',
      failureStage: 'testing',
    };
  }
  if (i.stageError) {
    return {
      status: 'error',
      errorMessage: i.stageError.message,
      failureStage: i.stageError.stage,
      timedOut: i.stageError.timedOut || undefined,
      failureKind: 'infrastructure',
    };
  }
  if (i.testTimedOut) {
    return {
      status: 'error',
      timedOut: true,
      failureStage: 'testing',
      errorMessage: `Test execution timed out after ${i.testTimeoutSeconds}s and was terminated.`,
    };
  }
  if (s.total === 0) {
    const base =
      i.exitCode === 0
        ? 'Infrastructure error: the test command exited 0 but produced no test results, so nothing was verified.'
        : `Infrastructure error: the test command exited with code ${i.exitCode} before any test result was produced. This is a runner/environment failure, not a test failure.`;
    return {
      status: 'error',
      failureStage: 'testing',
      failureKind: 'infrastructure',
      errorMessage: i.infraErrors.length ? `${base} Runner reported: ${i.infraErrors.join(' | ')}`.slice(0, 1000) : base,
      errorDetail: i.outputTail.trim() || undefined,
    };
  }
  if (i.infraErrors.length) {
    return {
      status: 'error',
      failureStage: 'testing',
      failureKind: 'infrastructure',
      errorMessage: `Infrastructure error reported by the test runner: ${i.infraErrors.join(' | ')}`.slice(0, 1000),
    };
  }
  if (i.exitCode === 0 && failedLike === 0) return { status: 'passed' };
  return {
    status: 'failed',
    ...(failedLike === 0 ? { errorMessage: `All reported tests passed but the test command exited with code ${i.exitCode}.` } : {}),
    ...(failedLike > 0 && (i.executionIssues || 0) > 0 && s.failed + (s.errors || 0) === 0
      ? { errorMessage: `${i.executionIssues} execution error(s) were reported (test file failed to load, unhandled error or global/setup error); see the error details.` }
      : {}),
  };
}
