import { InspectionReport } from '../types';

interface Props {
  report: InspectionReport | null;
}

export function PyramidRecommendations({ report }: Props) {
  if (!report) {
    return (
      <div className="card">
        <h2 className="card-title">Testing Pyramid Strategy</h2>
        <p className="card-subtitle">Inspecting application structure...</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Testing Pyramid & Strategy</h2>
          <p className="card-subtitle">
            Deterministic recommendations grounded in codebase evidence (no hardcoded ratio).
          </p>
        </div>
      </div>

      <div className="pyramid-visual">
        <div className="pyramid-tier tier-e2e">
          E2E / Browser · {report.surfaces.frontendPagesAndComponents.length} UI surfaces
        </div>
        <div className="pyramid-tier tier-integration">
          Integration / API · {report.surfaces.apiServersAndRoutes.length} server & route files
        </div>
        <div className="pyramid-tier tier-unit">
          Unit Testing · {report.surfaces.pureModules.length} pure/helper modules
        </div>
      </div>

      {report.recommendations.map((rec) => (
        <div className="rec-item" key={rec.layer}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ textTransform: 'uppercase', fontSize: 13 }}>{rec.layer} Testing</strong>
            <span className={`badge badge-${rec.priority}`}>{rec.priority} emphasis</span>
          </div>
          <p style={{ fontSize: 13, margin: '6px 0', color: 'var(--text-secondary)' }}>
            {rec.rationale}
          </p>
          <div className="muted">
            Evidence: {rec.evidence.slice(0, 4).join(', ')}
            {rec.evidence.length > 4 ? ` (+${rec.evidence.length - 4} more)` : ''}
          </div>
          <ul>
            {rec.suggestedTargets.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
