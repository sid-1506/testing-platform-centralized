import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRunDetail } from '../api/client';
import type { LogEntry, NormalizedTestRun, RunEvent, RunEventType, RunPhase, RunProgress, TestLayer } from '../types';

export interface LiveRunState {
  /** Title of the test currently executing (derived from real runner output / discovery order). */
  currentTest: string | null;
  phase: RunPhase | null;
  /** Counts accumulated from live test_* events while a run is executing. */
  passed: number;
  failed: number;
  skipped: number;
  /** Latest runner-reported progress per layer (only values the runner printed; totals only when really known). */
  progressByLayer: Partial<Record<TestLayer, RunProgress>>;
  /** Most recent stage text, shown instead of misleading 0/0 counters when no count is known. */
  stage: string | null;
  /** 'live' while the SSE stream is open, 'reconnecting' during a drop, 'lost' when the backend is unreachable. */
  stream: 'idle' | 'live' | 'reconnecting' | 'lost';
}

const EMPTY_LIVE: LiveRunState = { currentTest: null, phase: null, passed: 0, failed: 0, skipped: 0, progressByLayer: {}, stage: null, stream: 'idle' };

const EVENT_TYPES: RunEventType[] = [
  'run_started',
  'clone_started',
  'clone_completed',
  'install_started',
  'install_completed',
  'browser_install_started',
  'browser_install_completed',
  'test_started',
  'test_output',
  'test_passed',
  'test_failed',
  'test_skipped',
  'layer_started',
  'layer_progress',
  'run_completed',
  'run_failed',
  'run_cancelled',
];
const TERMINAL: ReadonlySet<string> = new Set(['run_completed', 'run_failed', 'run_cancelled']);
const isActiveStatus = (s?: string) => s === 'running' || s === 'queued';

function entriesFromDetail(detail: { log: string; entries: LogEntry[] | null }): LogEntry[] {
  if (detail.entries) return detail.entries;
  return detail.log ? [{ stream: 'stdout', text: detail.log }] : [];
}

/**
 * Owns the "currently selected run" and its live log. Active runs are followed
 * over Server-Sent Events (replayed from the start, so reconnects and page
 * reloads lose nothing); finished runs are loaded from persisted storage.
 */
export function useRunSession(onRunFinished: () => void) {
  const [selectedRun, setSelectedRun] = useState<NormalizedTestRun | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [clearedAt, setClearedAt] = useState(0);
  const [live, setLive] = useState<LiveRunState>(EMPTY_LIVE);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const passedTitles = useRef(new Set<string>());
  const failedTitles = useRef(new Set<string>());
  const skippedTitles = useRef(new Set<string>());
  const pendingRef = useRef<LogEntry[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const onFinishedRef = useRef(onRunFinished);
  onFinishedRef.current = onRunFinished;

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  /** Coalesce bursts of output into one React update per animation frame. */
  const flushPending = useCallback(() => {
    flushTimerRef.current = null;
    if (pendingRef.current.length === 0) return;
    const batch = pendingRef.current;
    pendingRef.current = [];
    setEntries((prev) => [...prev, ...batch]);
  }, []);
  const queueEntry = useCallback(
    (entry: LogEntry) => {
      pendingRef.current.push(entry);
      if (flushTimerRef.current === null) flushTimerRef.current = window.setTimeout(flushPending, 50);
    },
    [flushPending]
  );
  const dropPending = () => {
    pendingRef.current = [];
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  };

  const resetLive = () => {
    passedTitles.current = new Set();
    failedTitles.current = new Set();
    skippedTitles.current = new Set();
    lastEventIdRef.current = 0;
  };

  /** Pull the authoritative persisted result after the stream ended. */
  const finalize = useCallback(
    async (runId: string) => {
      closeStream();
      flushPending();
      try {
        const detail = await fetchRunDetail(runId);
        if (runIdRef.current !== runId) return;
        setSelectedRun(detail.run);
        if (detail.entries) setEntries(detail.entries);
        setLive((l) => ({ ...l, currentTest: null, phase: detail.run.phase ?? null, stream: 'idle' }));
        if (!isActiveStatus(detail.run.status)) onFinishedRef.current();
      } catch (err) {
        if (runIdRef.current !== runId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLive((l) => ({ ...l, stream: 'lost' }));
      }
    },
    [closeStream, flushPending]
  );

  const subscribe = useCallback(
    (runId: string) => {
      closeStream();
      const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
      sourceRef.current = es;
      let consecutiveErrors = 0;

      const handle = (ev: MessageEvent) => {
        if (runIdRef.current !== runId) return;
        consecutiveErrors = 0;
        let data: RunEvent;
        try {
          data = JSON.parse(ev.data) as RunEvent;
        } catch {
          return;
        }
        // De-duplicate replays after reconnects.
        if (data.id <= lastEventIdRef.current && data.id < 1_000_000) return;
        lastEventIdRef.current = data.id;

        setLive((l) => (l.stream === 'live' ? l : { ...l, stream: 'live' }));

        if (data.type === 'test_output') {
          if (data.text) queueEntry({ stream: data.stream ?? 'stdout', text: data.text });
          return;
        }
        if (data.phase) setLive((l) => ({ ...l, phase: data.phase ?? l.phase }));
        if ((data.type === 'layer_started' || data.type === 'layer_progress') && data.progress) {
          const p = data.progress;
          setLive((l) => ({
            ...l,
            stage: p.stage,
            progressByLayer: p.layer ? { ...l.progressByLayer, [p.layer]: { ...l.progressByLayer[p.layer], ...p } } : l.progressByLayer,
          }));
          return;
        }
        if (data.type === 'test_started' && data.test) {
          const title = data.test.title;
          setLive((l) => ({ ...l, currentTest: title }));
        } else if (data.type === 'test_passed' && data.test) {
          const t = data.test.title.replace(/ \(retry\)$/, '');
          passedTitles.current.add(t);
          setLive((l) => ({ ...l, passed: passedTitles.current.size, failed: [...failedTitles.current].filter((x) => !passedTitles.current.has(x)).length }));
        } else if (data.type === 'test_failed' && data.test) {
          failedTitles.current.add(data.test.title.replace(/ \(retry\)$/, ''));
          setLive((l) => ({ ...l, failed: [...failedTitles.current].filter((x) => !passedTitles.current.has(x)).length }));
        } else if (data.type === 'test_skipped' && data.test) {
          skippedTitles.current.add(data.test.title);
          setLive((l) => ({ ...l, skipped: skippedTitles.current.size }));
        }
        // Mirror run-level progress onto the selected run so status pills update immediately.
        if (data.type === 'run_started' || data.phase) {
          setSelectedRun((r) => (r && r.runId === runId ? { ...r, phase: data.phase ?? r.phase } : r));
        }
        if (TERMINAL.has(data.type)) {
          es.close();
          void finalize(runId);
        }
      };

      for (const type of EVENT_TYPES) es.addEventListener(type, handle as EventListener);

      es.onopen = () => {
        consecutiveErrors = 0;
        setLive((l) => ({ ...l, stream: 'live' }));
      };
      es.onerror = () => {
        if (runIdRef.current !== runId) return;
        consecutiveErrors += 1;
        setLive((l) => ({ ...l, stream: 'reconnecting' }));
        // EventSource retries by itself; give up after a few failures and check the run's real state.
        if (consecutiveErrors >= 4) {
          es.close();
          void finalize(runId);
        }
      };
    },
    [closeStream, finalize, queueEntry]
  );

  /** Begin following a run that was just started. */
  const attachRun = useCallback(
    (run: NormalizedTestRun) => {
      runIdRef.current = run.runId;
      dropPending();
      resetLive();
      setError(null);
      setClearedAt(0);
      setEntries([]);
      setSelectedRun(run);
      setLive({ ...EMPTY_LIVE, phase: run.phase ?? null, stream: 'live' });
      subscribe(run.runId);
    },
    [subscribe]
  );

  /** Select any run: stream it if it is still executing, otherwise load persisted logs. */
  const selectRun = useCallback(
    async (runId: string) => {
      try {
        const detail = await fetchRunDetail(runId);
        runIdRef.current = runId;
        dropPending();
        resetLive();
        setClearedAt(0);
        setSelectedRun(detail.run);
        if (isActiveStatus(detail.run.status)) {
          setEntries([]);
          setLive({ ...EMPTY_LIVE, phase: detail.run.phase ?? null, stream: 'live' });
          subscribe(runId);
        } else {
          closeStream();
          setEntries(entriesFromDetail(detail));
          setLive(EMPTY_LIVE);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [closeStream, subscribe]
  );

  useEffect(() => closeStream, [closeStream]);

  const clearLog = useCallback(() => setClearedAt(entries.length), [entries.length]);

  const visibleEntries = clearedAt > 0 ? entries.slice(clearedAt) : entries;

  return {
    selectedRun,
    setSelectedRun,
    entries: visibleEntries,
    live,
    streamError: error,
    clearStreamError: () => setError(null),
    attachRun,
    selectRun,
    clearLog,
  };
}
