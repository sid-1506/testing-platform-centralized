import { NormalizedTestRun } from '../types';

interface Props {
  selectedRun: NormalizedTestRun | null;
  history: NormalizedTestRun[];
}

export function OverviewKpis({ selectedRun, history }: Props) {
  const total = selectedRun?.summary.total ?? 0;
  const passed = selectedRun?.summary.passed ?? 0;
  const failed = selectedRun?.summary.failed ?? 0;
  const skipped = selectedRun?.summary.skipped ?? 0;
  const durationLabel =
    selectedRun?.durationMs !== undefined ? `${(selectedRun.durationMs / 1000).toFixed(2)}s` : '—';
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  const recentRuns = history.slice(0, 10).reverse();
  const maxDuration = Math.max(1, ...recentRuns.map((r) => r.durationMs || 1));

  return (
    <section className="kpi-grid" aria-label="Execution KPIs">
      <div className="kpi-card">
        <div className="kpi-head">
          <span className="kpi-label">Total Test Cases</span>
          <span className={`badge badge-${selectedRun?.status || 'queued'}`}>
            {selectedRun?.status || 'idle'}
          </span>
        </div>
        <div className="kpi-number">{total}</div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${passRate}%` }} />
        </div>
        <div className="kpi-sub">
          {selectedRun ? `${passRate}% pass rate (${selectedRun.layer})` : 'No run selected'}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-head">
          <span className="kpi-label">Passed Tests</span>
          <span className="badge badge-passed">OK</span>
        </div>
        <div className="kpi-number" style={{ color: 'var(--green)' }}>
          {passed}
        </div>
        <div className="kpi-sub">
          {selectedRun ? `Framework: ${selectedRun.framework}` : 'Waiting for execution'}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-head">
          <span className="kpi-label">Failed Tests</span>
          <span className={`badge ${failed > 0 ? 'badge-failed' : 'badge-skipped'}`}>
            {failed > 0 ? 'Alert' : 'Clean'}
          </span>
        </div>
        <div className="kpi-number" style={{ color: failed > 0 ? 'var(--red)' : 'var(--text)' }}>
          {failed}
        </div>
        <div className="kpi-sub">
          {selectedRun?.errorMessage ? 'Execution error recorded' : 'Zero assertion failures'}
        </div>
      </div>

      <div className="kpi-card">
        <div className="kpi-head">
          <span className="kpi-label">Skipped Tests</span>
          <span className="badge badge-skipped">Skip</span>
        </div>
        <div className="kpi-number" style={{ color: 'var(--muted)' }}>
          {skipped}
        </div>
        <div className="kpi-sub">Across {selectedRun?.suites.length ?? 0} executed suite(s)</div>
      </div>

      <div className="kpi-card">
        <div className="kpi-head">
          <span className="kpi-label">Last Duration</span>
          <span className="kpi-sub">{history.length} runs</span>
        </div>
        <div className="kpi-number">{durationLabel}</div>
        <div className="mini-bars" title="Recent run durations">
          {recentRuns.length === 0 ? (
            <span className="kpi-sub">No history yet</span>
          ) : (
            recentRuns.map((r) => {
              const pct = Math.max(18, Math.round(((r.durationMs || 500) / maxDuration) * 100));
              const cls = r.status === 'passed' ? 'pass' : r.status === 'failed' || r.status === 'error' ? 'fail' : '';
              return (
                <div
                  key={r.runId}
                  className={`mini-bar ${cls}`}
                  style={{ height: `${pct}%` }}
                  title={`${r.layer} (${r.status}) - ${r.durationMs ?? 0}ms`}
                />
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
