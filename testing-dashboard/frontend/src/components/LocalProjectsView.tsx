import { useState } from 'react';
import { InspectionReport, NormalizedTestRun, RegisteredApp } from '../types';
import { LAYERS, LAYER_SHORT, byNewest, hasResults, passRate } from '../lib/metrics';
import { CardHead, PageHead } from './common';
import { Icon } from './icons';

interface LocalProjectsViewProps {
  apps: RegisteredApp[];
  selectedAppId: string;
  inspection: InspectionReport | null;
  history?: NormalizedTestRun[];
  onSelectApp: (appId: string) => void;
  onRunApp: () => void;
  isRunning: boolean;
}

export function LocalProjectsView({
  apps,
  selectedAppId,
  inspection,
  history = [],
  onSelectApp,
  onRunApp,
  isRunning,
}: LocalProjectsViewProps) {
  const [showWorkspaces, setShowWorkspaces] = useState(true);

  return (
    <div className="page local-projects">
      <PageHead
        eyebrow="Local repository directory"
        title="Registered local applications"
        description="Local software projects registered with the Centralized Testing Platform. Target source is always read-only."
        meta={
          <span className="chip chip-plain">
            <Icon name="folder" size={13} />
            {apps.length} registered
          </span>
        }
      />

      <div className="project-detail-grid">
        {apps.map((app) => {
          const isSelected = app.id === selectedAppId;
          const appRuns = byNewest(history).filter((r) => r.appId === app.id);
          const lastRun = appRuns.find(hasResults);
          const rate = lastRun ? passRate(lastRun.summary) : null;
          const frameworks = Array.from(new Set(app.suites.map((s) => s.framework)));

          return (
            <section key={app.id} className={`card project-detail ${isSelected ? 'is-selected' : ''}`}>
              <div className="project-detail-head">
                <span className="project-icon project-icon-lg">
                  <Icon name="folder" size={20} />
                </span>
                <div className="project-detail-title">
                  <h3 className="card-title">{app.name}</h3>
                  <span className="project-stack">
                    ID <code className="mono">{app.id}</code>
                  </span>
                </div>
                <span className="tag tag-accent">Live registered</span>
              </div>

              <p className="project-desc">{app.description}</p>

              <div className="panel path-panel">
                <div className="path-row">
                  <span className="path-label">Source path</span>
                  <code className="mono">{app.sourcePath}</code>
                </div>
                <div className="path-row">
                  <span className="path-label">External suites</span>
                  <code className="mono">{app.suitePath}</code>
                </div>
                <div className="path-row">
                  <span className="path-label">Service ports</span>
                  <span className="port-list">
                    {app.ports.map((p) => (
                      <span key={p} className="chip chip-plain chip-mono">
                        :{p}
                      </span>
                    ))}
                  </span>
                </div>
              </div>

              <div className="project-stats">
                {LAYERS.map((layer) => (
                  <div key={layer} className="mini-stat">
                    <span className="mini-stat-label">{LAYER_SHORT[layer]}</span>
                    <span className="mini-stat-value">{app.suites.filter((s) => s.layer === layer).length}</span>
                  </div>
                ))}
                <div className="mini-stat">
                  <span className="mini-stat-label">Total</span>
                  <span className="mini-stat-value">{app.suites.length}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-label">Last pass rate</span>
                  <span className="mini-stat-value">{rate === null ? '—' : `${rate}%`}</span>
                </div>
                <div className="mini-stat">
                  <span className="mini-stat-label">Runs</span>
                  <span className="mini-stat-value">{appRuns.length}</span>
                </div>
              </div>

              <div className="project-suites">
                <span className="project-suites-title">Available suites</span>
                <ul>
                  {app.suites.map((s) => (
                    <li key={s.id}>
                      <span className={`layer-dot layer-${s.layer}`} />
                      <span className="suite-li-name">{s.name}</span>
                      <span className={`fw-tag fw-${s.framework}`}>{s.framework}</span>
                    </li>
                  ))}
                </ul>
                <span className="cell-muted project-fw-note">Frameworks: {frameworks.join(', ') || '—'}</span>
              </div>

              <div className="project-actions">
                <button
                  type="button"
                  className={`btn btn-pill ${isSelected ? 'btn-dark' : 'btn-white-line'}`}
                  onClick={() => onSelectApp(app.id)}
                >
                  {isSelected ? (
                    <>
                      <Icon name="check" size={14} strokeWidth={2.4} /> Selected application
                    </>
                  ) : (
                    'Select project'
                  )}
                </button>

                {isSelected && (
                  <button type="button" className="btn btn-pill btn-accent" disabled={isRunning} onClick={onRunApp}>
                    <Icon name="play" size={11} />
                    Run all suites
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Selected application workspaces breakdown */}
      {inspection && (
        <section className="card">
          <CardHead
            title={`Detected architecture surfaces · ${inspection.workspaces.length} workspaces`}
            subtitle={`Inspected from ${inspection.packageManager} monorepo manifest.`}
            actions={
              <button type="button" className="btn btn-pill btn-sm btn-white" onClick={() => setShowWorkspaces((v) => !v)}>
                {showWorkspaces ? 'Collapse workspaces' : 'Expand workspaces'}
              </button>
            }
          />

          <div className="tech-chips">
            {inspection.languages.map((l) => (
              <span key={`l-${l}`} className="chip chip-accent">
                {l}
              </span>
            ))}
            {inspection.frameworks.map((f) => (
              <span key={`f-${f}`} className="chip chip-plain">
                {f}
              </span>
            ))}
            {inspection.databases.map((d) => (
              <span key={`d-${d}`} className="chip chip-plain">
                {d}
              </span>
            ))}
          </div>

          {showWorkspaces && (
            <div className="panel table-panel">
              <div className="table-scroll">
                <table className="runs-table simple-table">
                  <thead>
                    <tr>
                      <th>Workspace</th>
                      <th>Path</th>
                      <th>Frameworks</th>
                      <th>Database</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspection.workspaces.map((ws) => (
                      <tr key={ws.name} className="no-hover">
                        <td>
                          <strong>{ws.name}</strong>
                        </td>
                        <td>
                          <code className="mono">{ws.path}</code>
                        </td>
                        <td className="cell-muted">{ws.frameworks.join(', ') || 'Node/TS'}</td>
                        <td>{ws.hasDatabase ? <span className="tag tag-muted">SQLite</span> : <span className="cell-muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
