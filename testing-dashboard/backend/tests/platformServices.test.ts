import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LayerProgressTracker, applyFlakyObservations } from '../src/services/layerProgress';
import { applySettingsPatch, runEnvFromSettings, toPublicRepo, SettingsError, SECRET_MASK } from '../src/services/repoSettings';
import { planRetention } from '../src/services/runRetention';
import { classifyScript, dependencyKey, detectRepository } from '../src/services/repoDetector';
import { QueueItem } from '../src/services/playwrightProgress';
import { NormalizedTestSuite, RunEventType, RunProgress, ExternalRepo } from '../src/types';

const tmp: string[] = [];
after(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function repoDir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-repo-'));
  tmp.push(d);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), content);
  }
  return d;
}

describe('layer-aware live progress', () => {
  type Ev = { type: RunEventType; progress?: RunProgress; test?: { title: string } };
  const run = (queue: QueueItem[], lines: string[], opts = { playwrightOnly: false }) => {
    const events: Ev[] = [];
    const t = new LayerProgressTracker(queue, (type, p) => events.push({ type, ...p }), opts);
    t.start();
    t.feed(lines.join('\n') + '\n');
    return { t, events };
  };

  it('reports Vitest file-level progress per layer without inventing a total', () => {
    const { events } = run([], [
      '▶ Layer: unit  (run x)',
      ' \u001b[32m✓\u001b[39m tests/unit/a.test.ts \u001b[2m(\u001b[22m\u001b[2m44 tests\u001b[22m\u001b[2m)\u001b[22m 14ms',
      ' ✓ tests/unit/b.test.ts (29 tests) 36ms',
      ' ❯ tests/unit/c.test.ts (5 tests | 1 failed | 1 skipped) 9ms',
    ]);
    const prog = events.filter((e) => e.type === 'layer_progress').map((e) => e.progress!);
    const last = prog[prog.length - 1];
    assert.equal(last.layer, 'unit');
    assert.equal(last.filesDone, 3);
    assert.equal(last.testsDone, 78);
    assert.equal(last.failedSoFar, 1);
    assert.equal(last.testsTotal, undefined, 'no total before the runner prints one');
    assert.ok(events.some((e) => e.type === 'layer_started'));
  });

  it('takes the total from the runner summary once it is printed', () => {
    const { events } = run([], ['▶ Layer: integration', ' ✓ tests/integration/x.test.ts (12 tests) 1ms', ' Tests  12 passed (12)']);
    const last = events.filter((e) => e.type === 'layer_progress').pop()!.progress!;
    assert.equal(last.testsTotal, 12);
    assert.equal(last.layer, 'integration');
  });

  it('does not start Playwright test announcements before the e2e layer begins', () => {
    const queue = [{ file: 'a.spec.ts', line: 3, title: 'a › t', project: 'chromium', allowedAttempts: 2 }];
    const { events } = run(queue, ['▶ Layer: unit', ' ✓ tests/unit/a.test.ts (2 tests) 1ms']);
    assert.ok(!events.some((e) => e.type === 'test_started'));
    const e2e = run(queue, ['▶ Layer: e2e', '  ✓  1 [chromium] › tests/e2e/a.spec.ts:3:3 › a › t (1.0s)']);
    assert.ok(e2e.events.some((e) => e.type === 'test_started'));
    const last = e2e.events.filter((e) => e.type === 'layer_progress').pop()!.progress!;
    assert.equal(last.testsTotal, 1);
    assert.equal(last.testsDone, 1);
  });

  it('records retries and merges them into cases that have no attempt history', () => {
    const queue = [{ file: 'a.spec.ts', line: 3, title: 'grp › t', project: 'chromium', allowedAttempts: 2 }];
    const { t } = run(queue, [
      '▶ Layer: e2e',
      '  ✘  1 [chromium] › tests/e2e/a.spec.ts:3:3 › grp › t (2.0s)',
      '  ✓  2 [chromium] › tests/e2e/a.spec.ts:3:3 › grp › t (retry #1) (1.0s)',
    ]);
    const suites: NormalizedTestSuite[] = [{ name: 'e2e', layer: 'e2e', durationMs: 1, cases: [{ name: 't', fullTitle: 'tests/e2e/a.spec.ts › grp › t', file: 'tests/e2e/a.spec.ts', status: 'passed', durationMs: 1000 }] }];
    assert.equal(applyFlakyObservations(suites, t.flakyObservations()), 1);
    const c = suites[0].cases[0];
    assert.equal(c.flaky, true);
    assert.equal(c.retries, 1);
    assert.equal(c.previousAttempts?.length, 1);
    assert.equal(c.status, 'passed');
  });

  it('a test that fails every attempt is not flaky and keeps its final failure', () => {
    const queue = [{ file: 'a.spec.ts', line: 3, title: 'grp › t', project: 'chromium', allowedAttempts: 2 }];
    const { t } = run(queue, [
      '▶ Layer: e2e',
      '  ✘  1 [chromium] › tests/e2e/a.spec.ts:3:3 › grp › t (2.0s)',
      '  ✘  2 [chromium] › tests/e2e/a.spec.ts:3:3 › grp › t (retry #1) (2.0s)',
    ]);
    const suites: NormalizedTestSuite[] = [{ name: 'e2e', layer: 'e2e', durationMs: 1, cases: [{ name: 't', fullTitle: 'tests/e2e/a.spec.ts › grp › t', status: 'failed', durationMs: 1 }] }];
    applyFlakyObservations(suites, t.flakyObservations());
    assert.equal(suites[0].cases[0].flaky, undefined);
    assert.equal(suites[0].cases[0].previousAttempts?.length, 1);
    assert.equal(suites[0].cases[0].status, 'failed');
  });
});

describe('per-repository settings', () => {
  const scripts = { test: 'tsx scripts/run-tests.ts', 'test:unit': 'x' };
  it('accepts only existing script names, validated URLs and allow-listed env names', () => {
    const s = applySettingsPatch(undefined, { testScript: 'test:unit', layer: 'unit', targetBaseUrl: 'https://example.com/app', targetApiUrl: 'http://api.example.com', env: { TEST_FOO: 'bar', API_TOKEN: 'abcdef123' } }, scripts);
    assert.equal(s.testScript, 'test:unit');
    assert.equal(s.layer, 'unit');
    assert.equal(s.env?.TEST_FOO, 'bar');
    assert.throws(() => applySettingsPatch(undefined, { testScript: 'rm -rf /' }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { testScript: 'missing' }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { targetBaseUrl: 'ftp://x' }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { targetBaseUrl: 'https://u:p@x.com' }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { env: { PATH: '/evil' } }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { env: { NODE_OPTIONS: '--require x' } }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { env: { TEST_LAYER: 'unit' } }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { env: { TEST_X: 'a\nb' } }, scripts), SettingsError);
    assert.throws(() => applySettingsPatch(undefined, { layer: 'smoke' }, scripts), SettingsError);
  });
  it('masks secret values for the browser and keeps them when the mask is sent back', () => {
    const s = applySettingsPatch(undefined, { env: { API_TOKEN: 'abcdef123', TEST_REGION: 'eu' } }, scripts);
    const pub = toPublicRepo({ settings: s } as ExternalRepo);
    assert.equal(pub.settings?.env?.API_TOKEN, SECRET_MASK);
    assert.equal(pub.settings?.env?.TEST_REGION, 'eu');
    const again = applySettingsPatch(s, { env: { API_TOKEN: SECRET_MASK, TEST_REGION: 'us' } }, scripts);
    assert.equal(again.env?.API_TOKEN, 'abcdef123');
    assert.equal(again.env?.TEST_REGION, 'us');
  });
  it('builds the run environment from settings only', () => {
    const env = runEnvFromSettings({ targetBaseUrl: 'https://a.b/', env: { TEST_X: '1' } }, 'integration');
    assert.deepEqual(env, { TEST_X: '1', TEST_LAYER: 'integration', TEST_BASE_URL: 'https://a.b/' });
  });
});

describe('run history retention', () => {
  const r = (id: string, day: number, status: 'passed' | 'running' = 'passed') => ({ runId: id, status, startedAt: new Date(Date.UTC(2026, 0, day)).toISOString() });
  it('keeps the newest N, never touches active or protected runs', () => {
    const runs = [r('a', 1), r('b', 2), r('c', 3), r('d', 4), r('act', 1, 'running'), r('prot', 1)];
    const doomed = planRetention({ runs, protectedIds: new Set(['prot']), maxRuns: 2, maxAgeDays: 0 });
    assert.deepEqual(doomed.sort(), ['a', 'b']);
  });
  it('removes finished runs older than the age limit only', () => {
    const now = Date.UTC(2026, 5, 1);
    const doomed = planRetention({ runs: [r('old', 1), r('older-running', 1, 'running'), r('new', 150)], protectedIds: new Set(), maxRuns: 0, maxAgeDays: 90, now });
    assert.deepEqual(doomed, ['old']);
  });
});

describe('repository detection beyond Playwright', () => {
  const pkg = (o: object) => JSON.stringify({ name: 'x', ...o });
  it('supports a Vitest-only repository without Playwright', () => {
    const d = repoDir({ 'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } }), 'package-lock.json': '{}', 'tests/unit/a.test.ts': "it('a', () => {})\nit('b', () => {})" });
    const det = detectRepository(d);
    assert.equal(det.supported, true);
    assert.deepEqual(det.frameworks, ['vitest']);
    assert.deepEqual(det.browsers, []);
    assert.equal(det.testCommand?.kind, 'vitest');
    assert.equal(det.staticDeclarationCount, 2);
    assert.deepEqual(det.layers, ['unit']);
  });
  it('supports Jest and Vitest + Playwright combinations', () => {
    const jest = detectRepository(repoDir({ 'package.json': pkg({ scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }), 'package-lock.json': '{}' }));
    assert.equal(jest.supported, true);
    assert.equal(jest.testCommand?.kind, 'jest');
    const both = detectRepository(repoDir({ 'package.json': pkg({ scripts: { test: 'tsx scripts/run-tests.ts' }, devDependencies: { vitest: '^2', '@playwright/test': '^1.50' } }), 'package-lock.json': '{}', 'scripts/run-tests.ts': 'process.env.TEST_LAYER', 'tests/unit/a.test.ts': '', 'tests/e2e/a.spec.ts': '' }));
    assert.deepEqual(both.frameworks, ['playwright', 'vitest']);
    assert.equal(both.supportsLayerSelection, true);
    assert.equal(both.testCommand?.kind, 'runner');
    assert.deepEqual(both.layers, ['unit', 'e2e']);
  });
  it('still rejects a repository with no supported framework', () => {
    const det = detectRepository(repoDir({ 'package.json': pkg({ scripts: { test: 'mocha' }, devDependencies: { mocha: '^10' } }), 'package-lock.json': '{}' }));
    assert.equal(det.supported, false);
    assert.match(det.problems.join(' '), /No supported test framework/);
  });
  it('classifies scripts conservatively and keys the dependency cache on the install-script flag', () => {
    assert.equal(classifyScript('vitest run'), 'vitest');
    assert.equal(classifyScript('jest --ci'), 'jest');
    assert.equal(classifyScript('playwright test'), 'playwright');
    assert.equal(classifyScript('vitest run && playwright test'), 'unknown');
    assert.equal(classifyScript('tsx scripts/run-tests.ts'), 'runner');
    const d = repoDir({ 'package.json': pkg({}), 'package-lock.json': '{}' });
    assert.notEqual(dependencyKey(d, 'package-lock.json', false), dependencyKey(d, 'package-lock.json', true));
  });
});

import { describeDetection } from '../src/services/repoStatus';
import type { RepoDetection } from '../src/types';

describe('repository status message', () => {
  const det = { supported: true, frameworks: ['vitest', 'playwright'], testFileCount: 11, staticDeclarationCount: 122, problems: [] } as unknown as RepoDetection;
  const base = { commitSha: 'a'.repeat(40) } as ExternalRepo;
  const layer = (total: number) => ({ total, passed: total, failed: 0, skipped: 0, errors: 0 });

  it('never quotes the static estimate and says so honestly before any run', () => {
    const msg = describeDetection(det, base);
    assert.match(msg, /Use Fetch Tests to discover test counts/);
    assert.ok(!/122|static|estimate/i.test(msg));
  });
  it('prefers what the last run on this commit executed, per layer', () => {
    const repo = { ...base, lastExecution: { runId: 'r', executedAt: 'x', commitSha: base.commitSha, total: 185, passed: 185, failed: 0, skipped: 0, errors: 0, byLayer: { unit: layer(142), integration: layer(24), e2e: layer(19) } } } as ExternalRepo;
    assert.match(describeDetection(det, repo), /last run executed 185 test\(s\) \(142 Unit · 24 Integration · 19 E2E\)/);
  });
  it('uses runtime discovery for the current commit, and ignores results of another commit', () => {
    const disc = { discoveredAt: 'x', commitSha: base.commitSha!, source: 'playwright test --list', byLayer: { e2e: 19 }, total: 19 };
    assert.match(describeDetection(det, { ...base, discovery: disc } as ExternalRepo), /19 E2E test\(s\) discovered at runtime/);
    const moved = { ...base, commitSha: 'b'.repeat(40), discovery: disc } as ExternalRepo;
    assert.match(describeDetection(det, moved), /Use Fetch Tests to discover test counts/);
  });
});
