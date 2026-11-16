import fs from 'fs';
import path from 'path';
import { DEPS_DIR, WORKSPACES_DIR } from '../config';
import { assertInside } from '../lib/fsSafe';
import { stripAnsi } from '../lib/ansi';
import { DiscoveryState, ExternalRepo, RepoDetection, RepoDiscovery, TestFramework, TestLayer } from '../types';
import {
  DISCOVERY_LAYERS,
  ListedTest,
  Observation,
  classifyObservations,
  extractJson,
  parseJestFiles,
  parsePlaywrightList,
  parseVitestList,
  testKey,
} from './discoveryParsers';
import { StageError, acquireRepoLock, cloneDirectory, ensureDependencyTemplate, releaseRepoLock } from './externalExecutor';
import { exportCheckout, fetchRepo, repoCacheDir } from './gitService';
import { collectProcessSecrets, sanitizeLogText } from './logSanitizer';
import { cleanupRunProcesses, runTrackedCommand } from './processManager';
import { dependencyKey, detectRepository, TEST_DECL_RE } from './repoDetector';
import { getRepo, listRepos, updateRepo } from './repoRegistry';
import { describeDetection } from './repoStatus';
import { runEnvFromSettings, secretValuesOf } from './repoSettings';
import { buildSandboxEnv } from './sandboxEnv';
import { createRunTmpDir, removeRunTmpDir } from './runTmp';

export class DiscoveryError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const LIST_TIMEOUT_MS = 180_000;
const MAX_ISSUES = 8;

function frameworksOf(d: RepoDetection): TestFramework[] {
  return d.frameworks?.length ? d.frameworks : d.framework ? [d.framework] : [];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Entry point of POST /api/repos/:id/discover. Validates synchronously (so the UI gets an immediate, specific error)
 * and runs the job in the background; progress/outcome are reported through `repo.discoveryState`.
 *
 * Listing loads the repository's own config and test files (Playwright/Vitest import them), which is repository code
 * running on this machine — so discovery requires the same per-commit trust as execution. It never runs a test body.
 */
export function startDiscovery(repoId: string): ExternalRepo {
  const repo = getRepo(repoId);
  if (!repo) throw new DiscoveryError(404, `Repository '${repoId}' not found.`);
  if (repo.status === 'connecting') throw new DiscoveryError(409, 'Repository is still connecting. Wait until it is ready.', 'CONNECTING');
  if (repo.status !== 'ready' || !repo.detection?.supported) {
    const why = repo.detection?.problems?.join(' ') || repo.statusMessage || 'Repository is not in a supported state.';
    throw new DiscoveryError(422, `Tests cannot be discovered: ${why}`, 'UNSUPPORTED');
  }
  if (!repo.trustedAt || !repo.trustedSha || repo.trustedSha !== repo.commitSha) {
    throw new DiscoveryError(
      403,
      'Discovering tests loads the repository\'s test configuration and test files on this machine. Confirm trust for the current commit first.',
      'NOT_TRUSTED'
    );
  }
  if (!acquireRepoLock(repo.id)) {
    throw new DiscoveryError(409, `A test run or test discovery is already in progress for ${repo.name}.`, 'BUSY');
  }
  const state: DiscoveryState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    commitSha: repo.commitSha,
    message: 'Preparing discovery…',
  };
  const updated = updateRepo(repo.id, { discoveryState: state }) || repo;
  void runDiscovery(repo.id).catch((err) => {
    // runDiscovery reports its own failures; this guards against the job dying silently with the repo locked.
    console.error(`[DISCOVERY ${repo.id}] unexpected rejection:`, err);
    finish(repo.id, { status: 'failed', error: `Unexpected platform error: ${errMessage(err)}` });
    releaseRepoLock(repo.id);
  });
  return updated;
}

function setMessage(repoId: string, message: string): void {
  updateRepo(repoId, (r) => {
    if (r.discoveryState?.status === 'running') r.discoveryState.message = message;
  });
}

function finish(repoId: string, patch: Partial<DiscoveryState> & { status: DiscoveryState['status'] }): void {
  updateRepo(repoId, (r) => {
    r.discoveryState = {
      ...(r.discoveryState ?? { startedAt: new Date().toISOString() }),
      ...patch,
      finishedAt: new Date().toISOString(),
    };
  });
}

/** Repositories left `running` by a previous process: that job is gone. */
export function recoverInterruptedDiscoveries(): number {
  let n = 0;
  for (const r of listRepos()) {
    if (r.discoveryState?.status === 'running') {
      finish(r.id, { status: 'failed', error: 'The backend restarted while tests were being discovered. Run Fetch Tests again.' });
      n += 1;
    }
  }
  return n;
}

async function runDiscovery(repoId: string): Promise<void> {
  const jobId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const initial = getRepo(repoId);
  if (!initial) {
    releaseRepoLock(repoId);
    return;
  }
  const secrets = [...collectProcessSecrets(), ...secretValuesOf(initial.settings)];
  const wsRoot = assertInside(WORKSPACES_DIR, path.join(WORKSPACES_DIR, jobId));
  const wsRepoDir = path.join(wsRoot, 'repo');
  let tmpDir: string | null = null;
  const issues: string[] = [];
  const addIssue = (msg: string) => {
    const clean = sanitizeLogText(stripAnsi(msg), secrets).trim();
    if (clean && issues.length < MAX_ISSUES && !issues.includes(clean)) issues.push(clean);
  };
  const log = (_m: string) => undefined; // discovery output is summarised into state/issues, not into run logs

  try {
    // ---- 1. current commit -------------------------------------------------------------------
    setMessage(repoId, 'Fetching the repository…');
    let sha: string;
    try {
      sha = await fetchRepo(repoId, initial.url, initial.branch, { trackId: jobId });
    } catch (err) {
      throw new StageError('cloning', errMessage(err));
    }
    if (!getRepo(repoId)) {
      return; // removed meanwhile (deleteRepository refuses while locked, so this is only a safety net)
    }
    if (initial.trustedSha && initial.trustedSha !== sha) {
      updateRepo(repoId, (r) => {
        delete r.trustedAt;
        delete r.trustedSha;
        r.commitSha = sha;
        r.lastFetchedAt = new Date().toISOString();
      });
      throw new StageError(
        'cloning',
        `Trust revoked: the branch moved from the trusted commit ${initial.trustedSha.slice(0, 12)} to ${sha.slice(0, 12)}. Nothing was loaded. Review the new commit, trust it, then fetch tests again.`
      );
    }
    const cacheDir = repoCacheDir(repoId);
    const detection = detectRepository(cacheDir, initial.settings);
    updateRepo(repoId, (r) => {
      r.commitSha = sha;
      r.lastFetchedAt = new Date().toISOString();
      r.detection = detection;
      r.status = detection.supported ? 'ready' : 'unsupported';
    });
    if (!detection.supported) throw new StageError('cloning', `Repository is not supported: ${detection.problems.join(' ')}`);
    const frameworks = frameworksOf(detection);

    // ---- 2. dependencies (shared per-lockfile cache with the run pipeline) ----------------------------
    setMessage(repoId, 'Preparing dependencies…');
    const allowScripts = !!initial.settings?.allowInstallScripts;
    const depKey = dependencyKey(cacheDir, detection.lockfile, allowScripts);
    const repoDepsRoot = assertInside(DEPS_DIR, path.join(DEPS_DIR, repoId));
    const templateDir = assertInside(DEPS_DIR, path.join(repoDepsRoot, depKey));
    const marker = path.join(templateDir, '.platform-prepared.json');
    tmpDir = createRunTmpDir(jobId).dir;
    const baseEnv = buildSandboxEnv({ tmpDir });
    fs.mkdirSync(repoDepsRoot, { recursive: true });
    await ensureDependencyTemplate({
      runId: jobId,
      repoId,
      sha,
      detection,
      depKey,
      templateDir,
      repoDepsRoot,
      marker,
      allowScripts,
      sandboxEnv: baseEnv,
      plat: log,
      onOutput: () => undefined,
    });

    // ---- 3. throwaway workspace at the exact commit -------------------------------------------------------
    setMessage(repoId, 'Listing tests…');
    fs.mkdirSync(wsRoot, { recursive: true });
    await exportCheckout(repoId, sha, wsRepoDir, jobId);
    await cloneDirectory(path.join(templateDir, 'node_modules'), path.join(wsRepoDir, 'node_modules'));

    // ---- 4. framework-native listing -----------------------------------------------------------------------
    const scoped = !!detection.supportsLayerSelection;
    // A layer-aware repository (test:<layer> scripts / TEST_LAYER runner) decides what a layer contains from the environment:
    // list once per layer. Otherwise a single unscoped listing is the whole truth.
    const scopes: Array<TestLayer | null> = scoped ? DISCOVERY_LAYERS : [null];
    const observed = new Map<string, Observation>();
    let listedAny = false;
    let failedListings = 0;
    for (const scope of scopes) {
      const env = {
        ...baseEnv,
        ...runEnvFromSettings(initial.settings, scope ?? 'all'),
        ...(scope ? { TEST_REPORT_LAYER: scope } : {}),
      };
      for (const fw of frameworks) {
        const label = `${fw}${scope ? ` (${scope})` : ''}`;
        try {
          const tests = await listFramework(fw, wsRepoDir, env, jobId, addIssue, label);
          listedAny = true;
          const seenHere = new Map<string, number>();
          for (const t of tests) {
            const base = testKey(t);
            const n = (seenHere.get(base) ?? 0) + 1;
            seenHere.set(base, n);
            const key = `${base}#${n}`; // identical titles in one file are distinct cases
            const o = observed.get(key) ?? { test: t, seenIn: new Set<TestLayer>() };
            if (scope) o.seenIn.add(scope);
            observed.set(key, o);
          }
        } catch (err) {
          failedListings += 1;
          addIssue(`${label}: ${errMessage(err)}`);
        }
      }
    }
    if (!listedAny) throw new StageError('testing', `No framework could list its tests. ${issues.join(' | ')}`);

    // ---- 5. classify + persist ---------------------------------------------------------------------------------------
    const onlyLayerFromCounts = (l: TestLayer, byLayer: Record<TestLayer, number>) =>
      DISCOVERY_LAYERS.filter((x) => byLayer[x] > 0).length === 1 && byLayer[l] > 0;
    const first = classifyObservations(Array.from(observed.values()), () => false);
    const classified = classifyObservations(Array.from(observed.values()), (l) => scoped || onlyLayerFromCounts(l, first.byLayer));
    const partial = failedListings > 0;
    const discovery: RepoDiscovery = {
      discoveredAt: new Date().toISOString(),
      commitSha: sha,
      source: describeSource(frameworks, scoped),
      byLayer: classified.byLayer,
      total: classified.total,
      details: classified.details,
      ...(partial ? { partial: true } : {}),
      ...(issues.length ? { issues } : {}),
    };
    const current = getRepo(repoId);
    updateRepo(repoId, (r) => {
      r.discovery = discovery;
      if (current) r.statusMessage = describeDetection(r.detection!, { ...r, discovery });
    });
    finish(repoId, {
      status: partial ? 'partial' : 'completed',
      commitSha: sha,
      message: classified.total === 0 ? 'No tests were found in this repository.' : `${classified.total} test(s) discovered.`,
      error: undefined,
    });
  } catch (err) {
    const message = errMessage(err);
    finish(repoId, { status: 'failed', error: sanitizeLogText(message, secrets), message: undefined });
  } finally {
    releaseRepoLock(repoId);
    await cleanupRunProcesses(jobId).catch(() => undefined);
    fs.rmSync(wsRoot, { recursive: true, force: true });
    if (tmpDir) removeRunTmpDir(tmpDir);
  }
}

function describeSource(frameworks: TestFramework[], scoped: boolean): string {
  const cmd: Record<TestFramework, string> = {
    playwright: 'playwright test --list',
    vitest: 'vitest list --staticParse=false',
    jest: 'jest --listTests (+ static scan)',
  };
  return `${frameworks.map((f) => cmd[f]).join(' + ')}${scoped ? ' · per layer' : ''}`;
}

/** Runs one framework's own listing command in the workspace and returns the test cases it reports. */
async function listFramework(
  fw: TestFramework,
  root: string,
  env: Record<string, string>,
  jobId: string,
  addIssue: (m: string) => void,
  label: string
): Promise<ListedTest[]> {
  const bin = path.join(root, 'node_modules', '.bin', fw === 'playwright' ? 'playwright' : fw);
  if (!fs.existsSync(bin)) throw new Error(`${fw} is declared but its CLI is not installed (node_modules/.bin/${path.basename(bin)}).`);
  // Vitest's `list` parses files statically by default, which leaves it.each/for-loop generated cases unexpanded
  // (`accepts %s` counted once). --staticParse=false collects them the way a run does (still no test body executes).
  const args =
    fw === 'playwright' ? ['test', '--list', '--reporter=json'] : fw === 'vitest' ? ['list', '--json', '--staticParse=false'] : ['--listTests', '--json'];
  let stdout = '';
  let stderr = '';
  const res = await runTrackedCommand({
    runId: jobId,
    label: `${fw}-list`,
    command: bin,
    args,
    cwd: root,
    env,
    timeoutMs: LIST_TIMEOUT_MS,
    onOutput: (chunk, stream) => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    },
  });
  if (res.timedOut) throw new Error(`listing timed out after ${LIST_TIMEOUT_MS / 1000}s.`);
  if (res.exitCode !== 0) {
    if (fw === 'playwright') {
      // `playwright test --list` exits 1 for "No tests found": an empty suite, not a failure, when it reported no errors.
      try {
        const parsed = parsePlaywrightList(extractJson(stdout), root);
        if (parsed.tests.length === 0 && parsed.errors.length === 0) return [];
      } catch {
        // not JSON: a real failure, reported below
      }
    }
    const detail = stripAnsi(stderr || stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ');
    throw new Error(`\`${fw}\` listing exited with code ${res.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const json = extractJson(stdout);
  if (fw === 'playwright') {
    const parsed = parsePlaywrightList(json, root);
    for (const e of parsed.errors) addIssue(`${label}: ${e}`);
    return parsed.tests;
  }
  if (fw === 'vitest') return parseVitestList(json, root);
  // Jest cannot list test cases without running them: count the declarations in the files it would run (an ESTIMATE).
  const out: ListedTest[] = [];
  for (const file of parseJestFiles(json, root)) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      // unreadable file: counts as zero declarations
    }
    const n = Math.max((text.match(new RegExp(TEST_DECL_RE.source, 'g')) || []).length, 0);
    for (let i = 0; i < n; i += 1) out.push({ framework: 'jest', file, title: `declaration ${i + 1}`, estimated: true });
  }
  return out;
}
