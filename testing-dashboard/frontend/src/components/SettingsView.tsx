import { ExecutionMode } from '../types';
import { CardHead, PageHead } from './common';
import { Icon } from './icons';

interface SettingsViewProps {
  executionMode: ExecutionMode;
  onChangeMode: (mode: ExecutionMode) => void;
}

export function SettingsView({ executionMode, onChangeMode }: SettingsViewProps) {
  return (
    <div className="page settings">
      <PageHead
        eyebrow="Platform configuration"
        title="Engine & security settings"
        description="Configure default runtime execution policies, port safeguards, secret redaction, and local report storage."
      />

      <div className="grid-two">
        {/* Runtime Mode Policy */}
        <section className="card">
          <CardHead
            title="Default execution mode"
            subtitle="Controls how target applications are initialized before external suites execute."
          />

          <div className="option-list">
            <label className={`option-card ${executionMode === 'isolated' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="execMode"
                value="isolated"
                checked={executionMode === 'isolated'}
                onChange={() => onChangeMode('isolated')}
              />
              <span className="option-radio" />
              <div className="option-content">
                <strong>Isolated temporary workspace</strong>
                <span className="tag tag-accent">Default &amp; recommended</span>
                <p>
                  Copies the target application into an isolated temporary directory (<code className="mono">/tmp/testing-platform-runs/</code>).
                  Never mutates original application files, databases, or logs. Original <code className="mono">.env</code> files are never copied.
                </p>
              </div>
            </label>

            <label className={`option-card ${executionMode === 'attach' ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="execMode"
                value="attach"
                checked={executionMode === 'attach'}
                onChange={() => onChangeMode('attach')}
              />
              <span className="option-radio" />
              <div className="option-content">
                <strong>Attach to running local services</strong>
                <p>
                  Skips starting local application processes and runs integration/E2E test suites directly against
                  already-running localhost servers. Never terminates pre-existing processes.
                </p>
              </div>
            </label>
          </div>
        </section>

        {/* Port Safeguards & Process Hygiene */}
        <section className="card">
          <CardHead
            title="Port safeguards & process management"
            subtitle="Fixed ports checked by pre-flight validation before launching platform-managed services."
          />
          <div className="panel">
            <div className="port-list">
              {[3000, 3001, 3003, 3004, 3005, 5001, 6001, 6002, 6003].map((port) => (
                <span key={port} className="chip chip-plain chip-mono">
                  :{port}
                </span>
              ))}
            </div>
            <p className="panel-note">
              The platform tracks only PIDs/PGIDs spawned by the platform itself. It will fail fast with a port conflict
              message rather than killing pre-existing user processes.
            </p>
          </div>
        </section>

        {/* Security & Secret Redaction */}
        <section className="card">
          <CardHead
            title="Log sanitization & secret redaction"
            subtitle="All execution logs streamed to the terminal and stored on disk pass through an automated secret filter."
          />
          <div className="panel">
            <ul className="rule-list">
              <li>
                <Icon name="shield" size={15} />
                <span>
                  <strong>JWT tokens:</strong> base64url three-segment tokens are sanitized to <code className="mono">[REDACTED_JWT]</code>.
                </span>
              </li>
              <li>
                <Icon name="lock" size={15} />
                <span>
                  <strong>Environment secrets:</strong> <code className="mono">testEnv</code> variables (such as <code className="mono">JWT_SECRET</code>) are sanitized to <code className="mono">[REDACTED_SECRET]</code>.
                </span>
              </li>
              <li>
                <Icon name="file" size={15} />
                <span>
                  <strong>Sensitive headers:</strong> <code className="mono">Authorization: Bearer …</code> and <code className="mono">Cookie: token=…</code> values are redacted.
                </span>
              </li>
            </ul>
          </div>
        </section>

        {/* Report Storage */}
        <section className="card">
          <CardHead
            title="Report storage & history"
            subtitle="All runs are saved as normalized JSON files and sanitized logs under testing-dashboard/.runs/."
          />
          <div className="panel kv-list">
            <div className="kv">
              <span className="path-label">Storage engine</span>
              <strong>Local file-based JSON</strong>
            </div>
            <div className="kv">
              <span className="path-label">Path</span>
              <code className="mono">testing-dashboard/.runs/&lt;runId&gt;/result.json</code>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
