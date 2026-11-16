import fs from 'fs';
import path from 'path';

/** Throws unless `target` resolves to `base` or a path strictly inside it. */
export function assertInside(base: string, target: string): string {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return resolvedTarget;
}

/**
 * Resolves `relative` inside `base` and returns the real file path only if it is
 * a regular file, contains no symlink component, and stays inside `base`.
 */
export function resolveRegularFileInside(base: string, relative: string): string | null {
  if (relative.includes('\0')) return null;
  let candidate: string;
  try {
    candidate = assertInside(base, path.join(base, relative));
  } catch {
    return null;
  }
  try {
    const realBase = fs.realpathSync(base);
    // Walk every component: refuse symlinks anywhere on the path.
    const rel = path.relative(path.resolve(base), candidate);
    let cursor = path.resolve(base);
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(candidate);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Recursively copies a directory, skipping symlinks entirely (artifacts come from untrusted code). */
export function copyDirNoSymlinks(src: string, dest: string, skip: (name: string, depth: number) => boolean = () => false, depth = 0): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (skip(entry.name, depth)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirNoSymlinks(from, to, skip, depth + 1);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

export interface FileListing {
  path: string;
  size: number;
}

export function listFilesRecursive(base: string, prefix = '', limit = 5000): FileListing[] {
  const out: FileListing[] = [];
  const walk = (dir: string, rel: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ path: prefix ? `${prefix}/${r}` : r, size: fs.statSync(abs).size });
      if (out.length >= limit) return;
    }
  };
  if (fs.existsSync(base)) walk(base, '');
  return out;
}
