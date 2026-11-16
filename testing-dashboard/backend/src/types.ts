export type TestLayer = 'unit' | 'integration' | 'e2e';
export type RunScopeLayer = TestLayer | 'all';
export type ExecutionMode = 'isolated' | 'attach';

export interface SuiteConfig {
  id: string;
  name: string;
  layer: TestLayer;
  framework: 'vitest' | 'playwright';
  targetFile: string;
  requiresAppRunning: boolean;
}

export interface AppRegistryEntry {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  suitePath: string;
  startup: {
    command: string;
    args: string[];
    ports: number[];
    healthUrls: string[];
    startupTimeoutMs: number;
  };
  testEnv: Record<string, string>;
  suites: SuiteConfig[];
}

export interface DetectedWorkspace {
  name: string;
  path: string;
  frameworks: string[];
  hasDatabase: boolean;
  entryPoints: string[];
  scripts: string[];
}

export interface PyramidLayerRecommendation {
  layer: TestLayer;
  priority: 'high' | 'medium' | 'focused';
  rationale: string;
  evidence: string[];
  suggestedTargets: string[];
}

export interface InspectionReport {
  appId: string;
  inspectedAt: string;
  rootName: string;
  packageManager: string;
  languages: string[];
  frameworks: string[];
  databases: string[];
  workspaces: DetectedWorkspace[];
  existingTestingSetup: {
    frameworksInstalled: string[];
    scriptsFound: string[];
    notes: string;
  };
  surfaces: {
    pureModules: string[];
    apiServersAndRoutes: string[];
    frontendPagesAndComponents: string[];
  };
  recommendations: PyramidLayerRecommendation[];
}

/**
 * passed      assertions and execution succeeded
 * failed      an assertion failed
 * skipped     intentionally skipped
 * error       the test could not complete because execution broke around it (network, setup, crash, timeout reported as ERROR by the runner)
 * timedOut / interrupted  Playwright's own non-pass flavours, preserved verbatim
 */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error' | 'timedOut' | 'interrupted';
export type AttachmentKind = 'screenshot' | 'trace' | 'video' | 'download' | 'other';

export interface TestAttachment {
  name: string;
  contentType?: string;
  /** Path relative to the run directory (always starts with `artifacts/` or `downloads/`). */
  path: string;
  kind: AttachmentKind;
  /** Zero-based attempt (retry) the attachment belongs to. */
  attempt: number;
}

/** One earlier, non-final attempt of a test that was retried. */
export interface TestAttemptInfo {
  /** Zero-based attempt number. */
  attempt: number;
  status: string;
  message?: string;
  durationMs?: number;
}

export interface NormalizedTestCase {
  name: string;
  /** The layer this test belongs to. Always set for new runs; older runs fall back to the owning suite's layer. */
  layer?: TestLayer;
  status: TestStatus;
  durationMs: number;
  error?: {
    message: string;
    stack?: string;
  };
  /** Stable test identifier (e.g. TC-ILPDF-001 parsed from the title, else Playwright's spec id). */
  id?: string;
  /** Title chain as reported by the runner (file > describe > test). */
  fullTitle?: string;
  file?: string;
  line?: number;
  column?: number;
  project?: string;
  /** Number of retries that were performed (attempts - 1). */
  retries?: number;
  /** Failed at least once but passed on a retry. */
  flaky?: boolean;
  /** Earlier failed attempts (only present when the test was retried). `status` is always the final outcome. */
  previousAttempts?: TestAttemptInfo[];
  /** Playwright's own status for the final attempt, preserved verbatim. */
  originalStatus?: string;
  attachments?: TestAttachment[];
}

export interface NormalizedTestSuite {
  name: string;
  layer: TestLayer;
  durationMs: number;
  cases: NormalizedTestCase[];
}

export interface LayerSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Test cases whose execution errored (status 'error'). Not assertion failures. */
  errors: number;
  timedOut?: number;
  interrupted?: number;
  flaky?: number;
}

export interface RunSummary extends LayerSummary {
  /** Execution problems that are not test cases (see RunIssue). Not part of `total`. */
  issues?: number;
  /** The same counters split by the layer each test belongs to. */
  byLayer?: Partial<Record<TestLayer, LayerSummary>>;
}

/**
 * A problem reported by a runner that is NOT a test case: `[global]` (Playwright global setup / worker / run-level error),
 * `[module]` (a test file failed to load), `[unhandled]` (unhandled error during the run) and `[runner]` (the layer runner itself).
 * They are kept verbatim here and never counted as passed/failed tests.
 */
export interface RunIssue {
  layer?: TestLayer;
  kind: 'global' | 'module' | 'unhandled' | 'runner' | 'other';
  /** Original placeholder name as written by the repository's reporter, e.g. `[module] tests/unit/a.test.ts`. */
  name: string;
  message: string;
  stack?: string;
  file?: string;
  /** True when the runner/environment failed before valid test results existed (INFRA_ERROR for that layer). */
  infrastructure: boolean;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type RunPhase = 'queued' | 'cloning' | 'installing' | 'browsers' | 'testing' | 'collecting' | 'done';

export interface RunRepoInfo {
  id: string;
  name: string;
  url: string;
  owner: string;
  branch: string;
  commitSha?: string;
  framework: string;
  command?: string;
}

export interface NormalizedTestRun {
  runId: string;
  appId: string;
  suiteId?: string;
  layer: RunScopeLayer;
  executionMode: ExecutionMode;
  framework: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary: RunSummary;
  suites: NormalizedTestSuite[];
  artifacts: {
    logPath?: string;
    rawReportPath?: string;
    /** Run-relative locations of preserved outputs (external runs). */
    resultsJson?: boolean;
    junitXml?: boolean;
    /** Run-relative preserved layer report files (results.<layer>.json, junit.<layer>.xml, ...). */
    layerFiles?: string[];
    /** The repository's OWN HTML report (Playwright `playwright-report/`), preserved separately from the unified report. */
    htmlReport?: boolean;
    /** Platform-generated unified HTML report (`report.html`), built from this run's normalized result. */
    unifiedReport?: boolean;
    /** Why no unified report exists (only set when `unifiedReport` is false for a finished run). */
    unifiedReportNote?: string;
  };
  errorMessage?: string;
  /** 'external' for runs of a registered GitHub repository. */
  kind?: 'local' | 'external';
  repo?: RunRepoInfo;
  phase?: RunPhase;
  /** Exit code of the test process (null when it was killed / never ran). */
  exitCode?: number | null;
  timedOut?: boolean;
  /** Stage that failed for status=error runs. */
  failureStage?: RunPhase;
  /**
   * 'infrastructure' = the test runner could not run/report (crash before any test, runner timeout,
   * runner-reported infrastructure error) — NOT a verdict about the tests. Set together with status 'error'.
   */
  failureKind?: 'infrastructure';
  /** Infrastructure problems reported by the repository's own layer runner (one entry per layer). */
  infraErrors?: string[];
  /** Non-test execution problems (`[global]`, `[module]`, `[unhandled]`, `[runner]`) with the original error text. */
  issues?: RunIssue[];
  /** Notes about how results were collected/validated (e.g. count mismatches); never hides data. */
  notes?: string[];
  /** Effective configuration the run used (no secret values). */
  config?: RunConfigInfo;
  /** Last lines of the test process output that explain an infrastructure failure (sanitized). */
  errorDetail?: string;
}

export interface RunConfigInfo {
  layer: RunScopeLayer;
  testScript?: string;
  targetBaseUrl?: string;
  targetApiUrl?: string;
  /** Names only; values are never recorded. */
  envNames?: string[];
  installScripts: 'disabled' | 'enabled';
}

export type LogStream = 'stdout' | 'stderr' | 'platform';

export type RunEventType =
  | 'run_started'
  | 'clone_started'
  | 'clone_completed'
  | 'install_started'
  | 'install_completed'
  | 'browser_install_started'
  | 'browser_install_completed'
  | 'test_started'
  | 'test_output'
  | 'test_passed'
  | 'test_failed'
  | 'test_skipped'
  | 'layer_started'
  | 'layer_progress'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled';

export interface RunEvent {
  /** Monotonic per-run id; usable as SSE Last-Event-ID. */
  id: number;
  runId: string;
  type: RunEventType;
  timestamp: string;
  stream?: LogStream;
  text?: string;
  test?: { index?: number; title: string; project?: string; durationMs?: number };
  phase?: RunPhase;
  status?: RunStatus;
  summary?: RunSummary;
  message?: string;
  progress?: RunProgress;
}

/**
 * Live, layer-aware progress. Only values the runner actually printed are present; `testsTotal` is set only when the
 * total is genuinely known (e.g. Playwright `--list`), never guessed.
 */
export interface RunProgress {
  layer?: TestLayer;
  /** Human readable stage, e.g. "unit: running tests". */
  stage: string;
  filesDone?: number;
  testsDone?: number;
  testsTotal?: number;
  failedSoFar?: number;
}

// ---------------------------------------------------------------------------
// External (GitHub) repositories
// ---------------------------------------------------------------------------

export type RepoConnectionStatus = 'connecting' | 'ready' | 'unsupported' | 'error';

export type TestFramework = 'playwright' | 'vitest' | 'jest';

export interface RepoDetection {
  detectedAt: string;
  /** Primary framework (kept for older records). See `frameworks` for everything that was detected. */
  framework: TestFramework | null;
  /** Every supported test framework found in the dependencies. */
  frameworks?: TestFramework[];
  /** True when the repository's scripts/runner honor `TEST_LAYER` (or expose test:<layer> scripts). */
  supportsLayerSelection?: boolean;
  /** Layers the repository is expected to contain (static hint, not a count). */
  layers?: TestLayer[];
  /** True when the platform can actually execute this repository today. */
  supported: boolean;
  /** Why the repository is not executable (empty when supported). */
  problems: string[];
  warnings: string[];
  packageName?: string;
  packageManager: 'npm' | 'unsupported' | 'none';
  lockfile?: string;
  playwrightDependency?: string;
  playwrightVersion?: string;
  vitestVersion?: string;
  jestVersion?: string;
  configFile?: string;
  testDir?: string;
  testFileCount: number;
  /**
   * STATIC ESTIMATE: number of `test('title', ...)` / `it('title', ...)` declarations found by a regex scan. It ignores
   * parameterized tests (`it.each`), generated tests and profile-driven tests, so it is never the real test count.
   * Runtime-discovered and executed counts live in `ExternalRepo.discovery` / `ExternalRepo.lastExecution`.
   */
  staticDeclarationCount: number;
  scripts: Record<string, string>;
  testCommand?: { script: string; display: string; forcesHeaded: boolean; kind?: TestCommandKind };
  reporters: string[];
  browsers: string[];
  forcesHeaded: boolean;
}

/** What the chosen package.json script runs; decides whether the platform may add reporter flags. */
export type TestCommandKind = 'runner' | 'playwright' | 'vitest' | 'jest' | 'unknown';

export interface RepoSettings {
  /** Name of a package.json script to run instead of the auto-detected one. Never an arbitrary command. */
  testScript?: string;
  /** Test execution timeout override. */
  testTimeoutMs?: number;
  /** Which layer to run (default all). Passed as TEST_LAYER and, when present, via the `test:<layer>` script. */
  layer?: RunScopeLayer;
  /** Target website URL, passed as TEST_BASE_URL. */
  targetBaseUrl?: string;
  /** Target API URL, passed as TEST_API_BASE_URL. */
  targetApiUrl?: string;
  /** Extra environment variables; names are restricted (see repoSettings.ts). Secret-looking values are masked in API responses. */
  env?: Record<string, string>;
  /** Allow npm lifecycle scripts (preinstall/install/postinstall) of the repository and its dependencies. Off by default. */
  allowInstallScripts?: boolean;
}

/** Runtime test discovery done by the framework's own listing command (Playwright `--list`). */
export interface RepoDiscovery {
  discoveredAt: string;
  /** Commit the discovery was made on; stale when the repository moved on. */
  commitSha: string;
  source: string;
  /** Layers this discovery covers. Layers not listed were NOT discovered (not zero). A "Fetch Tests" discovery lists all three (0 = not detected). */
  byLayer: Partial<Record<TestLayer, number>>;
  total: number;
  /** Set by "Fetch Tests" (dedicated discovery job). Absent for the Playwright-only count a run records as a side effect. */
  details?: Partial<Record<TestLayer, LayerDiscoveryDetail>>;
  /** True when something went wrong for part of the discovery (the counts above cover only what could be listed). */
  partial?: boolean;
  /** Non-fatal problems met while listing (a layer's config failed to load, ...). */
  issues?: string[];
  /** Computed when served: the repository moved to another commit since this discovery. Never persisted. */
  stale?: boolean;
}

/** How one layer's count was obtained. */
export interface LayerDiscoveryDetail {
  count: number;
  /** `list` = the framework's own listing (expanded cases); `estimate` = static declaration scan (framework cannot list cases). */
  method: 'list' | 'estimate';
  frameworks: TestFramework[];
  files: number;
  /** Whether the platform can execute this layer on its own (layer scripts / TEST_LAYER runner, or the only layer). */
  runnable: boolean;
}

/** Lifecycle of the most recent "Fetch Tests" job. Kept apart from `discovery` so a failed/running job never erases earlier results. */
export interface DiscoveryState {
  status: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string;
  /** Commit the job works on / worked on. */
  commitSha?: string;
  message?: string;
  error?: string;
}

/**
 * What was actually executed, per layer. A run restricted to one layer only replaces that layer's entry, so an earlier
 * full run is not forgotten. `layerRuns` says which run (and commit) each layer's numbers come from.
 */
export interface RepoLastExecution {
  /** Latest finished run that executed tests. */
  runId: string;
  executedAt: string;
  commitSha?: string;
  /** Sums of `byLayer`. */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  byLayer: Partial<Record<TestLayer, LayerSummary>>;
  layerRuns?: Partial<Record<TestLayer, { runId: string; executedAt: string; commitSha?: string }>>;
}

export interface ExternalRepo {
  id: string;
  name: string;
  url: string;
  owner: string;
  repo: string;
  branch: string;
  commitSha?: string;
  registeredAt: string;
  lastFetchedAt?: string;
  status: RepoConnectionStatus;
  statusMessage?: string;
  /** Repository cache location, relative to the platform workspace. */
  location: string;
  detection?: RepoDetection;
  /** Set once the user explicitly accepted that this repo's code will be executed locally. */
  trustedAt?: string;
  /** Commit the trust was granted for. Trust is void when the repository moves to another commit. */
  trustedSha?: string;
  /** Runtime-discovered tests (e.g. Playwright `--list`) from the last run. */
  discovery?: RepoDiscovery;
  discoveryState?: DiscoveryState;
  lastExecution?: RepoLastExecution;
  lastRun?: { runId: string; status: RunStatus; finishedAt?: string };
  settings?: RepoSettings;
}
