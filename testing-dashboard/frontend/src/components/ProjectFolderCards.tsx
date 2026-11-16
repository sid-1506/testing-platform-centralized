import { ProjectRef } from '../types';
import { repoLayerInfo } from '../lib/metrics';
import { Icon } from './icons';

interface ProjectFolderCardsProps {
  projects: ProjectRef[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  activeCategory: 'unit' | 'integration' | 'e2e';
}

function countFor(project: ProjectRef, category: 'unit' | 'integration' | 'e2e'): string {
  if (project.kind === 'external') {
    // Only numbers that were really measured: last executed count, else runtime discovery. A source-scan estimate is never presented as a per-layer count.
    const info = repoLayerInfo(project.repo, category);
    const label = category === 'e2e' ? 'E2E' : category === 'unit' ? 'Unit' : 'Integration';
    if (info.executed) return `${info.executed.total} ${label} ${info.executed.total === 1 ? 'test' : 'tests'} (last run)`;
    if (info.discovered !== null) return `${info.discovered} ${label} discovered`;
    if (!info.applicable) return `No ${label} tests detected`;
    return `${label} · test count available after execution`;
  }
  const n = project.app!.suites.filter((s) => s.layer === category).length;
  return `${n} ${category.toUpperCase()} ${n === 1 ? 'suite' : 'suites'}`;
}

export function ProjectFolderCards({ projects, selectedProjectId, onSelectProject, activeCategory }: ProjectFolderCardsProps) {
  return (
    <section className="card project-picker">
      <div className="card-head">
        <div>
          <h3 className="card-title">Repository</h3>
          <p className="card-sub">Select the project whose tests are shown below.</p>
        </div>
        <span className="chip chip-plain">{projects.length} available</span>
      </div>

      {projects.length === 0 ? (
        <div className="panel table-empty">No applications or repositories are registered yet.</div>
      ) : (
        <div className="project-grid">
          {projects.map((proj) => {
            const isSelected = proj.id === selectedProjectId;
            const external = proj.kind === 'external';
            return (
              <div
                key={proj.id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                className={`project-card ${isSelected ? 'is-selected' : ''}`}
                onClick={() => onSelectProject(proj.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectProject(proj.id);
                  }
                }}
              >
                <span className="project-icon">
                  <Icon name={external ? 'git' : 'folder'} size={16} />
                </span>
                <div className="project-body">
                  <div className="project-name" title={proj.name}>
                    {proj.name}
                  </div>
                  <div className="project-stack">
                    {external ? `${proj.repo!.owner}/${proj.repo!.repo}@${proj.repo!.branch}` : 'Local application'}
                  </div>
                </div>
                <div className="project-meta">
                  <span className="tag tag-accent">{external ? 'GitHub' : 'Local'}</span>
                  <span className="project-count">{countFor(proj, activeCategory)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
