import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { RepoDetection, RepoSettings, TestCommandKind, TestFramework, TestLayer } from '../types';

const MAX_TEXT_BYTES = 1024 * 1024;
const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.mts',
  'playwright.config.cts',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'playwright-report', 'test-results', 'blob-report']);
const TEST_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;
// test('title', ...) / it('title', ...) incl. .only/.skip/.fixme/.fail/.slow/.todo — a string title follows.
// STATIC ESTIMATE only: `it.each([...])('title')` counts once and generated tests are invisible.
export const TEST_DECL_RE = /(?:^|[^.\w$])(?:test|it)(?:\.(?:only|skip|fixme|fail|slow|todo|concurrent))?\s*\(\s*(?:'|"|`)/g;

function readText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function findTestFiles(root: string, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile() && TEST_FILE_RE.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function deriveBrowsers(configText: string): string[] {
  const found = new Set<string>();
  for (const m of configText.matchAll(/devices\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) {
    const d = m[1].toLowerCase();
    if (d.includes('firefox')) found.add('firefox');
    else if (d.includes('safari') || d.includes('iphone') || d.includes('ipad')) found.add('webkit');
    else found.add('chromium');
  }
  for (const m of configText.matchAll(/browserName\s*:\s*['"](chromium|firefox|webkit)['"]/g)) found.add(m[1]);
  return found.size > 0 ? Array.from(found) : ['chromium'];
}

function deriveReporters(configText: string): string[] {
  const names = new Set<string>();
  const known = ['list', 'line', 'dot', 'html', 'json', 'junit', 'github', 'blob', 'null'];
  const start = configText.search(/\breporter\s*:/);
  if (start < 0) return [];
  let i = configText.indexOf(':', start) + 1;
  while (/\s/.test(configText[i] || '')) i += 1;
  let body = '';
  if (configText[i] === '[') {
    // Match the closing bracket of the (possibly nested) reporter array.
    let depth = 0;
    let j = i;
    for (; j < configText.length; j += 1) {
      const ch = configText[j];
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    body = configText.slice(i, j + 1);
    // Reporter names are the first string literal of each entry: 'list' or ['html', {...}].
    for (const m of body.matchAll(/(?:^\[|\[|,)\s*\[?\s*['"]([a-z]+)['"]/g)) {
      if (known.includes(m[1])) names.add(m[1]);
    }
  } else {
    const m = configText.slice(i).match(/^['"]([a-z]+)['"]/);
    if (m && known.includes(m[1])) names.add(m[1]);
  }
  return Array.from(names);
}

export const HEADED_FLAG_RE = /(^|\s)(--headed|--ui|--debug)(\s|$)|PWDEBUG/;

const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts', 'vitest.config.cts', 'vitest.workspace.ts', 'vitest.workspace.js'];
const JEST_CONFIG_NAMES = ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json'];
const LAYERS: TestLayer[] = ['unit', 'integration', 'e2e'];

/** What a package.json script runs. Only a single, plain framework invocation may get reporter flags appended by the platform. */
export function classifyScript(text: string): TestCommandKind {
  const t = text.trim();
  const chained = /&&|\|\||;|\||`|\$\(/.test(t);
  if (!chained) {
    if (/^(?:npx\s+|pnpm exec\s+)?playwright\s+test\b/.test(t) || /^cross-env\b.*\bplaywright\s+test\b/.test(t)) return 'playwright';
    if (/^(?:npx\s+)?vitest(?:\s+run)?(?:\s|$)/.test(t)) return 'vitest';
    if (/^(?:npx\s+)?jest(?:\s|$)/.test(t)) return 'jest';
  }
  // A wrapper (tsx scripts/run-tests.ts, node run.js, ...) decides itself what to run and which reports to write.
  if (/\b(tsx|ts-node|node|bun|deno)\b/.test(t)) return 'runner';
  return 'unknown';
}

function fileMentions(repoDir: string, rel: string, re: RegExp): boolean {
  const abs = path.resolve(repoDir, rel);
  if (abs !== path.resolve(repoDir) && !abs.startsWith(path.resolve(repoDir) + path.sep)) return false;
  const text = readText(abs);
  return !!text && re.test(text);
}

/** True when the repository can run a single layer: `test:<layer>` scripts, or a runner file that reads TEST_LAYER. */
function detectLayerSelection(repoDir: string, scripts: Record<string, string>): boolean {
  if (LAYERS.some((l) => scripts[`test:${l}`])) return true;
  const referenced = new Set<string>();
  for (const text of Object.values(scripts)) {
    for (const m of text.matchAll(/(?:^|\s)((?:\.\/)?[\w./-]+\.(?:[cm]?[jt]s))(?:\s|$)/g)) referenced.add(m[1].replace(/^\.\//, ''));
  }
  for (const f of ['scripts/run-tests.ts', 'scripts/run-tests.js', 'scripts/run-tests.mjs']) referenced.add(f);
  return Array.from(referenced).some((f) => fileMentions(repoDir, f, /\bTEST_LAYER\b/));
}

function detectLayers(repoDir: string, frameworks: TestFramework[]): TestLayer[] {
  const found = LAYERS.filter((l) => ['tests', 'test', '__tests__', 'e2e', 'spec'].some((root) => {
    try {
      return fs.statSync(path.join(repoDir, root, l)).isDirectory() || (root === 'e2e' && l === 'e2e');
    } catch {
      return false;
    }
  }));
  if (found.length > 0) return found;
  if (frameworks.length === 1 && frameworks[0] === 'playwright') return ['e2e'];
  return frameworks.length > 0 ? ['unit'] : [];
}

/** Static, side-effect-free inspection of a checked-out repository. Never executes repository code. */
export function detectRepository(repoDir: string, settings?: RepoSettings): RepoDetection {
  const problems: string[] = [];
  const warnings: string[] = [];
  const detection: RepoDetection = {
    detectedAt: new Date().toISOString(),
    framework: null,
    frameworks: [],
    supported: false,
    problems,
    warnings,
    packageManager: 'none',
    testFileCount: 0,
    staticDeclarationCount: 0,
    scripts: {},
    reporters: [],
    browsers: ['chromium'],
    forcesHeaded: false,
  };

  const pkgText = readText(path.join(repoDir, 'package.json'));
  if (!pkgText) {
    problems.push('No package.json found at the repository root. Only Node.js/TypeScript test repositories (Playwright, Vitest, Jest) are supported.');
    return detection;
  }
  let pkg: {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    packageManager?: string;
    workspaces?: unknown;
  };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    problems.push('package.json is not valid JSON.');
    return detection;
  }
  detection.packageName = pkg.name;
  detection.scripts = Object.fromEntries(
    Object.entries(pkg.scripts || {}).filter(([, v]) => typeof v === 'string')
  ) as Record<string, string>;

  // --- package manager / lockfile -----------------------------------------
  const has = (f: string) => fs.existsSync(path.join(repoDir, f));
  if (has('package-lock.json')) {
    detection.packageManager = 'npm';
    detection.lockfile = 'package-lock.json';
  } else if (has('npm-shrinkwrap.json')) {
    detection.packageManager = 'npm';
    detection.lockfile = 'npm-shrinkwrap.json';
  } else if (has('yarn.lock') || has('pnpm-lock.yaml') || has('bun.lockb') || has('bun.lock')) {
    detection.packageManager = 'unsupported';
    problems.push('Repository uses yarn/pnpm/bun (lockfile found). Only npm-based projects are supported in this version.');
  } else if (/^(yarn|pnpm|bun)@/.test(pkg.packageManager || '')) {
    detection.packageManager = 'unsupported';
    problems.push(`Repository declares packageManager "${pkg.packageManager}". Only npm is supported in this version.`);
  } else {
    detection.packageManager = 'npm';
    warnings.push('No package-lock.json found: dependencies will be installed with `npm install` (not reproducible).');
  }
  if (pkg.workspaces) warnings.push('npm workspaces are not specially handled; tests run from the repository root.');

  // --- frameworks / versions -------------------------------------------------
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies };
  const frameworks: TestFramework[] = [];
  let lock: { packages?: Record<string, { version?: string }> } | null = null;
  if (detection.lockfile) {
    const lockText = readText(path.join(repoDir, detection.lockfile));
    if (lockText) {
      try {
        lock = JSON.parse(lockText);
      } catch {
        warnings.push(`${detection.lockfile} could not be parsed.`);
      }
    }
  }
  const lockedVersion = (name: string, declared?: string) => lock?.packages?.[`node_modules/${name}`]?.version || declared;
  detection.playwrightDependency = deps['@playwright/test'];
  if (deps['@playwright/test']) {
    frameworks.push('playwright');
    detection.playwrightVersion = lockedVersion('@playwright/test', deps['@playwright/test']);
  }
  if (deps.vitest) {
    frameworks.push('vitest');
    detection.vitestVersion = lockedVersion('vitest', deps.vitest);
  }
  if (deps.jest) {
    frameworks.push('jest');
    detection.jestVersion = lockedVersion('jest', deps.jest);
  }
  detection.frameworks = frameworks;
  detection.framework = frameworks[0] ?? null;
  if (frameworks.length === 0) {
    problems.push(
      'No supported test framework was detected: none of `@playwright/test`, `vitest` or `jest` is listed in dependencies/devDependencies.'
    );
  }

  // --- playwright config (only when Playwright is used) -----------------------------------
  const usesPlaywright = frameworks.includes('playwright');
  const configName = usesPlaywright ? CONFIG_NAMES.find((n) => has(n)) : undefined;
  let configText = '';
  if (configName) {
    detection.configFile = configName;
    configText = readText(path.join(repoDir, configName)) || '';
    detection.reporters = deriveReporters(configText);
    detection.browsers = deriveBrowsers(configText);
    if (/headless\s*:\s*false/.test(configText)) {
      detection.forcesHeaded = true;
      problems.push('playwright.config forces headed mode (`headless: false`). This platform only executes external suites headlessly.');
    }
  } else if (usesPlaywright) {
    warnings.push('No playwright.config.* found; Playwright defaults will be used.');
  } else {
    detection.configFile = [...VITEST_CONFIG_NAMES, ...JEST_CONFIG_NAMES].find((n) => has(n));
    detection.browsers = [];
  }

  // --- test directory + static declaration estimate -------------------------------------------
  const testDirMatch = configText.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
  const testDir = testDirMatch ? testDirMatch[1].replace(/^\.\//, '') : '.';
  detection.testDir = testDir;
  // Playwright's testDir only covers E2E files; when Vitest/Jest are present the estimate scans the whole repository.
  const scanDir = frameworks.some((f) => f !== 'playwright') || !usesPlaywright ? '.' : testDir;
  const testRoot = path.resolve(repoDir, scanDir);
  if (testRoot === path.resolve(repoDir) || testRoot.startsWith(path.resolve(repoDir) + path.sep)) {
    const files = findTestFiles(testRoot);
    detection.testFileCount = files.length;
    let count = 0;
    for (const f of files) {
      const text = readText(f);
      if (text) count += (text.match(TEST_DECL_RE) || []).length;
    }
    detection.staticDeclarationCount = count;
    if (frameworks.length > 0 && files.length === 0) {
      warnings.push(`No *.spec/*.test files found under "${testDir}".`);
    }
  }
  detection.layers = detectLayers(repoDir, frameworks);
  detection.supportsLayerSelection = detectLayerSelection(repoDir, detection.scripts);

  // --- test command -------------------------------------------------------------------------------
  const scripts = detection.scripts;
  const override = settings?.testScript;
  const layer = settings?.layer && settings.layer !== 'all' ? settings.layer : undefined;
  let chosen: string | undefined;
  if (override) {
    if (scripts[override]) chosen = override;
    else problems.push(`Configured test script "${override}" does not exist in package.json.`);
  } else {
    const preferred = ['test', 'test:all', 'test:e2e', 'e2e', 'test:playwright', 'playwright'];
    const mentionsFramework = (n: string) => /playwright|vitest|jest|run-tests/.test(scripts[n]);
    chosen =
      (layer && scripts[`test:${layer}`] ? `test:${layer}` : undefined) ||
      preferred.find((n) => scripts[n] && mentionsFramework(n)) ||
      Object.keys(scripts).find(
        (n) => /^test(:|$)/.test(n) && mentionsFramework(n) && !HEADED_FLAG_RE.test(scripts[n]) && !/show-report|install|watch|coverage|typecheck/.test(n)
      ) ||
      (scripts.test ? 'test' : undefined);
  }
  if (chosen) {
    const forcesHeaded = usesPlaywright && HEADED_FLAG_RE.test(scripts[chosen]);
    detection.testCommand = {
      script: chosen,
      display: chosen === 'test' ? 'npm test' : `npm run ${chosen}`,
      forcesHeaded,
      kind: classifyScript(scripts[chosen]),
    };
    if (forcesHeaded) {
      problems.push(`Test script "${chosen}" uses --headed/--ui/--debug. This platform only executes external suites headlessly.`);
    }
    if (/\bcypress\b|\bmocha\b|\bpytest\b/.test(scripts[chosen]) && frameworks.length === 0) {
      problems.push('The test script uses a framework that is not supported yet (Cypress, Mocha, pytest, ...).');
    }
  } else if (frameworks.length > 0 && !override) {
    const fw = frameworks[0];
    detection.testCommand = {
      script: '',
      display: fw === 'playwright' ? 'npx playwright test' : fw === 'vitest' ? 'npx vitest run' : 'npx jest',
      forcesHeaded: false,
      kind: fw,
    };
    warnings.push(`No npm test script found; falling back to the ${fw} CLI.`);
  }

  detection.supported = frameworks.length > 0 && detection.packageManager === 'npm' && problems.length === 0;
  return detection;
}

/** Key identifying a reusable installed-dependencies template (lockfile + manifest + runtime). */
export function dependencyKey(repoDir: string, lockfile?: string, allowInstallScripts = false): string {
  const h = crypto.createHash('sha256');
  h.update(allowInstallScripts ? 'scripts:on|' : 'scripts:off|');
  h.update(fs.readFileSync(path.join(repoDir, 'package.json')));
  if (lockfile && fs.existsSync(path.join(repoDir, lockfile))) h.update(fs.readFileSync(path.join(repoDir, lockfile)));
  h.update(`${process.version}|${process.platform}|${process.arch}`);
  return h.digest('hex').slice(0, 16);
}

/** Resolves config-derived output locations (all relative to the repo root). */
export function detectOutputLocations(configText: string): {
  htmlReportDir: string;
  jsonFile?: string;
  junitFile?: string;
  outputDir: string;
} {
  const pick = (re: RegExp) => configText.match(re)?.[1];
  return {
    htmlReportDir: pick(/\[\s*['"]html['"]\s*,\s*\{[^}]*outputFolder\s*:\s*['"]([^'"]+)['"]/) || 'playwright-report',
    jsonFile: pick(/\[\s*['"]json['"]\s*,\s*\{[^}]*outputFile\s*:\s*['"]([^'"]+)['"]/),
    junitFile: pick(/\[\s*['"]junit['"]\s*,\s*\{[^}]*outputFile\s*:\s*['"]([^'"]+)['"]/),
    outputDir: pick(/outputDir\s*:\s*['"]([^'"]+)['"]/) || 'test-results',
  };
}
