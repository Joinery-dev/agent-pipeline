#!/usr/bin/env node

/**
 * collect.js — Signal collector for inline autoresearch.
 *
 * Extracts structured task outcomes from .goals.json and appends them
 * to signals.jsonl. Pure data extraction — zero LLM calls.
 *
 * Called by ship.js lifecycle hooks (post-qa, post-resolve).
 * Receives context via SHIP_EVENT and SHIP_CONTEXT env vars.
 *
 * Usage:
 *   node .autoresearch/inline/collect.js --trigger post-qa
 *   node .autoresearch/inline/collect.js --trigger post-resolve
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

// ── Paths ────────────────────────────────────────────────────────────────

const GOALS_PATH = resolve('.goals.json');
const INLINE_DIR = resolve('.autoresearch/inline');
const SIGNALS_PATH = resolve(INLINE_DIR, 'signals.jsonl');
const EXPERIMENT_PATH = resolve(INLINE_DIR, 'experiment.json');
const MAX_SIGNAL_LINES = 500;
const TRUNCATE_TO = 300;

// ── Config ───────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = resolve('ship-config.json');
  if (!existsSync(configPath)) return { inlineAutoresearch: { enabled: false } };
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return { inlineAutoresearch: { enabled: false } };
  }
}

// ── Goals reading (standalone — no import dependency on pipeline.js) ─────

function readGoals() {
  if (!existsSync(GOALS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function getAllPhases(goals) {
  const phases = [];
  for (const mp of goals.majorPhases || []) {
    for (const p of mp.subPhases || []) {
      phases.push(p);
    }
  }
  return phases;
}

// ── Failure category extraction ──────────────────────────────────────────

const KNOWN_CATEGORIES = [
  'test-failure',
  'missing-feature',
  'visual-regression',
  'type-error',
  'lint-failure',
  'accessibility',
  'integration',
  'performance',
  'build-error',
];

function extractFailureCategories(notes) {
  if (!notes || typeof notes !== 'string') return [];
  const lower = notes.toLowerCase();
  const found = [];
  for (const cat of KNOWN_CATEGORIES) {
    // Match hyphenated or space-separated versions
    const variants = [cat, cat.replace(/-/g, ' ')];
    for (const v of variants) {
      if (lower.includes(v)) {
        found.push(cat);
        break;
      }
    }
  }
  // Heuristic fallbacks for common patterns
  if (found.length === 0) {
    if (/test(s)?\s+(fail|broke|error)/i.test(notes)) found.push('test-failure');
    if (/not\s+implement/i.test(notes) || /missing/i.test(notes)) found.push('missing-feature');
    if (/type\s*(script|error|check)/i.test(notes)) found.push('type-error');
    if (/lint/i.test(notes)) found.push('lint-failure');
    if (/build\s+(fail|error)/i.test(notes)) found.push('build-error');
  }
  if (found.length === 0 && notes.trim().length > 0) found.push('other');
  return [...new Set(found)];
}

// ── Deduplication ────────────────────────────────────────────────────────

function getExistingKeys() {
  if (!existsSync(SIGNALS_PATH)) return new Set();
  const keys = new Set();
  try {
    const content = readFileSync(SIGNALS_PATH, 'utf-8');
    const lines = content.trim().split('\n').slice(-100); // last 100 lines
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.phaseId && record.taskId) {
          keys.add(`${record.phaseId}:${record.taskId}`);
        }
      } catch {}
    }
  } catch {}
  return keys;
}

// ── Bounded growth ───────────────────────────────────────────────────────

function truncateIfNeeded() {
  if (!existsSync(SIGNALS_PATH)) return;
  try {
    const content = readFileSync(SIGNALS_PATH, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > MAX_SIGNAL_LINES) {
      const kept = lines.slice(-TRUNCATE_TO);
      writeFileSync(SIGNALS_PATH, kept.join('\n') + '\n');
    }
  } catch {}
}

// ── Protocol version ─────────────────────────────────────────────────────

function getProtocolVersion() {
  if (!existsSync(EXPERIMENT_PATH)) return 'baseline';
  try {
    const state = JSON.parse(readFileSync(EXPERIMENT_PATH, 'utf-8'));
    if (state.state === 'running' && state.activeExperiment) {
      return `exp-${String(state.activeExperiment.id).padStart(3, '0')}`;
    }
    return 'baseline';
  } catch {
    return 'baseline';
  }
}

// ── Main collection ──────────────────────────────────────────────────────

function collectSignals(phaseId, trigger) {
  const goals = readGoals();
  if (!goals) return 0;

  const phases = getAllPhases(goals);
  const targetPhases = phaseId
    ? phases.filter(p => p.id === phaseId)
    : phases;

  if (targetPhases.length === 0) return 0;

  const existingKeys = getExistingKeys();
  const protocolVersion = getProtocolVersion();
  let collected = 0;

  for (const phase of targetPhases) {
    const tasks = phase.tasks || [];
    for (const task of tasks) {
      // Only collect from tasks that have had QA or resolve activity
      const attempts = task.attempts || [];
      const qaAttempts = attempts.filter(a => a.type === 'qa' || a.type === 'qa-recheck');
      if (qaAttempts.length === 0) continue;

      // Dedup check
      const key = `${phase.id}:${task.id}`;
      if (existingKeys.has(key)) continue;

      // Compute fields
      const buildAttempts = attempts.filter(a => a.type === 'build').length;
      const fixAttempts = attempts.filter(a => a.type === 'build-fix').length;
      const qaCount = qaAttempts.length;

      // firstPassQA: QA succeeded AND zero fix attempts
      const hasQASuccess = qaAttempts.some(a => a.outcome === 'success');
      const firstPassQA = hasQASuccess && fixAttempts === 0;

      // Failure categories from QA failure notes
      const failureCategories = [];
      for (const qa of qaAttempts) {
        if (qa.outcome === 'failure' && qa.notes) {
          failureCategories.push(...extractFailureCategories(qa.notes));
        }
      }

      // Complexity proxy
      const filesCount = task.files?.length || 0;
      const complexity = filesCount + 1;

      // Rounds to complete
      const maxRound = attempts.reduce((max, a) => Math.max(max, a.round || 0), 0);

      const record = {
        ts: new Date().toISOString(),
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        agent: 'builder',
        protocolVersion,
        complexity,
        firstPassQA,
        buildAttempts,
        fixAttempts,
        qaAttempts: qaCount,
        failureCategories: [...new Set(failureCategories)],
        filesCount,
        roundsToComplete: maxRound,
        trigger,
      };

      appendFileSync(SIGNALS_PATH, JSON.stringify(record) + '\n');
      existingKeys.add(key);
      collected++;
    }
  }

  truncateIfNeeded();
  return collected;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const config = loadConfig();
  if (!config.inlineAutoresearch?.enabled) return;

  // Ensure directory exists
  if (!existsSync(INLINE_DIR)) mkdirSync(INLINE_DIR, { recursive: true });

  // Parse args
  let trigger = 'unknown';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--trigger' && args[i + 1]) trigger = args[++i];
  }

  // Also read from env (set by ship.js hook runner)
  if (trigger === 'unknown' && process.env.SHIP_EVENT) {
    trigger = process.env.SHIP_EVENT;
  }

  // Extract phase ID from context
  let phaseId = null;
  try {
    const ctx = JSON.parse(process.env.SHIP_CONTEXT || '{}');
    phaseId = ctx.phaseId || null;
  } catch {}

  const count = collectSignals(phaseId, trigger);
  if (count > 0) {
    console.log(JSON.stringify({ collected: count, trigger }));
  }
}

main();

export { collectSignals, extractFailureCategories, getExistingKeys };
