import { useEffect, useMemo, useState } from 'react';
import { LogEntry, NormalizedTestRun, ProjectRef, RegisteredApp, TestLayer } from '../types';
import type { LiveRunState } from '../hooks/useRunSession';
import {
  appKpis,
  byNewest,
  formatDuration,
  formatShortDateTime,
  repoLabel,
  runScopeLabel,
  shortRunId,
  layerCounts,
} from '../lib/metrics';
import { exportRuns } from '../lib/exportRuns';
import { CardHead, MetricCard, PageHead, StatusPill } from './common';
import { ExternalRunResults } from './ExternalRunResults';
import { Icon } from './icons';
import { RunsTable } from './RunsTable';
import { TerminalPanel } from './TerminalPanel';

interface TestHistoryViewProps {
  history: NormalizedTestRun[];
  selectedRun: NormalizedTestRun | null;
  onSelectRun: (runId: string) => void;
  apps?: RegisteredApp[];
  projects?: ProjectRef[];
  selectedProjectId?: string | null;
  entries?: LogEntry[];
  live?: LiveRunState;
  query?: string;
  onQueryChange?: (q: string) => void;
  selectedLog?: string;
  isRunning?: boolean;
  onCancelRun?: () => void;
  onClearLog?: () => void;
}

export function TestHistoryView({
  history,
  selectedRun,
  onSelectRun,
  apps = [],
  projects = [],
  selectedProjectId = null,
  entries,
  live,
  query,
  onQueryChange,
  selectedLog = '',
  isRunning = false,
  onCancelRun,
  onClearLog,
}: TestHistoryViewProps) {
  const [filterApp, setFilterApp] = useState<string>(selectedProjectId ?? 'all');
  const [filterLayer, setFilterLayer] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [localQuery, setLocalQuery] = useState('');

  const q = (query ?? localQuery).trim().toLowerCase();
  const setQ = onQueryChange ?? setLocalQuery;

  // Follow the header's project selector so history always matches what is selected.
  useEffect(() => {
    setFilterApp(selectedProjectId ?? 'all');
  }, [selectedProjectId]);

  const appRuns = useMemo(
    () => (filterApp === 'all' ? history : history.filter((r) => r.appId === filterApp)),
    [history, filterApp]
  );
  const kpis = useMemo(() => appKpis(appRuns), [appRuns]);
  const filterAppName = filterApp === 'all' ? 'All projects' : projects.find((p) => p.id === filterApp)?.name ?? filterApp;

  const filtered = useMemo(
    () =>
      byNewest(appRuns).filter((r) => {
        if (filterLayer !== 'all' && r.layer !== filterLayer && !(filterLayer !== 'all' && layerCounts(r, filterLayer as TestLayer))) return false;
        if (filterStatus !== 'all' && r.status !== filterStatus) return false;
        if (q) {
          const hay = [r.runId, r.suiteId, r.layer, r.status, r.framework, r.executionMode, runScopeLabel(r, apps), repoLabel(r, apps)]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [appRuns, filterLayer, filterStatus, q, apps]
  );

  return (
    <div className="page history">
      <PageHead
        eyebrow="Persisted reports"
        title="Test execution history"
        description="All past test runs persisted under testing-dashboard/.runs/. Select any row to inspect its report and replay its logs."
        meta={
          <span className="chip chip-plain">
            <Icon name="clock" size={13} />
            {appRuns.length} {appRuns.length === 1 ? 'run' : 'runs'} · {filterAppName}
          </span>
        }
        actions={
          <button
            type="button"
            className="btn btn-pill btn-white"
            onClick={() => exportRuns(filtered)}
            disabled={filtered.length === 0}
            title="Download the filtered runs as JSON"
          >
            <Icon name="download" size={15} />
            Export
          </button>
        }
      />

      <div className="metric-row history-kpis">
        <MetricCard icon={<Icon name="clock" size={14} />} label="Total runs" value={kpis.totalRuns} sub={`${kpis.passedRuns} passed · ${kpis.failedRuns} failed`} />
        <MetricCard icon={<Icon name="target" size={14} />} label="Pass rate" value={kpis.passRate === null ? '—' : `${kpis.passRate}%`} sub="of executed tests" />
        <MetricCard icon={<Icon name="x" size={14} strokeWidth={2.2} />} label="Failed runs" value={kpis.failedRuns} />
        <MetricCard icon={<Icon name="clock" size={14} />} label="Avg duration" value={formatDuration(kpis.avgDurationMs)} />
        <MetricCard
          icon={<Icon name="check" size={14} strokeWidth={2.2} />}
          label="Tests"
          value={
            <>
              {kpis.passedTests}
              <span className="metric-value-sub"> passed</span>
            </>
          }
          sub={`${kpis.failedTests} failed · ${kpis.errorTests} errors · ${kpis.skippedTests} skipped`}
        />
      </div>

      <section className="card">
        <div className="toolbar">
          <label className="search-pill toolbar-search">
            <Icon name="search" size={15} />
            <input
              type="text"
              value={query ?? localQuery}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search run ID, suite, status…"
              aria-label="Search test history"
            />
          </label>

          <div className="toolbar-filters">
            <label className="select-pill" htmlFor="filter-app">
              <span className="select-pill-label">Project</span>
              <select id="filter-app" value={filterApp} onChange={(e) => setFilterApp(e.target.value)}>
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={14} />
            </label>

            <label className="select-pill" htmlFor="filter-layer">
              <span className="select-pill-label">Layer</span>
              <select id="filter-layer" value={filterLayer} onChange={(e) => setFilterLayer(e.target.value)}>
                <option value="all">All layers</option>
                <option value="unit">Unit</option>
                <option value="integration">Integration</option>
                <option value="e2e">E2E</option>
              </select>
              <Icon name="chevron" size={14} />
            </label>

            <label className="select-pill" htmlFor="filter-status">
              <span className="select-pill-label">Status</span>
              <select id="filter-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="passed">Passed</option>
                <option value="failed">Failed</option>
                <option value="error">Error</option>
                <option value="running">Running</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <Icon name="chevron" size={14} />
            </label>
          </div>
        </div>

        <div className="panel table-panel">
          <RunsTable
            runs={filtered}
            apps={apps}
            variant="full"
            selectedRunId={selectedRun?.runId}
            onSelect={onSelectRun}
            emptyText="No test runs match the selected filters."
          />
        </div>
        <p className="table-foot">
          Showing {filtered.length} of {appRuns.length} runs
        </p>
      </section>

      {/* Selected run: report details + replayed logs */}
      {selectedRun && (
        <section className="card">
          <CardHead
            title={`Run ${shortRunId(selectedRun.runId)}`}
            subtitle={`${runScopeLabel(selectedRun, apps)} · ${formatShortDateTime(selectedRun.startedAt)} · ${formatDuration(selectedRun.durationMs)}`}
            actions={<StatusPill status={selectedRun.status} label={selectedRun.status === 'error' && selectedRun.failureKind === 'infrastructure' ? 'infra error' : undefined} />}
          />

          <div className="panel report-meta">
            <div className="report-item">
              <span className="path-label">Run ID</span>
              <code className="mono">{selectedRun.runId}</code>
            </div>
            <div className="report-item">
              <span className="path-label">Framework</span>
              <span>{selectedRun.framework}</span>
            </div>
            <div className="report-item">
              <span className="path-label">Mode</span>
              <span>{selectedRun.executionMode}</span>
            </div>
            {selectedRun.artifacts.logPath && (
              <div className="report-item report-wide">
                <span className="path-label">Log artifact</span>
                <code className="mono">{selectedRun.artifacts.logPath}</code>
              </div>
            )}
            {selectedRun.artifacts.rawReportPath && (
              <div className="report-item report-wide">
                <span className="path-label">Raw report</span>
                <code className="mono">{selectedRun.artifacts.rawReportPath}</code>
              </div>
            )}
          </div>

          {selectedRun.kind === 'external' ? (
            <p className="table-foot">Full results, failure details and reports for this external run are shown below.</p>
          ) : selectedRun.suites.length > 0 ? (
            selectedRun.suites.map((suite, idx) => (
              <div key={`${suite.name}-${idx}`} className="detail-suite">
                <div className="detail-suite-head">
                  <span className="detail-suite-name">
                    <span className={`layer-dot layer-${suite.layer}`} />
                    {suite.name}
                  </span>
                  <span className="cell-muted">
                    {suite.cases.length} {suite.cases.length === 1 ? 'case' : 'cases'} · {suite.durationMs}ms
                  </span>
                </div>

                {suite.cases.length > 0 && (
                  <div className="panel table-panel">
                    <div className="table-scroll">
                      <table className="runs-table simple-table">
                        <thead>
                          <tr>
                            <th>Test case</th>
                            <th>Status</th>
                            <th className="num">Duration</th>
                          </tr>
                        </thead>
                        <tbody>
                          {suite.cases.map((tc, cIdx) => (
                            <tr key={`${tc.name}-${cIdx}`} className="no-hover">
                              <td>
                                <div className="tc-name">{tc.name}</div>
                                {tc.error && (
                                  <div className="tc-error">
                                    <strong>{tc.error.message}</strong>
                                    {tc.error.stack && <pre>{tc.error.stack}</pre>}
                                  </div>
                                )}
                              </td>
                              <td>
                                <StatusPill status={tc.status === 'error' ? 'caseerror' : tc.status} label={tc.status} />
                              </td>
                              <td className="num">{tc.durationMs}ms</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))
          ) : (
            <p className="table-foot">No per-test report was recorded for this run.</p>
          )}
        </section>
      )}

      {selectedRun?.kind === 'external' && <ExternalRunResults run={selectedRun} isRunning={isRunning} />}

      {selectedRun && onCancelRun && (
        <TerminalPanel
          selectedRun={selectedRun}
          selectedLog={selectedLog}
          entries={entries}
          live={live}
          isRunning={isRunning}
          onCancel={onCancelRun}
          onClearLog={onClearLog}
          title="Run log"
          subtitle="Sanitized output persisted for the selected run"
        />
      )}
    </div>
  );
}
