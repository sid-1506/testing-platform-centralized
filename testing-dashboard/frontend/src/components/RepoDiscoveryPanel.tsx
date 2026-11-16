import { useState } from 'react';
import type { ExternalRepo, RunScopeLayer, TestLayer } from '../types';
import { LAYERS, LAYER_LABEL, LAYER_SHORT, formatShortDateTime } from '../lib/metrics';
import { Icon } from './icons';

interface RepoDiscoveryPanelProps {
  repo: ExternalRepo;
  /** A test run is executing somewhere: execution options stay disabled. */
  isRunning: boolean;
  busy: boolean;
  onFetchTests: () => void;
  onRun: (layer: RunScopeLayer, expectedCommitSha: string) => void;
}

function previewOf(text: string): string {
  const line = text.split('\n')[0];
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

const OPTIONS: Array<{ id: RunScopeLayer; label: string }> = [
  { id: 'unit', label: 'Run Unit Tests' },
  { id: 'integration', label: 'Run Integration Tests' },
  { id: 'e2e', label: 'Run E2E Tests' },
  { id: 'all', label: 'Run All Tests' },
];

/**
 * Step 2-3 of the public repository workflow: discover (never executes) → choose which layer to execute.
 * Discovered counts come from the framework's own listing; executed counts come from the last finished run's reports.
 * The two are always labelled separately.
 */
export function RepoDiscoveryPanel({ repo, isRunning, busy, onFetchTests, onRun }: RepoDiscoveryPanelProps) {
  const [choice, setChoice] = useState<RunScopeLayer | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const disc = repo.discovery?.details ? repo.discovery : null; // ignore the Playwright-only count a plain run records
  const state = repo.discoveryState;
  const discovering = state?.status === 'running';
  const stale = !!disc?.stale;
  const usable = !!disc && !stale && repo.status === 'ready';
  const exec = repo.lastExecution;
  const canFetch = repo.status === 'ready' && !discovering && !isRunning && !busy;

  const layerCount = (l: TestLayer) => disc?.byLayer[l] ?? 0;
  const layerRunnable = (l: TestLayer) => usable && layerCount(l) > 0 && !!disc?.details?.[l]?.runnable;
  const totalRunnable = usable && (disc?.total ?? 0) > 0;
  const optionState = (id: RunScopeLayer) => {
    if (!usable) return { enabled: false, why: stale ? 'Discovery is stale: fetch tests again' : 'Fetch tests first' };
    if (id === 'all') return { enabled: totalRunnable, why: totalRunnable ? '' : 'No tests were discovered' };
    if (layerCount(id) === 0) return { enabled: false, why: 'Not detected in this repository' };
    if (!layerRunnable(id)) return { enabled: false, why: 'This repository cannot run this layer on its own — run all layers' };
    return { enabled: true, why: '' };
  };
  const selected = choice && optionState(choice).enabled ? choice : null;
  const selectedCount = selected ? (selected === 'all' ? disc!.total : layerCount(selected)) : 0;
  const busyAll = isRunning || discovering || busy;

  return (
    <div className="discovery" aria-live="polite">
      <div className="discovery-head">
        <div>
          <strong className="discovery-title">Test discovery</strong>
          <span className="discovery-sub">
            {discovering
              ? state?.message || 'Listing tests…'
              : disc
                ? `${stale ? 'Stale · ' : ''}Discovered ${formatShortDateTime(disc.discoveredAt)} · commit ${disc.commitSha.slice(0, 7)} · nothing was executed`
                : 'Tests have not been fetched yet. Fetching lists them without running anything.'}
          </span>
        </div>
        <button type="button" className="btn btn-pill btn-sm btn-accent" disabled={!canFetch} onClick={onFetchTests} title="List Unit, Integration and E2E tests using the framework's own listing. Nothing is executed.">
          {discovering ? (
            <>
              <span className="spinner" /> Fetching…
            </>
          ) : (
            <>
              <Icon name="search" size={13} /> {disc ? 'Fetch Tests again' : 'Fetch Tests'}
            </>
          )}
        </button>
      </div>

      {state?.status === 'failed' && (
        <div className="notice notice-error" role="alert">
          <Icon name="info" size={16} />
          <div>
            <strong>Discovery failed:</strong> {state.error}
          </div>
        </div>
      )}
      {disc && stale && (
        <div className="notice notice-warn" role="status">
          <Icon name="info" size={16} />
          <span>The repository moved to another commit after these tests were discovered. Fetch tests again before running.</span>
        </div>
      )}
      {disc?.partial && (
        <div className="notice notice-warn" role="status">
          <Icon name="info" size={16} />
          <div>
            Partial discovery: part of the repository could not be listed, so the counts below may be incomplete.
            {disc.issues && disc.issues.length > 0 && (
              <div className="issue-detail">
                <button type="button" className="issue-toggle" onClick={() => setShowIssues((v) => !v)} aria-expanded={showIssues}>
                  {showIssues ? 'Hide details' : `Show details (${disc.issues.length})`}
                </button>
                {showIssues && (
                  <pre className="cell-muted">{disc.issues.join('\n\n')}</pre>
                )}
                {!showIssues && <div className="cell-muted">{previewOf(disc.issues[0])}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {disc && (
        <>
          <div className={`discovery-counts ${stale ? 'is-stale' : ''}`}>
            {LAYERS.map((l) => {
              const n = layerCount(l);
              const d = disc.details?.[l];
              const ex = exec?.byLayer[l];
              return (
                <div key={l} className="discovery-count">
                  <span className="discovery-label">{LAYER_SHORT[l]}</span>
                  {n > 0 ? (
                    <strong className="discovery-num" title={d?.method === 'estimate' ? 'Estimate: this framework cannot list test cases without running them (static declaration count).' : 'Counted by the framework listing'}>
                      {d?.method === 'estimate' ? '~' : ''}
                      {n}
                    </strong>
                  ) : (
                    <span className="discovery-none">Not detected</span>
                  )}
                  {n > 0 && d?.method === 'estimate' && <span className="discovery-flag">estimate</span>}
                  <span className="discovery-exec" title="From the last finished run's reports; independent from the discovered count">
                    {ex ? `Last run: ${ex.passed} passed · ${ex.failed} failed · ${ex.errors ?? 0} err · ${ex.skipped} skipped` : 'Not executed yet'}
                  </span>
                </div>
              );
            })}
            <div className="discovery-count discovery-total">
              <span className="discovery-label">Total discovered</span>
              <strong className="discovery-num">{disc.total}</strong>
              <span className="discovery-exec">{disc.source}</span>
            </div>
          </div>

          {disc.total === 0 && !stale && <p className="cell-muted">No tests were found in this repository, so there is nothing to run.</p>}

          <div className="discovery-run" role="radiogroup" aria-label="Choose which tests to execute">
            <span className="discovery-label">Choose what to execute</span>
            <div className="discovery-options">
              {OPTIONS.map((o) => {
                const st = optionState(o.id);
                const disabled = !st.enabled || busyAll;
                const n = o.id === 'all' ? disc.total : layerCount(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={choice === o.id}
                    className={`discovery-option ${choice === o.id && st.enabled ? 'is-active' : ''}`}
                    disabled={disabled}
                    title={st.why || undefined}
                    onClick={() => setChoice(o.id)}
                  >
                    <span>{o.label}</span>
                    <small>{n > 0 ? `${o.id === 'all' ? 'all layers · ' : ''}${n}` : '—'}</small>
                  </button>
                );
              })}
            </div>
            <div className="discovery-confirm">
              <span className="discovery-summary">
                {selected
                  ? `${selected === 'all' ? 'All Tests' : LAYER_LABEL[selected]} — ${selectedCount} discovered test${selectedCount === 1 ? '' : 's'}`
                  : 'Select Unit, Integration, E2E or All to see what will run.'}
              </span>
              <button
                type="button"
                className="btn btn-pill btn-sm btn-dark"
                disabled={!selected || busyAll}
                onClick={() => selected && onRun(selected, disc.commitSha)}
              >
                <Icon name="play" size={11} /> Run selected
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
