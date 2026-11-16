import fs from 'fs';
import path from 'path';
import { NormalizedTestSuite, RunIssue, TestLayer } from '../types';
import { PwJsonReport, parseJUnitXml, parsePlaywrightJson, stampLayers } from '../adapters/playwrightReport';
import { isJestStyleReport, JestJsonReport, parseJestStyleJson } from '../adapters/jestJson';
import { STANDARD_LAYERS, StandardReport, isStandardReport, parseStandardReport } from '../adapters/standardReport';
import { copyDirNoSymlinks } from '../lib/fsSafe';
import { detectOutputLocations } from './repoDetector';

export interface CollectResult {
  suites: NormalizedTestSuite[];
  globalErrors: string[];
  source: 'json' | 'junit' | 'standard' | 'vitest-json' | 'none';
  hasHtmlReport: boolean;
  hasResultsJson: boolean;
  hasJunitXml: boolean;
  notes: string[];
  /** Infrastructure problems the repository's own runner reported (never test failures). */
  infraErrors: string[];
  /** Non-test execution problems (`[global]` / `[module]` / `[unhandled]` / `[runner]`), verbatim. */
  issues: RunIssue[];
  /** Layers for which a standard layer report was parsed. */
  layers: string[];
  /** Run-relative file names preserved for the standard layer reports. */
  layerFiles: string[];
}

/** Where layer-runner repositories conventionally write `<root>/<layer>/results.json`. */
const STANDARD_REPORT_ROOTS = ['reports', 'test-reports', 'report'];
const MAX_LOG_COPY_BYTES = 5 * 1024 * 1024;
const MAX_REPORT_COPY_BYTES = 50 * 1024 * 1024;
/** Where the platform asks Vitest/Jest to write their JSON when it injects reporter flags itself. */
export const PLATFORM_REPORT_DIR = '.platform-report';
const TEXT_ARTIFACT_RE = /\.(txt|log|json|xml|csv|md|ya?ml|html?)$/i;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;

function deepSanitize(value: unknown, sanitize: (s: string) => string): unknown {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map((v) => deepSanitize(v, sanitize));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepSanitize(v, sanitize);
    return out;
  }
  return value;
}

/**
 * Writes a JSON report with every string value passed through the secret redactor. Parsing first guarantees the output
 * is still valid JSON (a textual replace could break escaping). Returns false (nothing written) for unreadable input.
 */
export function writeSanitizedJson(src: string, dest: string, sanitize: (s: string) => string): boolean {
  try {
    if (fs.statSync(src).size > MAX_REPORT_COPY_BYTES) return false;
    const parsed: unknown = JSON.parse(fs.readFileSync(src, 'utf8'));
    fs.writeFileSync(dest, `${JSON.stringify(deepSanitize(parsed, sanitize), null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function writeSanitizedText(src: string, dest: string, sanitize: (s: string) => string): boolean {
  try {
    if (fs.statSync(src).size > MAX_REPORT_COPY_BYTES) return false;
    fs.writeFileSync(dest, sanitize(fs.readFileSync(src, 'utf8')), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Redacts secrets in small text-like artifacts (logs, JSON, XML, markdown, CSV) copied from untrusted code. Binary files are untouched. */
function sanitizeTextTree(dir: string, sanitize: (s: string) => string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) sanitizeTextTree(abs, sanitize);
    else if (e.isFile() && TEXT_ARTIFACT_RE.test(e.name)) {
      try {
        if (fs.statSync(abs).size > MAX_TEXT_ARTIFACT_BYTES) continue;
        const text = fs.readFileSync(abs, 'utf8');
        const clean = sanitize(text);
        if (clean !== text) fs.writeFileSync(abs, clean, 'utf8');
      } catch {
        // leave it as is
      }
    }
  }
}

function insideOrEqual(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function firstRegularFile(root: string, candidates: Array<string | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(root, c);
    if (!insideOrEqual(path.resolve(root), abs)) continue;
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && !st.isSymbolicLink()) return abs;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Copies a finished run's outputs out of the (temporary) execution workspace into
 * the permanent run directory and parses the machine-readable report.
 * Symlinks inside the workspace are never followed or copied.
 */
export function collectArtifacts(opts: {
  workspaceRepoDir: string;
  runDir: string;
  configText: string;
  sanitize: (s: string) => string;
  /** Layer used for results that do not carry one (Playwright -> e2e, Vitest/Jest -> unit unless the path says otherwise). */
  defaultLayer?: TestLayer;
  /** Layer the run was restricted to by the user; forces the layer of Vitest/Jest results. */
  forcedLayer?: TestLayer;
  /** Framework of an injected JSON reporter (`.platform-report/<framework>.json`). */
  injectedFramework?: 'vitest' | 'jest' | 'playwright';
}): CollectResult {
  const { workspaceRepoDir, runDir, sanitize } = opts;
  const notes: string[] = [];
  const wsReal = realOr(workspaceRepoDir);
  const locs = detectOutputLocations(opts.configText);
  const resultsRoot = path.join(workspaceRepoDir, 'test-results');

  const result: CollectResult = {
    suites: [],
    globalErrors: [],
    source: 'none',
    hasHtmlReport: false,
    hasResultsJson: false,
    hasJunitXml: false,
    notes,
    infraErrors: [],
    issues: [],
    layers: [],
    layerFiles: [],
  };

  const safeResolve = (rel: string): string | null => {
    const abs = path.resolve(workspaceRepoDir, rel);
    return insideOrEqual(path.resolve(workspaceRepoDir), abs) ? abs : null;
  };

  // --- HTML report ----------------------------------------------------------
  const htmlAbs = safeResolve(locs.htmlReportDir);
  if (htmlAbs && fs.existsSync(path.join(htmlAbs, 'index.html'))) {
    copyDirNoSymlinks(htmlAbs, path.join(runDir, 'playwright-report'));
    result.hasHtmlReport = true;
  }

  // --- JSON / JUnit reports ---------------------------------------------------
  const jsonFile = firstRegularFile(workspaceRepoDir, [
    opts.injectedFramework ? `${PLATFORM_REPORT_DIR}/${opts.injectedFramework}.json` : undefined,
    locs.jsonFile,
    'test-results/results.json',
    'results.json',
    'playwright-report/results.json',
    'test-results.json',
    'vitest-results.json',
    'jest-results.json',
  ]);
  const junitFile = firstRegularFile(workspaceRepoDir, [
    locs.junitFile,
    'test-results/junit.xml',
    'junit.xml',
    'results.xml',
  ]);
  // Raw reports are written through the secret redactor: they come from untrusted code and are offered for download.
  if (jsonFile) {
    if (writeSanitizedJson(jsonFile, path.join(runDir, 'results.json'), sanitize)) result.hasResultsJson = true;
    else notes.push('results.json is not valid JSON (or too large); it was not preserved.');
  }
  if (junitFile) {
    if (writeSanitizedText(junitFile, path.join(runDir, 'junit.xml'), sanitize)) result.hasJunitXml = true;
    else notes.push('junit.xml could not be read; it was not preserved.');
  }

  // --- downloads + per-test artifacts -----------------------------------------
  const downloadsAbs = path.join(resultsRoot, 'downloads');
  if (fs.existsSync(downloadsAbs)) copyDirNoSymlinks(downloadsAbs, path.join(runDir, 'downloads'));

  const outputAbs = safeResolve(locs.outputDir);
  const outputIsResultsRoot = outputAbs !== null && path.resolve(outputAbs) === path.resolve(resultsRoot);
  if (outputAbs && fs.existsSync(outputAbs)) {
    copyDirNoSymlinks(outputAbs, path.join(runDir, 'artifacts'), (name, depth) =>
      outputIsResultsRoot && depth === 0 && ['downloads', 'results.json', 'junit.xml'].includes(name)
    );
  }
  sanitizeTextTree(path.join(runDir, 'artifacts'), sanitize);
  sanitizeTextTree(path.join(runDir, 'downloads'), sanitize);

  let extra = 0;
  const mapAttachment = (absPath: string): string | null => {
    let abs: string;
    try {
      const lst = fs.lstatSync(absPath);
      if (lst.isSymbolicLink() || !lst.isFile()) return null;
      abs = fs.realpathSync(absPath);
    } catch {
      return null;
    }
    if (!insideOrEqual(wsReal, abs)) return null; // never leak files from outside the workspace
    const outReal = outputAbs ? realOr(outputAbs) : null;
    const dlReal = realOr(downloadsAbs);
    if (outReal && insideOrEqual(outReal, abs) && !(outputIsResultsRoot && insideOrEqual(dlReal, abs))) {
      const rel = `artifacts/${path.relative(outReal, abs).split(path.sep).join('/')}`;
      return fs.existsSync(path.join(runDir, rel)) ? rel : null;
    }
    if (insideOrEqual(dlReal, abs)) {
      const rel = `downloads/${path.relative(dlReal, abs).split(path.sep).join('/')}`;
      return fs.existsSync(path.join(runDir, rel)) ? rel : null;
    }
    // Attachment stored somewhere else inside the workspace: preserve it explicitly.
    extra += 1;
    const dest = path.join(runDir, 'artifacts', '_attachments', `${extra}-${path.basename(abs)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    return `artifacts/_attachments/${extra}-${path.basename(abs)}`;
  };

  // --- standard layer reports (<reports>/<layer>/results.json) ---------------------
  collectStandardReports({ workspaceRepoDir, runDir, sanitize, result });

  // --- parse -----------------------------------------------------------------
  if (result.source === 'standard') {
    // Layer reports are authoritative: they carry the repository's own per-layer verdicts.
  } else if (jsonFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as PwJsonReport & JestJsonReport;
      if (Array.isArray(raw.suites)) {
        const parsed = parsePlaywrightJson(raw, { layer: opts.forcedLayer ?? 'e2e', mapAttachment, sanitize });
        result.suites = parsed.suites;
        result.globalErrors = parsed.globalErrors;
        result.source = 'json';
      } else if (isJestStyleReport(raw)) {
        // Vitest (`--reporter=json`) and Jest (`--json`) share this shape.
        const parsed = parseJestStyleJson(raw, {
          rootDir: wsReal,
          defaultLayer: opts.defaultLayer ?? 'unit',
          forceLayer: opts.forcedLayer,
          sanitize,
        });
        result.suites = parsed.suites;
        result.issues.push(...parsed.issues);
        result.source = 'vitest-json';
        // The Vitest/Jest JSON shape has no per-attempt data: say so instead of implying "0 retries".
        notes.push('Retry/flaky information is unavailable: the Vitest/Jest JSON report does not record test attempts.');
      } else {
        throw new Error('not a Playwright, Vitest or Jest JSON report');
      }
    } catch (err) {
      notes.push(`Could not parse JSON report: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.source === 'none' && junitFile) {
    try {
      const parsed = parseJUnitXml(fs.readFileSync(junitFile, 'utf8'), { layer: opts.forcedLayer ?? opts.defaultLayer ?? 'e2e', sanitize });
      result.suites = parsed.suites;
      result.source = 'junit';
      if (jsonFile) notes.push('Fell back to JUnit XML because results.json was unreadable.');
    } catch (err) {
      notes.push(`Could not parse JUnit report: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.source === 'none') {
    notes.push('No machine-readable report (results.json / junit.xml) was found; per-test results are unavailable.');
  }
  stampLayers(result.suites);
  return result;
}

/**
 * Finds, preserves and parses `<root>/<layer>/results.json` (+ junit.xml, execution.log) written by
 * layer-runner repositories. Files are copied flat into the run directory as
 * `results.<layer>.json`, `junit.<layer>.xml`, `execution.<layer>.log` and `summary.json`.
 * A layer whose JSON is unreadable falls back to its junit.xml; nothing is ever synthesised.
 */
function collectStandardReports(opts: {
  workspaceRepoDir: string;
  runDir: string;
  sanitize: (s: string) => string;
  result: CollectResult;
}): void {
  const { workspaceRepoDir, runDir, sanitize, result } = opts;
  const { notes } = result;
  const wsAbs = path.resolve(workspaceRepoDir);

  for (const rootName of STANDARD_REPORT_ROOTS) {
    const rootAbs = path.join(wsAbs, rootName);
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(rootAbs);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;

    const suites: ReturnType<typeof parseStandardReport>[] = [];
    for (const layer of STANDARD_LAYERS) {
      const layerAbs = path.join(rootAbs, layer);
      try {
        const st = fs.lstatSync(layerAbs);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const resultsFile = firstRegularFile(layerAbs, ['results.json']);
      const junitPath = firstRegularFile(layerAbs, ['junit.xml']);
      const logFile = firstRegularFile(layerAbs, ['execution.log']);
      if (!resultsFile && !junitPath) continue;

      let parsedLayer: ReturnType<typeof parseStandardReport> | null = null;
      if (resultsFile) {
        try {
          const raw: unknown = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
          if (isStandardReport(raw) && (raw as StandardReport).layer === layer) {
            parsedLayer = parseStandardReport(raw as StandardReport, sanitize);
          } else {
            notes.push(`${rootName}/${layer}/results.json is not a standard layer report (schemaVersion 1); ignored.`);
          }
        } catch (err) {
          notes.push(`Could not parse ${rootName}/${layer}/results.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!parsedLayer && junitPath) {
        try {
          const parsed = parseJUnitXml(fs.readFileSync(junitPath, 'utf8'), { layer, sanitize });
          if (parsed.suites.length > 0) {
            parsedLayer = {
              layer,
              suite: {
                name: layer,
                layer,
                durationMs: parsed.suites.reduce((n, x) => n + x.durationMs, 0),
                cases: parsed.suites.flatMap((x) => x.cases),
              },
              runnerError: null,
              reportStatus: 'PASSED',
              declared: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
              ignoredSynthetic: 0,
              issues: [],
              layerInfraFailure: false,
            };
            notes.push(`${rootName}/${layer}: results.json unusable, parsed junit.xml instead.`);
          }
        } catch (err) {
          notes.push(`Could not parse ${rootName}/${layer}/junit.xml: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const keepSanitizedJson = (src: string | null, name: string) => {
        if (!src) return;
        if (writeSanitizedJson(src, path.join(runDir, name), sanitize)) result.layerFiles.push(name);
        else notes.push(`Could not preserve ${name}: not valid JSON.`);
      };
      const keep = (src: string | null, name: string, transform?: (t: string) => string) => {
        if (!src) return;
        try {
          if (transform) {
            if (fs.statSync(src).size > MAX_LOG_COPY_BYTES) return;
            fs.writeFileSync(path.join(runDir, name), transform(fs.readFileSync(src, 'utf8')), 'utf8');
          } else {
            fs.copyFileSync(src, path.join(runDir, name));
          }
          result.layerFiles.push(name);
        } catch (err) {
          notes.push(`Could not preserve ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      keepSanitizedJson(resultsFile, `results.${layer}.json`);
      keep(junitPath, `junit.${layer}.xml`, sanitize);
      keep(logFile, `execution.${layer}.log`, sanitize);
      if (resultsFile) result.hasResultsJson = true;
      if (junitPath) result.hasJunitXml = true;

      if (parsedLayer) {
        suites.push(parsedLayer);
        const counted = parsedLayer.suite.cases.length;
        const declared = parsedLayer.declared.total - parsedLayer.ignoredSynthetic;
        if (parsedLayer.declared.total > 0 && counted !== declared) {
          notes.push(`${layer}: parsed ${counted} test(s) but the report declares ${parsedLayer.declared.total}.`);
        }
        if (parsedLayer.runnerError) {
          result.infraErrors.push(`${layer}: [${parsedLayer.runnerError.kind}] ${parsedLayer.runnerError.message}`);
        } else if (parsedLayer.layerInfraFailure) {
          const first = parsedLayer.issues[0];
          result.infraErrors.push(`${layer}: no test produced a result; ${first.name} — ${first.message.split('\n')[0].slice(0, 300)}`);
        }
        result.issues.push(...parsedLayer.issues);
        notes.push(
          `${layer}: ${parsedLayer.suite.cases.length} test(s) parsed from ${rootName}/${layer}/results.json (report status ${parsedLayer.reportStatus}).`
        );
      }
    }

    if (suites.length === 0) continue;
    const summaryFile = firstRegularFile(rootAbs, ['summary.json']);
    if (summaryFile) {
      try {
        fs.copyFileSync(summaryFile, path.join(runDir, 'summary.json'));
        result.layerFiles.push('summary.json');
      } catch {
        // optional file
      }
    }
    result.suites = suites.map((x) => x.suite);
    result.layers = suites.map((x) => x.layer);
    result.source = 'standard';
    return;
  }
}
