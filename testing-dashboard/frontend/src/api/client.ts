import {
  ExecutionMode,
  ExternalRepo,
  InspectionReport,
  LogEntry,
  NormalizedTestRun,
  RegisteredApp,
  RepoSettings,
  RunScopeLayer,
} from '../types';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function fetchApps(): Promise<RegisteredApp[]> {
  const data = await requestJson<{ apps: RegisteredApp[] }>('/api/apps');
  return data.apps;
}

export async function inspectApp(appId: string): Promise<InspectionReport> {
  return requestJson<InspectionReport>(`/api/apps/${encodeURIComponent(appId)}/inspect`);
}

export async function triggerRun(params: {
  appId: string;
  suiteId?: string;
  layer?: RunScopeLayer;
  executionMode: ExecutionMode;
  /** External repositories: refuse to run when the repository is no longer at the commit tests were discovered on. */
  expectedCommitSha?: string;
}): Promise<NormalizedTestRun> {
  const data = await requestJson<{ run: NormalizedTestRun }>('/api/runs', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(params),
  });
  return data.run;
}

export async function fetchRuns(): Promise<NormalizedTestRun[]> {
  const data = await requestJson<{ runs: NormalizedTestRun[] }>('/api/runs');
  return data.runs;
}

export interface RunDetail {
  run: NormalizedTestRun;
  log: string;
  /** Stream-tagged output; null for runs recorded before stream capture existed. */
  entries: LogEntry[] | null;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  return requestJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function cancelRun(runId: string): Promise<void> {
  await requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
}

/* ---------------- external repositories ---------------- */

export async function fetchRepos(): Promise<ExternalRepo[]> {
  const data = await requestJson<{ repos: ExternalRepo[] }>('/api/repos');
  return data.repos;
}

export async function fetchRepo(id: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}`);
  return data.repo;
}

export async function registerRepo(url: string, branch: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>('/api/repos', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ url, branch }),
  });
  return data.repo;
}

export async function removeRepo(id: string): Promise<void> {
  await requestJson(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function refetchRepo(id: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}/fetch`, { method: 'POST' });
  return data.repo;
}

export async function inspectRepo(id: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}/inspect`, { method: 'POST' });
  return data.repo;
}

/** Starts test discovery (framework-native listing; executes no test). Progress is reported through `repo.discoveryState`. */
export async function discoverRepoTests(id: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}/discover`, { method: 'POST' });
  return data.repo;
}

export async function trustRepo(id: string): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}/trust`, { method: 'POST' });
  return data.repo;
}

export async function updateRepoSettings(id: string, patch: Partial<Record<keyof RepoSettings, unknown>>): Promise<ExternalRepo> {
  const data = await requestJson<{ repo: ExternalRepo }>(`/api/repos/${encodeURIComponent(id)}/settings`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  return data.repo;
}

/* ---------------- artifacts ---------------- */

/**
 * The HTML report is a full web page produced by untrusted test code. It is
 * opened on the backend origin directly (not through the dashboard's dev proxy)
 * so it can never share an origin with the dashboard UI.
 */
const BACKEND_ORIGIN: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_ORIGIN || 'http://127.0.0.1:4000';

/** Platform-generated unified report (primary). Opened on the backend origin; served with a restrictive CSP + sandbox. */
export function unifiedReportUrl(runId: string, download = false): string {
  return `${BACKEND_ORIGIN}/api/runs/${encodeURIComponent(runId)}/unified-report${download ? '?download=1' : ''}`;
}

/** The repository's own HTML report (Playwright etc.), when it produced one. */
export function reportUrl(runId: string): string {
  return `${BACKEND_ORIGIN}/api/runs/${encodeURIComponent(runId)}/report/index.html`;
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** `relPath` starts with `artifacts/` or `downloads/`. */
export function artifactUrl(runId: string, relPath: string, download = false): string {
  return `/api/runs/${encodeURIComponent(runId)}/${encodePath(relPath)}${download ? '?download=1' : ''}`;
}

export function rawFileUrl(runId: string, name: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/raw/${encodeURIComponent(name)}`;
}

export interface RunFiles {
  report: boolean;
  nativeReport?: boolean;
  unifiedReport?: boolean;
  raw: string[];
  artifacts: Array<{ path: string; size: number }>;
  downloads: Array<{ path: string; size: number }>;
}

export async function fetchRunFiles(runId: string): Promise<RunFiles> {
  return requestJson<RunFiles>(`/api/runs/${encodeURIComponent(runId)}/files`);
}
