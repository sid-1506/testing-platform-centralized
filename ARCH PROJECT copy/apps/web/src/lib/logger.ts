import fs from 'fs';
import path from 'path';

// Find root logs directory robustly
function getLogsDir(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.resolve(cwd, 'logs'))) {
    return path.resolve(cwd, 'logs');
  }
  const parentLogs = path.resolve(cwd, '../../logs');
  if (fs.existsSync(parentLogs)) {
    return parentLogs;
  }
  const target = path.resolve(cwd, 'logs');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {}
  return target;
}

const logFilePath = path.join(getLogsDir(), 'web.log');

export interface LogEntry {
  service: string;
  event: string;
  timestamp: string;
  timestamp_ist: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  route?: string;
  method?: string;
  [key: string]: any;
}

export function getISTTimestamp(date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  return istDate.toISOString().replace('Z', '+05:30');
}

export function maskEmail(email?: string): string {
  if (!email || !email.includes('@')) return 'unknown';
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `${user[0]}***@${domain}`;
  return `${user[0]}***${user[user.length - 1]}@${domain}`;
}

export function logWebEvent(entry: {
  event: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  route?: string;
  method?: string;
  [key: string]: any;
}): void {
  const now = new Date();
  const fullEntry: LogEntry = {
    service: 'web-app',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  // 1. Asynchronously append newline-delimited JSON to logs/web.log
  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[WEB LOGGER ERROR]', err.message);
    }
  });

  // 2. Terminal logging
  const reqId = fullEntry.request_id ? `[${fullEntry.request_id}] ` : '';
  const status = fullEntry.status_code ? `status=${fullEntry.status_code} ` : '';
  console.log(`[WEB-LOG] ${fullEntry.timestamp_ist} ${reqId}${fullEntry.event} ${status}${fullEntry.route || ''}`);
}
