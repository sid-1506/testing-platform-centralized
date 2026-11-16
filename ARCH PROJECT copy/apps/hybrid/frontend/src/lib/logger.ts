import fs from 'fs';
import path from 'path';

function getLogsDir(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.resolve(cwd, 'logs'))) {
    return path.resolve(cwd, 'logs');
  }
  const repoLogs = path.resolve(cwd, '../../../logs');
  if (fs.existsSync(repoLogs)) {
    return repoLogs;
  }
  const target = path.resolve(cwd, 'logs');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {}
  return target;
}

const logFilePath = path.join(getLogsDir(), 'hybrid.log');

export function getISTTimestamp(date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  return istDate.toISOString().replace('Z', '+05:30');
}

export function logHybridFrontendEvent(entry: {
  event: string;
  request_id?: string;
  user_id?: number;
  route?: string;
  method?: string;
  status_code?: number;
  duration_ms?: number;
  [key: string]: any;
}): void {
  const now = new Date();
  const fullEntry = {
    service: 'hybrid-frontend',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[HYBRID FRONTEND LOGGER ERROR]', err.message);
    }
  });
}
