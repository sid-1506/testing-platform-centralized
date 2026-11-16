import os from 'os';
import path from 'path';

/** testing-dashboard/ (works from both src/ and dist/). */
export const DASHBOARD_ROOT = path.resolve(__dirname, '..', '..');
export const RUNS_DIR = path.join(DASHBOARD_ROOT, '.runs');

/** Platform-controlled storage for external repositories (never inside a target repo). */
export const PLATFORM_DIR = path.join(DASHBOARD_ROOT, '.platform');
export const REPO_CACHE_DIR = path.join(PLATFORM_DIR, 'repos'); // one git clone per registered repo
export const DEPS_DIR = path.join(PLATFORM_DIR, 'deps'); // prepared (npm ci) templates keyed by lockfile hash
export const WORKSPACES_DIR = path.join(PLATFORM_DIR, 'workspaces'); // per-run execution workspaces
export const SANDBOX_HOME_DIR = path.join(PLATFORM_DIR, 'home'); // HOME handed to external code
export const NPM_CACHE_DIR = path.join(PLATFORM_DIR, 'npm-cache');
export const REPO_REGISTRY_FILE = path.join(PLATFORM_DIR, 'repos.json');

export const BIND_HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || 4000);

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Separately configurable stage timeouts (milliseconds). */
export const TIMEOUTS = {
  gitProbeMs: envMs('PLATFORM_TIMEOUT_GIT_PROBE_MS', 30_000),
  cloneMs: envMs('PLATFORM_TIMEOUT_CLONE_MS', 180_000),
  installMs: envMs('PLATFORM_TIMEOUT_INSTALL_MS', 600_000),
  browserInstallMs: envMs('PLATFORM_TIMEOUT_BROWSER_INSTALL_MS', 900_000),
  testMs: envMs('PLATFORM_TIMEOUT_TEST_MS', 1_800_000),
};

/** Upper bound for a per-repository `testTimeoutMs` override. */
export const MAX_TEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** First release: one external suite execution at a time. */
export const MAX_CONCURRENT_EXTERNAL_RUNS = envMs('PLATFORM_MAX_EXTERNAL_RUNS', 1);

/** Where Playwright keeps downloaded browsers. Shared + version-aware (revision-keyed directories). */
export function playwrightBrowsersPath(): string {
  if (process.env.PLATFORM_PLAYWRIGHT_BROWSERS_PATH) return process.env.PLATFORM_PLAYWRIGHT_BROWSERS_PATH;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

export const ALLOWED_UI_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];
export const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  'localhost:5173',
  '127.0.0.1:5173',
  'localhost:4173',
  '127.0.0.1:4173',
]);
