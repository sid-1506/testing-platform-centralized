import { ExternalRepo, RepoDetection, TestLayer } from '../types';

const FRAMEWORK_LABEL = { playwright: 'Playwright', vitest: 'Vitest', jest: 'Jest' } as const;
const LAYER_ORDER: TestLayer[] = ['unit', 'integration', 'e2e'];
const LAYER_SHORT: Record<TestLayer, string> = { unit: 'Unit', integration: 'Integration', e2e: 'E2E' };

/**
 * One-line repository status, rebuilt whenever something it mentions changes (fetch, inspect, run).
 *
 * Which number it may show, in order of trustworthiness:
 *  1. what the last run on THIS commit actually executed,
 *  2. what the framework's own listing discovered on THIS commit,
 *  3. nothing: "Test count available after execution".
 * The regex-based static declaration estimate is deliberately NOT part of this message: it ignores parameterized and
 * generated tests, so it is never the number of tests that run (it stays available as `detection.staticDeclarationCount`).
 */
export function describeDetection(detection: RepoDetection, repo?: ExternalRepo): string {
  if (!detection.supported) return detection.problems.join(' ');
  const fws = (detection.frameworks?.length ? detection.frameworks : detection.framework ? [detection.framework] : []).map((f) => FRAMEWORK_LABEL[f]);
  const parts = [`${fws.join(' + ') || 'Tests'} detected`, `${detection.testFileCount} test file(s)`];

  const last = repo?.lastExecution;
  const disc = repo?.discovery;
  const sameCommit = (sha?: string) => !repo?.commitSha || !sha || sha === repo.commitSha;
  if (last && last.total > 0 && sameCommit(last.commitSha)) {
    const layers = LAYER_ORDER.filter((l) => last.byLayer[l]).map((l) => `${last.byLayer[l]!.total} ${LAYER_SHORT[l]}`);
    parts.push(`last run executed ${last.total} test(s)${layers.length > 1 ? ` (${layers.join(' · ')})` : ''}`);
  } else if (disc && disc.total > 0 && sameCommit(disc.commitSha)) {
    const layers = LAYER_ORDER.filter((l) => disc.byLayer[l] !== undefined).map((l) => `${disc.byLayer[l]} ${LAYER_SHORT[l]}`);
    parts.push(`${layers.join(' · ')} test(s) discovered at runtime`);
  } else {
    parts.push('Use Fetch Tests to discover test counts');
  }
  return parts.join(' · ');
}
