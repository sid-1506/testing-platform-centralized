import { useMemo } from 'react';
import { ExecutionMode, LogEntry, NormalizedTestRun, ProjectRef, RegisteredApp, SuiteConfig } from '../types';
import type { LiveRunState } from '../hooks/useRunSession';
import {
  LAYER_SHORT,
  byNewest,
  formatDuration,
  formatShortDateTime,
  isActive,
  latestSuiteResult,
  layerCounts,
  layerSeries,
  passRate,
  repoLayerInfo,
  shortAppName,
  staticEstimate,
} from '../lib/metrics';
import { CardHead, MetricCard, PageHead, StatusPill } from './common';
import { Icon } from './icons';
import type { IconName } from './icons';
import { ExternalRunResults } from './ExternalRunResults';
import { ProjectFolderCards } from './ProjectFolderCards';
import { RunsTable } from './RunsTable';
import { TerminalPanel } from './TerminalPanel';

type Category = 'unit' | 'integration' | 'e2e';

interface CategoryTestingViewProps {
  category: Category;
  apps: RegisteredApp[];
  projects: ProjectRef[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  executionMode: ExecutionMode;
  isRunning: boolean;
  activeRunSuiteId?: string;
  selectedRun: NormalizedTestRun | null;
  history: NormalizedTestRun[];
  selectedLog: string;
  entries: LogEntry[];
  live: LiveRunState;
  onRunCategoryAll: (category: Category) => void;
  onRunSuite: (suiteId: string) => void;
  onSelectRun: (runId: string) => void;
  onCancelRun: () => void;
  onClearLog: () => void;
}

const CATEGORY_META: Record<
  Category,
  { title: string; badge: string; description: string; runAllLabel: string; icon: IconName }
> = {
  unit: {
    title: 'Unit Testing',
    badge: 'Isolated execution',
    description:
      'Fast, independent tests for standalone functions, security helpers, and business logic. Does not require target servers to be running.',
    runAllLabel: 'Run all unit tests',
    icon: 'unit',
  },
  integration: {
    title: 'Integration & API Testing',
    badge: 'Multi-service verification',
    description:
      'Verifies inter-service HTTP communication, authentication tokens, SQLite isolation, and API gateway routing across microservices.',
    runAllLabel: 'Run all integration tests',
    icon: 'layers',
  },
  e2e: {
    title: 'End-to-End (E2E) Testing',
    badge: 'Headless browser · Playwright',
    description:
      'Simulates real user workflows in a browser, covering centralized SSO login, session preservation, and multi-app navigation.',
    runAllLabel: 'Run all E2E tests',
    icon: 'target',
  },
};

export function CategoryTestingView({
  category,
  apps,
  projects,
  selectedProjectId,
  onSelectProject,
  executionMode,
  isRunning,
  activeRunSuiteId,
  selectedRun,
  history,
  selectedLog,
  entries,
  live,
  onRunCategoryAll,
  onRunSuite,
  onSelectRun,
  onCancelRun,
  onClearLog,
}: CategoryTestingViewProps) {
  const meta = CATEGORY_META[category];
  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const selectedRealApp = selectedProject?.kind === 'local' ? selectedProject.app ?? null : null;
  const selectedRepo = selectedProject?.kind === 'external' ? selectedProject.repo ?? null : null;

  // Only the suites belonging to this category (external repositories are a single E2E suite, handled below)
  const suites: SuiteConfig[] = selectedRealApp ? selectedRealApp.suites.filter((s) => s.layer === category) : [];

  const frameworks = Array.from(new Set(suites.map((s) => s.framework)));

  // Metrics come from the (already project-scoped) history.
  const layerRuns = useMemo(
    () => byNewest(history).filter((r) => r.layer === category || (r.layer === 'all' && layerCounts(r, category) !== null)),
    [history, category]
  );
  const series = useMemo(() => layerSeries(history, category), [history, category]);
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const latestLayerRun = layerRuns.find((r) => r.layer === category && !isActive(r));
  const rate = latest ? passRate(latest.counts) : null;

  const selectedRunId = selectedRun?.runId;
  const projectName = selectedRealApp ? shortAppName(selectedRealApp.name) : selectedRepo ? selectedRepo.name : null;
  const repoInfo = selectedRepo ? repoLayerInfo(selectedRepo, category) : null;
  const externalRunnable = !!selectedRepo && selectedRepo.status === 'ready' && !!repoInfo?.applicable;
  const canRunAll = !!selectedProject && !isRunning && (selectedRepo ? externalRunnable : suites.length > 0);
  const externalRun = selectedRepo && selectedRun?.appId === selectedRepo.id ? selectedRun : null;
  const repoFrameworks = selectedRepo?.detection?.frameworks ?? (selectedRepo?.detection?.framework ? [selectedRepo.detection.framework] : []);
  const executedHere = repoInfo?.executed ?? null;
  const countChip = selectedRepo
    ? executedHere
      ? `${executedHere.total} executed (last run)`
      : repoInfo?.discovered !== null && repoInfo?.discovered !== undefined
        ? `${repoInfo.discovered} discovered (runtime)`
        : 'not run yet'
    : `${suites.length} ${suites.length === 1 ? 'suite' : 'suites'}`;

  return (
    <div className="page category">
      <PageHead
        eyebrow={meta.badge}
        title={meta.title}
        description={meta.description}
        meta={
          <>
            <span className="chip chip-plain">
              <Icon name={selectedRepo ? 'git' : 'folder'} size={13} />
              {projectName ?? 'No repository selected'}
            </span>
            <span className="chip chip-plain">
              <Icon name={meta.icon} size={13} />
              {countChip}
            </span>
            {(selectedRepo ? repoFrameworks : frameworks).map((fw) => (
              <span key={fw} className="chip chip-plain">
                <Icon name="bolt" size={13} />
                {fw}
              </span>
            ))}
            {category !== 'unit' && selectedRealApp && (
              <span className="chip chip-plain">
                <Icon name="lock" size={13} />
                {executionMode === 'isolated' ? 'Isolated temp copy' : 'Attach to local'}
              </span>
            )}
            {selectedRepo && (
              <span className="chip chip-plain">
                <Icon name="lock" size={13} />
                Isolated workspace{repoFrameworks.includes('playwright') ? ' · headless' : ''}
              </span>
            )}
          </>
        }
        actions={
          <button
            type="button"
            className="btn btn-pill btn-accent btn-lg btn-run-all"
            disabled={!canRunAll}
            title={!selectedProject ? 'Select a repository first' : undefined}
            onClick={() => onRunCategoryAll(category)}
          >
            {isRunning && (selectedRepo ? selectedRun?.appId === selectedRepo.id : selectedRun?.layer === category) ? (
              <>
                <span className="spinner" /> Running…
              </>
            ) : (
              <>
                <Icon name="play" size={12} />
                {meta.runAllLabel}
              </>
            )}
          </button>
        }
      />

      <ProjectFolderCards
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        activeCategory={category}
      />

      {!selectedProject && (
        <div className="notice notice-error" role="alert">
          <Icon name="info" size={16} />
          <div>
            <strong>No repository selected.</strong> Choose an application or connected repository above (or in the header). Nothing will be executed until a valid project is selected.
          </div>
        </div>
      )}

      {selectedProject && (
        <div className="metric-row">
          <MetricCard
            icon={<Icon name={meta.icon} size={14} />}
            label={selectedRepo ? 'Tests executed' : 'Suites configured'}
            value={selectedRepo ? (executedHere ? executedHere.total : '—') : suites.length}
            sub={
              selectedRepo
                ? [
                    executedHere ? 'last run' : 'no run yet',
                    repoInfo?.discovered !== null && repoInfo?.discovered !== undefined
                      ? `${repoInfo.discovered} discovered at runtime${repoInfo.discoveredStale ? ' (stale)' : ''}`
                      : 'not runtime-discovered',
                  ].join(' · ')
                : frameworks.length > 0
                  ? frameworks.join(', ')
                  : 'None registered'
            }
          />
          <MetricCard
            icon={<Icon name="check" size={14} strokeWidth={2.2} />}
            label="Latest result"
            value={
              latest ? (
                <>
                  {latest.counts.passed}
                  <span className="metric-value-sub"> / {latest.counts.total}</span>
                </>
              ) : (
                '—'
              )
            }
            sub={latest ? `${latest.counts.failed} failed · ${latest.counts.errors} errors` : 'No runs yet'}
          />
          <MetricCard
            icon={<Icon name="target" size={14} />}
            label="Pass rate"
            value={rate === null ? '—' : `${rate}%`}
            delta={
              latest && previous ? (
                <span className={`delta delta-${latest.rate > previous.rate ? 'up' : latest.rate < previous.rate ? 'down' : 'flat'}`}>
                  {latest.rate === previous.rate ? 'Steady' : `${latest.rate > previous.rate ? '+' : '−'}${Math.abs(latest.rate - previous.rate)}% vs prev`}
                </span>
              ) : undefined
            }
          />
          <MetricCard
            icon={<Icon name="clock" size={14} />}
            label="Last duration"
            value={formatDuration(latestLayerRun?.durationMs)}
            sub={latestLayerRun ? formatShortDateTime(latestLayerRun.startedAt) : `No ${LAYER_SHORT[category]} runs yet`}
          />
        </div>
      )}

      {selectedRepo ? (
        <section className="card">
          <CardHead
            title="Available suites"
            subtitle="External repositories run their own configured test command; layers come from the repository's reports."
          />
          {!repoInfo?.applicable ? (
            <div className="panel table-empty">
              No {LAYER_SHORT[category]} tests were detected in {selectedRepo.name}. Run the repository once to see which layers it really executes.
            </div>
          ) : (
            <div className="suite-grid">
              <article className="suite-card">
                <div className="suite-top">
                  <span className="suite-icon">
                    <Icon name="git" size={16} />
                  </span>
                  <div className="suite-title">
                    <h4 className="suite-name">
                      {selectedRepo.name} · {LAYER_SHORT[category]}
                    </h4>
                    {repoFrameworks.map((fw) => (
                      <span key={fw} className={`fw-tag fw-${fw}`}>
                        {fw}
                      </span>
                    ))}
                  </div>
                  <StatusPill
                    status={selectedRepo.lastRun?.status ?? 'idle'}
                    label={selectedRepo.lastRun ? undefined : 'Not run'}
                  />
                </div>
                <div className="suite-file">
                  <Icon name="file" size={13} />
                  <code className="mono">{selectedRepo.detection?.testCommand?.display ?? '—'}</code>
                </div>
                <div className="suite-facts">
                  <span>
                    <Icon name="bolt" size={13} />
                    {selectedRepo.status !== 'ready'
                      ? selectedRepo.statusMessage ?? 'Repository is not ready'
                      : executedHere
                        ? `${executedHere.passed}/${executedHere.total} passed in the last run · ${executedHere.failed} failed · ${executedHere.errors} errors · ${executedHere.skipped} skipped`
                        : 'Not executed yet'}
                  </span>
                  <span>
                    <Icon name="file" size={13} />
                    {repoInfo?.discovered !== null && repoInfo?.discovered !== undefined
                      ? `${repoInfo.discovered} discovered by the framework's own listing${repoInfo.discoveredStale ? ' (older commit)' : ''}`
                      : 'No runtime discovery for this layer'}
                    {staticEstimate(selectedRepo) !== null && ` · ~${staticEstimate(selectedRepo)} static declarations repo-wide (estimate)`}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid={`run-repo-${selectedRepo.id}`}
                  className="btn btn-pill btn-run-single"
                  disabled={!canRunAll}
                  title={repoInfo?.canRunAlone ? undefined : 'This repository runs all of its layers together'}
                  onClick={() => onRunCategoryAll(category)}
                >
                  <Icon name="play" size={11} />
                  {repoInfo?.canRunAlone ? `Run ${LAYER_SHORT[category]} tests` : 'Run repository tests (all layers)'}
                </button>
              </article>
            </div>
          )}
        </section>
      ) : selectedRealApp ? (
        <section className="card">
          <CardHead
            title="Available suites"
            subtitle={`Run an individual suite, or run all ${LAYER_SHORT[category].toLowerCase()} suites from the header.`}
          />
          {suites.length === 0 ? (
            <div className="panel table-empty">No suites are configured for this layer.</div>
          ) : (
            <div className="suite-grid">
              {suites.map((suite) => {
                const isThisSuiteRunning =
                  isRunning && (activeRunSuiteId === suite.id || selectedRun?.suiteId === suite.id);
                const result = latestSuiteResult(history, suite.id, suite.targetFile);
                const resultStatus = result ? (result.failed > 0 ? 'failed' : 'passed') : isThisSuiteRunning ? 'running' : 'idle';

                return (
                  <article key={suite.id} className="suite-card">
                    <div className="suite-top">
                      <span className="suite-icon">
                        <Icon name={meta.icon} size={16} />
                      </span>
                      <div className="suite-title">
                        <h4 className="suite-name">{suite.name}</h4>
                        <span className={`fw-tag fw-${suite.framework}`}>{suite.framework}</span>
                      </div>
                      <StatusPill status={resultStatus} label={result || isThisSuiteRunning ? undefined : 'Not run'} />
                    </div>

                    <div className="suite-file">
                      <Icon name="file" size={13} />
                      <code className="mono" title={suite.targetFile}>
                        {suite.targetFile}
                      </code>
                    </div>

                    <div className="suite-facts">
                      <span>
                        <Icon name={suite.requiresAppRunning ? 'bolt' : 'check'} size={13} />
                        {suite.requiresAppRunning ? 'Needs running stack or free ports' : 'Standalone, no server needed'}
                      </span>
                      <span>
                        <Icon name="clock" size={13} />
                        {result
                          ? `${result.passed}/${result.total} passed · ${formatDuration(result.durationMs)} · ${formatShortDateTime(result.startedAt)}`
                          : 'No recorded result yet'}
                      </span>
                    </div>

                    <button
                      type="button"
                      data-testid={`run-suite-${suite.id}`}
                      className="btn btn-pill btn-run-single"
                      disabled={isRunning}
                      onClick={() => onRunSuite(suite.id)}
                    >
                      {isThisSuiteRunning ? (
                        <>
                          <span className="spinner" /> Running…
                        </>
                      ) : (
                        <>
                          <Icon name="play" size={11} />
                          Run suite
                        </>
                      )}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {selectedProject && (
        <>
          <TerminalPanel
            selectedRun={selectedRun}
            selectedLog={selectedLog}
            entries={entries}
            live={live}
            isRunning={isRunning}
            onCancel={onCancelRun}
            onClearLog={onClearLog}
          />

          {externalRun && <ExternalRunResults run={externalRun} isRunning={isRunning} layerFilter={category} />}

          <section className="card">
            <CardHead title={`${LAYER_SHORT[category]} execution results`} subtitle="Persisted runs that include this layer." />
            <div className="panel table-panel">
              <RunsTable
                runs={layerRuns.slice(0, 6)}
                apps={apps}
                selectedRunId={selectedRunId}
                onSelect={onSelectRun}
                emptyText={`No ${LAYER_SHORT[category].toLowerCase()} runs recorded yet.`}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
