import fs from 'fs';
import path from 'path';
import { NPM_CACHE_DIR, SANDBOX_HOME_DIR, playwrightBrowsersPath } from '../config';

/**
 * Environment handed to external (untrusted) repository code.
 *
 * It is built from an allow-list, never from the dashboard's process.env, so
 * dashboard secrets / JWTs / API keys / cookies cannot leak into npm scripts or
 * Playwright tests. HOME points at a platform-owned directory so user dotfiles
 * (~/.npmrc tokens, ~/.gitconfig, ~/.ssh config) are not picked up implicitly.
 *
 * Pass `tmpDir` (see runTmp.ts) for external runs: it must be short and exist before the child starts.
 *
 * NOTE: this is hardening, NOT a sandbox. Code still runs with the local user's
 * permissions and can read any file that user can read.
 */
export function buildSandboxEnv(opts: { tmpDir?: string; extra?: Record<string, string> } = {}): Record<string, string> {
  fs.mkdirSync(SANDBOX_HOME_DIR, { recursive: true });
  fs.mkdirSync(NPM_CACHE_DIR, { recursive: true });
  const tmpDir = opts.tmpDir || path.join(SANDBOX_HOME_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: SANDBOX_HOME_DIR,
    USERPROFILE: SANDBOX_HOME_DIR,
    // TMPDIR (POSIX), TMP and TEMP (Windows / some Node tooling) must agree. Keep this path SHORT:
    // tools like tsx bind a Unix socket below it and bind(2) fails with EINVAL past ~104 chars on macOS.
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
    TERM: 'dumb',
    CI: '1',
    FORCE_COLOR: '0',
    NODE_ENV: 'test',
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PLAYWRIGHT_HTML_OPEN: 'never',
    npm_config_cache: NPM_CACHE_DIR,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
    ...opts.extra,
  };
  return env;
}

/** Minimal environment for git (no prompts, no system/global config, https only). */
export function buildGitEnv(): Record<string, string> {
  fs.mkdirSync(SANDBOX_HOME_DIR, { recursive: true });
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: SANDBOX_HOME_DIR,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
