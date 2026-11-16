import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { appsRouter } from './routes/apps';
import { runsRouter } from './routes/runs';
import { reposRouter } from './routes/repos';
import { cleanupAllTrackedProcesses } from './services/processManager';
import { recoverStaleRuns } from './services/runStore';
import { reapOrphanedProcesses } from './services/pidRegistry';
import { recoverInterruptedRepos } from './services/repoRegistry';
import { recoverInterruptedDiscoveries } from './services/testDiscovery';
import { sweepStaleRunTmpDirs } from './services/runTmp';
import { pruneRunHistory } from './services/runRetention';
import { hostGuard, originGuard } from './middleware/security';
import { ALLOWED_UI_ORIGINS, BIND_HOST, PORT, WORKSPACES_DIR } from './config';
import fs from 'fs';

const app = express();

// Never trust a reverse proxy header; this service only talks to the local dashboard.
app.disable('x-powered-by');
app.use(hostGuard);
app.use(cors({ origin: ALLOWED_UI_ORIGINS }));
app.use(originGuard);
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'testing-dashboard-backend', port: PORT, host: BIND_HOST });
});

app.use('/api/apps', appsRouter);
app.use('/api/repos', reposRouter);
app.use('/api/runs', runsRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode ?? 500;
  if (status >= 500) console.error('[TESTING-PLATFORM BACKEND] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err as Error).message });
});

// Startup recovery: nothing from a previous process is still executing.
reapOrphanedProcesses();
const recoveredRuns = recoverStaleRuns();
const recoveredRepos = recoverInterruptedRepos();
const recoveredDiscoveries = recoverInterruptedDiscoveries();
if (recoveredDiscoveries > 0) console.log(`[TESTING-PLATFORM BACKEND] Marked ${recoveredDiscoveries} interrupted test discovery job(s) as failed.`);
try {
  if (fs.existsSync(WORKSPACES_DIR)) fs.rmSync(WORKSPACES_DIR, { recursive: true, force: true });
} catch {
  // best effort
}
const prunedRuns = pruneRunHistory();
if (prunedRuns.length > 0) console.log(`[TESTING-PLATFORM BACKEND] Retention removed ${prunedRuns.length} old run(s).`);
const sweptTmp = sweepStaleRunTmpDirs();
if (sweptTmp > 0) console.log(`[TESTING-PLATFORM BACKEND] Removed ${sweptTmp} stale run temp director${sweptTmp === 1 ? 'y' : 'ies'} from a previous process.`);
if (recoveredRuns > 0) console.log(`[TESTING-PLATFORM BACKEND] Marked ${recoveredRuns} interrupted run(s) from a previous process as failed.`);
if (recoveredRepos > 0) console.log(`[TESTING-PLATFORM BACKEND] Marked ${recoveredRepos} interrupted repository connection(s) as errored.`);

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`[TESTING-PLATFORM BACKEND] Listening on http://${BIND_HOST}:${PORT} (loopback only)`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[TESTING-PLATFORM BACKEND] Received ${signal}, cleaning up tracked processes...`);
  await cleanupAllTrackedProcesses();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
