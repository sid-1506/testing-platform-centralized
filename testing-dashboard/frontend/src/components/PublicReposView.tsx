import React, { useState } from 'react';
import type { ExternalRepo, LogEntry, NormalizedTestRun, RunScopeLayer } from '../types';
import type { LiveRunState } from '../hooks/useRunSession';
import { inspectRepo, refetchRepo, registerRepo, removeRepo } from '../api/client';
import { LAYERS, LAYER_SHORT, formatShortDateTime, staticEstimate } from '../lib/metrics';
import { RepoDiscoveryPanel } from './RepoDiscoveryPanel';
import { RepoSettingsForm } from './RepoSettingsForm';
import { CardHead, PageHead, StatusPill } from './common';
import { ExternalRunResults } from './ExternalRunResults';
import { Icon } from './icons';
import { TerminalPanel } from './TerminalPanel';

interface PublicReposViewProps {
  repos: ExternalRepo[];
  reposLoaded: boolean;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onReposChanged: () => Promise<unknown> | void;
  onRunRepo: (repoId: string, layer?: RunScopeLayer, selection?: { expectedCommitSha?: string }) => Promise<void>;
  onDiscoverRepo: (repoId: string) => Promise<void>;
  isRunning: boolean;
  selectedRun: NormalizedTestRun | null;
  selectedLog: string;
  entries: LogEntry[];
  live: LiveRunState;
  onCancelRun: () => void;
  onClearLog: () => void;
}

const FRAMEWORK_NAME = { playwright: 'Playwright', vitest: 'Vitest', jest: 'Jest' } as const;

const STATUS_LABEL: Record<ExternalRepo['status'], string> = {
  connecting: 'Connecting',
  ready: 'Ready',
  unsupported: 'Unsupported',
  error: 'Error',
};

// StatusPill colours by run-status vocabulary; map repo connection states onto it.
const STATUS_PILL: Record<ExternalRepo['status'], string> = {
  connecting: 'running',
  ready: 'passed',
  unsupported: 'error',
  error: 'failed',
};

export function PublicReposView({
  repos,
  reposLoaded,
  selectedProjectId,
  onSelectProject,
  onReposChanged,
  onRunRepo,
  onDiscoverRepo,
  isRunning,
  selectedRun,
  selectedLog,
  entries,
  live,
  onCancelRun,
  onClearLog,
}: PublicReposViewProps) {
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim() || submitting) return;
    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      const repo = await registerRepo(repoUrl.trim(), branch.trim() || 'main');
      setNotice(`Connected ${repo.owner}/${repo.repo} (${repo.branch}). Cloning and detecting the test framework…`);
      setRepoUrl('');
      await onReposChanged();
      onSelectProject(repo.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const guard = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setFormError(null);
    try {
      await fn();
      await onReposChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  // Trust confirmation is handled by the app-level dialog (shared with the header Run button).
  const runRepo = (repo: ExternalRepo) => {
    onSelectProject(repo.id);
    void guard(repo.id, () => onRunRepo(repo.id));
  };

  const selectedRepo = repos.find((r) => r.id === selectedProjectId) ?? null;
  const runForSelected = selectedRepo && selectedRun?.appId === selectedRepo.id ? selectedRun : null;

  return (
    <div className="page public-repos">
      <PageHead
        eyebrow="Remote version control"
        title="Public repositories"
        description="Connect a public GitHub repository with a Node.js test suite (Playwright, Vitest or Jest). The platform clones it, detects the frameworks, installs its dependencies in isolation and runs its real test command, then builds one unified report."
        meta={
          <span className="chip chip-plain">
            <Icon name="git" size={13} />
            {repos.length} connected
          </span>
        }
      />

      {notice && (
        <div className="notice notice-success" role="status">
          <Icon name="check" size={16} strokeWidth={2.4} />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid-two">
        <section className="card">
          <CardHead title="Import repository" subtitle="Public HTTPS GitHub URL only. Nothing is executed until you explicitly trust the repository." />

          <form onSubmit={handleImport} className="panel repo-form">
            <div className="field field-grow">
              <label htmlFor="repo-url" className="field-label">
                GitHub repository URL
              </label>
              <input
                id="repo-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/organization/repository.git"
                className="input-pill"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="repo-branch" className="field-label">
                Branch
              </label>
              <input
                id="repo-branch"
                type="text"
                placeholder="main"
                className="input-pill"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={submitting}
              />
            </div>

            <button type="submit" className="btn btn-pill btn-accent" disabled={submitting || !repoUrl.trim()}>
              {submitting ? (
                <>
                  <span className="spinner" /> Validating…
                </>
              ) : (
                <>
                  <Icon name="git" size={15} />
                  Connect repository
                </>
              )}
            </button>
          </form>

          {formError && (
            <div className="notice notice-error" role="alert">
              <Icon name="info" size={16} />
              <span>{formError}</span>
            </div>
          )}
        </section>

        <section className="card">
          <CardHead title="What can be connected" subtitle="Scope of this version." />
          <div className="panel capability-list">
            <div className="capability">
              <span className="project-icon">
                <Icon name="target" size={15} />
              </span>
              <div className="capability-text">
                <strong>Node.js / TypeScript: Playwright, Vitest, Jest</strong>
                <span>package.json with @playwright/test, vitest or jest and an npm test command (or a layer runner). Uses npm ci when a lockfile exists. Browsers are only installed when Playwright is used.</span>
              </div>
              <span className="chip chip-accent">Supported</span>
            </div>
            <div className="capability">
              <span className="project-icon">
                <Icon name="layers" size={15} />
              </span>
              <div className="capability-text">
                <strong>Other frameworks / languages</strong>
                <span>Pytest, Cypress, Selenium, Java, … are not supported yet (runner adapters can be added).</span>
              </div>
              <span className="chip chip-plain">Not yet</span>
            </div>
            <div className="capability">
              <span className="project-icon">
                <Icon name="lock" size={15} />
              </span>
              <div className="capability-text">
                <strong>Security</strong>
                <span>
                  Repository code runs on this machine with your user permissions. Environment filtering and temp workspaces are hardening, not a sandbox.
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <CardHead
          title="Connected repositories"
          subtitle="Real registrations stored by the backend. Select one to run it or view its results."
          actions={
            repos.length > 1 ? (
              <button
                type="button"
                className="btn btn-pill btn-sm btn-white-line"
                onClick={() => setExpandedIds(expandedIds.size === repos.length ? new Set() : new Set(repos.map((r) => r.id)))}
              >
                {expandedIds.size === repos.length ? 'Collapse all' : 'Expand all'}
              </button>
            ) : undefined
          }
        />

        {!reposLoaded ? (
          <div className="panel table-empty">Loading repositories…</div>
        ) : repos.length === 0 ? (
          <div className="panel table-empty">No repositories connected yet. Import a public GitHub repository above.</div>
        ) : (
          <div className="repo-grid">
            {repos.map((repo) => {
              const selected = repo.id === selectedProjectId;
              const det = repo.detection;
              const busy = busyId === repo.id;
              const canRun = repo.status === 'ready' && !isRunning && !busy;
              const open = expandedIds.has(repo.id);
              return (
                <article key={repo.id} className={`repo-card ${selected ? 'is-selected' : ''} ${open ? 'is-open' : ''}`}>
                  <div className="repo-head" onClick={() => toggleExpanded(repo.id)}>
                    <span className="project-icon project-icon-lg">
                      <Icon name="git" size={20} />
                    </span>
                    <div className="repo-title-group">
                      <h4 className="repo-title">{repo.name}</h4>
                      <span className="project-stack">
                        {repo.owner}/{repo.repo} · branch {repo.branch}
                      </span>
                    </div>
                    <StatusPill status={STATUS_PILL[repo.status]} label={STATUS_LABEL[repo.status]} />
                    <button
                      type="button"
                      className="icon-btn repo-toggle"
                      aria-expanded={open}
                      aria-controls={`repo-body-${repo.id}`}
                      title={open ? 'Collapse details' : 'View details'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(repo.id);
                      }}
                    >
                      <Icon name="chevron" size={16} />
                    </button>
                  </div>

                  {/* Kept mounted (collapsed with CSS) so discovery selection and settings state survive collapsing. */}
                  <div className="repo-body" id={`repo-body-${repo.id}`} aria-hidden={!open}>
                  <div className="repo-body-clip">
                  <div className="repo-body-inner">
                  <div className="repo-facts">
                    <span className="chip chip-plain">
                      <Icon name="bolt" size={13} />
                      {det?.framework
                        ? (det.frameworks?.length ? det.frameworks : [det.framework]).map((f) => FRAMEWORK_NAME[f]).join(' + ')
                        : repo.status === 'connecting' ? 'Detecting…' : 'No framework detected'}
                    </span>
                    {repo.lastExecution && (
                      <span className="chip chip-plain" title="Tests actually executed in the last finished run (from the repository's own reports)">
                        <Icon name="check" size={13} />
                        Executed: {repo.lastExecution.total}
                        {LAYERS.filter((l) => repo.lastExecution!.byLayer[l]).length > 0 &&
                          ` (${LAYERS.filter((l) => repo.lastExecution!.byLayer[l]).map((l) => `${repo.lastExecution!.byLayer[l]!.total} ${LAYER_SHORT[l]}`).join(' · ')})`}
                      </span>
                    )}
                    {det?.framework && staticEstimate(repo) !== null && (
                      <span className="chip chip-plain" title="Regex scan of test files. Ignores parameterized and generated tests, so it is NOT the number of tests that run.">
                        <Icon name="layers" size={13} />
                        ~{staticEstimate(repo)} static declarations (estimate) · {det.testFileCount} {det.testFileCount === 1 ? 'file' : 'files'}
                      </span>
                    )}
                    {det?.testCommand && (
                      <span className="chip chip-plain chip-mono" title="Command executed for each run">
                        {det.testCommand.display}
                      </span>
                    )}
                    {repo.trustedAt && repo.trustedSha && repo.trustedSha === repo.commitSha ? (
                      <span className="tag tag-accent" title={`Trusted at commit ${repo.trustedSha}`}>Trusted · {repo.trustedSha.slice(0, 7)}</span>
                    ) : (
                      repo.status === 'ready' && (
                        <span className="tag tag-muted" title="Trust is bound to one commit; it is requested before the next run.">
                          {repo.trustedAt ? 'Re-trust needed' : 'Not trusted yet'}
                        </span>
                      )
                    )}
                  </div>

                  {repo.status === 'connecting' && (
                    <p className="project-desc">
                      <span className="spinner spinner-dark" /> {repo.statusMessage ?? 'Connecting…'}
                    </p>
                  )}
                  {repo.status === 'ready' && repo.statusMessage && <p className="project-desc">{repo.statusMessage}</p>}
                  {(repo.status === 'unsupported' || repo.status === 'error') && (
                    <div className="notice notice-error" role="alert">
                      <Icon name="info" size={16} />
                      <div>
                        <strong>{repo.status === 'unsupported' ? 'Unsupported repository:' : 'Connection failed:'}</strong>{' '}
                        {repo.statusMessage}
                        {repo.status === 'unsupported' && (
                          <div className="cell-muted">The repository was registered but cannot be executed, so Run is disabled.</div>
                        )}
                      </div>
                    </div>
                  )}
                  {det && det.warnings.length > 0 && (
                    <ul className="repo-warnings">
                      {det.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}

                  <div className="repo-foot">
                    <span title={repo.commitSha}>
                      Last fetched commit: <code className="mono">{repo.commitSha ? repo.commitSha.slice(0, 7) : '—'}</code>
                      {repo.lastFetchedAt && <span className="cell-muted"> · {formatShortDateTime(repo.lastFetchedAt)}</span>}
                    </span>
                    <span>
                      Last execution:{' '}
                      {repo.lastRun ? <StatusPill status={repo.lastRun.status} /> : <span className="cell-muted">never run</span>}
                    </span>
                  </div>

                  {repo.status === 'ready' && (
                    <RepoDiscoveryPanel
                      repo={repo}
                      isRunning={isRunning}
                      busy={busy}
                      onFetchTests={() => {
                        onSelectProject(repo.id);
                        void guard(repo.id, () => onDiscoverRepo(repo.id));
                      }}
                      onRun={(layer, sha) => {
                        onSelectProject(repo.id);
                        void guard(repo.id, () => onRunRepo(repo.id, layer, { expectedCommitSha: sha }));
                      }}
                    />
                  )}

                  <RepoSettingsForm repo={repo} disabled={isRunning || busy} onSaved={onReposChanged} />

                  <div className="project-actions">
                    <button
                      type="button"
                      className={`btn btn-pill btn-sm ${selected ? 'btn-dark' : 'btn-white-line'}`}
                      onClick={() => onSelectProject(repo.id)}
                    >
                      {selected ? (
                        <>
                          <Icon name="check" size={13} strokeWidth={2.4} /> Selected
                        </>
                      ) : (
                        'Select'
                      )}
                    </button>
                    <button type="button" className="btn btn-pill btn-sm btn-white-line" disabled={!canRun} onClick={() => runRepo(repo)} title={repo.status !== 'ready' ? 'Repository is not ready' : "Run the repository's default test command (all layers) without fetching tests first"}>
                      <Icon name="play" size={11} /> Run tests
                    </button>
                    <button
                      type="button"
                      className="btn btn-pill btn-sm btn-white-line"
                      disabled={busy || isRunning || repo.status === 'connecting'}
                      onClick={() => void guard(repo.id, () => refetchRepo(repo.id))}
                      title="Fetch the latest commit of this branch"
                    >
                      <Icon name="refresh" size={13} /> Fetch
                    </button>
                    <button
                      type="button"
                      className="btn btn-pill btn-sm btn-white-line"
                      disabled={busy || repo.status === 'connecting'}
                      onClick={() => void guard(repo.id, () => inspectRepo(repo.id))}
                      title="Re-detect framework, scripts and tests (no code is executed)"
                    >
                      <Icon name="search" size={13} /> Inspect
                    </button>
                    {confirmRemoveId === repo.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-pill btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => {
                            setConfirmRemoveId(null);
                            void guard(repo.id, () => removeRepo(repo.id));
                          }}
                        >
                          Confirm remove
                        </button>
                        <button type="button" className="btn btn-pill btn-sm btn-white-line" onClick={() => setConfirmRemoveId(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-pill btn-sm btn-white-line"
                        disabled={busy || isRunning}
                        onClick={() => setConfirmRemoveId(repo.id)}
                        title="Remove this repository (run history is kept)"
                      >
                        <Icon name="trash" size={13} /> Remove
                      </button>
                    )}
                  </div>
                  </div>
                  </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selectedRepo && (
        <>
          <TerminalPanel
            selectedRun={runForSelected}
            selectedLog={runForSelected ? selectedLog : ''}
            entries={runForSelected ? entries : []}
            live={live}
            isRunning={isRunning && !!runForSelected}
            onCancel={onCancelRun}
            onClearLog={onClearLog}
            title={`${selectedRepo.name} · execution terminal`}
            subtitle="Real git, npm and test-runner output, streamed live"
          />
          {runForSelected ? (
            <ExternalRunResults run={runForSelected} isRunning={isRunning} />
          ) : (
            <section className="card">
              <CardHead title="Results" />
              <div className="panel table-empty">No run selected for {selectedRepo.name}. Click “Run tests”, or open a previous run from Test History.</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
