import fs from 'fs';
import path from 'path';

// apps/hybrid/backend/src -> ../../../../logs
const logDir = path.resolve(__dirname, '../../../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
}
const logFilePath = path.join(logDir, 'hybrid.log');

export interface LogEntry {
  service: string;
  event: string;
  timestamp: string;
  timestamp_ist: string;
  request_id?: string;
  user_id?: number;
  route?: string;
  method?: string;
  status_code?: number;
  duration_ms?: number;
  [key: string]: any;
}

export function getISTTimestamp(date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  return istDate.toISOString().replace('Z', '+05:30');
}

export function logHybridBackendEvent(entry: {
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
  const fullEntry: LogEntry = {
    service: 'hybrid-backend',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[HYBRID BACKEND LOGGER ERROR]', err.message);
    }
  });

  const reqId = fullEntry.request_id ? `[${fullEntry.request_id}] ` : '';
  const status = fullEntry.status_code ? `status=${fullEntry.status_code} ` : '';
  console.log(`[HYBRID-API] ${fullEntry.timestamp_ist} ${reqId}${fullEntry.event} ${status}${fullEntry.route || ''}`);
}
