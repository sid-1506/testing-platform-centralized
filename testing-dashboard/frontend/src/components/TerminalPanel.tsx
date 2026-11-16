import { useEffect, useMemo, useRef, useState } from 'react';
import { LogEntry, LogStream, NormalizedTestRun, RunPhase } from '../types';
import type { LiveRunState } from '../hooks/useRunSession';
import { LAYERS, LAYER_SHORT, failedLike, formatDuration } from '../lib/metrics';
import { StatusPill } from './common';
import { Icon } from './icons';

interface TerminalPanelProps {
  selectedRun: NormalizedTestRun | null;
  selectedLog: string;
  /** Stream-tagged output. When omitted the plain `selectedLog` is shown. */
  entries?: LogEntry[];
  live?: LiveRunState;
  isRunning: boolean;
  onCancel: () => void;
  onClearLog?: () => void;
  title?: string;
  subtitle?: string;
}

interface Line {
  stream: LogStream;
  text: string;
}

type LineKind = 'platform' | 'pass' | 'fail' | 'stderr' | 'plain';
type StreamFilter = 'all' | LogStream;

const PHASE_LABEL: Record<RunPhase, string> = {
  queued: 'Queued',
  cloning: 'Fetching repository',
  installing: 'Installing dependencies',
  browsers: 'Checking browsers',
  testing: 'Running tests',
  collecting: 'Collecting reports',
  done: 'Finished',
};

function classify(line: Line): LineKind {
  if (line.stream === 'platform' || line.text.startsWith('[PLATFORM')) return 'platform';
  if (line.stream === 'stderr') return 'stderr';
  const t = line.text;
  if (/(^|\s)(✕|×|✘)(\s|$)|\b(FAIL|FAILED)\b|\bError:|AssertionError/.test(t)) return 'fail';
  if (/(^|\s)(✓|✔)(\s|$)|\b(PASS|PASSED)\b/.test(t)) return 'pass';
  return 'plain';
}

/** Re-assembles stream-tagged chunks into lines (chunks may split lines; stdout/stderr interleave). */
function entriesToLines(entries: LogEntry[]): Line[] {
  const lines: Line[] = [];
  const partial: Partial<Record<LogStream, string>> = {};
  for (const entry of entries) {
    const parts = ((partial[entry.stream] ?? '') + entry.text).split('\n');
    partial[entry.stream] = parts.pop() ?? '';
    for (const text of parts) lines.push({ stream: entry.stream, text });
  }
  (['platform', 'stdout', 'stderr'] as LogStream[]).forEach((stream) => {
    if (partial[stream]) lines.push({ stream, text: partial[stream]! });
  });
  return lines;
}

function plainToLines(log: string): Line[] {
  if (!log) return [];
  return log
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => ({ stream: text.startsWith('[PLATFORM') ? ('platform' as const) : ('stdout' as const), text }));
}

export function TerminalPanel({
  selectedRun,
  selectedLog,
  entries,
  live,
  isRunning,
  onCancel,
  onClearLog,
  title = 'Live Execution Terminal',
  subtitle = 'Streaming output from the test runner',
}: TerminalPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [streamFilter, setStreamFilter] = useState<StreamFilter>('all');

  const allLines = useMemo(() => (entries ? entriesToLines(entries) : plainToLines(selectedLog)), [entries, selectedLog]);
  const counts = useMemo(() => {
    const c = { stdout: 0, stderr: 0, platform: 0 };
    for (const l of allLines) c[l.stream] += 1;
    return c;
  }, [allLines]);
  const hasStreams = entries !== undefined;

  const lines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allLines.filter(
      (l) => (streamFilter === 'all' || l.stream === streamFilter) && (!q || l.text.toLowerCase().includes(q))
    );
  }, [allLines, search, streamFilter]);

  // Scroll the log container itself (never the page) to the newest line.
  useEffect(() => {
    const el = bodyRef.current;
    if (autoScroll && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, autoScroll]);

  const copyText = useMemo(() => allLines.map((l) => l.text).join('\n'), [allLines]);
  const hasLog = allLines.length > 0;

  const handleCopy = async () => {
    if (!hasLog) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable (insecure context / permissions) - ignore.
    }
  };

  const status = selectedRun?.status ?? 'idle';
  const summary = selectedRun?.summary;
  const showLive = isRunning && live;
  const passed = summary?.passed ?? 0;
  const failed = summary ? failedLike(summary) : 0;
  const errors = summary?.errors ?? 0;
  const skipped = summary?.skipped ?? 0;
  const total = summary?.total ?? 0;
  // While running, show only what the runner really reported: per-layer progress, never a made-up 0/0.
  const liveLayers = showLive ? LAYERS.filter((l) => live.progressByLayer[l]) : [];
  const liveCounted = showLive && live.passed + live.failed + live.skipped > 0;
  const repo = selectedRun?.repo;

  return (
    <section className="card term-card" aria-label="Execution Terminal">
      <div className="card-head">
        <div>
          <h3 className="card-title">{title}</h3>
          <p className="card-sub">{subtitle}</p>
        </div>
        <StatusPill status={status} />
      </div>

      <div className="term-toolbar">
        <div className="term-chips">
          <span className="chip" title={selectedRun?.runId ?? 'No run selected'}>
            <span className="chip-key">Run</span>
            <span className="chip-val mono">{selectedRun?.runId ?? '—'}</span>
          </span>
          {repo ? (
            <>
              <span className="chip" title={repo.url}>
                <span className="chip-key">Repo</span>
                <span className="chip-val">
                  {repo.owner}/{repo.name}@{repo.branch}
                </span>
              </span>
              {repo.commitSha && (
                <span className="chip" title={repo.commitSha}>
                  <span className="chip-key">Commit</span>
                  <span className="chip-val mono">{repo.commitSha.slice(0, 7)}</span>
                </span>
              )}
            </>
          ) : (
            <span className="chip">
              <span className="chip-key">Layer</span>
              <span className="chip-val">{selectedRun?.layer ?? '—'}</span>
            </span>
          )}
          {selectedRun?.suiteId && (
            <span className="chip">
              <span className="chip-key">Suite</span>
              <span className="chip-val">{selectedRun.suiteId}</span>
            </span>
          )}
        </div>

        <div className="term-controls">
          <label className="search-pill term-search">
            <Icon name="search" size={14} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter output"
              aria-label="Search in execution output"
            />
          </label>

          <button
            type="button"
            className={`btn btn-pill btn-sm btn-toggle ${autoScroll ? 'is-on' : ''}`}
            onClick={() => setAutoScroll((v) => !v)}
            aria-pressed={autoScroll}
            title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
          >
            <span className="toggle-track">
              <span className="toggle-knob" />
            </span>
            Auto-scroll
          </button>

          <button type="button" className="btn btn-pill btn-sm" onClick={handleCopy} disabled={!hasLog} title="Copy full log">
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>

          {onClearLog && (
            <button type="button" className="btn btn-pill btn-sm" onClick={onClearLog} disabled={!hasLog} title="Clear terminal">
              <Icon name="trash" size={14} />
              Clear
            </button>
          )}

          {isRunning && (
            <button type="button" className="btn btn-pill btn-sm btn-danger" onClick={onCancel} title="Cancel active run">
              <Icon name="stop" size={12} />
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="term-surface">
        <div className="term-stats">
          {showLive ? (
            <>
              {liveLayers.map((layer) => {
                const p = live.progressByLayer[layer]!;
                const known = p.testsDone !== undefined;
                return (
                  <span className="term-stat" key={layer} title={p.stage}>
                    {LAYER_SHORT[layer]}:{' '}
                    {known ? `${p.testsDone}${p.testsTotal !== undefined ? `/${p.testsTotal}` : ''} test${p.testsDone === 1 && p.testsTotal === undefined ? '' : 's'}` : 'running'}
                    {p.failedSoFar ? ` · ${p.failedSoFar} failed` : ''}
                  </span>
                );
              })}
              {liveLayers.length === 0 && liveCounted && (
                <span className="term-stat">
                  {live.passed} passed · {live.failed} failed · {live.skipped} skipped so far
                </span>
              )}
              {liveLayers.length === 0 && !liveCounted && (
                <span className="term-stat term-stage">{live.stage ?? (live.phase ? PHASE_LABEL[live.phase] : 'Starting…')}</span>
              )}
            </>
          ) : (
            <>
              <span className="term-stat is-pass">
                <Icon name="check" size={13} strokeWidth={2.4} /> {passed} passed
              </span>
              <span className={`term-stat ${failed > 0 ? 'is-fail' : ''}`}>
                <Icon name="x" size={13} strokeWidth={2.4} /> {failed} failed
              </span>
              {summary?.errors !== undefined && (
                <span className={`term-stat ${errors > 0 ? 'is-fail' : ''}`} title="Tests whose execution errored (not assertion failures)">
                  <Icon name="info" size={13} /> {errors} errors
                </span>
              )}
              <span className="term-stat">{skipped} skipped</span>
              <span className="term-stat">Total {total}</span>
              {(summary?.issues ?? 0) > 0 && (
                <span className="term-stat is-fail" title="Runner placeholders ([global]/[module]/[unhandled]/[runner]) — not tests">
                  {summary!.issues} execution issue{summary!.issues === 1 ? '' : 's'}
                </span>
              )}
            </>
          )}
          <span className="term-stat">
            <Icon name="clock" size={13} /> {formatDuration(selectedRun?.durationMs)}
          </span>
          {showLive && live.phase && <span className="term-stat term-phase">{PHASE_LABEL[live.phase]}</span>}
          {isRunning && (
            <span className={`term-stat is-live ${live?.stream === 'reconnecting' ? 'is-warn' : ''}`}>
              <span className="pill-dot is-live" /> {live?.stream === 'reconnecting' ? 'Reconnecting…' : 'Streaming'}
            </span>
          )}
        </div>

        {hasStreams && (
          <div className="term-filters" role="group" aria-label="Filter by output stream">
            {(
              [
                ['all', 'All', allLines.length],
                ['stdout', 'stdout', counts.stdout],
                ['stderr', 'stderr', counts.stderr],
                ['platform', 'platform', counts.platform],
              ] as Array<[StreamFilter, string, number]>
            ).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                className={`term-filter term-filter-${key} ${streamFilter === key ? 'is-on' : ''}`}
                aria-pressed={streamFilter === key}
                onClick={() => setStreamFilter(key)}
              >
                {label}
                <span className="term-filter-n">{n}</span>
              </button>
            ))}
          </div>
        )}

        {isRunning && live?.currentTest && (
          <div className="term-current" title="Derived from the repository's test order and the runner's real output">
            <span className="spinner spinner-sm" /> <strong>Now running:</strong> <span className="term-current-title">{live.currentTest}</span>
          </div>
        )}

        {live?.stream === 'lost' && (
          <div className="term-notice">
            <strong>Connection lost:</strong> the live stream to the backend ended and the run state could not be refreshed. Check that the backend is running.
          </div>
        )}

        {selectedRun?.errorMessage && (
          <div className="term-notice">
            <strong>Execution notice:</strong> {selectedRun.errorMessage}
          </div>
        )}

        <div className="term-body" ref={bodyRef} role="log" aria-live="off" tabIndex={0}>
          {lines.length > 0 ? (
            lines.map((line, i) => (
              <div key={i} className={`term-line term-${classify(line)}`}>
                {line.text || ' '}
              </div>
            ))
          ) : (
            <div className="term-empty">
              <Icon name="terminal" size={22} />
              <p className="term-empty-title">{hasLog ? 'No lines match the filter' : 'Terminal standby'}</p>
              {!hasLog && (
                <p className="term-empty-hint">
                  Run a project or suite to stream real process output (git, npm, Playwright, Vitest) here.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
