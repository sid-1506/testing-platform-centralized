import { MAX_TEST_TIMEOUT_MS } from '../config';
import { ExternalRepo, RepoSettings, RunScopeLayer } from '../types';

/**
 * Per-repository run configuration. Everything here is data, never a command: the test command can only be the NAME of an
 * existing package.json script (validated against detection), URLs are plain http(s) values handed over as environment
 * variables, and extra environment variables are limited to an allow-listed name pattern.
 */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export const SECRET_MASK = '********';
const MAX_ENV_VARS = 20;
const MAX_VALUE_LENGTH = 2000;
/** Variables the platform sets itself from dedicated fields; they cannot be overridden through `env`. */
const MANAGED_ENV = new Set(['TEST_LAYER', 'TEST_BASE_URL', 'TEST_API_BASE_URL', 'TEST_RUN_ID', 'TEST_REPORT_LAYER', 'TEST_PROJECT_ID']);
/** Names the user may define. Anything else (PATH, HOME, NODE_OPTIONS, LD_PRELOAD, npm_config_*, ...) is refused. */
const ENV_NAME_RE = /^(?:TEST|E2E|API|APP|TARGET)_[A-Z0-9_]{1,56}$/;
const SECRET_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SESSION|COOKIE|JWT|AUTH)/i;
const LAYERS: RunScopeLayer[] = ['all', 'unit', 'integration', 'e2e'];

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function isRunScopeLayer(v: unknown): v is RunScopeLayer {
  return typeof v === 'string' && (LAYERS as string[]).includes(v);
}

export function validateTargetUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 500) throw new SettingsError(`${label} must be a URL of at most 500 characters.`);
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new SettingsError(`${label} is not a valid URL.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SettingsError(`${label} must use http or https.`);
  if (u.username || u.password) throw new SettingsError(`${label} must not contain credentials.`);
  return u.toString();
}

function validateEnv(input: unknown, existing: Record<string, string> = {}): Record<string, string> {
  if (input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new SettingsError('env must be an object of NAME: value pairs.');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) throw new SettingsError(`At most ${MAX_ENV_VARS} environment variables are allowed.`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name)) {
      throw new SettingsError(`Environment variable "${name.slice(0, 40)}" is not allowed. Names must look like TEST_*, E2E_*, API_*, APP_* or TARGET_*.`);
    }
    if (MANAGED_ENV.has(name)) throw new SettingsError(`${name} is set by the platform; use the dedicated setting instead.`);
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(value)) {
      throw new SettingsError(`Value of ${name} must be a single-line string of at most ${MAX_VALUE_LENGTH} characters.`);
    }
    if (value === SECRET_MASK) {
      if (!(name in existing)) throw new SettingsError(`${name}: enter a value (the masked placeholder is only valid for an existing secret).`);
      out[name] = existing[name];
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Applies a PATCH body to existing settings and returns the new settings. `scripts` are the repository's detected
 * package.json scripts (a `testScript` must be one of them).
 */
export function applySettingsPatch(current: RepoSettings | undefined, body: Record<string, unknown>, scripts: Record<string, string> | undefined): RepoSettings {
  const settings: RepoSettings = { ...(current || {}) };
  if ('testScript' in body) {
    const v = body.testScript;
    if (v === null || v === '') delete settings.testScript;
    else if (typeof v === 'string' && /^[\w:.-]{1,80}$/.test(v) && scripts?.[v]) settings.testScript = v;
    else throw new SettingsError('testScript must be the name of an existing package.json script.');
  }
  if ('testTimeoutMs' in body) {
    const v = body.testTimeoutMs;
    if (v === null) delete settings.testTimeoutMs;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 10_000 && v <= MAX_TEST_TIMEOUT_MS) settings.testTimeoutMs = Math.round(v);
    else throw new SettingsError(`testTimeoutMs must be between 10000 and ${MAX_TEST_TIMEOUT_MS}.`);
  }
  if ('layer' in body) {
    const v = body.layer;
    if (v === null || v === 'all') delete settings.layer;
    else if (isRunScopeLayer(v)) settings.layer = v;
    else throw new SettingsError('layer must be one of all, unit, integration, e2e.');
  }
  for (const [key, label] of [['targetBaseUrl', 'Target website URL'], ['targetApiUrl', 'Target API URL']] as const) {
    if (key in body) {
      const v = body[key];
      if (v === null || v === '') delete settings[key];
      else settings[key] = validateTargetUrl(v, label);
    }
  }
  if ('env' in body) {
    const env = validateEnv(body.env, settings.env);
    if (Object.keys(env).length === 0) delete settings.env;
    else settings.env = env;
  }
  if ('allowInstallScripts' in body) {
    if (typeof body.allowInstallScripts !== 'boolean') throw new SettingsError('allowInstallScripts must be true or false.');
    if (body.allowInstallScripts) settings.allowInstallScripts = true;
    else delete settings.allowInstallScripts;
  }
  return settings;
}

/** Environment handed to the test process, built only from validated settings. */
export function runEnvFromSettings(settings: RepoSettings | undefined, layer: RunScopeLayer): Record<string, string> {
  const env: Record<string, string> = { ...(settings?.env || {}) };
  env.TEST_LAYER = layer;
  if (settings?.targetBaseUrl) env.TEST_BASE_URL = settings.targetBaseUrl;
  if (settings?.targetApiUrl) env.TEST_API_BASE_URL = settings.targetApiUrl;
  return env;
}

/** Values that must be redacted from logs/reports (secret-looking env values and credentials). */
export function secretValuesOf(settings: RepoSettings | undefined): string[] {
  return Object.entries(settings?.env || {})
    .filter(([name, value]) => isSecretName(name) && value.length >= 4)
    .map(([, value]) => value);
}

/** Copy of a repository record that is safe to send to the browser: secret env values are masked. */
export function toPublicRepo(input: ExternalRepo): ExternalRepo {
  // Discovery is only valid for the commit it was made on; computed here so every response agrees.
  const repo: ExternalRepo = input.discovery
    ? { ...input, discovery: { ...input.discovery, stale: !!input.commitSha && input.discovery.commitSha !== input.commitSha } }
    : input;
  if (!repo.settings?.env) return repo;
  const env = Object.fromEntries(Object.entries(repo.settings.env).map(([k, v]) => [k, isSecretName(k) ? SECRET_MASK : v]));
  return { ...repo, settings: { ...repo.settings, env } };
}
