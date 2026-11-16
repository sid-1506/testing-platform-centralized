import fs from 'fs';
import path from 'path';

// Resolve logs directory at root: apps/services/product-service/src -> ../../../../logs
const logDir = path.resolve(__dirname, '../../../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}
const logFilePath = path.join(logDir, 'product-service.log');

export interface LogEntry {
  service: string;
  event: string;
  instance_id: string;
  timestamp: string;
  timestamp_ist: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  operation?: string;
  method?: string;
  route?: string;
  [key: string]: any;
}

export function getISTTimestamp(date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  return istDate.toISOString().replace('Z', '+05:30');
}

export function logProductEvent(entry: {
  event: string;
  instance_id: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  operation?: string;
  method?: string;
  route?: string;
  [key: string]: any;
}): void {
  const now = new Date();
  const fullEntry: LogEntry = {
    service: 'product-service',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  // 1. Asynchronously append newline-delimited JSON to logs/product-service.log
  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[PRODUCT LOGGER ERROR]', err.message);
    }
  });
}
