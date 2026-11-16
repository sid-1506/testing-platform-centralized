import { useMemo, useState } from 'react';
import { LogEntry, NormalizedTestRun, ProjectRef, RegisteredApp, TestLayer } from '../types';
import type { LiveRunState } from '../hooks/useRunSession';
import {
  LAYERS,
  LAYER_LABEL,
  LAYER_SHORT,
  averageDuration,
  byNewest,
  dayBuckets,
  failedLike,
  notPassing,
  repoLayerInfo,
  formatDuration,
  hasResults,
  isActive,
  layerSeries,
  passRate,
  runBuckets,
  runsBetween,
  shortRunId,
  shortAppName,
} from '../lib/metrics';
import { exportRuns } from '../lib/exportRuns';
import { AnimatedNumber, BarChart, CardHead, DeltaChip, MetricCard, PageHead, Sparkline, SplitBar, StatusPill } from './common';
import { Icon } from './icons';
import type { IconName } from './icons';
import { ExternalRunResults } from './ExternalRunResults';
import { RecentRepoRuns } from './RecentRepoRuns';
import { RunsTable } from './RunsTable';
import { TerminalPanel } from './TerminalPanel';

type TabTarget = 'unit' | 'integration' | 'e2e' | 'history' | 'settings';

interface MinimalOverviewProps {
  apps: RegisteredApp[];
  selectedProject: ProjectRef | null;
  selectedRun: NormalizedTestRun | null;
  history: NormalizedTestRun[];
  /** All persisted runs across every project (for the Recent Repository Runs card). */
  allRuns: NormalizedTestRun[];
  onOpenRepoRun: (appId: string, runId: string) => void;
  isRunning: boolean;
  executionMode: 'isolated' | 'attach';
  onNavigateTab: (tab: TabTarget) => void;
  onRunCategory: (layer: TestLayer) => void;
  onRerun: () => void;
  onSelectRun: (runId: string) => void;
  selectedLog: string;
  entries: LogEntry[];
  live: LiveRunState;
  onCancelRun: () => void;
  onClearLog: () => void;
  onToggleMode: () => void;
}

const LAYER_ICON: Record<TestLayer, IconName> = {
  unit: 'unit',
  integration: 'layers',
  e2e: 'target',
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function MinimalOverview({
  apps,
  selectedProject,
  selectedRun,
  history,
  allRuns,
  onOpenRepoRun,
  isRunning,
  executionMode,
  onNavigateTab,
  onRunCategory,
  onRerun,
  onSelectRun,
  selectedLog,
  entries,
  live,
  onCancelRun,
  onClearLog,
  onToggleMode,
}: MinimalOverviewProps) {
  const selectedApp: RegisteredApp | null = selectedProject?.kind === 'local' ? selectedProject.app ?? null : null;
  const selectedRepo = selectedProject?.kind === 'external' ? selectedProject.repo ?? null : null;
  const [range, setRange] = useState<'days' | 'runs'>('days');

  const sorted = useMemo(() => byNewest(history), [history]);
  // Only follow the selected run when it belongs to the selected project (history is already project-scoped).
  const latestRun = (selectedRun && selectedRun.appId === selectedProject?.id ? selectedRun : null) ?? sorted[0] ?? null;
  const latestActive = isActive(latestRun);

  const repoLayers = selectedRepo ? LAYERS.filter((l) => repoLayerInfo(selectedRepo, l).applicable) : [];
  const totalSuites = selectedRepo ? repoLayers.length : selectedApp?.suites.length ?? 0;
  const suiteCount = (layer: TestLayer) =>
    selectedRepo ? (repoLayers.includes(layer) ? 1 : 0) : selectedApp?.suites.filter((s) => s.layer === layer).length ?? 0;

  const summary = latestRun?.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };
  const latestRate = latestActive ? null : passRate(summary);

  const buckets = useMemo(() => (range === 'days' ? dayBuckets(history, 7) : runBuckets(history, 12)), [history, range]);

  const layerCards = useMemo(
    () =>
      LAYERS.map((layer) => {
        const series = layerSeries(history, layer);
        const latest = series[series.length - 1];
        const prev = series[series.length - 2];
        return {
          layer,
          series,
          latest,
          delta: latest && prev ? latest.rate - prev.rate : null,
          suites: selectedApp?.suites.filter((s) => s.layer === layer) ?? [],
        };
      }),
    [history, selectedApp]
  );

  const highlightLayer: TestLayer | null =
    latestRun && (LAYERS as string[]).includes(latestRun.layer) ? (latestRun.layer as TestLayer) : null;

  // Weekly + totals - all derived from persisted runs.
  const now = Date.now();
  const thisWeek = runsBetween(history, now - 7 * DAY_MS, now + 1);
  const prevWeek = runsBetween(history, now - 14 * DAY_MS, now - 7 * DAY_MS);
  const weekDelta = thisWeek + prevWeek > 0 ? thisWeek - prevWeek : null;
  const totalTestsExecuted = history.filter(hasResults).reduce((acc, r) => acc + r.summary.total, 0);
  const avg = averageDuration(history);

  const recent = sorted.slice(0, 6);

  return (
    <div className="page overview">
      {/* ------------------------------------------------------------------ Heading */}
      <PageHead
        eyebrow="Overview"
        title={selectedProject ? shortAppName(selectedProject.name) : 'Welcome back'}
        description="Monitor your application quality, test executions and results."
        meta={
          <>
            <span className="chip chip-plain">
              <Icon name={selectedRepo ? 'git' : 'folder'} size={13} />
              {selectedProject?.name ?? 'No repository selected'}
            </span>
            <span className="chip chip-plain">
              <Icon name="layers" size={13} />
              {totalSuites} test {totalSuites === 1 ? 'suite' : 'suites'}
            </span>
            <button
              type="button"
              className="chip chip-plain chip-button"
              onClick={onToggleMode}
              disabled={isRunning}
              title="Toggle runtime isolation mode"
            >
              <Icon name="lock" size={13} />
              {executionMode === 'isolated' ? 'Isolated copy' : 'Attach to local'}
            </button>
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-pill btn-white" onClick={() => onNavigateTab('history')}>
              <Icon name="clock" size={15} />
              History
            </button>
            <button
              type="button"
              className="btn btn-pill btn-white"
              onClick={() => exportRuns(sorted)}
              disabled={sorted.length === 0}
              title="Download persisted runs as JSON"
            >
              <Icon name="download" size={15} />
              Export
            </button>
          </>
        }
      />

      {/* ------------------------------------------------------------------ Latest run + Activity */}
      <div className="grid-main">
        <section className="card">
          <CardHead
            title="Latest run"
            subtitle={latestRun ? `${latestRun.suiteId ?? latestRun.layer} · ${shortRunId(latestRun.runId)}` : 'No runs yet for this project.'}
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-pill btn-sm btn-white-line"
                  onClick={onRerun}
                  disabled={isRunning || !latestRun}
                  title="Run the same scope again"
                >
                  <Icon name="refresh" size={13} />
                  Re-run
                </button>
                <button type="button" className="btn btn-pill btn-sm btn-dark" onClick={() => onNavigateTab('history')} disabled={!latestRun}>
                  Inspect
                  <Icon name="arrow-up-right" size={13} />
                </button>
              </>
            }
          />

          <div className="hero">
            <div className="hero-figure">
              <span className="hero-label">
                Pass rate
                <StatusPill status={latestRun?.status ?? 'idle'} />
              </span>
              <span className="hero-value" title={latestRun?.runId}>
                {latestRate === null ? (
                  '—'
                ) : (
                  <>
                    <AnimatedNumber value={latestRate} />
                    <span className="hero-unit">%</span>
                  </>
                )}
              </span>
            </div>

            <div className="stat-row">
              <div className="stat">
                <span className="stat-label">Total tests</span>
                <span className="stat-value">{summary.total}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Passed</span>
                <span className="stat-value">{summary.passed}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Failed</span>
                <span className={`stat-value ${failedLike(summary) > 0 ? 'is-fail' : ''}`}>{failedLike(summary)}</span>
              </div>
              {summary.errors !== undefined && (
                <div className="stat">
                  <span className="stat-label">Errors</span>
                  <span className={`stat-value ${summary.errors > 0 ? 'is-fail' : ''}`}>{summary.errors}</span>
                </div>
              )}
            </div>
          </div>

          <SplitBar passed={summary.passed} failed={notPassing(summary)} skipped={summary.skipped} />

          <div className="chart-block">
            <div className="chart-head">
              <span className="chart-title">{range === 'days' ? 'Tests per day' : 'Tests per run'}</span>
              <label className="select-pill">
                <select value={range} onChange={(e) => setRange(e.target.value as 'days' | 'runs')} aria-label="Summary range">
                  <option value="days">Last 7 days</option>
                  <option value="runs">Recent runs</option>
                </select>
                <Icon name="chevron" size={14} />
              </label>
            </div>
            <BarChart
              key={range}
              buckets={buckets}
              unit={range === 'days' ? 'Tests per day, last 7 days' : 'Tests per run, latest 12 runs'}
              emptyText={range === 'days' ? 'No runs in the last 7 days' : 'No finished runs yet'}
              showEveryLabel={range === 'days'}
            />
          </div>
        </section>

        <div className="grid-side">
          <section className="card">
            <CardHead
              title="Activity"
              subtitle="Latest result per testing layer."
              actions={
                <button type="button" className="icon-btn" onClick={() => onNavigateTab('history')} title="Open history" aria-label="Open history">
                  <Icon name="arrow-up-right" size={16} />
                </button>
              }
            />

            <div className="layer-list">
              {layerCards.map(({ layer, series, latest, delta, suites }) => {
                const isLatest = highlightLayer === layer;
                const frameworks = Array.from(new Set(suites.map((s) => s.framework)));
                return (
                  <article
                    key={layer}
                    className={`layer-row ${isLatest ? 'is-latest' : ''}`}
                    role="link"
                    tabIndex={0}
                    onClick={() => onNavigateTab(layer)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onNavigateTab(layer);
                    }}
                    title={`Open ${LAYER_LABEL[layer]}`}
                  >
                    <span className="layer-icon">
                      <Icon name={LAYER_ICON[layer]} size={16} />
                    </span>

                    <div className="layer-id">
                      <span className="layer-name">
                        {LAYER_SHORT[layer]}
                        {isLatest && <span className="layer-tag">Latest</span>}
                      </span>
                      <span className="layer-delta">
                        {delta !== null ? (
                          <DeltaChip value={delta} suffix="%" hint="Pass rate vs previous run of this layer" />
                        ) : (
                          <span className="delta delta-flat">
                            {suites.length} {suites.length === 1 ? 'suite' : 'suites'}
                            {frameworks.length > 0 ? ` · ${frameworks.join(', ')}` : ''}
                          </span>
                        )}
                      </span>
                    </div>

                    <div className="layer-trend">
                      <Sparkline
                        values={series.map((p) => p.counts.passed)}
                        label={`${LAYER_SHORT[layer]} tests passed across the last ${series.length} runs`}
                        emptyText={series.length === 0 ? 'No runs yet' : 'Trend appears after 2 runs'}
                      />
                    </div>

                    <div className="layer-value">
                      {latest ? latest.counts.passed : '—'}
                      {latest && <span className="layer-value-total"> / {latest.counts.total}</span>}
                    </div>

                    <button
                      type="button"
                      className="btn btn-pill btn-sm layer-run"
                      disabled={isRunning || suites.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRunCategory(layer);
                      }}
                    >
                      <Icon name="play" size={10} />
                      Run
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <RecentRepoRuns runs={allRuns} onOpenRun={onOpenRepoRun} />
        </div>
      </div>

      {/* ------------------------------------------------------------------ Totals */}
      <div className="metric-row">
        <MetricCard
          icon={<Icon name="clock" size={14} />}
          label="Runs · 7 days"
          delta={<DeltaChip value={weekDelta} hint="Compared with the previous 7 days" />}
          value={thisWeek}
          sub={weekDelta === null ? 'No earlier runs to compare' : 'vs previous 7 days'}
        />
        <MetricCard
          icon={<Icon name="bolt" size={14} />}
          label="Avg duration"
          value={avg ? formatDuration(avg.ms) : '—'}
          sub={avg ? `across ${avg.samples} runs` : 'No data'}
        />
        <MetricCard icon={<Icon name="refresh" size={14} />} label="Total executions" value={history.length} sub={`${totalTestsExecuted} tests run`} />
        <MetricCard
          icon={<Icon name="layers" size={14} />}
          label="Test suites"
          value={totalSuites}
          sub={`${suiteCount('unit')} unit · ${suiteCount('integration')} integration · ${suiteCount('e2e')} E2E`}
        />
      </div>

      {/* ------------------------------------------------------------------ Live terminal (wide) */}
      <TerminalPanel
        selectedRun={latestRun}
        selectedLog={selectedLog}
        entries={entries}
        live={live}
        isRunning={isRunning}
        onCancel={onCancelRun}
        onClearLog={onClearLog}
      />

      {latestRun?.kind === 'external' && <ExternalRunResults run={latestRun} isRunning={isActive(latestRun)} />}

      {/* ------------------------------------------------------------------ History */}
      <section className="card">
        <CardHead
          title="Test execution history"
          subtitle={selectedProject ? `Track your history · ${shortAppName(selectedProject.name)}` : 'Track your history.'}
          actions={
            <button type="button" className="btn btn-pill btn-sm btn-white-line" onClick={() => onNavigateTab('history')}>
              Open history
              <Icon name="arrow-up-right" size={13} />
            </button>
          }
        />
        <div className="panel table-panel">
          <RunsTable runs={recent} apps={apps} selectedRunId={latestRun?.runId} onSelect={onSelectRun} />
          {sorted.length > recent.length && (
            <button type="button" className="link-row" onClick={() => onNavigateTab('history')}>
              View all {sorted.length} runs <Icon name="arrow-right" size={14} />
            </button>
          )}
        </div>
      </section>

      <div className="safeguard-card">
        <span className="safeguard-icon">
          <Icon name="shield" size={18} />
        </span>
        <div className="safeguard-text">
          <strong>Sandbox safeguards</strong>
          <span>Source is read-only. Secrets and ports stay isolated.</span>
        </div>
        <button type="button" className="btn btn-pill btn-sm btn-white-line" onClick={() => onNavigateTab('settings')}>
          Verify config
        </button>
      </div>
    </div>
  );
}
