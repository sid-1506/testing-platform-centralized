import fs from 'fs';
import path from 'path';

// Resolve logs directory at root: apps/gateway/src -> ../../../logs
const logDir = path.resolve(__dirname, '../../../logs');
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}
const logFilePath = path.join(logDir, 'gateway.log');

export interface LogEntry {
  service: string;
  event: string;
  timestamp: string;
  timestamp_ist: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  instance_id?: string;
  method?: string;
  route?: string;
  [key: string]: any;
}

export function getISTTimestamp(date = new Date()): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  return istDate.toISOString().replace('Z', '+05:30');
}

export function logGatewayEvent(entry: {
  event: string;
  request_id?: string;
  status_code?: number;
  duration_ms?: number;
  instance_id?: string;
  method?: string;
  route?: string;
  [key: string]: any;
}): void {
  const now = new Date();
  const fullEntry: LogEntry = {
    service: 'api-gateway',
    timestamp: now.toISOString(),
    timestamp_ist: getISTTimestamp(now),
    ...entry,
  };

  // 1. Asynchronously append newline-delimited JSON to logs/gateway.log
  fs.appendFile(logFilePath, JSON.stringify(fullEntry) + '\n', (err) => {
    if (err) {
      console.error('[GATEWAY LOGGER ERROR]', err.message);
    }
  });
}
