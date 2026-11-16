import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { summarizeSuites, stampLayers } from '../src/adapters/playwrightReport';
import { classifyFailureMessage, inferLayerFromPath, parseJestStyleJson } from '../src/adapters/jestJson';
import { collectArtifacts, writeSanitizedJson } from '../src/services/artifactCollector';
import { esc, renderUnifiedReport, reportBelongsToRun, validateRunForReport, writeUnifiedReport } from '../src/services/htmlReport';
import { NormalizedTestCase, NormalizedTestRun, NormalizedTestSuite, TestLayer } from '../src/types';

const tmp: string[] = [];
after(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mkdtemp = (n: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), n));
  tmp.push(d);
  return d;
};

const tc = (name: string, status: NormalizedTestCase['status'], extra: Partial<NormalizedTestCase> = {}): NormalizedTestCase => ({
  name, status, durationMs: 5, ...extra,
});
const suite = (layer: TestLayer, cases: NormalizedTestCase[]): NormalizedTestSuite => ({ name: layer, layer, durationMs: 10, cases });

function makeRun(suites: NormalizedTestSuite[], over: Partial<NormalizedTestRun> = {}): NormalizedTestRun {
  stampLayers(suites);
  return {
    runId: 'run_1_abcd', appId: 'gh-x-123456', layer: 'all', executionMode: 'isolated', framework: 'vitest + playwright', status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', durationMs: 60000,
    summary: summarizeSuites(suites), suites, artifacts: {}, kind: 'external',
    repo: { id: 'gh-x-123456', name: 'demo', url: 'https://github.com/o/demo.git', owner: 'o', branch: 'main', commitSha: 'a'.repeat(40), framework: 'x', command: 'npm test' },
    ...over,
  };
}

describe('layer-aware summaries', () => {
  it('splits counts by each case\'s own layer and keeps errors separate from failures', () => {
    const suites = [
      suite('unit', [tc('a', 'passed'), tc('b', 'passed'), tc('c', 'failed')]),
      suite('integration', [tc('d', 'error'), tc('e', 'skipped')]),
      suite('e2e', [tc('f', 'passed', { flaky: true })]),
    ];
    stampLayers(suites);
    const s = summarizeSuites(suites);
    assert.equal(s.total, 6);
    assert.deepEqual([s.passed, s.failed, s.errors, s.skipped, s.flaky], [3, 1, 1, 1, 1]);
    assert.deepEqual([s.byLayer!.unit!.total, s.byLayer!.integration!.total, s.byLayer!.e2e!.total], [3, 2, 1]);
    assert.equal(s.byLayer!.integration!.errors, 1);
    assert.equal(s.byLayer!.unit!.failed, 1);
  });

  it('uses the case layer over the suite layer', () => {
    const suites = [suite('e2e', [tc('x', 'passed', { layer: 'unit' })])];
    assert.equal(summarizeSuites(suites).byLayer!.unit!.total, 1);
    assert.equal(summarizeSuites(suites).byLayer!.e2e, undefined);
  });
});

describe('Vitest / Jest JSON adapter', () => {
  const raw = {
    testResults: [
      { name: '/ws/tests/unit/a.test.ts', status: 'passed', startTime: 1, endTime: 11, assertionResults: [
        { fullName: 'a ok', title: 'ok', ancestorTitles: ['a'], status: 'passed', duration: 2 },
        { fullName: 'a boom', title: 'boom', ancestorTitles: ['a'], status: 'failed', duration: 3, failureMessages: ['AssertionError: expected 1 to be 2\n at x'] },
        { fullName: 'a net', title: 'net', ancestorTitles: ['a'], status: 'failed', duration: 3, failureMessages: ['Error: connect ECONNREFUSED 127.0.0.1:1'] },
        { fullName: 'a todo', title: 'todo', ancestorTitles: ['a'], status: 'todo' },
      ] },
      { name: '/ws/tests/integration/b.test.ts', status: 'passed', assertionResults: [{ fullName: 'b', title: 'b', status: 'passed', duration: 1 }] },
      { name: '/ws/tests/unit/broken.test.ts', status: 'failed', message: 'Cannot find module ./x', assertionResults: [] },
    ],
  };
  it('attributes layers from the path, separates failed/error/skipped and records load failures as [module] issues', () => {
    const { suites, issues } = parseJestStyleJson(raw, { rootDir: '/ws', defaultLayer: 'unit' });
    const s = summarizeSuites(suites);
    assert.deepEqual([s.byLayer!.unit!.total, s.byLayer!.integration!.total], [4, 1]);
    assert.deepEqual([s.passed, s.failed, s.errors, s.skipped], [2, 1, 1, 1]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'module');
    assert.equal(issues[0].message, 'Cannot find module ./x');
  });
  it('infers layers and classifies failures', () => {
    assert.equal(inferLayerFromPath('tests/e2e/a.spec.ts', 'unit'), 'e2e');
    assert.equal(inferLayerFromPath('src/api.integration.test.ts', 'unit'), 'integration');
    assert.equal(inferLayerFromPath('src/a.test.ts', 'unit'), 'unit');
    assert.equal(classifyFailureMessage('expect(received).toBe(expected)'), 'failed');
    assert.equal(classifyFailureMessage('Error: Test timed out in 5000ms'), 'error');
  });
});

describe('unified HTML report', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const run = makeRun([
    suite('unit', [tc('plain', 'passed'), tc(evil, 'failed', { fullTitle: `f › ${evil}`, error: { message: evil, stack: `at ${evil}` } })]),
    suite('integration', [tc('net', 'error', { error: { message: 'ECONNRESET' } })]),
    suite('e2e', [tc('flaky one', 'passed', { flaky: true, retries: 1, previousAttempts: [{ attempt: 0, status: 'failed', message: evil }] })]),
  ], {
    issues: [{ layer: 'unit', kind: 'module', name: `[module] ${evil}`, message: evil, stack: evil, infrastructure: false }],
    repo: { id: 'r', name: evil, url: `https://github.com/o/${evil}`, owner: 'o', branch: evil, commitSha: 'c'.repeat(40), framework: 'x' },
  });

  it('escapes every untrusted string and contains no script or event handler', () => {
    const html = renderUnifiedReport(run);
    assert.ok(!html.includes('<script'), 'no <script>');
    assert.ok(!/<img\b/.test(html), 'no injected <img>');
    assert.ok(!/<[^>]*\sonerror=/.test(html), 'no event-handler attribute');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(html, /Content-Security-Policy" content="default-src &#39;none&#39;/);
  });

  it('shows each layer, accurate counts, errors, flaky info, run id and commit', () => {
    const html = renderUnifiedReport(makeRun(run.suites));
    for (const l of ['Unit', 'Integration', 'E2E']) assert.ok(html.includes(`id="layer-${l === 'E2E' ? 'e2e' : l.toLowerCase()}"`), l);
    assert.match(html, /FLAKY/);
    assert.match(html, /Earlier failed attempts/);
    assert.ok(html.includes('run_1_abcd'));
    assert.ok(html.includes('c'.repeat(0) + 'a'.repeat(40)));
    assert.match(html, /ECONNRESET/);
  });

  it('has a per-layer duration column and script-free CSS status filters that cover every status group', () => {
    const html = renderUnifiedReport(makeRun([
      { name: 'unit', layer: 'unit', durationMs: 1500, cases: [tc('a', 'passed'), tc('b', 'failed', { error: { message: 'x' } })] },
      { name: 'e2e', layer: 'e2e', durationMs: 90_000, cases: [tc('c', 'passed', { flaky: true }), tc('d', 'skipped'), tc('e', 'error', { error: { message: 'y' } })] },
    ]));
    assert.match(html, /<th>Duration<\/th>/);
    assert.match(html, /1\.50 s/);
    assert.match(html, /1m 30s/);
    for (const id of ['all', 'passed', 'failed', 'error', 'skipped', 'flaky']) {
      assert.ok(html.includes(`id="f-${id}"`), `filter ${id}`);
      if (id !== 'all') assert.ok(html.includes(`#f-${id}:checked~.tests`), `rule ${id}`);
    }
    assert.ok(!html.includes('<script') && !/\son\w+=/.test(html));
    // Detail rows carry the status class too, so they are hidden together with their test row.
    assert.match(html, /<tr class="detail case r-error">/);
    assert.match(html, /<tr class="case r-passed flaky">/);
  });

  it('is tied to its run id', () => {
    const html = renderUnifiedReport(run);
    assert.equal(reportBelongsToRun(html.slice(0, 4096), 'run_1_abcd'), true);
    assert.equal(reportBelongsToRun(html.slice(0, 4096), 'run_2_zzzz'), false);
  });

  it('refuses to produce a report for invalid or empty data and writes nothing', () => {
    const dir = mkdtemp('tp-rep-');
    const empty = makeRun([suite('unit', [])]);
    assert.equal(validateRunForReport(empty).ok, false);
    assert.equal(writeUnifiedReport(dir, empty).ok, false);
    const mismatch = makeRun([suite('unit', [tc('a', 'passed')])]);
    mismatch.summary.total = 7;
    assert.equal(validateRunForReport(mismatch).ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'report.html')), false);
    assert.equal(validateRunForReport(null).ok, false);
  });

  it('writes report.html for a valid run', () => {
    const dir = mkdtemp('tp-rep-');
    assert.equal(writeUnifiedReport(dir, run).ok, true);
    assert.ok(fs.statSync(path.join(dir, 'report.html')).size > 500);
  });

  it('esc handles the HTML-significant characters', () => {
    assert.equal(esc(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
  });
});

describe('raw artifact sanitization', () => {
  it('redacts secrets inside JSON string values and keeps the file valid JSON', () => {
    const dir = mkdtemp('tp-san-');
    const src = path.join(dir, 'in.json');
    fs.writeFileSync(src, JSON.stringify({ a: 'token=s3cr3t-value-123 and "quotes"', n: [{ m: 's3cr3t-value-123' }] }));
    assert.equal(writeSanitizedJson(src, path.join(dir, 'out.json'), (t) => t.split('s3cr3t-value-123').join('[REDACTED]')), true);
    const out = fs.readFileSync(path.join(dir, 'out.json'), 'utf8');
    assert.ok(!out.includes('s3cr3t-value-123'));
    assert.deepEqual(JSON.parse(out).n, [{ m: '[REDACTED]' }]);
  });
  it('does not preserve an invalid JSON file', () => {
    const dir = mkdtemp('tp-san-');
    const src = path.join(dir, 'in.json');
    fs.writeFileSync(src, '{nope');
    assert.equal(writeSanitizedJson(src, path.join(dir, 'out.json'), (t) => t), false);
    assert.equal(fs.existsSync(path.join(dir, 'out.json')), false);
  });
  it('collectArtifacts stores sanitized results.json / junit.xml and sanitizes text artifacts', () => {
    const ws = mkdtemp('tp-ws-');
    const run = mkdtemp('tp-run-');
    fs.mkdirSync(path.join(ws, '.platform-report'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.platform-report', 'vitest.json'), JSON.stringify({ testResults: [{ name: path.join(ws, 'tests/unit/a.test.ts'), status: 'passed', assertionResults: [{ fullName: 'x HUNTER2SECRET', title: 'x', status: 'passed', duration: 1 }] }] }));
    fs.writeFileSync(path.join(ws, 'junit.xml'), '<testsuites><testcase name="x HUNTER2SECRET"/></testsuites>');
    fs.writeFileSync(path.join(ws, 'test-results', 'note.txt'), 'password HUNTER2SECRET');
    const res = collectArtifacts({ workspaceRepoDir: ws, runDir: run, configText: '', sanitize: (t) => t.replace(/HUNTER2SECRET/g, '[X]'), injectedFramework: 'vitest', defaultLayer: 'unit' });
    assert.equal(res.source, 'vitest-json');
    assert.equal(res.suites[0].cases[0].layer, 'unit');
    for (const f of ['results.json', 'junit.xml', 'artifacts/note.txt']) {
      assert.ok(!fs.readFileSync(path.join(run, f), 'utf8').includes('HUNTER2SECRET'), f);
    }
  });
});
