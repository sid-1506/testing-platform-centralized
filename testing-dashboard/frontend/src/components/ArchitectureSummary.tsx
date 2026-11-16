import { useState } from 'react';
import { InspectionReport, RegisteredApp } from '../types';

interface Props {
  app: RegisteredApp;
  report: InspectionReport | null;
  loading: boolean;
  onRefresh: () => void;
}

export function ArchitectureSummary({ app, report, loading, onRefresh }: Props) {
  const [showWorkspaces, setShowWorkspaces] = useState(true);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Application Overview</h2>
          <p className="card-subtitle">{app.description}</p>
        </div>
        <button className="btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Inspecting...' : 'Re-inspect'}
        </button>
      </div>

      <div className="pill-list">
        <span className="pill">
          Source: <code>{app.sourcePath}</code>
        </span>
        <span className="pill">
          Suites: <code>{app.suitePath}</code>
        </span>
      </div>

      {report && (
        <>
          <div className="section-heading">Detected Technologies & Stack</div>
          <div className="pill-list">
            <span className="pill">Package Manager: {report.packageManager}</span>
            {report.languages.map((l) => (
              <span className="pill" key={l}>
                {l}
              </span>
            ))}
            {report.frameworks.map((f) => (
              <span className="pill" key={f}>
                {f}
              </span>
            ))}
            {report.databases.map((d) => (
              <span className="pill" key={d}>
                {d}
              </span>
            ))}
          </div>

          <div className="section-heading">Existing Testing Setup</div>
          <p style={{ fontSize: 13, margin: '4px 0 8px', color: 'var(--text-secondary)' }}>
            {report.existingTestingSetup.notes}
          </p>
          {report.existingTestingSetup.scriptsFound.length > 0 && (
            <div className="pill-list">
              {report.existingTestingSetup.scriptsFound.map((s) => (
                <span className="pill" key={s}>
                  <code>{s}</code>
                </span>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 16,
            }}
          >
            <div className="section-heading" style={{ margin: 0 }}>
              Detected Workspaces ({report.workspaces.length})
            </div>
            <button className="btn" onClick={() => setShowWorkspaces((v) => !v)}>
              {showWorkspaces ? 'Collapse' : 'Expand'}
            </button>
          </div>

          {showWorkspaces && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Workspace</th>
                    <th>Frameworks</th>
                    <th>Database</th>
                  </tr>
                </thead>
                <tbody>
                  {report.workspaces.map((ws) => (
                    <tr key={ws.name}>
                      <td>
                        <strong>{ws.name}</strong>
                        <div className="muted">{ws.path}</div>
                      </td>
                      <td>{ws.frameworks.join(', ') || 'Node / TypeScript'}</td>
                      <td>{ws.hasDatabase ? 'SQLite' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
