import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response, Router } from 'express';
import { ExecutionMode, NormalizedTestRun, RunEvent, RunScopeLayer } from '../types';
import { getRegisteredApp } from '../services/registry';
import { cancelRun, startTestExecution } from '../services/executor';
import { ExternalRunError, startExternalRun } from '../services/externalExecutor';
import { getRepo } from '../services/repoRegistry';
import { secretValuesOf } from '../services/repoSettings';
import { collectProcessSecrets, sanitizeLogText } from '../services/logSanitizer';
import { UNIFIED_REPORT_CSP, UNIFIED_REPORT_FILE, reportBelongsToRun } from '../services/htmlReport';
import { getActiveRun, listActiveRuns } from '../services/runRegistry';
import { hasChannel, isTerminalEvent, subscribeToRun } from '../services/eventBus';
import {
  getRunDir,
  getRunResult,
  isValidRunId,
  listRunResults,
  readRunEntries,
  readRunLog,
  runDirExists,
} from '../services/runStore';
import { param } from '../lib/params';
import { listFilesRecursive, resolveRegularFileInside } from '../lib/fsSafe';

export const runsRouter = Router();

function currentRun(runId: string): NormalizedTestRun | undefined {
  return getActiveRun(runId) || getRunResult(runId) || undefined;
}

runsRouter.get('/', (_req, res) => {
  const stored = listRunResults();
  // Prefer the live in-memory object for runs that are still executing.
  const active = new Map(listActiveRuns().map((r) => [r.runId, r]));
  res.json({ runs: stored.map((r) => active.get(r.runId) || r) });
});

runsRouter.get('/:runId', (req, res) => {
  const run = currentRun(param(req, 'runId'));
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  res.json({ run, log: readRunLog(run.runId), entries: readRunEntries(run.runId) });
});

runsRouter.post('/', (req, res) => {
  const { appId, suiteId, layer, executionMode, expectedCommitSha } = (req.body ?? {}) as {
    expectedCommitSha?: string;
    appId?: string;
    suiteId?: string;
    layer?: RunScopeLayer;
    executionMode?: ExecutionMode;
  };

  if (!appId || typeof appId !== 'string') {
    res.status(400).json({ error: 'appId is required' });
    return;
  }

  // Local application?
  const app = getRegisteredApp(appId);
  if (app) {
    try {
      const run = startTestExecution(app, { suiteId, layer, executionMode });
      res.status(202).json({ run });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: msg });
    }
    return;
  }

  // Registered external GitHub repository?
  if (getRepo(appId)) {
    try {
      const run = startExternalRun(appId, { layer, expectedCommitSha: typeof expectedCommitSha === 'string' ? expectedCommitSha : undefined });
      res.status(202).json({ run });
    } catch (err: unknown) {
      if (err instanceof ExternalRunError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  res.status(404).json({ error: `No registered application or repository '${appId}'.` });
});

runsRouter.post('/:runId/cancel', async (req, res) => {
  const ok = await cancelRun(param(req, 'runId'));
  if (!ok) {
    res.status(404).json({ error: 'Active run not found or already finished' });
    return;
  }
  res.json({ cancelled: true });
});

/* ---------------------------------------------------------------------------
 * Server-Sent Events
 * ------------------------------------------------------------------------- */
runsRouter.get('/:runId/events', (req, res) => {
  const runId = param(req, 'runId');
  if (!isValidRunId(runId)) {
    res.status(400).json({ error: 'Invalid runId' });
    return;
  }
  const stored = currentRun(runId);
  if (!stored && !hasChannel(runId)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const lastEventId = Number(req.header('last-event-id') ?? req.query.since ?? 0);
  const since = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const write = (ev: RunEvent) => {
    res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };

  // Run finished earlier (e.g. before a backend restart / buffer expiry): synthesize its terminal event.
  if (!hasChannel(runId) && stored) {
    const status = stored.status;
    write({
      id: since + 1,
      runId,
      type: status === 'passed' ? 'run_completed' : status === 'cancelled' ? 'run_cancelled' : 'run_failed',
      timestamp: stored.finishedAt || new Date().toISOString(),
      status,
      summary: stored.summary,
      message: stored.errorMessage,
    });
    res.end();
    return;
  }

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15_000);

  const sub = subscribeToRun(runId, since, (ev) => {
    if (closed) return;
    write(ev);
    if (isTerminalEvent(ev.type)) {
      closed = true;
      clearInterval(heartbeat);
      setTimeout(() => res.end(), 50);
    }
  });

  if (sub.finished && !closed) {
    closed = true;
    clearInterval(heartbeat);
    res.end();
  }

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    sub.unsubscribe();
  });
});

/* ---------------------------------------------------------------------------
 * Reports and artifacts (read-only, confined to the run directory)
 * ------------------------------------------------------------------------- */
const INLINE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.mp4', '.webm', '.txt', '.log', '.md']);
const RAW_FILES = new Set(['run.log', 'stdout.log', 'stderr.log', 'results.json', 'junit.xml', 'result.json', 'summary.json']);
/** Per-layer reports preserved from layer-runner repositories (results.unit.json, junit.e2e.xml, execution.integration.log, ...). */
const LAYER_RAW_FILE = /^(results\.(unit|integration|e2e)\.json|junit\.(unit|integration|e2e)\.xml|execution\.(unit|integration|e2e)\.log)$/;
const STANDARD_RAW_NAMES = ['unit', 'integration', 'e2e'].flatMap((l) => [`results.${l}.json`, `junit.${l}.xml`, `execution.${l}.log`]);
const isRawFile = (name: string): boolean => RAW_FILES.has(name) || LAYER_RAW_FILE.test(name);

function requireKnownRun(req: Request, res: Response): string | null {
  const runId = param(req, 'runId');
  if (!isValidRunId(runId) || !runDirExists(runId) || !(currentRun(runId))) {
    res.status(404).json({ error: 'Run not found' });
    return null;
  }
  return runId;
}

function sendConfined(
  req: Request,
  res: Response,
  base: string,
  relative: string,
  mode: 'inline-all' | 'safe-inline'
): void {
  let rel = relative;
  try {
    rel = decodeURIComponent(relative);
  } catch {
    res.status(400).json({ error: 'Bad path' });
    return;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..')) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const real = resolveRegularFileInside(base, rel);
  if (!real) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const ext = path.extname(real).toLowerCase();
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'private, max-age=300');
  if (mode === 'safe-inline') {
    // Untrusted artifact: never let it run script or load resources if a browser decides to render it.
    if (ext !== '.pdf') res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    const forceDownload = req.query.download === '1' || !INLINE_TYPES.has(ext);
    res.set('Content-Disposition', `${forceDownload ? 'attachment' : 'inline'}; filename="${path.basename(real).replace(/[^\w.\- ]/g, '_')}"`);
  }
  res.sendFile(real, { dotfiles: 'allow' });
}

runsRouter.get('/:runId/files', (req, res) => {
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const dir = getRunDir(runId, false);
  const exists = (f: string) => fs.existsSync(path.join(dir, f));
  res.json({
    report: exists('playwright-report/index.html'),
    nativeReport: exists('playwright-report/index.html'),
    unifiedReport: exists(UNIFIED_REPORT_FILE),
    raw: [...Array.from(RAW_FILES), ...STANDARD_RAW_NAMES].filter(exists),
    artifacts: listFilesRecursive(path.join(dir, 'artifacts'), 'artifacts'),
    downloads: listFilesRecursive(path.join(dir, 'downloads'), 'downloads'),
  });
});

const MAX_RAW_BYTES = 50 * 1024 * 1024;

runsRouter.get('/:runId/raw/:name', (req, res) => {
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const name = param(req, 'name');
  if (!isRawFile(name)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const dir = getRunDir(runId, false);
  const real = resolveRegularFileInside(dir, name);
  if (!real) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  let text: string;
  try {
    if (fs.statSync(real).size > MAX_RAW_BYTES) {
      res.status(413).json({ error: 'File is too large to serve.' });
      return;
    }
    // Defence in depth: raw files are redacted when stored, and again here (covers runs recorded before redaction existed
    // and secrets that were configured after the run was stored).
    const run = currentRun(runId);
    const repoSecrets = run?.kind === 'external' ? secretValuesOf(getRepo(run.appId)?.settings) : [];
    text = sanitizeLogText(fs.readFileSync(real, 'utf8'), [...collectProcessSecrets(), ...repoSecrets]);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Content-Disposition', `attachment; filename="${runId}-${name}"`);
  res.send(text);
});

// Platform-generated unified HTML report. Static document with its own CSP; the `sandbox` directive gives it an opaque
// origin so nothing in it could reach this API even if it contained script.
runsRouter.get('/:runId/unified-report', (req, res) => {
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const dir = getRunDir(runId, false);
  const real = resolveRegularFileInside(dir, UNIFIED_REPORT_FILE);
  if (!real) {
    const run = currentRun(runId);
    res.status(404).json({ error: run?.artifacts?.unifiedReportNote || 'This run has no unified HTML report.' });
    return;
  }
  let html: string;
  try {
    html = fs.readFileSync(real, 'utf8');
  } catch {
    res.status(404).json({ error: 'This run has no unified HTML report.' });
    return;
  }
  if (!reportBelongsToRun(html.slice(0, 4096), runId)) {
    res.status(409).json({ error: 'The stored report does not belong to this run id; refusing to serve it.' });
    return;
  }
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': UNIFIED_REPORT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'private, max-age=60',
  });
  if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="${runId}-report.html"`);
  else res.set('Content-Disposition', `inline; filename="${runId}-report.html"`);
  res.send(html);
});

// Repository-native HTML report (e.g. Playwright's static site), kept separately from the unified report.
// Served confined to <run>/playwright-report.
runsRouter.use('/:runId/report', (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const reportDir = path.join(getRunDir(runId, false), 'playwright-report');
  if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
    res.status(404).json({ error: 'This run has no repository-native HTML report.' });
    return;
  }
  // The repository's own report is untrusted code (it ships JavaScript). `sandbox` without allow-same-origin gives it an
  // opaque origin: it cannot read this origin's data or call the platform API with credentials.
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-downloads');
  if (req.path === '/' || req.path === '') {
    // Redirect so relative asset URLs inside the report resolve correctly.
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      res.redirect(302, `${req.baseUrl}/index.html`);
      return;
    }
    sendConfined(req, res, reportDir, 'index.html', 'inline-all');
    return;
  }
  sendConfined(req, res, reportDir, req.path, 'inline-all');
});

runsRouter.get('/:runId/artifacts/*splat', (req, res) => {
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const parts = (req.params as unknown as { splat: string[] }).splat;
  sendConfined(req, res, path.join(getRunDir(runId, false), 'artifacts'), parts.join('/'), 'safe-inline');
});

runsRouter.get('/:runId/downloads/*splat', (req, res) => {
  const runId = requireKnownRun(req, res);
  if (!runId) return;
  const parts = (req.params as unknown as { splat: string[] }).splat;
  sendConfined(req, res, path.join(getRunDir(runId, false), 'downloads'), parts.join('/'), 'safe-inline');
});
