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
const MAX_SIGNAL_LINES = 500;
const TRUNCATE_TO = 300;

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

// ── Task type derivation ─────────────────────────────────────────────────

function deriveTaskType(files) {
  if (!files || files.length === 0) return 'general';

  let ui = 0, api = 0, test = 0, data = 0;
  for (const f of files) {
    const lower = f.toLowerCase();
    if (/\.(tsx|jsx|css|scss|sass|less|svg)$/.test(lower) || /component/i.test(lower)) ui++;
    if (/route\.(js|ts)$/.test(lower) || /\/api\//.test(lower) || /controller/i.test(lower)) api++;
    if (/\.(test|spec)\.(js|ts|jsx|tsx)$/.test(lower) || /\/__tests__\//.test(lower)) test++;
    if (/schema|migration|seed|model\.(js|ts)$/.test(lower) || /prisma|drizzle|knex/i.test(lower)) data++;
  }

  const max = Math.max(ui, api, test, data);
  if (max === 0) return 'general';
  if (ui === max) return 'ui';
  if (api === max) return 'api';
  if (test === max) return 'test';
  if (data === max) return 'data';
  return 'general';
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

      // ── Per-agent signal extraction ──

      // Builder signal
      const buildCount = attempts.filter(a => a.type === 'build').length;
      const fixCount = attempts.filter(a => a.type === 'build-fix').length;
      const hasQASuccess = qaAttempts.some(a => a.outcome === 'success');
      const firstPassQA = hasQASuccess && fixCount === 0;

      const builderFailureCategories = [];
      for (const qa of qaAttempts) {
        if (qa.outcome === 'failure' && qa.notes) {
          builderFailureCategories.push(...extractFailureCategories(qa.notes));
        }
      }

      // QA signal
      const qaFailures = qaAttempts.filter(a => a.outcome === 'failure');
      const qaSuccesses = qaAttempts.filter(a => a.outcome === 'success');
      const qaRechecks = attempts.filter(a => a.type === 'qa-recheck');
      // False positive heuristic: QA failed a task, resolver made no meaningful change,
      // but qa-recheck passed. We can't detect this perfectly, so we track recheck success rate.
      const recheckSuccessRate = qaRechecks.length > 0
        ? qaRechecks.filter(a => a.outcome === 'success').length / qaRechecks.length
        : null;

      // Resolver signal
      const resolveAttempts = attempts.filter(a => a.type === 'build-fix');
      const resolveSucceeded = resolveAttempts.length > 0 && hasQASuccess;
      const resolveRounds = resolveAttempts.length;

      // Task metadata
      const filesCount = task.files?.length || 0;
      const complexity = filesCount + 1;
      const complexityTier = complexity <= 2 ? 'low' : complexity <= 4 ? 'medium' : 'high';
      const taskType = deriveTaskType(task.files || []);
      const maxRound = attempts.reduce((max, a) => Math.max(max, a.round || 0), 0);

      const record = {
        ts: new Date().toISOString(),
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        complexity,
        complexityTier,
        taskType,
        filesCount,
        roundsToComplete: maxRound,
        trigger,
        // Per-agent signal
        builder: {
          buildAttempts: buildCount,
          fixAttempts: fixCount,
          firstPassQA,
          failureCategories: [...new Set(builderFailureCategories)],
        },
        qa: {
          attempts: qaAttempts.length,
          failures: qaFailures.length,
          successes: qaSuccesses.length,
          rechecks: qaRechecks.length,
          recheckSuccessRate,
        },
        resolver: {
          attempts: resolveRounds,
          succeeded: resolveSucceeded,
          fixAttempts: fixCount,
        },
      };

      appendFileSync(SIGNALS_PATH, JSON.stringify(record) + '\n');
      existingKeys.add(key);
      collected++;
    }

    // ── Phase-level signal (PM / Exec) ──
    const phaseKey = `phase:${phase.id}`;
    if (!existingKeys.has(phaseKey) && phase.pipeline?.state === 'complete') {
      const qaRounds = phase.pipeline?.qaRoundsCumulative || 0;
      const taskCount = (phase.tasks || []).length;
      const completedTasks = (phase.tasks || []).filter(t => t.status === 'completed').length;

      const phaseRecord = {
        ts: new Date().toISOString(),
        phaseId: phase.id,
        type: 'phase',
        trigger,
        pm: {
          taskCount,
          completedTasks,
          completionRate: taskCount > 0 ? completedTasks / taskCount : 0,
          qaRoundsNeeded: qaRounds,
          planRequired: !!phase.planFile,
        },
      };

      appendFileSync(SIGNALS_PATH, JSON.stringify(phaseRecord) + '\n');
      existingKeys.add(phaseKey);
      collected++;
    }
  }

  truncateIfNeeded();
  return collected;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
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
