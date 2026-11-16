import { ExecutionMode, RegisteredApp, RunScopeLayer } from '../types';

interface Props {
  app: RegisteredApp;
  executionMode: ExecutionMode;
  onChangeMode: (mode: ExecutionMode) => void;
  isRunning: boolean;
  onRun: (opts: { suiteId?: string; layer?: RunScopeLayer }) => void;
  onCancel: () => void;
}

export function RunControls({
  app,
  executionMode,
  onChangeMode,
  isRunning,
  onRun,
  onCancel,
}: Props) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Test Execution Center</h2>
          <p className="card-subtitle">
            Trigger real Vitest & Playwright runs via the backend execution orchestrator.
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <select
            id="exec-mode"
            aria-label="Runtime Mode"
            className="select-light"
            value={executionMode}
            onChange={(e) => onChangeMode(e.target.value as ExecutionMode)}
            disabled={isRunning}
          >
            <option value="isolated">Isolated Temp Copy (Default)</option>
            <option value="attach">Attach to Running Local Services</option>
          </select>

          <button
            className="btn btn-primary"
            disabled={isRunning}
            onClick={() => onRun({ layer: 'all' })}
          >
            Run All Tests
          </button>

          {isRunning && (
            <button className="btn btn-danger" onClick={onCancel}>
              Cancel Run
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn" disabled={isRunning} onClick={() => onRun({ layer: 'unit' })}>
          Run Unit Tests
        </button>
        <button
          className="btn"
          disabled={isRunning}
          onClick={() => onRun({ layer: 'integration' })}
        >
          Run Integration Tests
        </button>
        <button className="btn" disabled={isRunning} onClick={() => onRun({ layer: 'e2e' })}>
          Run E2E Tests
        </button>
      </div>

      {app.suites.map((suite) => (
        <div className="suite-row" key={suite.id}>
          <div>
            <strong>{suite.name}</strong>
            <div className="muted" style={{ marginTop: 3 }}>
              Layer: <code>{suite.layer}</code> · Framework: <code>{suite.framework}</code> · File:{' '}
              <code>{suite.targetFile}</code>
              {suite.requiresAppRunning ? ' · Requires running services' : ' · Standalone'}
            </div>
          </div>
          <button
            className="btn btn-olive"
            disabled={isRunning}
            onClick={() => onRun({ suiteId: suite.id })}
          >
            Run Suite
          </button>
        </div>
      ))}
    </div>
  );
}
