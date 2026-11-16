import fs from 'fs';
import path from 'path';

// Resolve logs directory at root: apps/auth/src -> ../../../logs
const logDir = path.resolve(__dirname, '../../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}
const logFilePath = path.join(logDir, 'auth.log');

export interface LogEntry {
  service: string;
  event: string;
  timestamp: string;
  timestamp_ist: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
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

export function logAuthEvent(entry: {
  event: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  [key: string]: any;
}): void {
  const now = new Date();
  const fullEntry: LogEntry = {
    service: 'auth-service',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  // 1. Asynchronously append newline-delimited JSON to logs/auth.log
  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[AUTH LOGGER ERROR]', err.message);
    }
  });

  // 2. Terminal logging (formatted for readability)
  const reqId = fullEntry.request_id ? `[${fullEntry.request_id}] ` : '';
  const status = fullEntry.status_code ? `status=${fullEntry.status_code} ` : '';
  console.log(`[AUTH-LOG] ${fullEntry.timestamp_ist} ${reqId}${fullEntry.event} ${status}${fullEntry.email ? `email=${fullEntry.email}` : ''}`);
}
