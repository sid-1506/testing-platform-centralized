import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRepos } from '../api/client';
import type { ExternalRepo } from '../types';

const POLL_MS = 1500;
const POLL_MAX_MS = 5 * 60 * 1000;

/**
 * Registered external repositories. While any repository is still `connecting`
 * (cloning/detecting) the list is polled; polling stops as soon as every repo
 * has a final status (the backend guarantees one), or after a hard cap.
 */
export function useRepos() {
  const [repos, setRepos] = useState<ExternalRepo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingSince = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchRepos();
      setRepos(list);
      setError(null);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a repository connects or while "Fetch Tests" is listing.
  const anyConnecting = repos.some((r) => r.status === 'connecting' || r.discoveryState?.status === 'running');
  useEffect(() => {
    if (!anyConnecting) {
      pollingSince.current = null;
      return;
    }
    if (pollingSince.current === null) pollingSince.current = Date.now();
    const timer = window.setInterval(() => {
      if (pollingSince.current !== null && Date.now() - pollingSince.current > POLL_MAX_MS) {
        window.clearInterval(timer);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyConnecting, refresh]);

  return { repos, loaded, error, refresh };
}
