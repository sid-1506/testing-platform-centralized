import fs from 'fs';
import path from 'path';

// Resolve logs directory at root: apps/notes/src -> ../../../logs
const logDir = path.resolve(__dirname, '../../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}
const logFilePath = path.join(logDir, 'notes.log');

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

export function logNotesEvent(entry: {
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
    service: 'notes-app',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  // Append newline-delimited JSON to logs/notes.log for Grafana Alloy
  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[NOTES LOGGER ERROR]', err.message);
    }
  });

  const reqId = fullEntry.request_id ? `[${fullEntry.request_id}] ` : '';
  const status = fullEntry.status_code ? `status=${fullEntry.status_code} ` : '';
  console.log(`[NOTES-LOG] ${fullEntry.timestamp_ist} ${reqId}${fullEntry.event} ${status}${fullEntry.route || ''}`);
}
