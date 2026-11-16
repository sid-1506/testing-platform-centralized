import { useEffect, useMemo, useState } from 'react';
import { NormalizedTestCase, NormalizedTestRun, TestAttachment, TestLayer } from '../types';
import { RunFiles, artifactUrl, fetchRunFiles, rawFileUrl, reportUrl, unifiedReportUrl } from '../api/client';
import { LAYERS, LAYER_SHORT, caseLayer, failedLike, formatBytes, formatDuration, formatShortDateTime, layerBreakdown } from '../lib/metrics';
import { CardHead, MetricCard, StatusPill } from './common';
import { Icon } from './icons';

interface ExternalRunResultsProps {
  run: NormalizedTestRun;
  isRunning: boolean;
  /** Only list the test cases of this layer (summary cards stay run-wide). */
  layerFilter?: TestLayer;
}

interface FlatCase extends NormalizedTestCase {
  key: string;
  suiteName: string;
  /** Resolved layer (own layer, else the suite's). */
  layerOf: TestLayer;
}

/** A test whose execution errored gets its own colour; an infra-error run keeps the run-level 'error' pill. */
const pillStatus = (status: string) => (status === 'error' ? 'caseerror' : status);

const STATUS_LABEL: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  error: 'error',
  skipped: 'skipped',
  timedOut: 'timed out',
  interrupted: 'interrupted',
};

function fileLabel(tc: NormalizedTestCase): string | null {
  if (!tc.file) return null;
  return tc.line ? `${tc.file}:${tc.line}` : tc.file;
}

/**
 * Results of an external (GitHub) run (Playwright / Vitest / Jest): execution summary, every real
 * test case, failure details and links to the preserved reports/artifacts.
 * Everything shown is read from the persisted run — nothing is hardcoded.
 */
export function ExternalRunResults({ run, isRunning, layerFilter }: ExternalRunResultsProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [files, setFiles] = useState<RunFiles | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);

  const allCases: FlatCase[] = useMemo(
    () =>
      run.suites.flatMap((suite, si) =>
        suite.cases.map((tc, ci) => ({ ...tc, key: `${si}-${ci}`, suiteName: suite.name, layerOf: caseLayer(tc, suite) }))
      ),
    [run.suites]
  );
  const cases = useMemo(() => (layerFilter ? allCases.filter((c) => c.layerOf === layerFilter) : allCases), [allCases, layerFilter]);

  // Open the first problem automatically so failure details are one glance away.
  useEffect(() => {
    const firstBad = cases.find((c) => c.status !== 'passed' && c.status !== 'skipped');
    setSelectedKey(firstBad ? firstBad.key : null);
  }, [run.runId, cases]);

  useEffect(() => {
    setFiles(null);
    setFilesError(null);
    if (isRunning) return;
    let cancelled = false;
    fetchRunFiles(run.runId)
      .then((f) => !cancelled && setFiles(f))
      .catch((err: unknown) => !cancelled && setFilesError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [run.runId, isRunning]);

  const selected = cases.find((c) => c.key === selectedKey) ?? null;
  const s = run.summary;
  const timedOut = s.timedOut ?? 0;
  const repo = run.repo;
  const byLayer = useMemo(() => layerBreakdown(run), [run]);
  const issues = run.issues ?? [];

  const screenshots = files?.artifacts.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.path)) ?? [];
  const traces = files?.artifacts.filter((f) => /trace\.zip$/i.test(f.path)) ?? [];
  const videos = files?.artifacts.filter((f) => /\.(webm|mp4)$/i.test(f.path)) ?? [];
  const downloads = files?.downloads ?? [];

  return (
    <div className="ext-results">
      <section className="card">
        <CardHead
          title="Execution summary"
          subtitle={
            run.finishedAt
              ? `${formatShortDateTime(run.startedAt)} · finished ${formatShortDateTime(run.finishedAt)}`
              : `Started ${formatShortDateTime(run.startedAt)}`
          }
          actions={<StatusPill status={run.status} label={run.status === 'error' && run.failureKind === 'infrastructure' ? 'infra error' : undefined} />}
        />

        <div className="panel report-meta">
          <div className="report-item">
            <span className="path-label">Repository</span>
            <span>
              {repo ? (
                <a href={repo.url.replace(/\.git$/, '')} target="_blank" rel="noreferrer noopener">
                  {repo.owner}/{repo.name}
                </a>
              ) : (
                run.appId
              )}
            </span>
          </div>
          <div className="report-item">
            <span className="path-label">Branch</span>
            <code className="mono">{repo?.branch ?? '—'}</code>
          </div>
          <div className="report-item">
            <span className="path-label">Commit</span>
            <code className="mono" title={repo?.commitSha}>
              {repo?.commitSha ? repo.commitSha.slice(0, 12) : '—'}
            </code>
          </div>
          <div className="report-item">
            <span className="path-label">Framework</span>
            <span>{run.framework}</span>
          </div>
          <div className="report-item">
            <span className="path-label">Command</span>
            <code className="mono">{repo?.command ?? '—'}</code>
          </div>
          <div className="report-item">
            <span className="path-label">Exit code</span>
            <code className="mono">{run.exitCode === undefined || run.exitCode === null ? '—' : run.exitCode}</code>
          </div>
          <div className="report-item">
            <span className="path-label">Run ID</span>
            <code className="mono">{run.runId}</code>
          </div>
        </div>

        {run.errorMessage && run.status !== 'passed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="info" size={16} />
            <div>
              <strong>
                {run.timedOut ? 'Timed out' : run.status === 'cancelled' ? 'Cancelled' : run.failureKind === 'infrastructure' ? `Infrastructure error${run.failureStage ? ` (${run.failureStage})` : ''}` : run.failureStage ? `Failed during ${run.failureStage}` : 'Run notice'}:
              </strong>{' '}
              {run.errorMessage}
              {run.errorDetail && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', maxHeight: 220, overflow: 'auto' }}>{run.errorDetail}</pre>}
            </div>
          </div>
        )}

        <div className="metric-row ext-metrics">
          <MetricCard icon={<Icon name="layers" size={14} />} label="Total tests" value={isRunning && s.total === 0 ? '…' : s.total} />
          <MetricCard icon={<Icon name="check" size={14} strokeWidth={2.2} />} label="Passed" value={s.passed} sub={s.flaky ? `${s.flaky} flaky (passed on retry)` : undefined} />
          <MetricCard icon={<Icon name="x" size={14} strokeWidth={2.2} />} label="Failed" value={s.failed + (s.interrupted ?? 0)} sub={timedOut ? `+ ${timedOut} timed out` : 'assertion failures'} />
          <MetricCard icon={<Icon name="info" size={14} />} label="Errors" value={s.errors ?? 0} sub={issues.length ? `+ ${issues.length} execution issue${issues.length === 1 ? '' : 's'} (not tests)` : 'execution errors'} />
          <MetricCard icon={<Icon name="arrow-right" size={14} />} label="Skipped" value={s.skipped} />
          <MetricCard icon={<Icon name="clock" size={14} />} label="Duration" value={formatDuration(run.durationMs)} />
        </div>

        <div className="ext-layer-grid" aria-label="Results by layer">
          {LAYERS.map((layer) => {
            const c = byLayer[layer];
            return (
              <div className={`ext-layer-card ${c ? '' : 'is-empty'}`} key={layer}>
                <div className="ext-layer-name">
                  <span className={`layer-dot layer-${layer}`} /> {LAYER_SHORT[layer]}
                </div>
                <div className="ext-layer-value">{c ? c.total : '—'}</div>
                <div className="cell-muted">
                  {c
                    ? `${c.passed} passed · ${c.failed} failed · ${c.errors} errors · ${c.skipped} skipped`
                    : 'No tests ran in this layer'}
                </div>
              </div>
            );
          })}
        </div>

        {issues.length > 0 && (
          <div className="ext-issues" role="region" aria-label="Execution issues">
            <h4 className="ext-art-title">
              Execution issues <span className="cell-muted">({issues.length}) — reported by the runner, not counted as tests</span>
            </h4>
            {issues.map((issue, i) => (
              <details className="ext-issue" key={`${issue.name}-${i}`} open={issue.infrastructure || i === 0}>
                <summary>
                  <StatusPill status={issue.infrastructure ? 'error' : 'caseerror'} label={issue.infrastructure ? 'infra error' : 'execution error'} />{' '}
                  <code className="mono">{issue.name}</code>
                  {issue.layer && <span className="cell-muted"> · {LAYER_SHORT[issue.layer]}</span>}
                </summary>
                <pre className="mono">{issue.message}</pre>
                {issue.stack && <pre className="mono ext-stack">{issue.stack}</pre>}
              </details>
            ))}
          </div>
        )}

        {run.config && (
          <p className="cell-muted ext-config">
            Run configuration: layer <code className="mono">{run.config.layer}</code>
            {run.config.targetBaseUrl && <> · site <code className="mono">{run.config.targetBaseUrl}</code></>}
            {run.config.targetApiUrl && <> · API <code className="mono">{run.config.targetApiUrl}</code></>}
            {run.config.envNames && run.config.envNames.length > 0 && <> · env {run.config.envNames.join(', ')}</>} · npm install scripts {run.config.installScripts}
          </p>
        )}
      </section>

      <section className="card">
        <CardHead
          title={layerFilter ? `${LAYER_SHORT[layerFilter]} test cases` : 'Test cases'}
          subtitle={`Parsed from the repository's own report${layerFilter ? ` · ${cases.length} of ${allCases.length} tests in this run` : ''}. Select a row for details.`}
        />
        {cases.length === 0 ? (
          <div className="panel table-empty">
            {isRunning ? 'Results appear here when the run finishes.' : 'No per-test results were recorded for this run.'}
          </div>
        ) : (
          <div className="panel table-panel">
            <div className="table-scroll">
              <table className="runs-table ext-table">
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th>Test ID</th>
                    <th>Test name</th>
                    <th>Status</th>
                    <th className="num">Duration</th>
                    <th className="num">Retries</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((tc) => {
                    const isSel = tc.key === selectedKey;
                    const bad = tc.status !== 'passed' && tc.status !== 'skipped';
                    return (
                      <tr
                        key={tc.key}
                        className={isSel ? 'is-selected' : ''}
                        tabIndex={0}
                        aria-selected={isSel}
                        onClick={() => setSelectedKey(isSel ? null : tc.key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedKey(isSel ? null : tc.key);
                          }
                        }}
                      >
                        <td>
                          <span className="ext-layer-tag"><span className={`layer-dot layer-${tc.layerOf}`} /> {LAYER_SHORT[tc.layerOf]}</span>
                        </td>
                        <td>
                          <code className="mono">{tc.id ?? '—'}</code>
                        </td>
                        <td>
                          <div className="tc-name" title={tc.fullTitle}>
                            {tc.name}
                          </div>
                          {fileLabel(tc) && <div className="cell-muted ext-file">{fileLabel(tc)}</div>}
                        </td>
                        <td>
                          <StatusPill status={pillStatus(tc.status)} label={STATUS_LABEL[tc.status] ?? tc.status} />
                          {tc.flaky && <span className="tag tag-muted ext-flaky" title="Failed at least once, then passed on retry">flaky</span>}
                        </td>
                        <td className="num">{formatDuration(tc.durationMs)}</td>
                        <td className="num">{tc.retries ?? 0}</td>
                        <td>
                          <span className="ext-details-link">{bad || tc.flaky ? 'View failure' : 'View'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {selected && <CaseDetails runId={run.runId} tc={selected} />}
      </section>

      <section className="card">
        <CardHead title="Reports & artifacts" subtitle="Preserved from the run and served read-only by the backend." />
        {isRunning ? (
          <div className="panel table-empty">Available once the run finishes.</div>
        ) : filesError ? (
          <div className="panel table-empty">Could not load artifacts: {filesError}</div>
        ) : (
          <div className="panel ext-artifacts">
            <div className="ext-art-actions">
              {files?.unifiedReport || run.artifacts.unifiedReport ? (
                <>
                  <a className="btn btn-pill btn-accent" href={unifiedReportUrl(run.runId)} target="_blank" rel="noreferrer noopener">
                    <Icon name="file" size={14} /> Open HTML Report
                  </a>
                  <a className="btn btn-pill btn-white" href={unifiedReportUrl(run.runId, true)} download>
                    <Icon name="download" size={14} /> Download HTML Report
                  </a>
                </>
              ) : (
                <span className="chip chip-plain" title={run.artifacts.unifiedReportNote}>
                  No unified HTML report{run.artifacts.unifiedReportNote ? `: ${run.artifacts.unifiedReportNote}` : ''}
                </span>
              )}
              {run.artifacts.htmlReport || files?.nativeReport || files?.report ? (
                <a className="btn btn-pill btn-white" href={reportUrl(run.runId)} target="_blank" rel="noreferrer noopener" title="The repository's own HTML report (preserved separately, runs sandboxed)">
                  <Icon name="file" size={14} /> Repository-native report
                </a>
              ) : null}
              {(files?.raw ?? []).filter((f) => f !== 'result.json').map((name) => (
                <a key={name} className="btn btn-pill btn-white" href={rawFileUrl(run.runId, name)} download>
                  <Icon name="download" size={14} /> {name}
                </a>
              ))}
            </div>

            <ArtifactGroup title="Downloaded files" runId={run.runId} items={downloads} empty="No files were downloaded by this run." />
            <ArtifactGroup title="Screenshots" runId={run.runId} items={screenshots} empty="No screenshots were captured (only-on-failure)." image />
            <ArtifactGroup title="Traces" runId={run.runId} items={traces} empty="No traces were retained." hint="Download and open with `npx playwright show-trace <file>`, or open the HTML report." />
            {videos.length > 0 && <ArtifactGroup title="Videos" runId={run.runId} items={videos} empty="" />}
          </div>
        )}
      </section>
    </div>
  );
}

function ArtifactGroup({
  title,
  runId,
  items,
  empty,
  hint,
  image,
}: {
  title: string;
  runId: string;
  items: Array<{ path: string; size: number }>;
  empty: string;
  hint?: string;
  image?: boolean;
}) {
  return (
    <div className="ext-art-group">
      <h4 className="ext-art-title">
        {title} <span className="cell-muted">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="cell-muted">{empty}</p>
      ) : (
        <ul className="ext-art-list">
          {items.map((f) => (
            <li key={f.path}>
              {image && (
                <a href={artifactUrl(runId, f.path)} target="_blank" rel="noreferrer noopener" className="ext-thumb">
                  <img src={artifactUrl(runId, f.path)} alt={f.path} loading="lazy" />
                </a>
              )}
              <a href={artifactUrl(runId, f.path)} target="_blank" rel="noreferrer noopener" className="mono ext-art-name" title={f.path}>
                {f.path.split('/').slice(-2).join('/')}
              </a>
              <span className="cell-muted">{formatBytes(f.size)}</span>
              <a className="icon-btn" href={artifactUrl(runId, f.path, true)} download title="Download" aria-label={`Download ${f.path}`}>
                <Icon name="download" size={14} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {hint && items.length > 0 && <p className="cell-muted ext-hint">{hint}</p>}
    </div>
  );
}

function AttachmentLink({ runId, a }: { runId: string; a: TestAttachment }) {
  const label = `${a.kind}${a.attempt > 0 ? ` (retry ${a.attempt})` : ''}: ${a.name}`;
  if (a.kind === 'screenshot') {
    return (
      <a href={artifactUrl(runId, a.path)} target="_blank" rel="noreferrer noopener" className="ext-shot">
        <img src={artifactUrl(runId, a.path)} alt={label} loading="lazy" />
        <span>{label}</span>
      </a>
    );
  }
  return (
    <a className="chip chip-plain" href={artifactUrl(runId, a.path, a.kind !== 'download')} target="_blank" rel="noreferrer noopener" download={a.kind === 'trace' ? true : undefined}>
      <Icon name={a.kind === 'download' ? 'download' : 'file'} size={13} /> {label}
    </a>
  );
}

function CaseDetails({ runId, tc }: { runId: string; tc: FlatCase }) {
  return (
    <div className="panel ext-case-details" aria-live="polite">
      <div className="ext-case-head">
        <div>
          <code className="mono">{tc.id ?? '—'}</code> <strong>{tc.name}</strong>
        </div>
        <StatusPill status={pillStatus(tc.status)} label={STATUS_LABEL[tc.status] ?? tc.status} />
      </div>
      <div className="ext-case-meta">
        {fileLabel(tc) && (
          <span>
            <span className="path-label">File</span> <code className="mono">{fileLabel(tc)}</code>
          </span>
        )}
        {tc.project && (
          <span>
            <span className="path-label">Project</span> {tc.project}
          </span>
        )}
        <span>
          <span className="path-label">Duration</span> {formatDuration(tc.durationMs)}
        </span>
        <span>
          <span className="path-label">Layer</span> {LAYER_SHORT[tc.layerOf]}
        </span>
        <span>
          <span className="path-label">Retries</span> {tc.retries ?? 0}
        </span>
        {tc.originalStatus && (
          <span>
            <span className="path-label">Runner status</span> <code className="mono">{tc.originalStatus}</code>
          </span>
        )}
      </div>

      {tc.flaky && (
        <p className="cell-muted">This test failed on an earlier attempt and passed on retry; its final status is passed.</p>
      )}
      {tc.previousAttempts && tc.previousAttempts.length > 0 && (
        <div className="ext-attempts">
          <span className="path-label">Earlier failed attempts</span>
          <ul>
            {tc.previousAttempts.map((a) => (
              <li key={a.attempt}>
                attempt {a.attempt + 1}: {a.status}
                {a.durationMs !== undefined ? ` (${formatDuration(a.durationMs)})` : ''}
                {a.message ? ` — ${a.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tc.error ? (
        <div className="tc-error">
          <strong>{tc.error.message}</strong>
          {tc.error.stack && <pre>{tc.error.stack}</pre>}
        </div>
      ) : (
        tc.status === 'passed' && <p className="cell-muted">No errors were recorded for this test.</p>
      )}

      {tc.attachments && tc.attachments.length > 0 && (
        <div className="ext-attachments">
          <span className="path-label">Attachments</span>
          <div className="ext-attach-list">
            {tc.attachments.map((a, i) => (
              <AttachmentLink key={`${a.path}-${i}`} runId={runId} a={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
