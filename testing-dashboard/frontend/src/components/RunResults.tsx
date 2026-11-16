import { NormalizedTestRun } from '../types';

interface Props {
  selectedRun: NormalizedTestRun | null;
  selectedLog: string;
  history: NormalizedTestRun[];
  onSelectRun: (runId: string) => void;
  showResults?: boolean;
  showHistory?: boolean;
}

export function RunResults({
  selectedRun,
  selectedLog,
  history,
  onSelectRun,
  showResults = true,
  showHistory = true,
}: Props) {
  const containerClass = showResults && showHistory ? 'grid-2' : '';

  return (
    <div className={containerClass}>
      {showResults && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Execution Results & Logs</h2>
              <p className="card-subtitle">
                {selectedRun
                  ? `${selectedRun.runId} · ${selectedRun.layer} · ${selectedRun.executionMode}`
                  : 'Select a run or trigger execution above'}
              </p>
            </div>
            {selectedRun && (
              <span className={`badge badge-${selectedRun.status}`}>{selectedRun.status}</span>
            )}
          </div>

          {!selectedRun ? (
            <p className="muted">No test run selected yet. Click Run above to execute tests.</p>
          ) : (
            <>
              {selectedRun.errorMessage && (
                <div className="error-banner">{selectedRun.errorMessage}</div>
              )}

              <div className="pill-list">
                <span className="pill">Total: {selectedRun.summary.total}</span>
                <span className="pill">Passed: {selectedRun.summary.passed}</span>
                <span className="pill">Failed: {selectedRun.summary.failed}</span>
                <span className="pill">Errors: {selectedRun.summary.errors ?? 0}</span>
                <span className="pill">Skipped: {selectedRun.summary.skipped}</span>
                {selectedRun.durationMs !== undefined && (
                  <span className="pill">
                    Duration: {(selectedRun.durationMs / 1000).toFixed(2)}s
                  </span>
                )}
              </div>

              {selectedRun.suites.map((suite, idx) => (
                <div key={`${suite.name}-${idx}`} style={{ marginBottom: 16 }}>
                  <div className="section-heading">
                    {suite.name} ({suite.durationMs}ms)
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Test Case</th>
                          <th>Status</th>
                          <th>Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {suite.cases.map((tc, cIdx) => (
                          <tr key={`${tc.name}-${cIdx}`}>
                            <td>
                              {tc.name}
                              {tc.error && (
                                <div
                                  className="error-banner"
                                  style={{ marginTop: 8, marginBottom: 0 }}
                                >
                                  <strong>{tc.error.message}</strong>
                                  {tc.error.stack && (
                                    <pre
                                      style={{
                                        margin: '6px 0 0',
                                        fontSize: 11,
                                        whiteSpace: 'pre-wrap',
                                      }}
                                    >
                                      {tc.error.stack}
                                    </pre>
                                  )}
                                </div>
                              )}
                            </td>
                            <td>
                              <span className={`badge badge-${tc.status}`}>{tc.status}</span>
                            </td>
                            <td>{tc.durationMs}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              <div className="section-heading">Sanitized Execution Log</div>
              <div className="log-box">{selectedLog || 'Waiting for log output...'}</div>
            </>
          )}
        </div>
      )}

      {showHistory && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Test History ({history.length})</h2>
              <p className="card-subtitle">
                Persisted JSON run reports under <code>testing-dashboard/.runs/</code>
              </p>
            </div>
          </div>

          {history.length === 0 ? (
            <p className="muted">No persisted runs yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Layer / Suite</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th>P / F / T</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr
                      key={r.runId}
                      className={`clickable ${
                        selectedRun?.runId === r.runId ? 'selected-row' : ''
                      }`}
                      onClick={() => onSelectRun(r.runId)}
                    >
                      <td>{new Date(r.startedAt).toLocaleTimeString()}</td>
                      <td>
                        <strong>{r.suiteId || r.layer}</strong>
                      </td>
                      <td>{r.executionMode}</td>
                      <td>
                        <span className={`badge badge-${r.status}`}>{r.status}</span>
                      </td>
                      <td>
                        {r.summary.passed} / {r.summary.failed} / {r.summary.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
