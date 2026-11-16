import { LogStream, RunEvent, RunEventType } from '../types';

type Listener = (event: RunEvent) => void;

interface Channel {
  events: RunEvent[];
  nextId: number;
  listeners: Set<Listener>;
  finished: boolean;
  cleanupTimer?: NodeJS.Timeout;
}

const MAX_EVENTS_PER_RUN = 100_000;
const RETAIN_AFTER_FINISH_MS = 15 * 60 * 1000;

const TERMINAL_EVENTS: ReadonlySet<RunEventType> = new Set(['run_completed', 'run_failed', 'run_cancelled']);
const channels = new Map<string, Channel>();

export function isTerminalEvent(type: RunEventType): boolean {
  return TERMINAL_EVENTS.has(type);
}

function channelFor(runId: string): Channel {
  let ch = channels.get(runId);
  if (!ch) {
    ch = { events: [], nextId: 1, listeners: new Set(), finished: false };
    channels.set(runId, ch);
  }
  return ch;
}

export type RunEventPayload = Partial<Omit<RunEvent, 'id' | 'runId' | 'type' | 'timestamp'>>;

/** Records an event for a run and fans it out to live SSE subscribers. */
export function emitRunEvent(runId: string, type: RunEventType, payload: RunEventPayload = {}): RunEvent {
  const ch = channelFor(runId);
  const event: RunEvent = {
    id: ch.nextId++,
    runId,
    type,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  if (ch.events.length < MAX_EVENTS_PER_RUN) ch.events.push(event);
  for (const listener of Array.from(ch.listeners)) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never affect the run.
    }
  }
  if (isTerminalEvent(type)) {
    ch.finished = true;
    if (ch.cleanupTimer) clearTimeout(ch.cleanupTimer);
    ch.cleanupTimer = setTimeout(() => channels.delete(runId), RETAIN_AFTER_FINISH_MS);
    ch.cleanupTimer.unref();
  }
  return event;
}

export function emitOutput(runId: string, stream: LogStream, text: string): void {
  emitRunEvent(runId, 'test_output', { stream, text });
}

export function hasChannel(runId: string): boolean {
  return channels.has(runId);
}

/**
 * Subscribes to a run. Buffered events with id > sinceId are replayed first so
 * a (re)connecting client never misses output. Returns an unsubscribe function.
 */
export function subscribeToRun(
  runId: string,
  sinceId: number,
  listener: Listener
): { unsubscribe: () => void; finished: boolean } {
  const ch = channelFor(runId);
  for (const event of ch.events) {
    if (event.id > sinceId) listener(event);
  }
  if (ch.finished) {
    return { unsubscribe: () => undefined, finished: true };
  }
  ch.listeners.add(listener);
  return { unsubscribe: () => ch.listeners.delete(listener), finished: false };
}
