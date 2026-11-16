import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  DEPS_DIR,
  MAX_CONCURRENT_EXTERNAL_RUNS,
  MAX_TEST_TIMEOUT_MS,
  TIMEOUTS,
  WORKSPACES_DIR,
  playwrightBrowsersPath,
} from '../config';
import { assertInside } from '../lib/fsSafe';
import { stripAnsi } from '../lib/ansi';
import { ExternalRepo, NormalizedTestRun, RepoDetection, RunPhase, RunScopeLayer, RunStatus, TestFramework, TestLayer } from '../types';
import { summarizeSuites } from '../adapters/playwrightReport';
import { PLATFORM_REPORT_DIR, collectArtifacts } from './artifactCollector';
import { writeUnifiedReport } from './htmlReport';
import { LayerProgressTracker, applyFlakyObservations } from './layerProgress';
import { isRunScopeLayer, runEnvFromSettings, secretValuesOf } from './repoSettings';
import { pruneRunHistory } from './runRetention';
import { emitRunEvent } from './eventBus';
import { exportCheckout, fetchRepo, repoCacheDir } from './gitService';
import { startHeadlessGuard } from './headlessGuard';
import { collectProcessSecrets, sanitizeLogText } from './logSanitizer';
import { cleanupRunProcesses, runTrackedCommand } from './processManager';
import { QueueItem, queueFromListJson } from './playwrightProgress';
import { dependencyKey, detectRepository } from './repoDetector';
import { getRepo, updateRepo } from './repoRegistry';
import { describeDetection } from './repoStatus';
import { buildSandboxEnv } from './sandboxEnv';
import { createRunLogger } from './runLogger';
import { classifyRunOutcome } from './runOutcome';
import { createRunTmpDir, probeSocketSupport, removeRunTmpDir } from './runTmp';
import { isCancelled, listActiveRuns, trackActiveRun, untrackActiveRun } from './runRegistry';
import { getRunDir, saveRunResult } from './runStore';

export class ExternalRunError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ExternalRunError';
  }
}

/** A failure attributable to one pipeline stage (clone, install, browsers, tests). */
export class StageError extends Error {
  constructor(public stage: RunPhase, message: string, public timedOut = false) {
    super(message);
  }
}

/** Keeps the last `max` characters of a command's output (both streams, in arrival order). */
class TailBuffer {
  private buf = '';
  constructor(private max: number) {}
  push(_stream: 'stdout' | 'stderr', chunk: string): void {
    this.buf = (this.buf + stripAnsi(chunk)).slice(-this.max);
  }
  text(): string {
    const lines = this.buf.split('\n');
    return lines.slice(-30).join('\n');
  }
}

const activeRepoLocks = new Set<string>();

export function isRepoBusy(repoId: string): boolean {
  return activeRepoLocks.has(repoId);
}

/** Exclusive per-repository lock shared by test runs and test discovery. Returns false when already held. */
export function acquireRepoLock(repoId: string): boolean {
  if (activeRepoLocks.has(repoId)) return false;
  activeRepoLocks.add(repoId);
  return true;
}

export function releaseRepoLock(repoId: string): void {
  activeRepoLocks.delete(repoId);
}

export interface StartExternalRunOptions {
  /** Layer to run (default: the repository's configured layer, else all). */
  layer?: unknown;
  /** Commit the user discovered tests on. The run refuses to execute a different commit (the repository changed since "Fetch Tests"). */
  expectedCommitSha?: string;
}

function frameworksOf(d: RepoDetection): TestFramework[] {
  return d.frameworks?.length ? d.frameworks : d.framework ? [d.framework] : [];
}

export function startExternalRun(repoId: string, options: StartExternalRunOptions = {}): NormalizedTestRun {
  const repo = getRepo(repoId);
  if (!repo) throw new ExternalRunError(404, `Repository '${repoId}' is not registered.`);
  if (repo.status === 'connecting') throw new ExternalRunError(409, 'Repository is still connecting. Wait until it is ready.');
  if (repo.status !== 'ready' || !repo.detection?.supported) {
    const why = repo.detection?.problems?.join(' ') || repo.statusMessage || 'Repository is not in a runnable state.';
    throw new ExternalRunError(422, `This repository cannot be executed: ${why}`);
  }
  if (!repo.trustedAt || !repo.trustedSha || repo.trustedSha !== repo.commitSha) {
    throw new ExternalRunError(
      403,
      repo.trustedAt && repo.trustedSha && repo.trustedSha !== repo.commitSha
        ? 'The repository moved to a different commit after it was trusted. Review it and confirm trust again.'
        : 'This repository has not been trusted for its current commit. Running it executes its npm scripts and test code on this machine with your user permissions. Confirm trust first.'
    );
  }

  const requested = options.layer ?? repo.settings?.layer ?? 'all';
  if (!isRunScopeLayer(requested)) throw new ExternalRunError(400, 'layer must be one of all, unit, integration, e2e.');
  const layer: RunScopeLayer = requested;
  const det = repo.detection;
  if (options.expectedCommitSha && repo.commitSha && options.expectedCommitSha !== repo.commitSha) {
    throw new ExternalRunError(
      409,
      `The repository is now at commit ${repo.commitSha.slice(0, 12)}, but tests were discovered on ${options.expectedCommitSha.slice(0, 12)}. Nothing was executed — run Fetch Tests again.`
    );
  }
  const discoveredLayers = repo.discovery && !repo.discovery.stale && repo.discovery.commitSha === repo.commitSha && repo.discovery.details
    ? (Object.keys(repo.discovery.details) as TestLayer[]).filter((l) => (repo.discovery!.byLayer[l] ?? 0) > 0)
    : [];
  const onlyLayer = det.layers?.length === 1 ? det.layers[0] : discoveredLayers.length === 1 ? discoveredLayers[0] : undefined;
  if (layer !== 'all' && !det.supportsLayerSelection && onlyLayer !== layer) {
    throw new ExternalRunError(
      422,
      `This repository cannot run a single layer: it has no test:<layer> scripts and its runner does not read TEST_LAYER. Run all layers instead.`
    );
  }

  if (activeRepoLocks.has(repo.id)) {
    throw new ExternalRunError(409, `A test run or test discovery is already in progress for ${repo.name}. Wait for it to finish or cancel the run.`);
  }
  const activeExternal = listActiveRuns().filter((r) => r.kind === 'external').length;
  if (activeExternal >= MAX_CONCURRENT_EXTERNAL_RUNS) {
    throw new ExternalRunError(409, 'Another external test run is in progress. Only one external suite runs at a time; wait for it to finish or cancel it.');
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const fws = frameworksOf(det);
  const initialLayer: RunScopeLayer = layer !== 'all' ? layer : det.layers?.length === 1 ? det.layers[0] : 'all';
  const run: NormalizedTestRun = {
    runId,
    appId: repo.id,
    layer: initialLayer,
    executionMode: 'isolated',
    framework: fws.join(' + ') || 'unknown',
    kind: 'external',
    status: 'running',
    phase: 'queued',
    startedAt: new Date().toISOString(),
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, timedOut: 0, interrupted: 0, flaky: 0 },
    suites: [],
    artifacts: {},
    repo: {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      owner: repo.owner,
      branch: repo.branch,
      commitSha: repo.commitSha,
      framework: fws.join(' + ') || 'unknown',
      command: det.testCommand?.display,
    },
    config: {
      layer,
      testScript: det.testCommand?.script || undefined,
      targetBaseUrl: repo.settings?.targetBaseUrl,
      targetApiUrl: repo.settings?.targetApiUrl,
      envNames: repo.settings?.env ? Object.keys(repo.settings.env) : undefined,
      installScripts: repo.settings?.allowInstallScripts ? 'enabled' : 'disabled',
    },
  };

  activeRepoLocks.add(repo.id);
  try {
    trackActiveRun(run);
    saveRunResult(run);
    emitRunEvent(runId, 'run_started', {
      status: 'running',
      phase: 'queued',
      message: `Run ${runId} started for ${repo.owner}/${repo.repo}@${repo.branch}`,
    });
  } catch (err) {
    // Could not even record the run: release everything so the repository is not locked forever.
    activeRepoLocks.delete(repo.id);
    untrackActiveRun(runId);
    throw new ExternalRunError(500, `Could not start the run: ${err instanceof Error ? err.message : String(err)}`);
  }
  executeExternalRun(repo, run, layer, options.expectedCommitSha).catch((err) => {
    // executeExternalRun is written not to reject; this is the last line of defence against a run stuck in "running".
    console.error(`[EXTERNAL RUN ${runId}] unexpected rejection:`, err);
    forceFinishRun(run, err);
  });
  return run;
}

/** Last-resort finalizer used only when the pipeline itself threw past all of its own handling. */
function forceFinishRun(run: NormalizedTestRun, err: unknown): void {
  try {
    if (run.status === 'running' || run.status === 'queued') {
      run.status = 'error';
      run.failureKind = 'infrastructure';
      run.errorMessage = `Unexpected platform error: ${err instanceof Error ? err.message : String(err)}`;
      run.phase = 'done';
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      saveRunResult(run);
      emitRunEvent(run.runId, 'run_failed', { status: 'error', message: run.errorMessage, phase: 'done' });
    }
  } catch {
    // nothing else we can do
  } finally {
    activeRepoLocks.delete(run.appId);
    untrackActiveRun(run.runId);
    void cleanupRunProcesses(run.runId);
  }
}

/** Runs `fn`, never throws; reports the failure through `onError`. */
function attempt(fn: () => void, onError: (msg: string) => void): void {
  try {
    fn();
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}

/* ---------------------------------------------------------------------------
 * Pipeline
 * ------------------------------------------------------------------------- */

interface ReporterInjection {
  args: string[];
  env: Record<string, string>;
  framework: 'vitest' | 'jest' | 'playwright';
}

/** Reporter flags the platform may add so the run produces a machine-readable report. Only for plain single-framework commands. */
function reporterInjection(kind: string | undefined, detection: RepoDetection, wsRepoDir: string): ReporterInjection | null {
  const out = path.join(wsRepoDir, PLATFORM_REPORT_DIR);
  if (kind === 'vitest') {
    return { framework: 'vitest', args: ['--reporter=default', '--reporter=json', `--outputFile.json=${path.join(out, 'vitest.json')}`], env: {} };
  }
  if (kind === 'jest') {
    return { framework: 'jest', args: ['--json', `--outputFile=${path.join(out, 'jest.json')}`], env: {} };
  }
  if (kind === 'playwright' && !detection.reporters.includes('json') && !detection.reporters.includes('junit')) {
    return { framework: 'playwright', args: ['--reporter=list,json'], env: { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(out, 'playwright.json') } };
  }
  return null;
}

async function executeExternalRun(initialRepo: ExternalRepo, run: NormalizedTestRun, layer: RunScopeLayer, expectedCommitSha?: string): Promise<void> {
  const runId = run.runId;
  const runDir = getRunDir(runId);
  const secrets = [...collectProcessSecrets(), ...secretValuesOf(initialRepo.settings)];
  const logger = createRunLogger(runId, secrets);
  const plat = (msg: string) => logger.log(`[PLATFORM] ${msg}\n`, 'platform');
  const sanitize = (s: string) => sanitizeLogText(s, secrets);
  const started = Date.now();

  const wsRoot = assertInside(WORKSPACES_DIR, path.join(WORKSPACES_DIR, runId));
  const wsRepoDir = path.join(wsRoot, 'repo');
  // Per-run TMPDIR. Deliberately NOT inside wsRoot: it must stay short (see runTmp.ts) so tools that
  // bind a Unix socket below it (tsx's IPC pipe) work regardless of how deep the workspace is.
  let runTmpDir: string | null = null;
  const outputTail = new TailBuffer(8192);

  const setPhase = (phase: RunPhase) => {
    run.phase = phase;
    saveRunResult(run);
  };
  const persist = () => saveRunResult(run);

  let repo = initialRepo;
  let finalStatus: RunStatus = 'error';
  let stageError: StageError | null = null;
  let exitCode: number | null = null;
  let testTimedOut = false;
  let headedViolation: string | null = null;
  let configText = '';
  let tracker: LayerProgressTracker | null = null;
  let detection: RepoDetection | null = null;
  let injection: ReporterInjection | null = null;
  let finalized = false;

  try {
    try {
      // ---- 1. clone / fetch ------------------------------------------------------
      setPhase('cloning');
      plat(`Preparing ${repo.owner}/${repo.repo} @ ${repo.branch}`);
      emitRunEvent(runId, 'clone_started', { phase: 'cloning', message: `Fetching ${repo.url} (${repo.branch})` });
      let sha: string;
      try {
        sha = await fetchRepo(repo.id, repo.url, repo.branch, {
          trackId: runId,
          onOutput: (chunk, stream) => logger.log(chunk, stream),
        });
      } catch (err) {
        throw new StageError('cloning', err instanceof Error ? err.message : String(err));
      }
      if (isCancelled(runId)) throw new StageError('cloning', 'Run cancelled by user.');
      // Trust is bound to one commit. If the branch moved since the user trusted it, refuse to run unreviewed code.
      if (repo.trustedSha && repo.trustedSha !== sha) {
        updateRepo(repo.id, (r) => {
          delete r.trustedAt;
          delete r.trustedSha;
          r.commitSha = sha;
          r.lastFetchedAt = new Date().toISOString();
        });
        throw new StageError(
          'cloning',
          `Trust revoked: the branch moved from the trusted commit ${repo.trustedSha.slice(0, 12)} to ${sha.slice(0, 12)}. Nothing was executed. Review the new commit and confirm trust again.`
        );
      }
      if (expectedCommitSha && expectedCommitSha !== sha) {
        updateRepo(repo.id, { commitSha: sha, lastFetchedAt: new Date().toISOString() });
        throw new StageError(
          'cloning',
          `The repository changed after tests were discovered (discovered ${expectedCommitSha.slice(0, 12)}, now ${sha.slice(0, 12)}). Nothing was executed. Run Fetch Tests again to discover the new commit.`
        );
      }
      repo = updateRepo(repo.id, { commitSha: sha, lastFetchedAt: new Date().toISOString() }) || repo;
      run.repo = { ...run.repo!, commitSha: sha };
      plat(`Checked out commit ${sha}`);
      emitRunEvent(runId, 'clone_completed', { phase: 'cloning', message: `Commit ${sha.slice(0, 12)}` });

      // Re-detect: the repository may have changed since it was registered; honour the requested layer when choosing the script.
      const cacheDir = repoCacheDir(repo.id);
      detection = detectRepository(cacheDir, { ...repo.settings, layer: layer === 'all' ? undefined : layer });
      repo = updateRepo(repo.id, { detection }) || repo;
      if (!detection.supported) {
        throw new StageError('cloning', `Repository is no longer runnable: ${detection.problems.join(' ')}`);
      }
      const fws = frameworksOf(detection);
      const usesPlaywright = fws.includes('playwright');
      run.framework = fws.join(' + ');
      if (detection.configFile && usesPlaywright) {
        try {
          configText = fs.readFileSync(path.join(cacheDir, detection.configFile), 'utf8').slice(0, 1_000_000);
        } catch {
          configText = '';
        }
      }
      const testCommand = detection.testCommand!;
      run.repo = { ...run.repo!, command: testCommand.display, framework: fws.join(' + ') };
      run.config = { ...run.config!, testScript: testCommand.script || undefined };
      persist();

      // Playwright (browsers, discovery, headless guard) only when the repository uses it and the selected layer can include it.
      const needsPlaywright =
        usesPlaywright && (layer === 'all' || layer === 'e2e' || !detection.supportsLayerSelection || testCommand.kind === 'playwright');
      if (usesPlaywright && !needsPlaywright) plat(`Layer "${layer}" selected: Playwright setup is skipped.`);
      if (!usesPlaywright) plat('This repository does not use Playwright: no browser installation and no Playwright discovery.');

      // ---- 2. dependencies (cached per lockfile) --------------------------------------
      setPhase('installing');
      const allowScripts = !!repo.settings?.allowInstallScripts;
      const depKey = dependencyKey(cacheDir, detection.lockfile, allowScripts);
      const repoDepsRoot = assertInside(DEPS_DIR, path.join(DEPS_DIR, repo.id));
      const templateDir = assertInside(DEPS_DIR, path.join(repoDepsRoot, depKey));
      const marker = path.join(templateDir, '.platform-prepared.json');
      let tmpInfo;
      try {
        tmpInfo = createRunTmpDir(runId);
      } catch (err) {
        throw new StageError('installing', `Could not create a temporary directory for the run: ${err instanceof Error ? err.message : String(err)}`);
      }
      runTmpDir = tmpInfo.dir;
      const probe = await probeSocketSupport(tmpInfo.dir);
      if (!probe.ok) {
        throw new StageError(
          'installing',
          `The run temporary directory ${tmpInfo.dir} cannot host a Unix-domain socket (${probe.error}). Test runners such as tsx would fail to start. Set PLATFORM_TMP_BASE to a short, writable local directory (e.g. /tmp).`
        );
      }
      plat(`Temporary directory (TMPDIR/TMP/TEMP): ${tmpInfo.dir} [${tmpInfo.dir.length} chars; Unix-socket headroom ${Number.isFinite(tmpInfo.socketHeadroom) ? tmpInfo.socketHeadroom : 'n/a'}]`);
      const runEnv = runEnvFromSettings(repo.settings, layer);
      const sandboxEnv = buildSandboxEnv({ tmpDir: tmpInfo.dir, extra: runEnv });
      const configuredEnv = Object.keys(runEnv).filter((k) => k !== 'TEST_LAYER');
      plat(`Run configuration: layer=${layer}; script=${testCommand.script || `(${testCommand.display})`}; env=[TEST_LAYER${configuredEnv.length ? `, ${configuredEnv.join(', ')}` : ''}] (values not logged); npm lifecycle scripts ${allowScripts ? 'ENABLED' : 'disabled'}.`);

      emitRunEvent(runId, 'install_started', { phase: 'installing' });
      await ensureDependencyTemplate({
        runId,
        repoId: repo.id,
        sha,
        detection,
        depKey,
        templateDir,
        repoDepsRoot,
        marker,
        allowScripts,
        sandboxEnv,
        plat,
        onOutput: (chunk, stream) => logger.log(chunk, stream),
      });
      emitRunEvent(runId, 'install_completed', { phase: 'installing' });

      // ---- 3. browsers (Playwright repositories only; version-aware, skipped when already present) ------
      setPhase('browsers');
      if (needsPlaywright) {
        emitRunEvent(runId, 'browser_install_started', { phase: 'browsers' });
        const pwBin = path.join(templateDir, 'node_modules', '.bin', 'playwright');
        if (!fs.existsSync(pwBin)) {
          throw new StageError('browsers', 'Playwright CLI not found after installing dependencies (node_modules/.bin/playwright).');
        }
        const browsers = detection.browsers.length ? detection.browsers : ['chromium'];
        const missing = await browsersMissing(runId, pwBin, templateDir, browsers, sandboxEnv);
        if (missing === false) {
          plat(`Required Playwright browser(s) [${browsers.join(', ')}] for Playwright ${detection.playwrightVersion} already installed in ${playwrightBrowsersPath()}; skipping download.`);
        } else {
          plat(`Installing Playwright browser(s): ${browsers.join(', ')} (Playwright ${detection.playwrightVersion}) ...`);
          const inst = await runTrackedCommand({
            runId,
            label: 'playwright-install',
            command: pwBin,
            args: ['install', ...browsers],
            cwd: templateDir,
            env: sandboxEnv,
            timeoutMs: TIMEOUTS.browserInstallMs,
            onOutput: (chunk, stream) => logger.log(chunk, stream),
          });
          if (inst.timedOut) {
            throw new StageError('browsers', `Browser installation timed out after ${Math.round(TIMEOUTS.browserInstallMs / 1000)}s.`, true);
          }
          if (isCancelled(runId)) throw new StageError('browsers', 'Run cancelled by user.');
          if (inst.exitCode !== 0) {
            throw new StageError('browsers', `\`playwright install ${browsers.join(' ')}\` failed with exit code ${inst.exitCode}.`);
          }
        }
        emitRunEvent(runId, 'browser_install_completed', { phase: 'browsers' });
      } else {
        plat('Browser setup skipped (no Playwright in this run).');
      }

      // ---- 4. per-run workspace -----------------------------------------------------------
      plat('Creating isolated per-run workspace (exact commit + cached node_modules)...');
      fs.mkdirSync(wsRoot, { recursive: true });
      await exportCheckout(repo.id, sha, wsRepoDir, runId);
      await cloneDirectory(path.join(templateDir, 'node_modules'), path.join(wsRepoDir, 'node_modules'));
      if (isCancelled(runId)) throw new StageError('testing', 'Run cancelled by user.');

      // ---- 5. runtime discovery (the framework's own listing; never a regex estimate) --------------
      setPhase('testing');
      let queue: QueueItem[] = [];
      if (needsPlaywright) {
        const wsPwBin = path.join(wsRepoDir, 'node_modules', '.bin', 'playwright');
        queue = await discoverQueue(runId, wsPwBin, wsRepoDir, sandboxEnv, plat);
        if (queue.length > 0) {
          plat(`Runtime discovery: ${queue.length} Playwright test(s) found via \`playwright test --list\`.`);
          // A dedicated "Fetch Tests" discovery of this commit is more complete (all layers): never replace it with this partial count.
          const existing = getRepo(repo.id)?.discovery;
          if (existing?.details && existing.commitSha === sha) {
            plat('Keeping the existing "Fetch Tests" discovery for this commit.');
          } else updateRepo(repo.id, {
            discovery: {
              discoveredAt: new Date().toISOString(),
              commitSha: sha,
              source: 'playwright test --list',
              byLayer: { e2e: queue.length },
              total: queue.length,
            },
          });
        }
      }
      const defaultLayer: TestLayer = layer !== 'all' ? layer : usesPlaywright && fws.length === 1 ? 'e2e' : 'unit';
      tracker = new LayerProgressTracker(
        queue,
        (type, payload) => emitRunEvent(runId, type, { ...payload, phase: 'testing' }),
        { playwrightOnly: testCommand.kind === 'playwright', initialLayer: testCommand.kind === 'runner' ? undefined : defaultLayer }
      );

      // ---- 6. execute the repository's real test command ----------------------------------------------
      const testTimeout = Math.min(repo.settings?.testTimeoutMs || TIMEOUTS.testMs, MAX_TEST_TIMEOUT_MS);
      injection = reporterInjection(testCommand.kind, detection, wsRepoDir);
      if (injection) fs.mkdirSync(path.join(wsRepoDir, PLATFORM_REPORT_DIR), { recursive: true });
      const bin = (name: string) => path.join(wsRepoDir, 'node_modules', '.bin', name);
      let command: string;
      let args: string[];
      if (testCommand.script) {
        command = 'npm';
        args = testCommand.script === 'test' ? ['test'] : ['run', testCommand.script];
        if (injection?.args.length) args = [...args, '--', ...injection.args];
      } else {
        const fw = testCommand.kind === 'jest' ? 'jest' : testCommand.kind === 'vitest' ? 'vitest' : 'playwright';
        command = bin(fw);
        args = fw === 'playwright' ? ['test'] : fw === 'vitest' ? ['run'] : [];
        if (injection?.args.length) args = [...args, ...injection.args];
      }
      const testEnv = { ...sandboxEnv, ...(injection?.env ?? {}) };
      plat(`Executing: ${testCommand.display}${injection ? ` (+ platform reporter flags: ${injection.args.join(' ').replace(wsRepoDir, '<workspace>')})` : ''} (${needsPlaywright ? 'headless, ' : ''}CI=1, timeout ${Math.round(testTimeout / 1000)}s) in ${path.basename(wsRoot)}/repo`);

      const guard = needsPlaywright
        ? startHeadlessGuard({
            onHeaded: (cmd) => {
              if (headedViolation) return;
              headedViolation = cmd;
              plat(`SAFETY ABORT: a visible (headed) browser was detected: ${cmd}`);
              void cleanupRunProcesses(runId);
            },
            onHeadless: (f) =>
              plat(`Headless check: ${f.headless} Playwright browser process(es) running in headless mode (no visible window).`),
          })
        : null;
      tracker.start();
      let testResult;
      try {
        testResult = await runTrackedCommand({
          runId,
          label: 'tests',
          command,
          args,
          cwd: wsRepoDir,
          env: testEnv,
          timeoutMs: testTimeout,
          onOutput: (chunk, stream) => {
            logger.log(chunk, stream);
            outputTail.push(stream, chunk);
            if (stream === 'stdout') tracker!.feed(chunk);
          },
        });
      } finally {
        const f = guard?.stop();
        if (f) {
          if (f.headless > 0 && f.headed === 0) plat(`Headless verification: observed ${f.headless} headless browser process(es), 0 headed.`);
          else if (f.headless === 0 && f.headed === 0) plat('Headless verification: no browser process was sampled during the run (sampling is periodic).');
        }
      }
      exitCode = testResult.exitCode;
      testTimedOut = testResult.timedOut;
      plat(`Test command finished: exit code ${exitCode ?? 'null'}${testResult.signal ? ` (signal ${testResult.signal})` : ''}${testTimedOut ? ' — TIMED OUT' : ''}.`);
    } catch (err) {
      stageError = err instanceof StageError ? err : new StageError(run.phase || 'testing', err instanceof Error ? err.message : String(err));
      plat(`ERROR (${stageError.stage}): ${stageError.message}`);
    }

    // ---- 7. collect + parse (also for failed/cancelled/timed-out runs) --------------------------
    try {
      setPhase('collecting');
      if (fs.existsSync(wsRepoDir)) {
        const fws = detection ? frameworksOf(detection) : [];
        const defaultLayer: TestLayer = layer !== 'all' ? layer : fws.length === 1 && fws[0] === 'playwright' ? 'e2e' : 'unit';
        const collected = collectArtifacts({
          workspaceRepoDir: wsRepoDir,
          runDir,
          configText,
          sanitize,
          defaultLayer,
          injectedFramework: injection?.framework,
        });
        run.suites = collected.suites;
        if (tracker) {
          const merged = applyFlakyObservations(run.suites, tracker.flakyObservations());
          if (merged > 0) plat(`Retry history: ${merged} test(s) needed retries (taken from the runner's own output).`);
        }
        run.summary = summarizeSuites(collected.suites);
        run.issues = collected.issues.length ? collected.issues : undefined;
        if (collected.issues.length) run.summary.issues = collected.issues.length;
        run.artifacts = {
          ...run.artifacts,
          htmlReport: collected.hasHtmlReport,
          resultsJson: collected.hasResultsJson,
          junitXml: collected.hasJunitXml,
          layerFiles: collected.layerFiles.length ? collected.layerFiles : undefined,
          rawReportPath:
            collected.source === 'standard'
              ? collected.layerFiles.find((f) => f.startsWith('results.')) || collected.layerFiles[0]
              : collected.hasResultsJson ? 'results.json' : collected.hasJunitXml ? 'junit.xml' : undefined,
        };
        if (collected.infraErrors.length) run.infraErrors = collected.infraErrors.map((e) => sanitize(e));
        if (collected.notes.length) run.notes = collected.notes.map((n) => sanitize(n));
        for (const n of collected.notes) plat(n);
        if (collected.source !== 'none') {
          plat(
            `Parsed ${run.summary.total} test result(s) from ${
              collected.source === 'standard' ? `layer reports [${collected.layers.join(', ')}]` : collected.source === 'json' ? 'results.json' : collected.source === 'vitest-json' ? 'Vitest/Jest JSON report' : 'junit.xml'
            }.`
          );
        }
        for (const e of collected.globalErrors) logger.log(`[REPORT ERROR] ${e}\n`, 'platform');
        if (collected.globalErrors.length && !stageError && !isCancelled(runId)) {
          run.errorMessage = collected.globalErrors[0].split('\n')[0].slice(0, 500);
        }
        // The layer(s) that actually produced results, not a hardcoded guess.
        const layersSeen = Array.from(new Set(run.suites.filter((x) => x.cases.length > 0).map((x) => x.layer)));
        if (layersSeen.length === 1) run.layer = layersSeen[0];
        else if (layersSeen.length > 1) run.layer = 'all';
      }
    } catch (err) {
      plat(`Could not collect artifacts: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- 8. final status ----------------------------------------------------------------------
    const s = run.summary;
    const testTimeoutSeconds = Math.round(Math.min(repo.settings?.testTimeoutMs || TIMEOUTS.testMs, MAX_TEST_TIMEOUT_MS) / 1000);
    const outcome = classifyRunOutcome({
      cancelled: isCancelled(runId),
      headedViolation,
      stageError: stageError ? { stage: stageError.stage, message: stageError.message, timedOut: stageError.timedOut } : null,
      testTimedOut,
      testTimeoutSeconds,
      exitCode,
      summary: s,
      infraErrors: run.infraErrors ?? [],
      outputTail: sanitize(outputTail.text()),
      executionIssues: (run.issues ?? []).filter((i) => !i.infrastructure).length,
    });
    finalStatus = outcome.status;
    // A report-level errorMessage (e.g. a Playwright global error) is kept when the outcome has none of its own.
    run.errorMessage = outcome.errorMessage ?? (finalStatus === 'passed' ? undefined : run.errorMessage);
    run.failureStage = outcome.failureStage;
    run.failureKind = outcome.failureKind;
    run.errorDetail = outcome.errorDetail;
    if (outcome.timedOut) run.timedOut = true;

    if (finalStatus === 'error' && run.failureKind === 'infrastructure' && !isCancelled(runId)) {
      plat(`INFRA_ERROR (${run.failureStage ?? 'unknown'}): ${run.errorMessage}`);
      if (run.errorDetail) {
        logger.log(`[INFRA_ERROR] Last output of the failing command (exit code ${exitCode ?? 'null'}):\n${run.errorDetail}\n`, 'platform');
      }
    }
    finalized = true;
  } catch (unexpected) {
    // Anything the stage handlers did not anticipate: keep the real error, never leave the run "running".
    const msg = unexpected instanceof Error ? unexpected.message : String(unexpected);
    plat(`UNEXPECTED PLATFORM ERROR: ${msg}`);
    run.errorMessage = sanitize(`Unexpected platform error: ${msg}`);
    run.failureKind = 'infrastructure';
    run.failureStage = run.phase && run.phase !== 'done' ? run.phase : 'testing';
    finalStatus = isCancelled(runId) ? 'cancelled' : 'error';
    finalized = true;
  } finally {
    // ---- 9. cleanup + persist (always runs) ---------------------------------------------------------
    const warn = (what: string) => (msg: string) => attempt(() => plat(`${what}: ${msg}`), () => undefined);
    attempt(() => plat('Cleaning up platform-spawned processes and the temporary workspace...'), () => undefined);
    try {
      await cleanupRunProcesses(runId);
    } catch (err) {
      warn('Process cleanup warning')(err instanceof Error ? err.message : String(err));
    }
    attempt(() => fs.rmSync(wsRoot, { recursive: true, force: true }), warn('Workspace cleanup warning'));
    if (runTmpDir) {
      const dir = runTmpDir;
      attempt(() => {
        const cleaned = removeRunTmpDir(dir);
        if (!cleaned.removed) plat(`Temporary directory cleanup warning: ${cleaned.reason}`);
      }, warn('Temporary directory cleanup warning'));
    }

    if (!finalized) finalStatus = 'error';
    run.exitCode = exitCode;
    run.status = finalStatus;
    run.phase = 'done';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - started;
    run.artifacts.logPath = 'run.log';

    // Unified HTML report: built from this run's normalized result, kept in the run directory (survives workspace cleanup).
    attempt(() => {
      const report = writeUnifiedReport(runDir, run, { nativeReportAvailable: !!run.artifacts.htmlReport });
      run.artifacts.unifiedReport = report.ok;
      if (report.ok) plat('Unified HTML report written (report.html).');
      else {
        run.artifacts.unifiedReportNote = report.reason;
        plat(`No unified HTML report was generated: ${report.reason}`);
      }
    }, (msg) => {
      run.artifacts.unifiedReport = false;
      run.artifacts.unifiedReportNote = `Report generation failed: ${msg}`;
    });

    attempt(() => saveRunResult(run), (msg) => console.error(`[EXTERNAL RUN ${runId}] could not persist result: ${msg}`));
    attempt(() => {
      const s = run.summary;
      const patch: Partial<ExternalRepo> = { lastRun: { runId, status: finalStatus, finishedAt: run.finishedAt } };
      if (s.total > 0 && finalStatus !== 'cancelled') {
        // Merge per layer: a unit-only run replaces the unit numbers and keeps what the last full run said about the rest.
        const prev = getRepo(run.appId)?.lastExecution;
        const byLayer = { ...(prev?.byLayer ?? {}), ...(s.byLayer ?? {}) };
        const layerRuns = { ...(prev?.layerRuns ?? {}) };
        for (const l of Object.keys(s.byLayer ?? {}) as TestLayer[]) {
          layerRuns[l] = { runId, executedAt: run.finishedAt!, commitSha: run.repo?.commitSha };
        }
        const sum = Object.values(byLayer).reduce(
          (a, l) => ({
            total: a.total + l.total,
            passed: a.passed + l.passed,
            failed: a.failed + l.failed + (l.timedOut ?? 0) + (l.interrupted ?? 0),
            skipped: a.skipped + l.skipped,
            errors: a.errors + l.errors,
          }),
          { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 }
        );
        patch.lastExecution = { runId, executedAt: run.finishedAt!, commitSha: run.repo?.commitSha, ...sum, byLayer, layerRuns };
      }
      updateRepo(run.appId, patch);
      // The card text quotes executed/discovered counts: rebuild it from the state we just wrote so it can never lag a run behind.
      const latest = getRepo(run.appId);
      if (latest?.status === 'ready' && latest.detection?.supported) updateRepo(run.appId, { statusMessage: describeDetection(latest.detection, latest) });
    }, () => undefined);
    attempt(() => {
      const s = run.summary;
      plat(
        `Run ${finalStatus === 'error' ? 'INFRA_ERROR' : finalStatus.toUpperCase()}: ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.errors} errors, ${s.skipped} skipped${s.issues ? `, ${s.issues} execution issue(s)` : ''} in ${((run.durationMs || 0) / 1000).toFixed(1)}s.`
      );
    }, () => undefined);
    attempt(
      () =>
        emitRunEvent(runId, finalStatus === 'passed' ? 'run_completed' : finalStatus === 'cancelled' ? 'run_cancelled' : 'run_failed', {
          status: finalStatus,
          summary: run.summary,
          message: run.errorMessage,
          phase: 'done',
        }),
      () => undefined
    );
    // Release the repository and the active-run slot no matter what happened above.
    activeRepoLocks.delete(run.appId);
    untrackActiveRun(runId);
    attempt(() => pruneRunHistory(), () => undefined);
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** True/array when Playwright reports a browser that is not installed; false when everything is present. */
async function browsersMissing(
  runId: string,
  pwBin: string,
  cwd: string,
  browsers: string[],
  env: Record<string, string>
): Promise<boolean> {
  let out = '';
  const res = await runTrackedCommand({
    runId,
    label: 'playwright-dry-run',
    command: pwBin,
    args: ['install', '--dry-run', ...browsers],
    cwd,
    env,
    timeoutMs: 60_000,
    onOutput: (chunk, stream) => {
      if (stream === 'stdout') out += chunk;
    },
  });
  if (res.exitCode !== 0) return true; // unknown → let `playwright install` decide (idempotent)
  const locations = Array.from(out.matchAll(/Install location:\s+(.+)/g)).map((m) => m[1].trim());
  if (locations.length === 0) return true;
  return !locations.every((loc) => fs.existsSync(path.join(loc, 'INSTALLATION_COMPLETE')));
}

async function discoverQueue(
  runId: string,
  pwBin: string,
  cwd: string,
  env: Record<string, string>,
  plat: (msg: string) => void
) {
  let stdout = '';
  try {
    const res = await runTrackedCommand({
      runId,
      label: 'playwright-list',
      command: pwBin,
      args: ['test', '--list', '--reporter=json'],
      cwd,
      env,
      timeoutMs: 120_000,
      onOutput: (chunk, stream) => {
        if (stream === 'stdout') stdout += chunk;
      },
    });
    if (res.exitCode !== 0) {
      plat(`Test discovery (--list) exited ${res.exitCode}; continuing without a precomputed test queue.`);
      return [];
    }
    return queueFromListJson(JSON.parse(stdout));
  } catch (err) {
    plat(`Test discovery failed (${err instanceof Error ? err.message : String(err)}); continuing without a precomputed test queue.`);
    return [];
  }
}

export interface EnsureDependenciesOptions {
  /** Id used to track (and cancel) the spawned processes. */
  runId: string;
  repoId: string;
  sha: string;
  detection: RepoDetection;
  depKey: string;
  templateDir: string;
  repoDepsRoot: string;
  marker: string;
  allowScripts: boolean;
  sandboxEnv: Record<string, string>;
  plat: (msg: string) => void;
  onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/** Installs the repository's dependencies into the per-lockfile template unless it already exists. Throws StageError('installing'). */
export async function ensureDependencyTemplate(o: EnsureDependenciesOptions): Promise<void> {
  const { runId, detection, depKey, templateDir, marker, allowScripts, plat } = o;
  if (fs.existsSync(marker)) {
    plat(`Dependencies already installed for this lockfile (cache key ${depKey}); skipping npm install.`);
    return;
  }
  plat(`Installing dependencies (cache key ${depKey}) with ${detection.lockfile ? 'npm ci' : 'npm install'}${allowScripts ? '' : ' --ignore-scripts'} ...`);
  fs.rmSync(templateDir, { recursive: true, force: true });
  await exportCheckout(o.repoId, o.sha, templateDir, runId);
  const installArgs = [
    detection.lockfile ? 'ci' : 'install',
    '--no-audit',
    '--no-fund',
    // Dependency lifecycle scripts (preinstall/install/postinstall) of a public repository and of ALL its
    // transitive dependencies are arbitrary code. They stay off unless the user opted in for this repository.
    ...(allowScripts ? [] : ['--ignore-scripts']),
  ];
  const install = await runTrackedCommand({
    runId,
    label: 'npm-install',
    command: 'npm',
    args: installArgs,
    cwd: templateDir,
    env: o.sandboxEnv,
    timeoutMs: TIMEOUTS.installMs,
    onOutput: o.onOutput,
  });
  if (install.timedOut) {
    fs.rmSync(templateDir, { recursive: true, force: true });
    throw new StageError('installing', `Dependency installation timed out after ${Math.round(TIMEOUTS.installMs / 1000)}s.`, true);
  }
  if (isCancelled(runId)) {
    fs.rmSync(templateDir, { recursive: true, force: true });
    throw new StageError('installing', 'Run cancelled by user.');
  }
  if (install.exitCode !== 0) {
    fs.rmSync(templateDir, { recursive: true, force: true });
    throw new StageError(
      'installing',
      `\`npm ${installArgs[0]}\` failed with exit code ${install.exitCode}. Check the log above (lockfile out of sync, network${allowScripts ? '' : ', or a dependency that needs its install script — enable "Allow npm install scripts" for this repository if it does'}).`
    );
  }
  fs.writeFileSync(marker, JSON.stringify({ preparedAt: new Date().toISOString(), commit: o.sha, key: depKey, scripts: allowScripts }), 'utf8');
  // Prune stale templates of this repository.
  for (const other of fs.readdirSync(o.repoDepsRoot)) {
    if (other !== depKey) fs.rmSync(path.join(o.repoDepsRoot, other), { recursive: true, force: true });
  }
}

/** Copies a directory using copy-on-write where the OS supports it (APFS/btrfs), else a normal copy. */
export async function cloneDirectory(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  const attempt = (args: string[]) =>
    new Promise<boolean>((resolve) => {
      const child = spawn('cp', args, { stdio: 'ignore', shell: false });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  fs.rmSync(dest, { recursive: true, force: true });
  if (process.platform === 'darwin' && (await attempt(['-cR', src, dest]))) return;
  if (process.platform === 'linux' && (await attempt(['-R', '--reflink=auto', src, dest]))) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}
