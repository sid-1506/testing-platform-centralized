import type { NormalizedTestRun, RegisteredApp, TestLayer } from '../types';
import {
  failedLike,
  formatDate,
  formatDuration,
  formatShortDateTime,
  formatTime,
  repoLabel,
  runScopeLabel,
  shortRunId,
} from '../lib/metrics';
import { StatusPill } from './common';
import { Icon } from './icons';
import type { IconName } from './icons';

const LAYER_ICON: Record<TestLayer | 'all', IconName> = {
  unit: 'unit',
  integration: 'layers',
  e2e: 'target',
  all: 'grid',
};

interface RunsTableProps {
  runs: NormalizedTestRun[];
  apps: RegisteredApp[];
  selectedRunId?: string;
  onSelect: (runId: string) => void;
  variant?: 'compact' | 'full';
  emptyText?: string;
}

export function RunsTable({
  runs,
  apps,
  selectedRunId,
  onSelect,
  variant = 'compact',
  emptyText = 'No test runs yet. Run a suite to see it here.',
}: RunsTableProps) {
  const full = variant === 'full';

  if (runs.length === 0) {
    return <div className="table-empty">{emptyText}</div>;
  }

  return (
    <div className={`table-scroll ${full ? 'is-tall' : ''}`}>
      <table className={`runs-table ${full ? 'is-full' : ''}`}>
        <thead>
          <tr>
            {full ? (
              <>
                <th>Run ID</th>
                <th>Layer / Suite</th>
              </>
            ) : (
              <th>Run / Suite</th>
            )}
            <th>Repository</th>
            {full && <th>Mode</th>}
            {full && <th>Framework</th>}
            <th>Status</th>
            <th className="num" title="Passed / Failed / Errors / Total">P / F / E / T</th>
            <th className="num">Duration</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const selected = selectedRunId === run.runId;
            const scope = runScopeLabel(run, apps);
            return (
              <tr
                key={run.runId}
                className={selected ? 'is-selected' : ''}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onSelect(run.runId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(run.runId);
                  }
                }}
              >
                {full ? (
                  <>
                    <td>
                      <div className="run-cell">
                        <span className={`run-avatar layer-${run.layer}`}>
                          <Icon name={LAYER_ICON[run.layer]} size={14} />
                        </span>
                        <code className="mono run-id-full" title={run.runId}>
                          {run.runId}
                        </code>
                      </div>
                    </td>
                    <td>
                      <span className="cell-ellipsis" title={scope}>
                        {scope}
                      </span>
                    </td>
                  </>
                ) : (
                  <td>
                    <div className="run-cell">
                      <span className={`run-avatar layer-${run.layer}`}>
                        <Icon name={LAYER_ICON[run.layer]} size={14} />
                      </span>
                      <span className="run-stack">
                        <span className="cell-ellipsis run-id" title={scope}>
                          {scope}
                        </span>
                        <span className="run-sub" title={run.runId}>
                          {shortRunId(run.runId)}
                        </span>
                      </span>
                    </div>
                  </td>
                )}
                <td>
                  <span className="cell-ellipsis cell-muted" title={repoLabel(run, apps)}>
                    {repoLabel(run, apps)}
                  </span>
                </td>
                {full && <td className="cell-muted">{run.executionMode}</td>}
                {full && <td className="cell-muted">{run.framework}</td>}
                <td>
                  <StatusPill status={run.status} />
                </td>
                <td className="num">
                  <span className="t-pass">{run.summary.passed}</span>
                  <span className="t-sep"> / </span>
                  <span className={failedLike(run.summary) > 0 ? 't-fail' : ''}>{failedLike(run.summary)}</span>
                  <span className="t-sep"> / </span>
                  <span className={(run.summary.errors ?? 0) > 0 ? 't-fail' : ''}>{run.summary.errors ?? 0}</span>
                  <span className="t-sep"> / </span>
                  {run.summary.total}
                </td>
                <td className="num">{formatDuration(run.durationMs)}</td>
                <td>
                  {full ? (
                    <div className="date-cell">
                      <span>{formatDate(run.startedAt)}</span>
                      <span className="cell-muted">{formatTime(run.startedAt)}</span>
                    </div>
                  ) : (
                    <span className="nowrap">{formatShortDateTime(run.startedAt)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
