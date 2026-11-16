import { useEffect, useMemo, useState } from 'react';
import {
  cancelRun,
  fetchApps,
  fetchRuns,
  inspectApp,
  trustRepo,
  discoverRepoTests,
  triggerRun,
} from './api/client';
import {
  ExecutionMode,
  ExternalRepo,
  InspectionReport,
  NormalizedTestRun,
  ProjectRef,
  RegisteredApp,
  RunScopeLayer,
} from './types';
import { useRepos } from './hooks/useRepos';
import { useRunSession } from './hooks/useRunSession';
import { TrustDialog } from './components/TrustDialog';
import { MinimalOverview } from './components/MinimalOverview';
import { CategoryTestingView } from './components/CategoryTestingView';
import { TestHistoryView } from './components/TestHistoryView';
import { LocalProjectsView } from './components/LocalProjectsView';
import { PublicReposView } from './components/PublicReposView';
import { SettingsView } from './components/SettingsView';
import { Icon } from './components/icons';
import { Sidebar } from './components/Sidebar';
import type { NavSection } from './components/Sidebar';
import { useTheme } from './hooks/useTheme';
import { byNewest, isActive, repoLayerInfo } from './lib/metrics';

export type SidebarTab =
  | 'overview'
  | 'local-projects'
  | 'public-repos'
  | 'unit'
  | 'integration'
  | 'e2e'
  | 'history'
  | 'settings';

const SELECTED_KEY = 'testing-platform.selectedProject';
/** Below this width the sidebar is an off-canvas drawer instead of a collapsible rail. */
const DRAWER_QUERY = '(max-width: 960px)';

export function App() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('overview');
  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState<string>(() => {
    try {
      return localStorage.getItem(SELECTED_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [inspection, setInspection] = useState<InspectionReport | null>(null);

  const [executionMode, setExecutionMode] = useState<ExecutionMode>('isolated');
  const [history, setHistory] = useState<NormalizedTestRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeRunSuiteId, setActiveRunSuiteId] = useState<string | undefined>(undefined);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const [historyQuery, setHistoryQuery] = useState('');
  const [trustPrompt, setTrustPrompt] = useState<{ repo: ExternalRepo; layer?: RunScopeLayer; expectedCommitSha?: string; action: 'run' | 'discover' } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const { repos, loaded: reposLoaded, error: reposError, refresh: refreshRepos } = useRepos();

  const refreshHistory = async () => {
    try {
      setHistory(await fetchRuns());
    } catch {
      // transient; the next refresh will recover
    }
  };

  const session = useRunSession(() => {
    setActiveRunSuiteId(undefined);
    void refreshHistory();
    void refreshRepos();
  });
  const { selectedRun, entries, live } = session;

  // Every selectable project: real local applications + real connected GitHub repositories. No demo entries.
  const projects: ProjectRef[] = useMemo(
    () => [
      ...apps.map<ProjectRef>((app) => ({ id: app.id, name: app.name, kind: 'local', app })),
      ...repos.map<ProjectRef>((repo) => ({ id: repo.id, name: repo.name, kind: 'external', repo })),
    ],
    [apps, repos]
  );

  // The selection is exactly what the user picked. An unknown/removed id yields null (execution disabled) - never a fallback project.
  const selectedProject = projects.find((p) => p.id === selectedAppId) ?? null;
  const selectedApp = selectedProject?.kind === 'local' ? selectedProject.app ?? null : null;
  const selectedRepo = selectedProject?.kind === 'external' ? selectedProject.repo ?? null : null;

  const isRunning = isActive(selectedRun);
  const displayedLog = useMemo(() => entries.map((e) => e.text).join(''), [entries]);

  // History/KPIs for everything except the History page are scoped to the selected project.
  const scopedHistory = useMemo(
    () => (selectedProject ? history.filter((r) => r.appId === selectedProject.id) : []),
    [history, selectedProject]
  );
  const latestRunForRerun = useMemo(
    () => (selectedRun && selectedRun.appId === selectedProject?.id ? selectedRun : null) ?? byNewest(scopedHistory)[0] ?? null,
    [selectedRun, scopedHistory, selectedProject]
  );

  const selectProject = (id: string) => {
    setSelectedAppId(id);
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      // storage unavailable
    }
  };

  // Initial load: local apps + run history (repos load through useRepos)
  useEffect(() => {
    void (async () => {
      try {
        const [loadedApps, loadedRuns] = await Promise.all([fetchApps(), fetchRuns()]);
        setApps(loadedApps);
        setHistory(loadedRuns);
        if (loadedRuns.length > 0) await session.selectRun(loadedRuns[0].runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAppsLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selection hygiene once the project lists are known: pick a visible default only when nothing valid is selected.
  useEffect(() => {
    if (!appsLoaded || !reposLoaded) return;
    if (selectedAppId && !projects.some((p) => p.id === selectedAppId)) {
      // Selected repository was removed (or the id is stale): clear it rather than silently substituting another project.
      setSelectedAppId('');
      try {
        localStorage.removeItem(SELECTED_KEY);
      } catch {
        // ignore
      }
    }
  }, [appsLoaded, reposLoaded, projects, selectedAppId]);

  useEffect(() => {
    if (!appsLoaded || !reposLoaded) return;
    // First visit only (nothing ever selected): preselect the first project so the dropdown is never ambiguous.
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(SELECTED_KEY);
    } catch {
      remembered = null;
    }
    if (!selectedAppId && remembered === null && projects.length > 0) selectProject(projects[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appsLoaded, reposLoaded]);

  // Inspect local application when selected app changes
  useEffect(() => {
    setInspection(null);
    if (!selectedApp) return;
    void (async () => {
      try {
        setInspection(await inspectApp(selectedApp.id));
      } catch {
        // Non-blocking inspect error
      }
    })();
  }, [selectedApp?.id]);

  const surfaceError = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  async function startRun(params: { appId: string; suiteId?: string; layer?: RunScopeLayer; mode: ExecutionMode; expectedCommitSha?: string }) {
    setError(null);
    try {
      const run = await triggerRun({ appId: params.appId, suiteId: params.suiteId, layer: params.layer, executionMode: params.mode, expectedCommitSha: params.expectedCommitSha });
      session.attachRun(run);
      void refreshHistory();
      void refreshRepos();
    } catch (err: unknown) {
      setActiveRunSuiteId(undefined);
      surfaceError(err);
    }
  }

  async function handleRun(opts: { suiteId?: string; layer?: RunScopeLayer }) {
    if (!selectedProject) {
      setError('Select an application or connected repository before running tests.');
      return;
    }
    if (selectedProject.kind === 'external') {
      await handleRunRepo(selectedProject.id, opts.layer);
      return;
    }
    setActiveRunSuiteId(opts.suiteId);
    await startRun({ appId: selectedProject.id, suiteId: opts.suiteId, layer: opts.layer, mode: executionMode });
  }

  /** Runs an external repository, asking for explicit trust the first time. */
  async function handleRunRepo(repoId: string, requestedLayer?: RunScopeLayer, selection?: { expectedCommitSha?: string }) {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) {
      setError('That repository is no longer registered.');
      return;
    }
    if (repo.status !== 'ready') {
      setError(`${repo.name} is not ready to run (${repo.statusMessage ?? repo.status}).`);
      return;
    }
    // Trust is bound to one commit: a repository that moved on must be reviewed again.
    if (!repo.trustedAt || repo.trustedSha !== repo.commitSha) {
      setTrustPrompt({ repo, layer: runLayerFor(repo, requestedLayer, selection), expectedCommitSha: selection?.expectedCommitSha, action: 'run' });
      return;
    }
    await startRun({ appId: repo.id, layer: runLayerFor(repo, requestedLayer, selection), mode: 'isolated', expectedCommitSha: selection?.expectedCommitSha });
  }

  /** An explicit selection from the Fetch Tests panel is sent as-is ('all' included, so a saved layer setting cannot override it). */
  function runLayerFor(repo: ExternalRepo, requested: RunScopeLayer | undefined, selection?: { expectedCommitSha?: string }) {
    return selection && requested ? requested : repoRunLayer(repo, requested);
  }

  /** "Fetch Tests": list the repository's tests (never executes them). Needs the same per-commit trust as a run. */
  async function handleDiscoverRepo(repoId: string) {
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) {
      setError('That repository is no longer registered.');
      return;
    }
    if (!repo.trustedAt || repo.trustedSha !== repo.commitSha) {
      setTrustPrompt({ repo, action: 'discover' });
      return;
    }
    await discoverRepoTests(repo.id);
    await refreshRepos();
  }

  /** A layer is only requested when the repository can run it alone; otherwise the repository's own default (all) applies. */
  function repoRunLayer(repo: ExternalRepo, requested?: RunScopeLayer): RunScopeLayer | undefined {
    if (!requested || requested === 'all') return undefined;
    return repoLayerInfo(repo, requested).canRunAlone ? requested : undefined;
  }

  async function confirmTrust() {
    if (!trustPrompt) return;
    const { repo, layer, expectedCommitSha, action } = trustPrompt;
    setTrustBusy(true);
    try {
      await trustRepo(repo.id);
      await refreshRepos();
      setTrustPrompt(null);
      if (action === 'discover') await discoverRepoTests(repo.id);
      else await startRun({ appId: repo.id, layer, mode: 'isolated', expectedCommitSha });
      await refreshRepos();
    } catch (err) {
      setTrustPrompt(null);
      surfaceError(err);
    } finally {
      setTrustBusy(false);
    }
  }

  async function handleSelectRun(runId: string) {
    await session.selectRun(runId);
  }

  async function handleCancel() {
    if (!selectedRun) return;
    try {
      await cancelRun(selectedRun.runId);
    } catch (err: unknown) {
      surfaceError(err);
    }
  }

  // Re-run the same scope (suite or layer) as the latest run of the selected project.
  const handleRerun = () => {
    if (!latestRunForRerun) return;
    void handleRun(
      latestRunForRerun.suiteId
        ? { suiteId: latestRunForRerun.suiteId }
        : { layer: latestRunForRerun.kind === 'external' ? latestRunForRerun.config?.layer ?? 'all' : latestRunForRerun.layer }
    );
  };

  const handleToggleMode = () => {
    setExecutionMode((prev) => (prev === 'isolated' ? 'attach' : 'isolated'));
  };

  const runDisabledReason = !selectedProject
    ? 'Select an application or repository first'
    : selectedRepo && selectedRepo.status !== 'ready'
    ? `${selectedRepo.name} is not ready (${selectedRepo.status})`
    : null;

  // Repositories: what the last run really executed, else the runtime discovery; no badge rather than a guess.
  const suiteCount = (layer: 'unit' | 'integration' | 'e2e') =>
    selectedRepo
      ? (() => {
          const info = repoLayerInfo(selectedRepo, layer);
          return info.executed?.total ?? info.discovered ?? null;
        })()
      : selectedApp
      ? selectedApp.suites.filter((s) => s.layer === layer).length
      : null;

  const navSections: Array<NavSection<SidebarTab>> = [
    {
      heading: 'Main',
      items: [{ id: 'overview', label: 'Overview', icon: 'grid', title: 'Overview Dashboard' }],
    },
    {
      heading: 'Projects',
      items: [
        { id: 'local-projects', label: 'Local Projects', icon: 'folder', title: 'Local Projects', badge: apps.length },
        { id: 'public-repos', label: 'Public Repositories', icon: 'globe', title: 'Public Repositories', badge: repos.length },
      ],
    },
    {
      heading: 'Testing categories',
      items: [
        { id: 'unit', label: 'Unit Testing', icon: 'unit', title: 'Unit Testing', badge: suiteCount('unit') },
        { id: 'integration', label: 'Integration Testing', icon: 'layers', title: 'Integration Testing', badge: suiteCount('integration') },
        { id: 'e2e', label: 'E2E Testing', icon: 'target', title: 'E2E Browser Testing', badge: suiteCount('e2e') },
      ],
    },
    {
      heading: 'Management',
      items: [
        { id: 'history', label: 'Test History', icon: 'clock', title: 'Test Execution History', badge: history.length },
        { id: 'settings', label: 'Settings', icon: 'settings', title: 'Engine & Security Settings' },
      ],
    },
  ];

  const toggleNavigation = () => {
    if (window.matchMedia(DRAWER_QUERY).matches) setIsNavOpen((v) => !v);
    else setIsSidebarCollapsed((v) => !v);
  };

  const navigate = (tab: SidebarTab) => {
    setActiveTab(tab);
    setIsNavOpen(false);
    window.scrollTo({ top: 0 });
  };

  // Drawer hygiene: Escape closes it, and the page behind does not scroll while it is open.
  useEffect(() => {
    if (!isNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsNavOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [isNavOpen]);

  const alertMessage = error ?? session.streamError ?? reposError;
  const showNoProject =
    !selectedProject && appsLoaded && reposLoaded && activeTab !== 'public-repos' && activeTab !== 'settings' && activeTab !== 'history';

  return (
    <div className={`app ${isSidebarCollapsed ? 'is-collapsed' : ''} ${isNavOpen ? 'is-nav-open' : ''}`}>
      <Sidebar sections={navSections} active={activeTab} onSelect={navigate} targetName={selectedProject?.name ?? null} isRunning={isRunning} />
      <button type="button" className="scrim" aria-label="Close navigation" tabIndex={isNavOpen ? 0 : -1} onClick={() => setIsNavOpen(false)} />

      <div className="main">
        {/* ================================================================
            Top bar: what is selected, how it runs, and the one primary action
            ================================================================ */}
        <header className="topbar">
          <button
            type="button"
            className="icon-btn"
            onClick={toggleNavigation}
            title="Toggle sidebar navigation"
            aria-label="Toggle sidebar navigation"
            aria-controls="primary-navigation"
            aria-expanded={isNavOpen || !isSidebarCollapsed}
          >
            <Icon name="menu" size={18} strokeWidth={2} />
          </button>

          <div className="topbar-context">
            <label className="select-pill select-repo">
              <span className="select-pill-label">Repo</span>
              <select
                value={selectedProject ? selectedProject.id : ''}
                onChange={(e) => selectProject(e.target.value)}
                aria-label="Repository Selector"
              >
                {!selectedProject && (
                  <option value="" disabled>
                    {projects.length === 0 ? 'No repositories registered' : 'Select a repository…'}
                  </option>
                )}
                {apps.length > 0 && (
                  <optgroup label="Local applications">
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {repos.length > 0 && (
                  <optgroup label="GitHub repositories">
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} · {r.owner}/{r.branch}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <Icon name="chevron" size={14} />
            </label>

            <label className="select-pill select-mode">
              <span className="select-pill-label">Mode</span>
              <select
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
                disabled={isRunning || !!selectedRepo}
                title={selectedRepo ? 'External repositories always run in an isolated per-run workspace' : undefined}
                aria-label="Runtime Execution Mode"
              >
                <option value="isolated">Isolated Temp Copy</option>
                <option value="attach">Attach to Local Services</option>
              </select>
              <Icon name="chevron" size={14} />
            </label>
          </div>

          <div className="topbar-actions">
            <label className="search-pill header-search">
              <Icon name="search" size={15} />
              <input
                type="text"
                placeholder="Search runs…"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate('history');
                }}
                aria-label="Search test history"
              />
            </label>

            <button
              type="button"
              className="icon-btn theme-toggle"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name="sun" size={17} className="icon-sun" />
              <Icon name="moon" size={17} className="icon-moon" />
            </button>

            {isRunning ? (
              <button type="button" className="btn btn-dark" onClick={handleCancel}>
                <span className="pill-dot is-live" />
                <span className="btn-label-long">Cancel active run</span>
                <span className="btn-label-short">Cancel</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-accent"
                disabled={!!runDisabledReason}
                title={runDisabledReason ?? undefined}
                onClick={() => handleRun({ layer: 'all' })}
              >
                <Icon name="play" size={12} />
                <span className="btn-label-long">Run All Tests</span>
                <span className="btn-label-short">Run</span>
              </button>
            )}
          </div>
        </header>

        <main className="workspace">
          <div className="workspace-alerts">
            {alertMessage && (
              <div className="error-banner" role="alert">
                <span>{alertMessage}</span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setError(null);
                    session.clearStreamError();
                  }}
                  aria-label="Dismiss error"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}

            {showNoProject && (
              <div className="notice notice-error" role="status">
                <Icon name="info" size={16} />
                <div>
                  <strong>No repository selected.</strong>{' '}
                  {projects.length === 0
                    ? 'Register a local application or connect a public GitHub repository under Public Repositories.'
                    : 'Pick one in the Repository selector. Running is disabled until a valid project is selected.'}
                </div>
              </div>
            )}
          </div>

          {/* Keyed by tab so each screen replays its entrance when you arrive on it. */}
          <div className="view" key={activeTab}>
            {activeTab === 'overview' && (
              <MinimalOverview
                apps={apps}
                selectedProject={selectedProject}
                selectedRun={selectedRun}
                history={scopedHistory}
                allRuns={history}
                onOpenRepoRun={(appId, runId) => {
                  selectProject(appId);
                  void handleSelectRun(runId);
                  navigate('history');
                }}
                isRunning={isRunning}
                executionMode={executionMode}
                onNavigateTab={navigate}
                onRunCategory={(cat) => handleRun({ layer: cat })}
                onRerun={handleRerun}
                onSelectRun={handleSelectRun}
                selectedLog={displayedLog}
                entries={entries}
                live={live}
                onCancelRun={handleCancel}
                onClearLog={session.clearLog}
                onToggleMode={handleToggleMode}
              />
            )}

            {activeTab === 'local-projects' && (
              <LocalProjectsView
                apps={apps}
                selectedAppId={selectedAppId}
                inspection={inspection}
                history={history}
                onSelectApp={(id) => selectProject(id)}
                onRunApp={() => handleRun({ layer: 'all' })}
                isRunning={isRunning}
              />
            )}

            {activeTab === 'public-repos' && (
              <PublicReposView
                repos={repos}
                reposLoaded={reposLoaded}
                selectedProjectId={selectedProject?.id ?? null}
                onSelectProject={selectProject}
                onReposChanged={refreshRepos}
                onRunRepo={handleRunRepo}
                onDiscoverRepo={handleDiscoverRepo}
                isRunning={isRunning}
                selectedRun={selectedRun}
                selectedLog={displayedLog}
                entries={entries}
                live={live}
                onCancelRun={handleCancel}
                onClearLog={session.clearLog}
              />
            )}

            {(activeTab === 'unit' || activeTab === 'integration' || activeTab === 'e2e') && (
              <CategoryTestingView
                category={activeTab}
                apps={apps}
                projects={projects}
                selectedProjectId={selectedProject?.id ?? null}
                onSelectProject={(projId) => selectProject(projId)}
                executionMode={executionMode}
                isRunning={isRunning}
                activeRunSuiteId={activeRunSuiteId}
                selectedRun={selectedRun}
                history={scopedHistory}
                selectedLog={displayedLog}
                entries={entries}
                live={live}
                onRunCategoryAll={(cat) => handleRun({ layer: cat })}
                onRunSuite={(suiteId) => handleRun({ suiteId })}
                onSelectRun={handleSelectRun}
                onCancelRun={handleCancel}
                onClearLog={session.clearLog}
              />
            )}

            {activeTab === 'history' && (
              <TestHistoryView
                history={history}
                selectedRun={selectedRun}
                onSelectRun={handleSelectRun}
                apps={apps}
                projects={projects}
                selectedProjectId={selectedProject?.id ?? null}
                query={historyQuery}
                onQueryChange={setHistoryQuery}
                selectedLog={displayedLog}
                entries={entries}
                live={live}
                isRunning={isRunning}
                onCancelRun={handleCancel}
                onClearLog={session.clearLog}
              />
            )}

            {activeTab === 'settings' && <SettingsView executionMode={executionMode} onChangeMode={setExecutionMode} />}
          </div>
        </main>
      </div>

      {trustPrompt && (
        <TrustDialog repo={trustPrompt.repo} purpose={trustPrompt.action} busy={trustBusy} onConfirm={() => void confirmTrust()} onCancel={() => setTrustPrompt(null)} />
      )}
    </div>
  );
}
