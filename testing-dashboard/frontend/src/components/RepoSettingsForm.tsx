import { useEffect, useState } from 'react';
import type { ExternalRepo, RunScopeLayer } from '../types';
import { updateRepoSettings } from '../api/client';

interface RepoSettingsFormProps {
  repo: ExternalRepo;
  disabled: boolean;
  onSaved: () => Promise<unknown> | void;
}

const SECRET_MASK = '********';
const LAYER_OPTIONS: Array<{ value: RunScopeLayer; label: string }> = [
  { value: 'all', label: 'All layers' },
  { value: 'unit', label: 'Unit only' },
  { value: 'integration', label: 'Integration only' },
  { value: 'e2e', label: 'E2E only' },
];

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) throw new Error(`Environment line "${line.slice(0, 40)}" must look like NAME=value.`);
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

/**
 * Safe per-repository run configuration. Nothing here is a command: the test command can only be picked from the
 * repository's own package.json scripts; URLs and environment variables are passed as data (names are allow-listed by the
 * backend, secret-looking values stay masked).
 */
export function RepoSettingsForm({ repo, disabled, onSaved }: RepoSettingsFormProps) {
  const s = repo.settings ?? {};
  const det = repo.detection;
  const [layer, setLayer] = useState<RunScopeLayer>(s.layer ?? 'all');
  const [script, setScript] = useState(s.testScript ?? '');
  const [site, setSite] = useState(s.targetBaseUrl ?? '');
  const [api, setApi] = useState(s.targetApiUrl ?? '');
  const [envText, setEnvText] = useState(envToText(s.env));
  const [allowScripts, setAllowScripts] = useState(!!s.allowInstallScripts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const t = repo.settings ?? {};
    setLayer(t.layer ?? 'all');
    setScript(t.testScript ?? '');
    setSite(t.targetBaseUrl ?? '');
    setApi(t.targetApiUrl ?? '');
    setEnvText(envToText(t.env));
    setAllowScripts(!!t.allowInstallScripts);
  }, [repo.settings]);

  const canPickLayer = !!det?.supportsLayerSelection;
  const scripts = Object.keys(det?.scripts ?? {});

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateRepoSettings(repo.id, {
        layer: canPickLayer ? layer : 'all',
        testScript: script || null,
        targetBaseUrl: site.trim() || null,
        targetApiUrl: api.trim() || null,
        env: textToEnv(envText),
        allowInstallScripts: allowScripts,
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="repo-settings">
      <summary>Run settings</summary>
      <form className="repo-settings-form" onSubmit={save}>
        <label>
          <span className="path-label">Layer to run</span>
          <select value={canPickLayer ? layer : 'all'} onChange={(e) => setLayer(e.target.value as RunScopeLayer)} disabled={disabled || busy || !canPickLayer}>
            {LAYER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!canPickLayer && <span className="cell-muted"> This repository has no layer selection (no test:&lt;layer&gt; scripts / TEST_LAYER).</span>}
        </label>
        <label>
          <span className="path-label">Test command (a package.json script)</span>
          <select value={script} onChange={(e) => setScript(e.target.value)} disabled={disabled || busy}>
            <option value="">Auto-detect</option>
            {scripts.map((n) => (
              <option key={n} value={n}>
                npm run {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="path-label">Target website URL (TEST_BASE_URL)</span>
          <input type="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://example.com" disabled={disabled || busy} />
        </label>
        <label>
          <span className="path-label">Target API URL (TEST_API_BASE_URL)</span>
          <input type="url" value={api} onChange={(e) => setApi(e.target.value)} placeholder="https://api.example.com" disabled={disabled || busy} />
        </label>
        <label>
          <span className="path-label">Environment variables (NAME=value per line; names TEST_*, E2E_*, API_*, APP_*, TARGET_*)</span>
          <textarea rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} spellCheck={false} disabled={disabled || busy} placeholder="TEST_REGION=eu" />
          <span className="cell-muted"> Secret-looking values stay masked ({SECRET_MASK}); leave them as is to keep them.</span>
        </label>
        <label className="repo-settings-check">
          <input type="checkbox" checked={allowScripts} onChange={(e) => setAllowScripts(e.target.checked)} disabled={disabled || busy} />
          <span>
            Allow npm install scripts (<code className="mono">preinstall/install/postinstall</code>) — off by default; they run arbitrary code from this repository and every dependency.
          </span>
        </label>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <div className="project-actions">
          <button type="submit" className="btn btn-pill btn-sm btn-accent" disabled={disabled || busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {saved && <span className="cell-muted">Saved.</span>}
          {disabled && <span className="cell-muted">Settings are locked while a run is in progress.</span>}
        </div>
      </form>
    </details>
  );
}
