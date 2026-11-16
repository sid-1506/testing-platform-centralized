import { useMemo } from 'react';
import type { NormalizedTestRun, TestLayer } from '../types';
import { LAYERS, LAYER_SHORT, formatDuration, formatShortDateTime, isActive, layerBreakdown, notPassing } from '../lib/metrics';
import { CardHead, StatusPill } from './common';
import { Icon } from './icons';

interface RecentRepoRunsProps {
  /** Every persisted run (not scoped to the selected project). */
  runs: NormalizedTestRun[];
  onOpenRun: (appId: string, runId: string) => void;
  limit?: number;
}

/** Latest finished run per external repository, newest first. Repositories that never executed are absent by construction. */
export function latestRunPerRepo(runs: NormalizedTestRun[], limit: number): NormalizedTestRun[] {
  const ts = (r: NormalizedTestRun) => Date.parse(r.startedAt) || 0;
  const seen = new Set<string>();
  const out: NormalizedTestRun[] = [];
  for (const run of [...runs].sort((a, b) => ts(b) - ts(a))) {
    if (run.kind !== 'external' || !run.repo || isActive(run)) continue;
    if (seen.has(run.appId)) continue;
    seen.add(run.appId);
    out.push(run);
    if (out.length >= limit) break;
  }
  return out;
}

function slugOf(run: NormalizedTestRun): string {
  const repo = run.repo;
  if (!repo) return run.appId;
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repo.url ?? '');
  return m ? `${m[1]}/${m[2]}` : `${repo.owner}/${repo.name}`;
}

function layersOf(run: NormalizedTestRun): TestLayer[] {
  const breakdown = layerBreakdown(run);
  const found = LAYERS.filter((l) => breakdown[l]);
  if (found.length > 0) return found;
  return run.layer !== 'all' && run.summary.total > 0 ? [run.layer] : [];
}

export function RecentRepoRuns({ runs, onOpenRun, limit = 2 }: RecentRepoRunsProps) {
  const latest = useMemo(() => latestRunPerRepo(runs, limit), [runs, limit]);

  return (
    <section className="card recent-runs">
      <CardHead title="Recent Repository Runs" subtitle="Latest test executions across your repositories." />
      {latest.length === 0 ? (
        <div className="panel recent-empty">No repository runs yet</div>
      ) : (
        <div className="panel recent-list">
          {latest.map((run) => {
            const s = run.summary;
            const layers = layersOf(run);
            return (
              <button
                key={run.appId}
                type="button"
                className="recent-row"
                onClick={() => onOpenRun(run.appId, run.runId)}
                title="Open execution details"
              >
                <div className="recent-top">
                  <div className="recent-id">
                    <strong className="recent-name">{run.repo?.name}</strong>
                    <span className="cell-muted recent-slug">{slugOf(run)}</span>
                  </div>
                  <StatusPill status={run.status} />
                </div>
                <div className="recent-meta">
                  <span>
                    <Icon name="folder" size={12} /> {run.repo?.branch}
                  </span>
                  <span>
                    <Icon name="clock" size={12} /> {formatShortDateTime(run.finishedAt ?? run.startedAt)}
                  </span>
                  <span>
                    <Icon name="bolt" size={12} /> {formatDuration(run.durationMs)}
                  </span>
                </div>
                <div className="recent-counts">
                  <span>
                    <strong>{s.total}</strong> tests
                  </span>
                  <span>
                    <strong>{s.passed}</strong> passed
                  </span>
                  <span className={notPassing({ failed: s.failed, timedOut: s.timedOut, interrupted: s.interrupted }) > 0 ? 'is-fail' : ''}>
                    <strong>{s.failed + (s.timedOut ?? 0) + (s.interrupted ?? 0)}</strong> failed
                  </span>
                  <span className={(s.errors ?? 0) > 0 ? 'is-fail' : ''}>
                    <strong>{s.errors ?? 0}</strong> errors
                  </span>
                </div>
                <div className="recent-layers cell-muted">
                  {layers.length > 0 ? layers.map((l) => LAYER_SHORT[l]).join(' · ') : 'No layer results'}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
