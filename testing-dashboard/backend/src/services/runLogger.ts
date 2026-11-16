import { LogStream } from '../types';
import { appendRunLog } from './runStore';
import { emitOutput } from './eventBus';
import { sanitizeLogText } from './logSanitizer';

export interface RunLogger {
  /** Sanitizes, persists and live-streams a chunk of output. Returns the run.log path. */
  log: (text: string, stream?: LogStream) => string;
}

export function createRunLogger(runId: string, secrets: string[], mirrorToConsole = true): RunLogger {
  return {
    log(text, stream = 'platform') {
      const clean = sanitizeLogText(text, secrets);
      const logPath = appendRunLog(runId, clean, stream);
      emitOutput(runId, stream, clean);
      if (mirrorToConsole) {
        // Keep the backend terminal informative (VS Code terminal), prefixed with the run id.
        const tag = stream === 'stderr' ? 'err' : stream === 'stdout' ? 'out' : 'plt';
        for (const line of clean.replace(/\n$/, '').split('\n')) {
          console.log(`[${runId}:${tag}] ${line}`);
        }
      }
      return logPath;
    },
  };
}
