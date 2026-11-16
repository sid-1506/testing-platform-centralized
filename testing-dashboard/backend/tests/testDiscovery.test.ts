import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Observation,
  classifyObservations,
  extractJson,
  layerFromPath,
  parseJestFiles,
  parsePlaywrightList,
  parseVitestList,
} from '../src/services/discoveryParsers';
import { toPublicRepo } from '../src/services/repoSettings';
import { ExternalRepo, TestLayer } from '../src/types';

const ROOT = '/ws/repo';

describe('listing parsers', () => {
  it('extracts JSON around banner lines', () => {
    assert.deepEqual(extractJson('warning: x\n[1,2]'), [1, 2]);
    assert.throws(() => extractJson('nothing here'));
  });

  it('counts one Playwright case per project (expanded), relative to the root', () => {
    const json = {
      config: { projects: [{ name: 'chromium', retries: 0 }, { name: 'firefox', retries: 0 }] },
      errors: [{ message: 'Error: boom\n at x' }],
      suites: [{ title: 'a.spec.ts', file: 'tests/e2e/a.spec.ts', specs: [{ title: 'works', file: 'tests/e2e/a.spec.ts', line: 3, tests: [{ projectName: 'chromium' }, { projectName: 'firefox' }] }] }],
    };
    const r = parsePlaywrightList(json, ROOT);
    assert.equal(r.tests.length, 2);
    assert.equal(r.tests[0].file, 'tests/e2e/a.spec.ts');
    assert.deepEqual(r.errors, ['Error: boom']);
  });

  it('parses vitest list and jest file output', () => {
    const v = parseVitestList([{ name: 'a > b', file: `${ROOT}/tests/unit/x.test.ts` }], ROOT);
    assert.equal(v[0].file, 'tests/unit/x.test.ts');
    assert.deepEqual(parseJestFiles([`${ROOT}/src/a.test.ts`], ROOT), ['src/a.test.ts']);
    assert.throws(() => parseVitestList({}, ROOT));
  });
});

describe('layer classification', () => {
  it('reads layers from paths and names, nearest directory first', () => {
    assert.equal(layerFromPath('tests/integration/api.test.ts'), 'integration');
    assert.equal(layerFromPath('tests/e2e/unit-ish/x.spec.ts'), 'e2e');
    assert.equal(layerFromPath('src/a.e2e.spec.ts'), 'e2e');
    assert.equal(layerFromPath('src/a.test.ts'), undefined);
  });

  const obs = (file: string, title: string, seenIn: TestLayer[], framework: 'vitest' | 'playwright' = 'vitest'): Observation => ({
    test: { framework, file, title },
    seenIn: new Set(seenIn),
  });

  it('does not classify everything as E2E and shows zero for absent layers', () => {
    const c = classifyObservations(
      [obs('src/a.test.ts', 'a', []), obs('src/b.test.ts', 'b', []), obs('tests/e2e/x.spec.ts', 'x', [], 'playwright')],
      () => false
    );
    assert.deepEqual(c.byLayer, { unit: 2, integration: 0, e2e: 1 });
    assert.equal(c.total, 3);
    assert.equal(c.details.integration.runnable, false);
  });

  it('uses the single scoped listing that contained an unhinted test, defaults when the scope was ignored', () => {
    const c = classifyObservations(
      [obs('t/one.test.ts', 'only-integration', ['integration']), obs('t/all.test.ts', 'everywhere', ['unit', 'integration', 'e2e'])],
      () => true
    );
    assert.deepEqual(c.byLayer, { unit: 1, integration: 1, e2e: 0 });
    assert.equal(c.details.integration.runnable, true);
    assert.equal(c.details.e2e.runnable, false, 'an empty layer is never runnable');
  });

  it('labels a layer containing Jest static counts as an estimate', () => {
    const c = classifyObservations([{ test: { framework: 'jest', file: 'a.test.js', title: 'd', estimated: true }, seenIn: new Set() }], () => false);
    assert.equal(c.details.unit.method, 'estimate');
  });
});

describe('stale discovery', () => {
  it('is flagged when the repository moved to another commit', () => {
    const base = { id: 'x', commitSha: 'b'.repeat(40), discovery: { commitSha: 'a'.repeat(40), byLayer: {}, total: 0, discoveredAt: '', source: '' } } as unknown as ExternalRepo;
    assert.equal(toPublicRepo(base).discovery?.stale, true);
    assert.equal(toPublicRepo({ ...base, commitSha: 'a'.repeat(40) }).discovery?.stale, false);
  });
});
