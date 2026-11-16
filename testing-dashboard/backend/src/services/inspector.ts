import fs from 'fs';
import path from 'path';
import {
  DetectedWorkspace,
  InspectionReport,
  PyramidLayerRecommendation,
} from '../types';
import { ResolvedAppEntry } from './registry';

const KNOWN_TEST_PACKAGES = ['vitest', 'jest', 'mocha', 'playwright', '@playwright/test', 'cypress', '@testing-library/react'];

interface PackageJsonShape {
  name?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function walkSourceFiles(dir: string, rootDir: string, maxDepth = 5, depth = 0): string[] {
  if (depth > maxDepth || !fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(full, rootDir, maxDepth, depth + 1));
    } else if (/\.(ts|tsx|js|jsx|html|sh)$/.test(entry.name)) {
      results.push(path.relative(rootDir, full));
    }
  }
  return results;
}

function detectFrameworksFromDeps(deps: Record<string, string>): string[] {
  const found: string[] = [];
  if (deps.express) found.push(`Express (${deps.express})`);
  if (deps.next) found.push(`Next.js (${deps.next})`);
  if (deps.react) found.push(`React (${deps.react})`);
  if (deps.jsonwebtoken) found.push('JWT (jsonwebtoken)');
  if (deps.bcryptjs) found.push('bcryptjs');
  if (deps.typescript) found.push(`TypeScript (${deps.typescript})`);
  return found;
}

export function inspectApplication(app: ResolvedAppEntry): InspectionReport {
  const rootDir = app.resolvedSourcePath;
  const rootPkg = readJsonIfExists<PackageJsonShape>(path.join(rootDir, 'package.json'));
  const hasLock = fs.existsSync(path.join(rootDir, 'package-lock.json'));

  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const databases = new Set<string>();
  const testFrameworksInstalled = new Set<string>();
  const testScriptsFound: string[] = [];
  const workspaces: DetectedWorkspace[] = [];

  if (rootPkg) {
    const rootDeps = { ...(rootPkg.dependencies || {}), ...(rootPkg.devDependencies || {}) };
    if (rootDeps.typescript || fs.existsSync(path.join(rootDir, 'tsconfig.base.json'))) {
      languages.add('TypeScript');
    }
    for (const fw of detectFrameworksFromDeps(rootDeps)) frameworks.add(fw);
    for (const tp of KNOWN_TEST_PACKAGES) {
      if (rootDeps[tp]) testFrameworksInstalled.add(tp);
    }
    for (const [k, v] of Object.entries(rootPkg.scripts || {})) {
      if (k.includes('test') || k.includes('typecheck')) {
        testScriptsFound.push(`${k}: ${v}`);
      }
    }

    for (const wsRel of rootPkg.workspaces || []) {
      const wsDir = path.join(rootDir, wsRel);
      const wsPkg = readJsonIfExists<PackageJsonShape>(path.join(wsDir, 'package.json'));
      if (!wsPkg) continue;

      const wsDeps = { ...(wsPkg.dependencies || {}), ...(wsPkg.devDependencies || {}) };
      const wsFrameworks = detectFrameworksFromDeps(wsDeps);
      for (const fw of wsFrameworks) frameworks.add(fw);
      for (const tp of KNOWN_TEST_PACKAGES) {
        if (wsDeps[tp]) testFrameworksInstalled.add(tp);
      }

      const hasDb = Boolean(wsDeps['better-sqlite3']);
      if (hasDb) databases.add('SQLite (better-sqlite3)');

      const wsFiles = walkSourceFiles(path.join(wsDir, 'src'), rootDir, 4);
      const entryPoints = wsFiles.filter(
        (f) => f.endsWith('server.ts') || f.endsWith('/page.tsx') || f.endsWith('/route.ts')
      );

      workspaces.push({
        name: wsPkg.name || wsRel,
        path: wsRel,
        frameworks: wsFrameworks,
        hasDatabase: hasDb,
        entryPoints,
        scripts: Object.keys(wsPkg.scripts || {}),
      });
    }
  }

  const allFiles = walkSourceFiles(path.join(rootDir, 'apps'), rootDir, 6);
  const scriptFiles = walkSourceFiles(path.join(rootDir, 'scripts'), rootDir, 2);
  for (const sf of scriptFiles) {
    if (sf.includes('test')) testScriptsFound.push(sf);
  }

  const pureModules = allFiles.filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.endsWith('server.ts') &&
      !f.endsWith('logger.ts') &&
      !f.endsWith('db.ts') &&
      !f.endsWith('.d.ts') &&
      !f.includes('/app/')
  );

  const apiServersAndRoutes = allFiles.filter(
    (f) => f.endsWith('server.ts') || f.endsWith('/route.ts')
  );

  const frontendPagesAndComponents = allFiles.filter(
    (f) => f.endsWith('/page.tsx') || f.includes('/components/') || f.endsWith('.html')
  );

  const recommendations: PyramidLayerRecommendation[] = [];

  if (pureModules.length > 0) {
    recommendations.push({
      layer: 'unit',
      priority: 'high',
      rationale:
        'Detected standalone TypeScript helper modules (security validation, JWT helpers, and round-robin load balancer logic) that can be tested fast in isolation without starting servers.',
      evidence: pureModules.slice(0, 8),
      suggestedTargets: [
        'Validate redirect_uri allowlist & CORS helper rules in apps/auth/src/security.ts',
        'Verify Round-Robin selection and unhealthy instance skipping in apps/gateway/src/loadbalancer.ts',
      ],
    });
  }

  if (apiServersAndRoutes.length > 0) {
    recommendations.push({
      layer: 'integration',
      priority: 'high',
      rationale: `Detected ${apiServersAndRoutes.length} HTTP server/API route files across ${workspaces.length} workspaces with isolated SQLite databases and gateway proxying. Integration/API tests should carry strong coverage across service boundaries.`,
      evidence: apiServersAndRoutes.slice(0, 10),
      suggestedTargets: [
        'Verify service /health endpoints across Auth, Web, Notes, Hybrid, Gateway, and Product replicas',
        'Verify JWT HttpOnly cookie issuance, 401 enforcement, and cross-user isolation on Notes & Tasks APIs',
        'Verify API Gateway Round-Robin distribution across product-1, product-2, and product-3',
      ],
    });
  }

  if (frontendPagesAndComponents.length > 0) {
    recommendations.push({
      layer: 'e2e',
      priority: 'focused',
      rationale: `Detected ${frontendPagesAndComponents.length} frontend pages, React components, and HTML UIs participating in cross-app SSO redirects. Focused browser E2E tests should verify critical user journeys.`,
      evidence: frontendPagesAndComponents.slice(0, 8),
      suggestedTargets: [
        'Verify unauthenticated redirect from Web (:3000) to Auth (:3001/login) and post-login SSO return',
        'Verify authenticated navigation across Notes (:3003) and Hybrid Task Manager (:3004)',
      ],
    });
  }

  return {
    appId: app.id,
    inspectedAt: new Date().toISOString(),
    rootName: rootPkg?.name || path.basename(rootDir),
    packageManager: hasLock ? 'npm (workspaces)' : 'npm',
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    databases: Array.from(databases),
    workspaces,
    existingTestingSetup: {
      frameworksInstalled: Array.from(testFrameworksInstalled),
      scriptsFound: testScriptsFound,
      notes:
        testFrameworksInstalled.size === 0
          ? 'No unit, integration, or E2E testing framework (Vitest/Jest/Playwright) is installed in the target application. External test suites are recommended.'
          : `Detected installed testing tools: ${Array.from(testFrameworksInstalled).join(', ')}`,
    },
    surfaces: {
      pureModules,
      apiServersAndRoutes,
      frontendPagesAndComponents,
    },
    recommendations,
  };
}
