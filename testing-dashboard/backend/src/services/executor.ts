import path from 'path';
import {
  ExecutionMode,
  NormalizedTestRun,
  NormalizedTestSuite,
  RunScopeLayer,
  SuiteConfig,
} from '../types';
import { assertPathInside, ResolvedAppEntry } from './registry';
import { collectProcessSecrets, sanitizeLogText } from './logSanitizer';
import { getRunDir, saveRunResult } from './runStore';
import { createRunLogger } from './runLogger';
import { emitRunEvent } from './eventBus';
import {
  getActiveRun as registryGetActiveRun,
  isCancelled,
  markCancelled,
  trackActiveRun,
  untrackActiveRun,
} from './runRegistry';
import { stampLayers, summarizeSuites } from '../adapters/playwrightReport';
import { writeUnifiedReport } from './htmlReport';
import { cleanupIsolatedWorkspace, createIsolatedWorkspace } from './workspace';
import {
  cleanupRunProcesses,
  findOccupiedPorts,
  spawnTrackedProcess,
  waitForHealthUrls,
} from './processManager';
import { vitestAdapter } from '../adapters/vitestAdapter';
import { playwrightAdapter } from '../adapters/playwrightAdapter';

const activeAppLocks = new Set<string>();

export function getActiveRun(runId: string): NormalizedTestRun | undefined {
  return registryGetActiveRun(runId);
}

export function isAppLocked(appId: string): boolean {
  return activeAppLocks.has(appId);
}

export async function cancelRun(runId: string): Promise<boolean> {
  const run = registryGetActiveRun(runId);
  if (!run || (run.status !== 'running' && run.status !== 'queued')) {
    return false;
  }
  markCancelled(runId);
  await cleanupRunProcesses(runId);
  return true;
}

export function startTestExecution(
  app: ResolvedAppEntry,
  options: {
    suiteId?: string;
    layer?: RunScopeLayer;
    executionMode?: ExecutionMode;
  }
): NormalizedTestRun {
  if (activeAppLocks.has(app.id)) {
    throw new Error(`An execution is already in progress for ${app.name}. Wait for it to finish or cancel it.`);
  }

  let selectedSuites: SuiteConfig[];
  if (options.suiteId) {
    const found = app.suites.find((s) => s.id === options.suiteId);
    if (!found) {
      throw new Error(`Unknown suiteId: ${options.suiteId}`);
    }
    selectedSuites = [found];
  } else if (options.layer && options.layer !== 'all') {
    selectedSuites = app.suites.filter((s) => s.layer === options.layer);
  } else {
    selectedSuites = [...app.suites];
  }

  if (selectedSuites.length === 0) {
    throw new Error('No matching test suites found to execute.');
  }

  const executionMode: ExecutionMode = options.executionMode || 'isolated';
  const layer: RunScopeLayer = options.suiteId
    ? selectedSuites[0].layer
    : options.layer || 'all';

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const run: NormalizedTestRun = {
    runId,
    appId: app.id,
    suiteId: options.suiteId,
    layer,
    executionMode,
    framework: Array.from(new Set(selectedSuites.map((s) => s.framework))).join(', '),
    kind: 'local',
    status: 'running',
    startedAt: new Date().toISOString(),
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
    suites: [],
    artifacts: {},
  };

  activeAppLocks.add(app.id);
  trackActiveRun(run);
  saveRunResult(run);
  emitRunEvent(runId, 'run_started', { status: 'running', message: `Run ${runId} started for ${app.name}` });

  // Run asynchronously so HTTP POST /api/runs returns immediately with runId
  void executeRunLifecycle(app, selectedSuites, run, executionMode);

  return run;
}

async function executeRunLifecycle(
  app: ResolvedAppEntry,
  suites: SuiteConfig[],
  run: NormalizedTestRun,
  executionMode: ExecutionMode
): Promise<void> {
  const runDir = getRunDir(run.runId);
  const secrets = [...Object.values(app.testEnv || {}), ...collectProcessSecrets()];
  const logger = createRunLogger(run.runId, secrets);
  const log = (msg: string, stream: 'stdout' | 'stderr' | 'platform' = 'platform') => {
    run.artifacts.logPath = logger.log(msg, stream);
  };

  const startTime = Date.now();
  const needsAppRunning = suites.some((s) => s.requiresAppRunning);
  let targetAppDir = app.resolvedSourcePath;
  let workspaceCreated = false;
  let finalStatus: NormalizedTestRun['status'] = 'error';

  try {
    log(`[PLATFORM] Starting run ${run.runId} for ${app.name} (mode=${executionMode}, layer=${run.layer})\n`);

    if (executionMode === 'isolated') {
      log(`[PLATFORM] Preparing isolated temporary workspace (excluding .env, no node_modules symlink)...\n`);
      targetAppDir = createIsolatedWorkspace(app.resolvedSourcePath, run.runId, needsAppRunning);
      workspaceCreated = true;
      log(`[PLATFORM] Isolated workspace ready at ${targetAppDir}\n`);

      if (needsAppRunning) {
        log(`[PLATFORM] Checking pre-flight port availability: ${app.startup.ports.join(', ')}...\n`);
        const occupied = await findOccupiedPorts(app.startup.ports);
        if (occupied.length > 0) {
          throw new Error(
            `Port conflict detected on port(s): ${occupied.join(', ')}. ` +
              `Platform refuses to terminate pre-existing processes. Free these ports or switch to "Attach to Running Services" mode.`
          );
        }

        log(`[PLATFORM] Starting target application inside isolated workspace...\n`);
        spawnTrackedProcess(
          run.runId,
          `app:${app.id}`,
          app.startup.command,
          app.startup.args,
          targetAppDir,
          { ...process.env, ...app.testEnv },
          (chunk, stream) => log(chunk, stream)
        );

        log(`[PLATFORM] Waiting for ${app.startup.healthUrls.length} health endpoints...\n`);
        await waitForHealthUrls(app.startup.healthUrls, app.startup.startupTimeoutMs, () =>
          isCancelled(run.runId)
        );
        log(`[PLATFORM] All target application health endpoints returned HTTP 200.\n`);
      }
    } else {
      // Attach mode: never spawn or kill app processes, just verify health if required
      if (needsAppRunning) {
        log(`[PLATFORM] Attach mode: verifying health of already-running local services...\n`);
        await waitForHealthUrls(app.startup.healthUrls, 5000, () => isCancelled(run.runId));
        log(`[PLATFORM] Existing local services are healthy.\n`);
      }
    }

    const suitesPackageRoot = path.resolve(app.resolvedSuitePath, '..');
    const allNormalizedSuites: NormalizedTestSuite[] = [];
    let anySuiteFailedExit = false;

    for (const suite of suites) {
      if (isCancelled(run.runId)) {
        throw new Error('Run cancelled by user.');
      }

      // Prevent path traversal on targetFile
      assertPathInside(app.resolvedSuitePath, path.join(app.resolvedSuitePath, suite.targetFile));

      const rawReportPath = path.join(runDir, `${suite.id}.raw.json`);
      run.artifacts.rawReportPath = rawReportPath;

      log(`\n[PLATFORM] Executing suite "${suite.name}" (${suite.framework})...\n`);
      const adapter = suite.framework === 'playwright' ? playwrightAdapter : vitestAdapter;
      const output = await adapter.execute({
        runId: run.runId,
        suite,
        suiteRootDir: app.resolvedSuitePath,
        suitesPackageRoot,
        targetAppDir,
        rawReportPath,
        env: app.testEnv,
        timeoutMs: 120000,
        onOutput: (chunk, stream) => log(chunk, stream ?? 'stdout'),
      });

      if (output.exitCode !== 0) {
        anySuiteFailedExit = true;
      }
      allNormalizedSuites.push(...output.suites);
      log(`[PLATFORM] Suite "${suite.name}" exited with code ${output.exitCode}.\n`);
    }

    run.suites = stampLayers(allNormalizedSuites);
    const summary = summarizeSuites(allNormalizedSuites);
    const failedLike = summary.failed + summary.errors + (summary.timedOut ?? 0) + (summary.interrupted ?? 0);
    run.summary = summary;
    finalStatus = isCancelled(run.runId)
      ? 'cancelled'
      : anySuiteFailedExit || failedLike > 0 || summary.total === 0
      ? 'failed'
      : 'passed';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    finalStatus = isCancelled(run.runId) ? 'cancelled' : 'error';
    run.errorMessage = sanitizeLogText(message, secrets);
    log(`\n[PLATFORM ERROR] ${run.errorMessage}\n`);
  } finally {
    log(`[PLATFORM] Cleaning up platform-spawned processes...\n`);
    await cleanupRunProcesses(run.runId);

    if (workspaceCreated) {
      log(`[PLATFORM] Removing temporary isolated workspace...\n`);
      cleanupIsolatedWorkspace(run.runId);
    }

    run.status = finalStatus;
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startTime;
    // Unified HTML report from the normalized result (only when there is valid test data; never a fake one).
    try {
      const report = writeUnifiedReport(runDir, run);
      run.artifacts.unifiedReport = report.ok;
      if (!report.ok) run.artifacts.unifiedReportNote = report.reason;
    } catch {
      run.artifacts.unifiedReport = false;
    }
    saveRunResult(run);

    emitRunEvent(
      run.runId,
      finalStatus === 'passed' ? 'run_completed' : finalStatus === 'cancelled' ? 'run_cancelled' : 'run_failed',
      { status: finalStatus, summary: run.summary, message: run.errorMessage }
    );

    activeAppLocks.delete(app.id);
    untrackActiveRun(run.runId);
  }
}
