import { useEffect, useRef } from 'react';
import type { ExternalRepo } from '../types';
import { Icon } from './icons';

interface TrustDialogProps {
  repo: ExternalRepo;
  /** What trusting leads to: executing the tests, or only listing them (which still loads the repository's config and test files). */
  purpose?: 'run' | 'discover';
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Explicit trust gate shown before a newly connected external repository is executed for the first time. */
export function TrustDialog({ repo, purpose = 'run', busy, onConfirm, onCancel }: TrustDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="trust-title" aria-describedby="trust-desc">
        <div className="modal-head">
          <span className="project-icon project-icon-lg">
            <Icon name="lock" size={20} />
          </span>
          <div>
            <h3 id="trust-title" className="card-title">
              {purpose === 'discover' ? 'Load code from' : 'Run code from'} {repo.owner}/{repo.repo}?
            </h3>
            <p className="card-sub">
              Branch {repo.branch} · commit {repo.commitSha ? repo.commitSha.slice(0, 7) : 'unknown'}
            </p>
          </div>
        </div>
        <div id="trust-desc" className="modal-body">
          <p>
            {purpose === 'discover'
              ? <>Fetching tests runs the framework's listing command, which <strong>loads the repository's test configuration and test files</strong> (no test is executed) on this computer with{' '}</>
              : <>Running this repository executes its <strong>npm scripts</strong> and its <strong>test code</strong> on this computer with{' '}</>}
            <strong>your user permissions</strong>. Dependency install scripts stay disabled unless you enable them in the repository's run settings.
            Trust applies to <strong>this commit only</strong>: if the branch moves, you will be asked again.
          </p>
          <p>
            The platform hands it a minimal, filtered environment (no dashboard secrets), an isolated per-run workspace and a headless browser,
            and enforces timeouts. These are hardening measures — <strong>not a security sandbox</strong>: the code can still read files your
            user can read and use the network.
          </p>
          <p>Only continue if you trust this repository and its dependencies.</p>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-pill btn-white-line" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-pill btn-accent" onClick={onConfirm} disabled={busy}>
            {busy ? (
              <>
                <span className="spinner" /> Starting…
              </>
            ) : (
              <>
                <Icon name={purpose === 'discover' ? 'search' : 'play'} size={purpose === 'discover' ? 13 : 11} /> {purpose === 'discover' ? 'Trust & fetch tests' : 'Trust & run'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
