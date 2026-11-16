import fs from 'fs';
import os from 'os';
import path from 'path';

const WORKSPACE_BASE = path.join(os.tmpdir(), 'testing-platform-runs');

/**
 * Copies target application files into an isolated temporary workspace.
 * - Never copies `.env` files (prevents blind secret copying).
 * - Never symlinks `node_modules` back to the original repository.
 * - Excludes runtime logs and SQLite WAL/SHM artifacts so tests start clean.
 */
export function createIsolatedWorkspace(
  sourcePath: string,
  runId: string,
  includeNodeModules: boolean
): string {
  const runRoot = path.join(WORKSPACE_BASE, runId);
  const appDest = path.join(runRoot, 'app');
  fs.mkdirSync(appDest, { recursive: true });

  fs.cpSync(sourcePath, appDest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const base = path.basename(src);
      const rel = path.relative(sourcePath, src);

      if (!includeNodeModules && base === 'node_modules') {
        return false;
      }
      // Never blindly copy .env files
      if (base === '.env' || base.startsWith('.env.')) {
        return false;
      }
      // Skip git metadata, build caches, and runtime logs
      if (base === '.git' || base === '.next' || rel.startsWith('logs' + path.sep) || base.endsWith('.log')) {
        return false;
      }
      return true;
    },
  });

  // Ensure empty logs directory exists inside isolated workspace
  fs.mkdirSync(path.join(appDest, 'logs'), { recursive: true });

  return appDest;
}

export function cleanupIsolatedWorkspace(runId: string): void {
  const runRoot = path.join(WORKSPACE_BASE, runId);
  if (fs.existsSync(runRoot)) {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}
