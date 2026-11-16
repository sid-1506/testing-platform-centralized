import fs from 'fs';
import path from 'path';
import {
  LayerSummary,
  NormalizedTestCase,
  NormalizedTestRun,
  RunIssue,
  TestLayer,
} from '../types';
import { emptyLayerSummary } from '../adapters/playwrightReport';

/**
 * Platform-generated unified HTML report.
 *
 * Built ONLY from the run's normalized result (`result.json`); repositories do not have to produce HTML. The document is
 * static: no script, no external resource, every piece of untrusted text (test names, errors, stack traces, URLs,
 * branch names, commit messages) goes through `esc()`. It carries its own restrictive CSP (`<meta>`), and the server adds
 * a CSP header with `sandbox` so even a bug here could not reach the platform API.
 */
export const UNIFIED_REPORT_FILE = 'report.html';
export const REPORT_RUN_ID_META = 'platform-run-id';

/** Policy applied to the generated report both in a <meta> tag and as an HTTP header. No scripts, no network, no framing. */
export const UNIFIED_REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

const LAYER_ORDER: TestLayer[] = ['unit', 'integration', 'e2e'];
const FILTERS: Array<[string, string]> = [['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed'], ['error', 'Errors'], ['skipped', 'Skipped'], ['flaky', 'Flaky']];
const LAYER_TITLE: Record<TestLayer, string> = { unit: 'Unit', integration: 'Integration', e2e: 'E2E' };
const MAX_STACK_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_CASES = 50_000;

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function clip(text: string | undefined, max: number): string {
  const t = text ?? '';
  return t.length > max ? `${t.slice(0, max)}\n… [truncated ${t.length - max} characters]` : t;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export type ReportValidation = { ok: true } | { ok: false; reason: string };

/**
 * A report is built only from a structurally valid result that actually contains test cases whose counts agree with the
 * summary. Anything else is reported honestly instead of rendering a fake or empty-looking "all good" report.
 */
export function validateRunForReport(run: NormalizedTestRun | null | undefined): ReportValidation {
  if (!run || typeof run !== 'object') return { ok: false, reason: 'No run result is available.' };
  if (typeof run.runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(run.runId)) return { ok: false, reason: 'The run has no valid run id.' };
  if (!Array.isArray(run.suites)) return { ok: false, reason: 'The run result has no suites array.' };
  let cases = 0;
  for (const suite of run.suites) {
    if (!suite || !Array.isArray(suite.cases)) return { ok: false, reason: 'The run result contains a malformed suite.' };
    cases += suite.cases.length;
  }
  if (cases === 0) return { ok: false, reason: 'The run produced no parsed test results, so there is nothing to report.' };
  if (cases > MAX_CASES) return { ok: false, reason: `The run has more than ${MAX_CASES} test results.` };
  if (!run.summary || run.summary.total !== cases) {
    return { ok: false, reason: `The run summary (${run.summary?.total ?? 'missing'}) does not match the ${cases} parsed test result(s).` };
  }
  return { ok: true };
}

function badge(status: string): string {
  const cls = /^[a-zA-Z]+$/.test(status) ? status : 'unknown';
  const label = status === 'timedOut' ? 'TIMED OUT' : status.toUpperCase();
  return `<span class="b b-${cls}">${esc(label)}</span>`;
}

function statCard(label: string, value: number, cls: string): string {
  return `<div class="card ${cls}"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`;
}

function layerRow(layer: string, s: LayerSummary, durationMs?: number): string {
  const failedLike = s.failed + (s.timedOut ?? 0) + (s.interrupted ?? 0);
  return `<tr><th scope="row">${esc(layer)}</th><td>${s.total}</td><td class="t-pass">${s.passed}</td><td class="${failedLike ? 't-fail' : ''}">${failedLike}</td><td class="${s.errors ? 't-err' : ''}">${s.errors}</td><td>${s.skipped}</td><td>${s.flaky ?? 0}</td><td class="num">${esc(fmtDuration(durationMs))}</td></tr>`;
}

function issueHtml(i: RunIssue): string {
  return `<details class="issue" open><summary><span class="b b-${i.infrastructure ? 'infra' : 'error'}">${i.infrastructure ? 'INFRA ERROR' : 'EXECUTION ERROR'}</span> <code>${esc(i.name)}</code>${i.layer ? ` <span class="muted">· ${esc(LAYER_TITLE[i.layer] ?? i.layer)}</span>` : ''}</summary><pre>${esc(clip(i.message, MAX_MESSAGE_CHARS))}</pre>${i.stack ? `<pre class="stack">${esc(clip(i.stack, MAX_STACK_CHARS))}</pre>` : ''}</details>`;
}

function caseHtml(c: NormalizedTestCase): string {
  const bad = c.status === 'failed' || c.status === 'error' || c.status === 'timedOut' || c.status === 'interrupted';
  const hasDetail = !!c.error || !!(c.previousAttempts && c.previousAttempts.length);
  const rowClass = `case r-${/^[a-zA-Z]+$/.test(c.status) ? c.status : 'unknown'}${c.flaky ? ' flaky' : ''}`;
  const title = c.fullTitle && c.fullTitle !== c.name ? c.fullTitle : c.name;
  const flags: string[] = [];
  if (c.flaky) flags.push('<span class="b b-flaky">FLAKY</span>');
  if (c.retries) flags.push(`<span class="muted">${c.retries} retr${c.retries === 1 ? 'y' : 'ies'}</span>`);
  const detail = hasDetail
    ? `<tr class="detail ${rowClass}"><td colspan="5"><details${bad ? ' open' : ''}><summary>${c.error ? 'Error details' : 'Earlier attempts'}</summary>${
        c.error
          ? `<pre>${esc(clip(c.error.message, MAX_MESSAGE_CHARS))}</pre>${c.error.stack ? `<pre class="stack">${esc(clip(c.error.stack, MAX_STACK_CHARS))}</pre>` : ''}`
          : ''
      }${
        c.previousAttempts && c.previousAttempts.length
          ? `<div class="attempts"><strong>Earlier failed attempts</strong><ul>${c.previousAttempts
              .map((a) => `<li>attempt ${a.attempt + 1}: ${esc(a.status)}${a.message ? ` — ${esc(clip(a.message, 600))}` : ''}</li>`)
              .join('')}</ul></div>`
          : ''
      }</details></td></tr>`
    : '';
  return `<tr class="${rowClass}"><td>${badge(c.status)}</td><td class="name">${esc(title)}${flags.length ? ` ${flags.join(' ')}` : ''}${c.id ? ` <span class="muted">${esc(c.id)}</span>` : ''}</td><td class="muted">${esc(c.file ?? '')}${c.line ? `:${c.line}` : ''}</td><td class="num">${esc(fmtDuration(c.durationMs))}</td><td class="muted">${esc(c.originalStatus && c.originalStatus.toLowerCase() !== c.status.toLowerCase() ? `reported as ${c.originalStatus}` : '')}</td></tr>${detail}`;
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#1b1f24}
main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:30px 0 10px}
.muted{color:#6a737d}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
pre{background:#f0f2f5;border:1px solid #d9dde3;border-radius:6px;padding:10px;margin:8px 0;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
pre.stack{color:#57606a}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:6px 24px;background:#fff;border:1px solid #d9dde3;border-radius:8px;padding:14px 16px;margin:14px 0}
.meta div span:first-child{display:inline-block;min-width:96px;color:#6a737d}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0}
.card{background:#fff;border:1px solid #d9dde3;border-radius:8px;padding:12px 14px}
.card .v{font-size:26px;font-weight:650}
.card .l{color:#6a737d;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.card.pass .v,.t-pass{color:#1a7f37}.card.fail .v,.t-fail{color:#cf222e}.card.err .v,.t-err{color:#b35900}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9dde3;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eaecef;vertical-align:top}
thead th{background:#f0f2f5;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#57606a}
td.num{white-space:nowrap;text-align:right}
td.name{word-break:break-word}
tr.detail td{background:#fafbfc}
.b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:650;white-space:nowrap}
.b-passed{background:#dafbe1;color:#1a7f37}.b-failed,.b-timedOut,.b-interrupted{background:#ffebe9;color:#cf222e}
.b-error{background:#fff1e0;color:#b35900}.b-skipped{background:#eaecef;color:#57606a}
.b-flaky{background:#fff8c5;color:#7d4e00}.b-infra{background:#fbe0ff;color:#8250df}.b-unknown{background:#eaecef}
.status-passed{color:#1a7f37}.status-failed{color:#cf222e}.status-error{color:#8250df}.status-cancelled{color:#6a737d}
details.layer{margin:18px 0}
details.layer>summary{cursor:pointer;font-size:16px;font-weight:600;padding:6px 0}
.issue{background:#fff;border:1px solid #d9dde3;border-left:4px solid #8250df;border-radius:6px;padding:8px 12px;margin:8px 0}
.note{background:#fff8c5;border:1px solid #eac54f;border-radius:6px;padding:8px 12px;margin:10px 0}
footer{margin-top:36px;color:#6a737d;font-size:12px}
input.f{position:absolute;opacity:0;pointer-events:none}
.filterbox>label{display:inline-block;margin:0 6px 10px 0;cursor:pointer;border:1px solid #d9dde3;background:#fff;border-radius:16px;padding:3px 12px;font-size:12px;font-weight:600}
input.f:checked+label,input.f:focus-visible+label{outline:2px solid #0969da;outline-offset:1px}
input.f:checked+label{background:#0969da;color:#fff;border-color:#0969da}
#f-passed:checked~.tests tr.case:not(.r-passed),
#f-failed:checked~.tests tr.case:not(.r-failed):not(.r-timedOut):not(.r-interrupted),
#f-error:checked~.tests tr.case:not(.r-error),
#f-skipped:checked~.tests tr.case:not(.r-skipped),
#f-flaky:checked~.tests tr.case:not(.flaky){display:none}
@media (prefers-color-scheme:dark){
.filterbox>label{background:#161b22;border-color:#30363d}
body{background:#0d1117;color:#e6edf3}.meta,.card,table,.issue{background:#161b22;border-color:#30363d}
pre{background:#0d1117;border-color:#30363d}thead th{background:#1c2128;color:#9da7b3}th,td{border-color:#262c34}
tr.detail td{background:#12171d}.muted,.card .l,.meta div span:first-child{color:#9da7b3}pre.stack{color:#9da7b3}
.b-passed{background:#12361f;color:#56d364}.b-failed,.b-timedOut,.b-interrupted{background:#3d1417;color:#ff7b72}
.b-error{background:#3d2a10;color:#f0b35c}.b-skipped{background:#262c34;color:#9da7b3}.b-flaky{background:#3a3000;color:#f2cc60}
.card.pass .v,.t-pass{color:#56d364}.card.fail .v,.t-fail{color:#ff7b72}.card.err .v,.t-err{color:#f0b35c}.note{background:#2b2400;border-color:#6b5a10}
}
@media print{body{background:#fff}details>summary{list-style:none}}
`;

export interface RenderOptions {
  generatedAt?: string;
  /** A repository-native HTML report was preserved for this run (link is relative to the served report URL). */
  nativeReportAvailable?: boolean;
}

/** Renders the unified report. Call `validateRunForReport` first; this function assumes a valid run. */
export function renderUnifiedReport(run: NormalizedTestRun, opts: RenderOptions = {}): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const s = run.summary;
  const byLayer = s.byLayer ?? {};
  const failedLike = s.failed + (s.timedOut ?? 0) + (s.interrupted ?? 0);
  const issues = run.issues ?? [];
  const statusLabel = run.status === 'error' ? 'INFRA_ERROR' : run.status.toUpperCase();

  // Group cases by their own layer (not by the run's scope).
  const grouped = new Map<TestLayer, Array<{ suite: string; c: NormalizedTestCase }>>();
  for (const suite of run.suites) {
    for (const c of suite.cases) {
      const layer = c.layer ?? suite.layer;
      const list = grouped.get(layer) ?? [];
      list.push({ suite: suite.name, c });
      grouped.set(layer, list);
    }
  }
  const layers = LAYER_ORDER.filter((l) => grouped.has(l) || issues.some((i) => i.layer === l));

  const meta: Array<[string, string]> = [];
  if (run.repo) {
    meta.push(['Repository', `${esc(run.repo.owner)}/${esc(run.repo.name)}`]);
    meta.push(['URL', esc(run.repo.url)]);
    meta.push(['Branch', esc(run.repo.branch)]);
    meta.push(['Commit', `<code>${esc(run.repo.commitSha ?? 'unknown')}</code>`]);
    if (run.repo.command) meta.push(['Command', `<code>${esc(run.repo.command)}</code>`]);
  } else {
    meta.push(['Application', esc(run.appId)]);
  }
  meta.push(['Run ID', `<code>${esc(run.runId)}</code>`]);
  meta.push(['Framework', esc(run.framework)]);
  meta.push(['Started', esc(run.startedAt)]);
  if (run.finishedAt) meta.push(['Finished', esc(run.finishedAt)]);
  meta.push(['Duration', esc(fmtDuration(run.durationMs))]);
  if (run.config?.targetBaseUrl) meta.push(['Target site', esc(run.config.targetBaseUrl)]);
  if (run.config?.targetApiUrl) meta.push(['Target API', esc(run.config.targetApiUrl)]);
  if (run.config) meta.push(['Layer scope', esc(run.config.layer)]);

  const layerDuration = new Map<TestLayer, number>();
  for (const suite of run.suites) {
    if (Number.isFinite(suite.durationMs)) layerDuration.set(suite.layer, (layerDuration.get(suite.layer) ?? 0) + suite.durationMs);
  }
  const layerTable = `<table><thead><tr><th>Layer</th><th>Total</th><th>Passed</th><th>Failed</th><th>Errors</th><th>Skipped</th><th>Flaky</th><th>Duration</th></tr></thead><tbody>${layers
    .filter((l) => byLayer[l])
    .map((l) => layerRow(LAYER_TITLE[l], byLayer[l] ?? emptyLayerSummary(), layerDuration.get(l)))
    .join('')}${layerRow('Total', s, run.durationMs)}</tbody></table>`;

  const sections = layers
    .map((layer) => {
      const items = grouped.get(layer) ?? [];
      const sum = byLayer[layer];
      const layerIssues = issues.filter((i) => i.layer === layer);
      const files = new Map<string, NormalizedTestCase[]>();
      for (const { suite, c } of items) {
        const key = c.file || suite;
        const l = files.get(key) ?? [];
        l.push(c);
        files.set(key, l);
      }
      const rows = Array.from(files.entries())
        .map(([file, cases]) => `<tr><th colspan="5" class="muted">${esc(file)}</th></tr>${cases.map(caseHtml).join('')}`)
        .join('');
      return `<details class="layer" open id="layer-${layer}"><summary>${esc(LAYER_TITLE[layer])} — ${sum ? `${sum.passed}/${sum.total} passed` : `${items.length} tests`}${
        sum && sum.errors ? `, ${sum.errors} error${sum.errors === 1 ? '' : 's'}` : ''
      }${sum && sum.failed ? `, ${sum.failed} failed` : ''}${sum && sum.skipped ? `, ${sum.skipped} skipped` : ''}</summary>${layerIssues.map(issueHtml).join('')}${
        items.length
          ? `<table><thead><tr><th>Status</th><th>Test</th><th>File</th><th>Duration</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="muted">No test produced a result in this layer.</p>'
      }</details>`;
    })
    .join('');

  const unlayeredIssues = issues.filter((i) => !i.layer || !layers.includes(i.layer));
  const runLevel: string[] = [];
  if (run.errorMessage && run.status !== 'passed') runLevel.push(`<div class="note"><strong>${esc(statusLabel)}:</strong> ${esc(clip(run.errorMessage, MAX_MESSAGE_CHARS))}</div>`);
  if (run.infraErrors?.length) runLevel.push(`<div class="note"><strong>Infrastructure:</strong><ul>${run.infraErrors.map((e) => `<li>${esc(clip(e, 1000))}</li>`).join('')}</ul></div>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(UNIFIED_REPORT_CSP.replace('; frame-ancestors \'none\'', '').replace('; sandbox', ''))}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="${REPORT_RUN_ID_META}" content="${esc(run.runId)}">
<title>Test report — ${esc(run.repo ? `${run.repo.owner}/${run.repo.name}` : run.appId)} — ${esc(run.runId)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Unified test report <span class="status-${esc(run.status)}">${esc(statusLabel)}</span></h1>
<div class="muted">Generated by the Centralized Testing Platform from this run's normalized result · ${esc(generatedAt)}</div>
<div class="meta">${meta.map(([k, v]) => `<div><span>${esc(k)}</span><span>${v}</span></div>`).join('')}</div>
${runLevel.join('')}
<div class="cards">
${statCard('Total', s.total, '')}${statCard('Passed', s.passed, 'pass')}${statCard('Failed', failedLike, failedLike ? 'fail' : '')}${statCard('Errors', s.errors, s.errors ? 'err' : '')}${statCard('Skipped', s.skipped, '')}${statCard('Flaky', s.flaky ?? 0, '')}
</div>
${issues.length ? `<p class="muted">Not counted as tests: ${issues.length} execution issue${issues.length === 1 ? '' : 's'} (see below).</p>` : ''}
<h2>By layer</h2>
${layerTable}
${unlayeredIssues.length ? `<h2>Execution issues</h2>${unlayeredIssues.map(issueHtml).join('')}` : ''}
<h2>Tests</h2>
<div class="filterbox">
${FILTERS.map(([id, label], i) => `<input class="f" type="radio" name="status-filter" id="f-${id}"${i === 0 ? ' checked' : ''}><label for="f-${id}">${esc(label)}</label>`).join('')}
<div class="tests">
${sections}
</div>
</div>
${opts.nativeReportAvailable ? `<h2>Repository-native report</h2><p>The repository also produced its own HTML report. It is preserved separately and is not part of this report: <a href="report/">open repository-native report</a>.</p>` : ''}
<footer>Run <code>${esc(run.runId)}</code> · report format 1 · all test names, messages and stack traces above come from the tested repository and are shown as plain text.</footer>
</main>
</body>
</html>
`;
}

/** Writes `<runDir>/report.html`. Returns a reason instead of writing anything when the run data is not valid. */
export function writeUnifiedReport(runDir: string, run: NormalizedTestRun, opts: RenderOptions = {}): ReportValidation {
  const valid = validateRunForReport(run);
  if (!valid.ok) return valid;
  try {
    const html = renderUnifiedReport(run, opts);
    const target = path.join(runDir, UNIFIED_REPORT_FILE);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, html, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Could not write the unified report: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** True when `html` was generated for exactly this run id (checks the embedded meta tag). */
export function reportBelongsToRun(htmlHead: string, runId: string): boolean {
  const m = htmlHead.match(/<meta name="platform-run-id" content="([^"]*)">/);
  return !!m && m[1] === esc(runId);
}
