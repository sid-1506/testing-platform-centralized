const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const tsxBin = path.join(rootDir, 'node_modules', '.bin', 'tsx');

const services = [
  {
    name: 'auth-service',
    cmd: tsxBin,
    args: ['apps/auth/src/server.ts'],
    env: { ...process.env, PORT: '3001' },
  },
  {
    name: 'product-1',
    cmd: tsxBin,
    args: ['apps/services/product-service/src/server.ts'],
    env: { ...process.env, PORT: '6001', INSTANCE_ID: 'product-1' },
  },
  {
    name: 'product-2',
    cmd: tsxBin,
    args: ['apps/services/product-service/src/server.ts'],
    env: { ...process.env, PORT: '6002', INSTANCE_ID: 'product-2' },
  },
  {
    name: 'product-3',
    cmd: tsxBin,
    args: ['apps/services/product-service/src/server.ts'],
    env: { ...process.env, PORT: '6003', INSTANCE_ID: 'product-3' },
  },
  {
    name: 'api-gateway',
    cmd: tsxBin,
    args: ['apps/gateway/src/server.ts'],
    env: { ...process.env, PORT: '5001' },
  },
  {
    name: 'web-app',
    cmd: 'npm',
    args: ['run', 'dev', '-w', '@arch/web'],
    env: { ...process.env, PORT: '3000' },
  },
  {
    name: 'notes-app',
    cmd: tsxBin,
    args: ['apps/notes/src/server.ts'],
    env: { ...process.env, PORT: '3003' },
  },
  {
    name: 'hybrid-backend',
    cmd: tsxBin,
    args: ['apps/hybrid/backend/src/server.ts'],
    env: { ...process.env, PORT: '3005' },
  },
  {
    name: 'hybrid-frontend',
    cmd: 'npm',
    args: ['run', 'dev', '-w', '@arch/hybrid-frontend'],
    env: { ...process.env, PORT: '3004' },
  },
];

const children = [];

for (const s of services) {
  const child = spawn(s.cmd, s.args, {
    cwd: rootDir,
    env: s.env,
    stdio: 'inherit',
  });
  children.push(child);
  console.log(`[RUNNER] Started ${s.name} (PID: ${child.pid})`);
}

function shutdown() {
  console.log('\n[RUNNER] Shutting down all services...');
  for (const c of children) {
    c.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
