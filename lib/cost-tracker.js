#!/usr/bin/env node

/**
 * cost-tracker.js — Track token usage and estimated costs per agent dispatch.
 *
 * Records every agent dispatch with token counts, estimated cost, agent type,
 * phase, and task context. Produces a cost ledger in .ship/costs.json and
 * a human-readable summary.
 *
 * Usage:
 *   import { recordCost, getCostSummary } from './cost-tracker.js';
 *   recordCost({ agent, command, phaseId, taskTitle, usage, durationMs });
 *
 * CLI:
 *   node lib/cost-tracker.js                 # print summary
 *   node lib/cost-tracker.js --json          # print raw ledger
 *   node lib/cost-tracker.js --reset         # clear ledger
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { resolve } from 'path';

// ── Paths ────────────────────────────────────────────────────────────────

const SHIP_DIR = resolve('.ship');
const LEDGER_PATH = resolve(SHIP_DIR, 'costs.jsonl');
const SUMMARY_PATH = resolve(SHIP_DIR, 'cost-summary.json');

// ── Pricing (per million tokens, USD) ────────────────────────────────────
// Updated for current Claude model pricing. These are estimates —
// actual costs depend on caching, batching, and subscription type.

const PRICING = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00 },
  // Fallback for unknown models (use Sonnet pricing as middle ground)
  'default':           { input: 3.00,  output: 15.00 },
};

function estimateCost(inputTokens, outputTokens, model = 'default') {
  const pricing = PRICING[model] || PRICING['default'];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return +(inputCost + outputCost).toFixed(4);
}

// ── Recording ────────────────────────────────────────────────────────────

export function recordCost({ agent, command, phaseId, taskTitle, usage, durationMs, model }) {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return null;

  if (!existsSync(SHIP_DIR)) mkdirSync(SHIP_DIR, { recursive: true });

  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cost = estimateCost(inputTokens, outputTokens, model);

  const entry = {
    ts: new Date().toISOString(),
    agent: agent || 'unknown',
    command: (command || '').slice(0, 100),
    phaseId: phaseId || null,
    taskTitle: taskTitle || null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: cost,
    durationMs: durationMs || 0,
    model: model || 'default',
  };

  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');

  // Update running summary
  updateSummary(entry);

  return entry;
}

// ── Summary ──────────────────────────────────────────────────────────────

function loadSummary() {
  if (!existsSync(SUMMARY_PATH)) {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalEstimatedCost: 0,
      dispatches: 0,
      byAgent: {},
      byPhase: {},
      startedAt: null,
      updatedAt: null,
    };
  }
  try {
    return JSON.parse(readFileSync(SUMMARY_PATH, 'utf-8'));
  } catch {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalEstimatedCost: 0,
      dispatches: 0,
      byAgent: {},
      byPhase: {},
      startedAt: null,
      updatedAt: null,
    };
  }
}

function updateSummary(entry) {
  const summary = loadSummary();

  summary.totalInputTokens += entry.inputTokens;
  summary.totalOutputTokens += entry.outputTokens;
  summary.totalTokens += entry.totalTokens;
  summary.totalEstimatedCost = +(summary.totalEstimatedCost + entry.estimatedCost).toFixed(4);
  summary.dispatches++;
  if (!summary.startedAt) summary.startedAt = entry.ts;
  summary.updatedAt = entry.ts;

  // By agent
  if (!summary.byAgent[entry.agent]) {
    summary.byAgent[entry.agent] = { dispatches: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  }
  const ag = summary.byAgent[entry.agent];
  ag.dispatches++;
  ag.inputTokens += entry.inputTokens;
  ag.outputTokens += entry.outputTokens;
  ag.estimatedCost = +(ag.estimatedCost + entry.estimatedCost).toFixed(4);

  // By phase
  if (entry.phaseId) {
    if (!summary.byPhase[entry.phaseId]) {
      summary.byPhase[entry.phaseId] = { title: entry.taskTitle, dispatches: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
    }
    const ph = summary.byPhase[entry.phaseId];
    ph.dispatches++;
    ph.inputTokens += entry.inputTokens;
    ph.outputTokens += entry.outputTokens;
    ph.estimatedCost = +(ph.estimatedCost + entry.estimatedCost).toFixed(4);
  }

  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
}

export function getCostSummary() {
  return loadSummary();
}

// ── Ledger reading ───────────────────────────────────────────────────────

export function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    return readFileSync(LEDGER_PATH, 'utf-8').trim().split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function printSummary() {
  const summary = getCostSummary();

  if (summary.dispatches === 0) {
    console.log('No cost data yet.');
    return;
  }

  console.log('\n=== Pipeline Cost Summary ===\n');
  console.log(`Dispatches: ${summary.dispatches}`);
  console.log(`Tokens: ${(summary.totalInputTokens / 1000).toFixed(0)}k input + ${(summary.totalOutputTokens / 1000).toFixed(0)}k output = ${(summary.totalTokens / 1000).toFixed(0)}k total`);
  console.log(`Estimated cost: $${summary.totalEstimatedCost.toFixed(2)}`);
  if (summary.startedAt) {
    console.log(`Period: ${summary.startedAt.split('T')[0]} → ${summary.updatedAt.split('T')[0]}`);
  }

  console.log('\nBy Agent:');
  for (const [agent, data] of Object.entries(summary.byAgent).sort((a, b) => b[1].estimatedCost - a[1].estimatedCost)) {
    console.log(`  ${agent}: ${data.dispatches} dispatches, ${(data.inputTokens + data.outputTokens) / 1000 | 0}k tokens, $${data.estimatedCost.toFixed(2)}`);
  }

  if (Object.keys(summary.byPhase).length > 0) {
    console.log('\nBy Phase:');
    for (const [id, data] of Object.entries(summary.byPhase).sort((a, b) => b[1].estimatedCost - a[1].estimatedCost)) {
      console.log(`  ${data.title || id.slice(0, 8)}: ${data.dispatches} dispatches, $${data.estimatedCost.toFixed(2)}`);
    }
  }

  console.log('');
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--json')) {
    console.log(JSON.stringify(getCostSummary(), null, 2));
    return;
  }

  if (args.includes('--ledger')) {
    console.log(JSON.stringify(readLedger(), null, 2));
    return;
  }

  if (args.includes('--reset')) {
    try { writeFileSync(LEDGER_PATH, ''); } catch {}
    try { writeFileSync(SUMMARY_PATH, JSON.stringify({
      totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
      totalEstimatedCost: 0, dispatches: 0, byAgent: {}, byPhase: {},
      startedAt: null, updatedAt: null,
    }, null, 2)); } catch {}
    console.log('Cost ledger reset.');
    return;
  }

  printSummary();
}

// Only run CLI when executed directly
const isDirectRun = process.argv[1]?.endsWith('cost-tracker.js');
if (isDirectRun) main();
