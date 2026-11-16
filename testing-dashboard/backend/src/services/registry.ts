import fs from 'fs';
import path from 'path';
import { AppRegistryEntry } from '../types';

const DASHBOARD_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_PATH = path.join(DASHBOARD_ROOT, 'apps.registry.json');

export interface ResolvedAppEntry extends AppRegistryEntry {
  resolvedSourcePath: string;
  resolvedSuitePath: string;
}

export function loadRegistry(): ResolvedAppEntry[] {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { apps: AppRegistryEntry[] };
  return parsed.apps.map((app) => ({
    ...app,
    resolvedSourcePath: path.resolve(DASHBOARD_ROOT, app.sourcePath),
    resolvedSuitePath: path.resolve(DASHBOARD_ROOT, app.suitePath),
  }));
}

export function getRegisteredApp(appId: string): ResolvedAppEntry | undefined {
  if (!/^[a-z0-9-]+$/.test(appId)) {
    return undefined;
  }
  return loadRegistry().find((a) => a.id === appId);
}

export function assertPathInside(baseDir: string, targetPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal blocked: ${targetPath} is outside ${baseDir}`);
  }
  return resolvedTarget;
}
