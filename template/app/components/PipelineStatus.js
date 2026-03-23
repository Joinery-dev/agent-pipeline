'use client';

import { useState, useEffect } from 'react';
import styles from './PipelineStatus.module.css';

const POLL_INTERVAL = 3000; // 3 seconds

export default function PipelineStatus() {
  const [status, setStatus] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (mounted) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err.message);
      }
    }

    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.badge} data-state="error">
          Pipeline status unavailable
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={styles.container}>
        <div className={styles.badge} data-state="loading">
          Loading...
        </div>
      </div>
    );
  }

  const state = status.state;

  return (
    <div className={styles.container}>
      {/* Status badge */}
      <div className={styles.badge} data-state={state}>
        {state === 'running' && (
          <>
            <span className={styles.spinner} />
            <span>
              Iteration {status.iteration || '?'}:
              {status.phase ? ` ${status.phase}` : ''}
              {status.phaseState ? ` — ${status.phaseState}` : ''}
            </span>
          </>
        )}

        {state === 'post-completion' && (
          <>
            <span className={styles.spinner} />
            <span>Finishing up: {status.step || '...'}...</span>
          </>
        )}

        {state === 'repairing' && (
          <>
            <span className={styles.spinnerWarning} />
            <span>Self-healing: attempt {status.attempt || '?'}/3</span>
          </>
        )}

        {state === 'awaiting-review' && (
          <span>Ready for review</span>
        )}

        {state === 'reviewing' && (
          <>
            <span className={styles.spinner} />
            <span>Review in progress...</span>
          </>
        )}

        {state === 'finished' && (
          <>
            <span className={status.success ? styles.successDot : styles.failDot} />
            <span>
              {status.success ? 'Completed' : 'Failed'}
              {status.duration ? ` (${status.duration})` : ''}
            </span>
          </>
        )}

        {state === 'crashed' && (
          <>
            <span className={styles.failDot} />
            <span>Pipeline crashed</span>
          </>
        )}

        {state === 'not-running' && (
          <span className={styles.idle}>Pipeline not running</span>
        )}
      </div>

      {/* Review button */}
      {state === 'awaiting-review' && (
        <div className={styles.actions}>
          <button
            className={styles.reviewButton}
            onClick={() => {
              // Copy the command to clipboard
              navigator.clipboard?.writeText('node lib/ship.js --review');
              alert('Run in terminal:\n\nnode lib/ship.js --review');
            }}
          >
            Start Review
          </button>
          {status.reportContent && (
            <button
              className={styles.reportToggle}
              onClick={() => setShowReport(!showReport)}
            >
              {showReport ? 'Hide Report' : 'Preview Report'}
            </button>
          )}
        </div>
      )}

      {/* Cost summary */}
      {status.costs && status.costs.dispatches > 0 && (
        <div className={styles.costs}>
          <span>{status.costs.dispatches} dispatches</span>
          <span className={styles.costDivider}>|</span>
          <span>{(status.costs.totalTokens / 1000).toFixed(0)}k tokens</span>
          <span className={styles.costDivider}>|</span>
          <span>~${status.costs.totalEstimatedCost.toFixed(2)}</span>
        </div>
      )}

      {/* Report preview */}
      {showReport && status.reportContent && (
        <div className={styles.report}>
          <pre>{status.reportContent}</pre>
        </div>
      )}
    </div>
  );
}
