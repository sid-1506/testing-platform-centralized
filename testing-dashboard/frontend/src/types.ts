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

export interface RegisteredApp {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  suitePath: string;
  ports: number[];
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

/** error = the test could not complete because execution broke around it (not an assertion failure). */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error' | 'timedOut' | 'interrupted';
export type AttachmentKind = 'screenshot' | 'trace' | 'video' | 'download' | 'other';

export interface TestAttachment {
  name: string;
  contentType?: string;
  /** Run-relative path starting with `artifacts/` or `downloads/`. */
  path: string;
  kind: AttachmentKind;
  attempt: number;
}

export interface TestAttemptInfo {
  attempt: number;
  status: string;
  message?: string;
  durationMs?: number;
}

export interface NormalizedTestCase {
  name: string;
  /** Layer of this test. Older runs lack it; use `caseLayer()` from lib/metrics. */
  layer?: TestLayer;
  status: TestStatus;
  durationMs: number;
  error?: {
    message: string;
    stack?: string;
  };
  id?: string;
  fullTitle?: string;
  file?: string;
  line?: number;
  column?: number;
  project?: string;
  retries?: number;
  flaky?: boolean;
  previousAttempts?: TestAttemptInfo[];
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
  /** Absent on runs recorded before errors were tracked separately. */
  errors?: number;
  timedOut?: number;
  interrupted?: number;
  flaky?: number;
}

export interface RunSummary extends LayerSummary {
  /** Execution problems that are not test cases (`[global]`, `[module]`, `[unhandled]`, `[runner]`). */
  issues?: number;
  byLayer?: Partial<Record<TestLayer, LayerSummary>>;
}

export interface RunIssue {
  layer?: TestLayer;
  kind: 'global' | 'module' | 'unhandled' | 'runner' | 'other';
  name: string;
  message: string;
  stack?: string;
  file?: string;
  infrastructure: boolean;
}

export interface RunConfigInfo {
  layer: RunScopeLayer;
  testScript?: string;
  targetBaseUrl?: string;
  targetApiUrl?: string;
  envNames?: string[];
  installScripts: 'disabled' | 'enabled';
}

export interface RunProgress {
  layer?: TestLayer;
  stage: string;
  filesDone?: number;
  testsDone?: number;
  /** Only present when the total is really known. */
  testsTotal?: number;
  failedSoFar?: number;
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
    /** The repository's own HTML report (kept separately from the unified report). */
    htmlReport?: boolean;
    resultsJson?: boolean;
    junitXml?: boolean;
    layerFiles?: string[];
    /** Platform-generated unified HTML report. */
    unifiedReport?: boolean;
    unifiedReportNote?: string;
  };
  errorMessage?: string;
  kind?: 'local' | 'external';
  repo?: RunRepoInfo;
  phase?: RunPhase;
  exitCode?: number | null;
  timedOut?: boolean;
  failureStage?: RunPhase;
  failureKind?: 'infrastructure';
  infraErrors?: string[];
  errorDetail?: string;
  issues?: RunIssue[];
  notes?: string[];
  config?: RunConfigInfo;
}

export type LogStream = 'stdout' | 'stderr' | 'platform';

export interface LogEntry {
  stream: LogStream;
  text: string;
}

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

// ---------------------------------------------------------------------------
// External GitHub repositories
// ---------------------------------------------------------------------------

export type RepoConnectionStatus = 'connecting' | 'ready' | 'unsupported' | 'error';

export type TestFramework = 'playwright' | 'vitest' | 'jest';

export interface RepoDetection {
  detectedAt: string;
  framework: TestFramework | null;
  frameworks?: TestFramework[];
  supportsLayerSelection?: boolean;
  layers?: TestLayer[];
  supported: boolean;
  problems: string[];
  warnings: string[];
  packageName?: string;
  packageManager: 'npm' | 'unsupported' | 'none';
  lockfile?: string;
  playwrightVersion?: string;
  vitestVersion?: string;
  jestVersion?: string;
  configFile?: string;
  testDir?: string;
  testFileCount: number;
  /** STATIC ESTIMATE from a regex scan (ignores it.each / generated tests). Never the real test count. */
  staticDeclarationCount?: number;
  /** Legacy field of records stored before the rename; also a static estimate. */
  testCount?: number;
  scripts: Record<string, string>;
  testCommand?: { script: string; display: string; forcesHeaded: boolean; kind?: string };
  reporters: string[];
  browsers: string[];
  forcesHeaded: boolean;
}

export interface RepoSettings {
  testScript?: string;
  testTimeoutMs?: number;
  layer?: RunScopeLayer;
  targetBaseUrl?: string;
  targetApiUrl?: string;
  /** Secret-looking values arrive masked (`********`). */
  env?: Record<string, string>;
  allowInstallScripts?: boolean;
}

export interface RepoDiscovery {
  discoveredAt: string;
  commitSha: string;
  source: string;
  /** Layers not listed were NOT discovered (that is not zero). */
  byLayer: Partial<Record<TestLayer, number>>;
  total: number;
  details?: Partial<Record<TestLayer, LayerDiscoveryDetail>>;
  partial?: boolean;
  issues?: string[];
  /** Computed by the backend: the repository moved to another commit since this discovery. */
  stale?: boolean;
}

export interface LayerDiscoveryDetail {
  count: number;
  /** `list` = framework listing (expanded cases); `estimate` = static declaration scan. */
  method: 'list' | 'estimate';
  frameworks: TestFramework[];
  files: number;
  runnable: boolean;
}

export interface DiscoveryState {
  status: 'running' | 'completed' | 'partial' | 'failed';
  startedAt: string;
  finishedAt?: string;
  commitSha?: string;
  message?: string;
  error?: string;
}

export interface RepoLastExecution {
  runId: string;
  executedAt: string;
  commitSha?: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  byLayer: Partial<Record<TestLayer, LayerSummary>>;
  /** Which run/commit each layer's numbers come from (a layer-only run replaces only its own layer). */
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
  location: string;
  detection?: RepoDetection;
  trustedAt?: string;
  trustedSha?: string;
  discovery?: RepoDiscovery;
  discoveryState?: DiscoveryState;
  lastExecution?: RepoLastExecution;
  lastRun?: { runId: string; status: RunStatus; finishedAt?: string };
  settings?: RepoSettings;
}

/**
 * One selectable project in the dashboard: a local registered application or a
 * connected external GitHub repository.
 */
export interface ProjectRef {
  id: string;
  name: string;
  kind: 'local' | 'external';
  app?: RegisteredApp;
  repo?: ExternalRepo;
}
