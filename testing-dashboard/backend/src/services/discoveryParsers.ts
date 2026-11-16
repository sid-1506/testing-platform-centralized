import path from 'path';
import { LayerDiscoveryDetail, TestFramework, TestLayer } from '../types';
import { queueFromListJson } from './playwrightProgress';

export const DISCOVERY_LAYERS: TestLayer[] = ['unit', 'integration', 'e2e'];

/** One test case as reported by a framework's own listing. */
export interface ListedTest {
  framework: TestFramework;
  /** Repository-relative POSIX path. */
  file: string;
  title: string;
  project?: string;
  /** True when the number comes from a static scan instead of the framework (Jest). */
  estimated?: boolean;
}

/** Extracts the JSON document from stdout that may carry banner/warning lines around it. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through: find the first line that starts a JSON array/object
  }
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (/^[[{]/.test(lines[i])) {
      try {
        return JSON.parse(lines.slice(i).join('\n'));
      } catch {
        // try the next candidate
      }
    }
  }
  throw new Error('The listing command did not print valid JSON.');
}

export function toRelPosix(root: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

export interface PlaywrightListResult {
  tests: ListedTest[];
  /** Errors Playwright reported while loading config/files (some tests may be missing). */
  errors: string[];
}

export function parsePlaywrightList(json: unknown, root: string): PlaywrightListResult {
  const errors = (((json as { errors?: Array<{ message?: string }> })?.errors) || [])
    .map((e) => String(e?.message || '').split('\n')[0].slice(0, 300))
    .filter(Boolean);
  const tests = queueFromListJson(json).map<ListedTest>((q) => ({
    framework: 'playwright',
    file: toRelPosix(root, q.file),
    title: q.title,
    project: q.project,
  }));
  return { tests, errors };
}

/** `vitest list --json` → [{ name, file, location }]. */
export function parseVitestList(json: unknown, root: string): ListedTest[] {
  if (!Array.isArray(json)) throw new Error('vitest list --json did not return an array.');
  return json
    .filter((x) => x && typeof x.file === 'string')
    .map<ListedTest>((x) => ({
      framework: 'vitest',
      file: toRelPosix(root, x.file),
      title: String(x.name ?? ''),
      project: typeof x.projectName === 'string' && x.projectName ? x.projectName : undefined,
    }));
}

/** `jest --listTests --json` → ["/abs/a.test.ts", ...] (files only: Jest cannot list cases without running them). */
export function parseJestFiles(json: unknown, root: string): string[] {
  if (!Array.isArray(json)) throw new Error('jest --listTests --json did not return an array.');
  return json.filter((f): f is string => typeof f === 'string').map((f) => toRelPosix(root, f));
}

const LAYER_DIR_HINTS: Array<[TestLayer, RegExp]> = [
  ['e2e', /^(e2e|end-?to-?end|playwright|browser|ui)$/],
  ['integration', /^(integration|integrations|int|api|contract|service|services)$/],
  ['unit', /^(unit|units)$/],
];
const LAYER_FILE_HINTS: Array<[TestLayer, RegExp]> = [
  ['e2e', /\.(e2e|e2e-test)\./i],
  ['integration', /\.(integration|int|api)\./i],
  ['unit', /\.unit\./i],
];

/**
 * The layer a test file declares through its location (`tests/integration/…`) or name (`x.e2e.spec.ts`).
 * Returns undefined when the path says nothing: the caller then decides from the framework / selected layer.
 * Directories closest to the file win (`e2e/unit-helpers/` is unit only when no nearer hint exists).
 */
export function layerFromPath(relFile: string): TestLayer | undefined {
  const parts = relFile.split('/');
  const name = parts.pop() || '';
  for (const [layer, re] of LAYER_FILE_HINTS) if (re.test(name)) return layer;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const seg = parts[i].toLowerCase();
    for (const [layer, re] of LAYER_DIR_HINTS) if (re.test(seg)) return layer;
  }
  return undefined;
}

/** Last-resort layer for a test whose path and listing context give no hint. */
export function defaultLayerFor(framework: TestFramework): TestLayer {
  return framework === 'playwright' ? 'e2e' : 'unit';
}

export interface Observation {
  test: ListedTest;
  /** Layers whose layer-scoped listing contained this exact test. Empty for an unscoped listing. */
  seenIn: Set<TestLayer>;
}

export interface ClassifiedDiscovery {
  byLayer: Record<TestLayer, number>;
  details: Record<TestLayer, LayerDiscoveryDetail>;
  total: number;
}

/**
 * Assigns every listed test to exactly one layer. Priority:
 *   1. the layer its path/name declares (tests/integration/…),
 *   2. the one layer-scoped listing (TEST_LAYER=<layer>) that contained it,
 *   3. the framework default (Playwright → e2e, Vitest/Jest → unit) — also when several scoped listings contained it
 *      (the repository ignores the scope, so it tells nothing).
 * Nothing is classified by guessing "everything is E2E".
 */
export function classifyObservations(
  observations: Observation[],
  runnable: (layer: TestLayer) => boolean
): ClassifiedDiscovery {
  const buckets: Record<TestLayer, { count: number; frameworks: Set<TestFramework>; files: Set<string>; estimated: boolean }> = {
    unit: { count: 0, frameworks: new Set(), files: new Set(), estimated: false },
    integration: { count: 0, frameworks: new Set(), files: new Set(), estimated: false },
    e2e: { count: 0, frameworks: new Set(), files: new Set(), estimated: false },
  };
  for (const o of observations) {
    const hinted = layerFromPath(o.test.file);
    const layer = hinted ?? (o.seenIn.size === 1 ? Array.from(o.seenIn)[0] : defaultLayerFor(o.test.framework));
    const b = buckets[layer];
    b.count += 1;
    b.frameworks.add(o.test.framework);
    b.files.add(o.test.file);
    if (o.test.estimated) b.estimated = true;
  }
  const details = {} as Record<TestLayer, LayerDiscoveryDetail>;
  const byLayer = {} as Record<TestLayer, number>;
  let total = 0;
  for (const l of DISCOVERY_LAYERS) {
    const b = buckets[l];
    byLayer[l] = b.count;
    total += b.count;
    details[l] = {
      count: b.count,
      method: b.estimated ? 'estimate' : 'list',
      frameworks: Array.from(b.frameworks),
      files: b.files.size,
      runnable: b.count > 0 && runnable(l),
    };
  }
  return { byLayer, details, total };
}

/** Key identifying one test case across listings. */
export function testKey(t: ListedTest): string {
  return `${t.framework}|${t.project ?? ''}|${t.file}|${t.title}`;
}
