import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { isStandardReport, parseStandardReport } from '../src/adapters/standardReport';
import { collectArtifacts } from '../src/services/artifactCollector';

const t = (name: string, status: string, extra: Record<string, unknown> = {}) => ({
  name, file: 'tests/x.test.ts', status, startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:01.000Z',
  durationMs: 1000, errorMessage: null, stackTrace: null, ...extra,
});
const report = (layer: string, tests: ReturnType<typeof t>[], runnerError: unknown = null) => {
  const c = (s: string) => tests.filter((x) => x.status === s).length;
  return {
    schemaVersion: 1, runId: 'r', projectId: 'p', layer, status: 'PASSED', startTime: '', endTime: '', durationMs: 5000,
    target: { baseUrl: null, apiBaseUrl: null },
    summary: { total: tests.length, passed: c('PASSED'), failed: c('FAILED'), skipped: c('SKIPPED'), errors: c('ERROR') },
    runnerError, tests,
  };
};

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('standard layer report', () => {
  it('detects the format structurally and rejects look-alikes', () => {
    assert.equal(isStandardReport(report('unit', [t('a', 'PASSED')])), true);
    assert.equal(isStandardReport({ suites: [] }), false);
    assert.equal(isStandardReport({ ...report('unit', []), schemaVersion: 2 }), false);
    assert.equal(isStandardReport(report('smoke', [])), false);
  });

  it('keeps ERROR separate from FAILED, stamps the layer on every case and keeps the original status', () => {
    const p = parseStandardReport(report('integration', [t('f › a', 'PASSED'), t('f › b', 'FAILED', { errorMessage: 'boom' }), t('f › c', 'ERROR', { errorMessage: 'ECONNRESET' }), t('f › d', 'SKIPPED')]) as never);
    assert.deepEqual(p.suite.cases.map((c) => c.status), ['passed', 'failed', 'error', 'skipped']);
    assert.ok(p.suite.cases.every((c) => c.layer === 'integration'));
    assert.equal(p.suite.cases[2].originalStatus, 'ERROR');
    assert.equal(p.suite.cases[2].error?.message, 'ECONNRESET');
    assert.equal(p.suite.cases[1].error?.message, 'boom');
  });

  it('treats [global]/[module]/[unhandled] placeholders as issues, not tests, and keeps their original error text', () => {
    const p = parseStandardReport(
      report('unit', [
        t('a', 'PASSED'),
        t('[module] tests/unit/broken.test.ts', 'ERROR', { errorMessage: 'Cannot find module ./x', stackTrace: 'at load (x.ts:1:1)' }),
        t('[unhandled] TypeError', 'ERROR', { errorMessage: 'x is not a function' }),
        t('[global] setup/runtime error', 'ERROR', { errorMessage: 'ECONNREFUSED' }),
      ]) as never
    );
    assert.equal(p.suite.cases.length, 1);
    assert.deepEqual(p.issues.map((i) => i.kind), ['module', 'unhandled', 'global']);
    assert.equal(p.issues[0].message, 'Cannot find module ./x');
    assert.equal(p.issues[0].stack, 'at load (x.ts:1:1)');
    assert.equal(p.issues[0].name, '[module] tests/unit/broken.test.ts');
    assert.equal(p.ignoredSynthetic, 3);
    assert.equal(p.layerInfraFailure, false);
  });

  it('flags a layer with only placeholders as an infrastructure failure', () => {
    const p = parseStandardReport(report('e2e', [t('[global] setup/runtime error', 'ERROR', { errorMessage: 'target unreachable' })]) as never);
    assert.equal(p.suite.cases.length, 0);
    assert.equal(p.layerInfraFailure, true);
    assert.ok(p.issues[0].infrastructure);
  });

  it('does not count the runner placeholder as a test when runnerError is set', () => {
    const p = parseStandardReport(report('e2e', [t('[runner] EXECUTION', 'ERROR')], { kind: 'EXECUTION', message: 'could not start' }) as never);
    assert.equal(p.suite.cases.length, 0);
    assert.equal(p.ignoredSynthetic, 1);
    assert.equal(p.runnerError?.kind, 'EXECUTION');
  });

  it('collectArtifacts parses reports/<layer>, preserves files, and totals match the reports', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-collect-ws-'));
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-collect-run-'));
    dirs.push(ws, run);
    const layers: Array<[string, ReturnType<typeof t>[]]> = [
      ['unit', [t('a', 'PASSED'), t('b', 'PASSED')]],
      ['integration', [t('c', 'PASSED'), t('d', 'FAILED')]],
      ['e2e', [t('e', 'PASSED'), t('f', 'SKIPPED'), t('g', 'PASSED')]],
    ];
    for (const [layer, tests] of layers) {
      const d = path.join(ws, 'reports', layer);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'results.json'), JSON.stringify(report(layer, tests)));
      fs.writeFileSync(path.join(d, 'junit.xml'), '<testsuites/>');
      fs.writeFileSync(path.join(d, 'execution.log'), 'log token=abcdef123456');
    }
    fs.writeFileSync(path.join(ws, 'reports', 'summary.json'), '{}');
    const res = collectArtifacts({ workspaceRepoDir: ws, runDir: run, configText: '', sanitize: (s) => s.replace(/abcdef123456/g, '[X]') });
    assert.equal(res.source, 'standard');
    assert.deepEqual(res.layers, ['unit', 'integration', 'e2e']);
    assert.equal(res.suites.reduce((n, s) => n + s.cases.length, 0), 7);
    // layer attribution: 2 unit / 2 integration / 3 e2e, taken from each report, not from the run's scope
    assert.deepEqual(res.suites.map((x) => [x.layer, x.cases.length, x.cases.every((c) => c.layer === x.layer)]), [['unit', 2, true], ['integration', 2, true], ['e2e', 3, true]]);
    assert.equal(res.infraErrors.length, 0);
    for (const f of ['results.unit.json', 'junit.integration.xml', 'execution.e2e.log', 'summary.json']) {
      assert.ok(fs.existsSync(path.join(run, f)), f);
    }
    assert.match(fs.readFileSync(path.join(run, 'execution.e2e.log'), 'utf8'), /\[X\]/);
  });

  it('surfaces runnerError as an infra error and falls back to nothing fake when the report is garbage', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-collect-ws-'));
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-collect-run-'));
    dirs.push(ws, run);
    fs.mkdirSync(path.join(ws, 'reports', 'unit'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'reports', 'unit', 'results.json'), '{not json');
    const res = collectArtifacts({ workspaceRepoDir: ws, runDir: run, configText: '', sanitize: (s) => s });
    assert.equal(res.source, 'none');
    assert.equal(res.suites.length, 0);
    assert.ok(res.notes.some((n) => /Could not parse/.test(n)));
  });
});

describe('test names are redacted like the raw files', () => {
  it('sanitizes names and titles in the normalized result', () => {
    const p = parseStandardReport(report('unit', [t('suite › rejects https://user:pass@example.com', 'PASSED')]) as never, (s) => s.replace(/user:pass/g, '[REDACTED]'));
    assert.equal(p.suite.cases[0].fullTitle, 'suite › rejects https://[REDACTED]@example.com');
    assert.equal(p.suite.cases[0].name, 'rejects https://[REDACTED]@example.com');
  });
});
