#!/usr/bin/env node

/**
 * export.js — Telemetry export for inline autoresearch.
 *
 * Produces an anonymized aggregate summary of inline autoresearch activity
 * for cross-project learning. No task titles, file paths, or code content.
 *
 * Usage:
 *   node .autoresearch/inline/export.js           # generate export
 *   node .autoresearch/inline/export.js --print    # print to stdout
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

// ── Paths ────────────────────────────────────────────────────────────────

const INLINE_DIR = resolve('.autoresearch/inline');
const SIGNALS_PATH = resolve(INLINE_DIR, 'signals.jsonl');
const EXPERIMENT_PATH = resolve(INLINE_DIR, 'experiment.json');
const EXPORT_PATH = resolve(INLINE_DIR, 'telemetry-export.json');
const GOALS_PATH = resolve('.goals.json');

// ── Main ─────────────────────────────────────────────────────────────────

function generateExport() {
  // Read project identity
  let projectId = 'unknown';
  try {
    const goals = JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
    projectId = goals.name || goals.id || 'unknown';
  } catch {}
  const projectHash = createHash('sha256').update(projectId).digest('hex').slice(0, 8);

  // Read signals
  let signals = [];
  if (existsSync(SIGNALS_PATH)) {
    try {
      signals = readFileSync(SIGNALS_PATH, 'utf-8').trim().split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch {}
  }

  // Read experiment state
  let state = { globalStats: {}, history: [] };
  if (existsSync(EXPERIMENT_PATH)) {
    try {
      state = JSON.parse(readFileSync(EXPERIMENT_PATH, 'utf-8'));
    } catch {}
  }

  // Compute aggregate metrics
  const baselineSignals = signals.filter(s => s.protocolVersion === 'baseline');
  const allSignals = signals;

  const baselinePassRate = baselineSignals.length > 0
    ? baselineSignals.filter(s => s.firstPassQA).length / baselineSignals.length
    : null;

  const currentPassRate = allSignals.length > 0
    ? allSignals.filter(s => s.firstPassQA).length / allSignals.length
    : null;

  // Aggregate failure categories
  const failureCounts = {};
  for (const s of allSignals) {
    for (const cat of s.failureCategories || []) {
      failureCounts[cat] = (failureCounts[cat] || 0) + 1;
    }
  }
  const topFailureCategories = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, count }));

  // Extract kept convention texts
  const keptConventions = (state.history || [])
    .filter(h => h.result === 'kept')
    .map(h => h.hypothesis);

  // Build export
  const exportData = {
    exportedAt: new Date().toISOString(),
    projectHash,
    stats: {
      totalTasks: allSignals.length,
      totalExperiments: state.globalStats?.totalExperiments || 0,
      totalKept: state.globalStats?.totalKept || 0,
      totalReverted: state.globalStats?.totalReverted || 0,
      baselineFirstPassQARate: baselinePassRate,
      currentFirstPassQARate: currentPassRate,
      improvement: baselinePassRate !== null && currentPassRate !== null
        ? currentPassRate - baselinePassRate
        : null,
      topFailureCategories,
    },
    experiments: (state.history || []).map(h => ({
      agent: 'builder',
      hypothesis: h.hypothesis,
      result: h.result,
      improvement: h.improvement || null,
      dataPoints: h.dataPoints || null,
    })),
    keptConventions,
  };

  return exportData;
}

function main() {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');

  if (!existsSync(INLINE_DIR)) mkdirSync(INLINE_DIR, { recursive: true });

  const exportData = generateExport();

  if (printOnly) {
    console.log(JSON.stringify(exportData, null, 2));
    return;
  }

  writeFileSync(EXPORT_PATH, JSON.stringify(exportData, null, 2));
  console.log(JSON.stringify({ exported: true, path: EXPORT_PATH }));
}

main();

export { generateExport };
