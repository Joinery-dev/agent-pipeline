/**
 * GET /api/status — Returns pipeline status from .ship/status.json
 *
 * Includes staleness check: if the PID in status.json is dead but state
 * is "running", returns state as "crashed" instead.
 *
 * Also returns the report content if a report path is specified.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const statusPath = resolve('.ship/status.json');

  if (!existsSync(statusPath)) {
    return Response.json({ state: 'not-running', reason: 'No status file' });
  }

  let status;
  try {
    status = JSON.parse(readFileSync(statusPath, 'utf-8'));
  } catch {
    return Response.json({ state: 'not-running', reason: 'Invalid status file' });
  }

  // Staleness check: if state is "running" or "repairing" but PID is dead
  if (['running', 'repairing', 'post-completion', 'reviewing'].includes(status.state)) {
    if (status.pid && !isPidAlive(status.pid)) {
      status.state = 'crashed';
      status.crashedAt = status.timestamp;
      status.reason = `Process ${status.pid} is no longer running`;
    }
  }

  // Include report content if available
  if (status.report) {
    const reportPath = resolve(status.report);
    if (existsSync(reportPath)) {
      try {
        status.reportContent = readFileSync(reportPath, 'utf-8');
      } catch {}
    }
  }

  // Include cost summary if available
  const costPath = resolve('.ship/cost-summary.json');
  if (existsSync(costPath)) {
    try {
      status.costs = JSON.parse(readFileSync(costPath, 'utf-8'));
    } catch {}
  }

  // Cache for 2 seconds — status changes frequently during runs
  return new Response(JSON.stringify(status), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, max-age=2',
    },
  });
}
