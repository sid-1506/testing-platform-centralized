import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  RUN_TMP_MARKER,
  createRunTmpDir,
  maxBaseLength,
  pickTmpBase,
  probeSocketSupport,
  removeRunTmpDir,
  socketPathLimit,
  sweepStaleRunTmpDirs,
} from '../src/services/runTmp';
import { buildSandboxEnv } from '../src/services/sandboxEnv';

const posix = process.platform !== 'win32';
const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

/** A workspace path as deep as the platform's real one (`.platform/workspaces/run_x/repo`), deliberately > any sun_path. */
function makeDeepWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
  cleanup.push(root);
  const deep = path.join(root, 'testing-dashboard', '.platform', 'workspaces', 'run_1794811287403_g147', 'tmp-area', 'repo');
  fs.mkdirSync(deep, { recursive: true });
  assert.ok(deep.length + '/tsx-501/90053.pipe'.length > 140, 'fixture must exceed every sun_path limit');
  return deep;
}

function runTsx(script: string, cwd: string, tmp: string) {
  const tsxCli = require.resolve('tsx/cli');
  return spawnSync(process.execPath, [tsxCli, script], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), TMPDIR: tmp, TMP: tmp, TEMP: tmp },
  });
}

describe('tsx IPC pipe with a deeply nested workspace (EINVAL regression)', { skip: !posix && 'Unix sockets only' }, () => {
  it('reproduces the failure when TMPDIR lives inside the deep workspace (control)', () => {
    const ws = makeDeepWorkspace();
    const tmp = path.join(ws, 'tmp');
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(ws, 'hello.ts'), 'console.log("tsx-started");\n');
    const r = runTsx('hello.ts', ws, tmp);
    assert.notEqual(r.status, 0, 'tsx must fail with a socket path this long');
    assert.match(`${r.stdout}${r.stderr}`, /EINVAL|ENAMETOOLONG/);
  });

  it('starts tsx from the same deep workspace when the platform short TMPDIR is used', () => {
    const ws = makeDeepWorkspace();
    fs.writeFileSync(path.join(ws, 'hello.ts'), 'const n: number = 42;\nconsole.log("tsx-started", n);\n');
    const info = createRunTmpDir('run_regression');
    try {
      assert.ok(info.dir.length + '/tsx-4294967295/4194304.pipe'.length <= socketPathLimit(), 'headroom for the tsx pipe');
      const env = buildSandboxEnv({ tmpDir: info.dir });
      assert.equal(env.TMPDIR, info.dir);
      assert.equal(env.TMP, info.dir);
      assert.equal(env.TEMP, info.dir);
      const r = runTsx('hello.ts', ws, env.TMPDIR);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /tsx-started 42/);
      assert.doesNotMatch(r.stderr, /EINVAL/);
    } finally {
      assert.equal(removeRunTmpDir(info.dir).removed, true);
    }
  });

  it('probeSocketSupport detects an unusable (too long) directory and accepts the run directory', async () => {
    const ws = makeDeepWorkspace();
    const bad = await probeSocketSupport(ws);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /EINVAL|ENAMETOOLONG/);
    const info = createRunTmpDir('run_probe');
    try {
      assert.deepEqual(await probeSocketSupport(info.dir), { ok: true });
    } finally {
      removeRunTmpDir(info.dir);
    }
  });
});

describe('run temp directory selection', () => {
  it('skips a base that is too long for sockets and falls back to a short one', { skip: !posix }, () => {
    const deep = makeDeepWorkspace();
    assert.ok(deep.length > maxBaseLength());
    const base = pickTmpBase({ ...process.env, PLATFORM_TMP_BASE: deep });
    assert.ok(base.length <= maxBaseLength());
    assert.notEqual(base, fs.realpathSync(deep));
  });

  it('creates a private, marked directory and reports socket headroom', () => {
    const info = createRunTmpDir('run_x');
    try {
      assert.ok(fs.statSync(info.dir).isDirectory());
      if (posix) assert.equal(fs.statSync(info.dir).mode & 0o777, 0o700);
      assert.ok(fs.existsSync(path.join(info.dir, RUN_TMP_MARKER)));
      assert.ok(info.socketHeadroom >= 40);
    } finally {
      removeRunTmpDir(info.dir);
    }
  });
});

describe('run temp directory cleanup is safe', () => {
  it('removes a platform-created directory completely', () => {
    const info = createRunTmpDir('run_clean');
    fs.mkdirSync(path.join(info.dir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(info.dir, 'nested', 'deeper', 'f.txt'), 'x');
    assert.deepEqual(removeRunTmpDir(info.dir), { removed: true });
    assert.equal(fs.existsSync(info.dir), false);
  });

  it('is a no-op for a directory that is already gone', () => {
    assert.deepEqual(removeRunTmpDir(path.join(os.tmpdir(), 'tp-does-not-exist')), { removed: true });
  });

  it('refuses directories that are not platform run directories (no marker / wrong prefix)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-unrelated-'));
    cleanup.push(base);
    fs.writeFileSync(path.join(base, 'precious.txt'), 'keep');
    const res = removeRunTmpDir(base);
    assert.equal(res.removed, false);
    assert.ok(fs.existsSync(path.join(base, 'precious.txt')));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    cleanup.push(other);
    fs.writeFileSync(path.join(other, RUN_TMP_MARKER), '{}');
    assert.equal(removeRunTmpDir(other).removed, false);
  });

  it('refuses to follow a symlink to a real directory', { skip: !posix }, () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-target-'));
    cleanup.push(target);
    fs.writeFileSync(path.join(target, RUN_TMP_MARKER), '{}');
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep');
    const link = path.join(os.tmpdir(), `tp-link-${process.pid}`);
    fs.symlinkSync(target, link);
    cleanup.push(link);
    assert.equal(removeRunTmpDir(link).removed, false);
    assert.ok(fs.existsSync(path.join(target, 'precious.txt')));
  });

  it('sweeps directories orphaned by a dead backend but keeps those of a live one', { skip: !posix }, () => {
    const dead = createRunTmpDir('run_dead');
    const live = createRunTmpDir('run_live');
    const mine = createRunTmpDir('run_mine');
    try {
      // pid 2^22+1 is above any real pid on macOS/Linux defaults -> not alive.
      fs.writeFileSync(path.join(dead.dir, RUN_TMP_MARKER), JSON.stringify({ runId: 'run_dead', pid: 4194999 }));
      fs.writeFileSync(path.join(live.dir, RUN_TMP_MARKER), JSON.stringify({ runId: 'run_live', pid: process.ppid }));
      const removed = sweepStaleRunTmpDirs();
      assert.ok(removed >= 1);
      assert.equal(fs.existsSync(dead.dir), false, 'orphan removed');
      assert.equal(fs.existsSync(live.dir), true, 'another live backend keeps its dir');
      assert.equal(fs.existsSync(mine.dir), true, 'our own dir is never swept');
    } finally {
      for (const d of [dead, live, mine]) removeRunTmpDir(d.dir);
    }
  });
});
