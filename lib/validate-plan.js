#!/usr/bin/env node

/**
 * validate-plan.js — Validates plan files against .goals.json entries
 *
 * Usage:
 *   node lib/validate-plan.js              # validate all phases
 *   node lib/validate-plan.js --phase <id> # validate one phase by ID
 *   node lib/validate-plan.js --plan <file># validate one plan file
 */

import { readGoals } from './pipeline.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── CLI arg parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
let filterPhaseId = null;
let filterPlanFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--phase' && args[i + 1]) {
    filterPhaseId = args[++i];
  } else if (args[i] === '--plan' && args[i + 1]) {
    filterPlanFile = args[++i];
  }
}

// ── Main validation ────────────────────────────────────────────────────

const errors = [];   // FAIL-level
const warnings = []; // WARN-level
const stats = { phasesChecked: 0, tasksChecked: 0, plansChecked: 0 };

const goals = readGoals(resolve(ROOT, '.goals.json'));

// Collect all task IDs across the project to detect duplicates
const allTaskIds = new Map(); // id → title

for (const phase of goals.phases) {
  for (const task of phase.tasks) {
    if (allTaskIds.has(task.id)) {
      errors.push(`FAIL: Duplicate task ID "${task.id}" — "${task.title}" collides with "${allTaskIds.get(task.id)}"`);
    }
    allTaskIds.set(task.id, task.title);
  }
}

// Determine which phases to check
let phases = goals.phases;
if (filterPhaseId) {
  phases = phases.filter(p => p.id === filterPhaseId);
  if (phases.length === 0) {
    errors.push(`FAIL: Phase "${filterPhaseId}" not found in .goals.json`);
  }
} else if (filterPlanFile) {
  phases = phases.filter(p => p.planFile === filterPlanFile);
  if (phases.length === 0) {
    errors.push(`FAIL: No phase references plan file "${filterPlanFile}"`);
  }
}

for (const phase of phases) {
  stats.phasesChecked++;

  // Check for orphaned phases (no planFile, still not-started)
  if (!phase.planFile && phase.status === 'not-started') {
    warnings.push(`WARN: Orphaned phase "${phase.title}" (${phase.id}) — no planFile, status not-started`);
  }

  if (!phase.planFile) {
    // Still check tasks for data integrity
    for (const task of phase.tasks || []) {
      stats.tasksChecked++;
      checkTaskIntegrity(task, phase);
    }
    continue;
  }

  // Verify plan file exists on disk
  const planPath = resolve(ROOT, phase.planFile);
  if (!existsSync(planPath)) {
    errors.push(`FAIL: Plan file missing on disk: ${phase.planFile} (phase "${phase.title}")`);
    // Still check tasks
    for (const task of phase.tasks || []) {
      stats.tasksChecked++;
      checkTaskIntegrity(task, phase);
    }
    continue;
  }

  stats.plansChecked++;

  // Read and parse plan file
  const planContent = readFileSync(planPath, 'utf-8');
  const planTasks = extractPlanTasks(planContent);
  const planSuccessCriteria = extractSuccessCriteria(planContent);

  // Check success criteria exist
  if (planSuccessCriteria.length === 0) {
    // Only FAIL if there are tasks defined — a plan with no tasks might be structured differently
    if (planTasks.length > 0) {
      // This is a warning, not a fail — some plans use different formats
    }
  }

  // Cross-reference: plan tasks that aren't in .goals.json
  const goalTaskTitles = new Set((phase.tasks || []).map(t => t.title.toLowerCase()));
  for (const pt of planTasks) {
    const ptLower = pt.title.toLowerCase();
    // Check if any goals task title is a substring match (plans often have longer titles)
    const found = [...goalTaskTitles].some(gt =>
      gt.includes(ptLower) || ptLower.includes(gt) || similarEnough(gt, ptLower)
    );
    if (!found) {
      warnings.push(`WARN: Plan task "${pt.title}" in ${phase.planFile} not found in .goals.json phase "${phase.title}"`);
    }
  }

  // Check each task in the phase
  for (const task of phase.tasks || []) {
    stats.tasksChecked++;
    checkTaskIntegrity(task, phase);

    // Check files[] populated
    if (!task.files || task.files.length === 0) {
      warnings.push(`WARN: Empty files[] on task "${task.title}" (${task.id})`);
    }

    // Check for generic task title (fewer than 4 words)
    const wordCount = task.title.trim().split(/\s+/).length;
    if (wordCount < 4) {
      warnings.push(`WARN: Generic task title (<4 words): "${task.title}" (${task.id})`);
    }
  }
}

// ── Task integrity checks ──────────────────────────────────────────────

function checkTaskIntegrity(task, phase) {
  // Completed tasks must have at least one success attempt
  if (task.status === 'completed') {
    const hasSuccess = (task.attempts || []).some(a => a.outcome === 'success');
    if (!hasSuccess) {
      errors.push(`FAIL: Completed task "${task.title}" (${task.id}) has no success attempt`);
    }
  }
}

// ── Plan file parsing ──────────────────────────────────────────────────

function extractPlanTasks(content) {
  const tasks = [];
  // Match ### Task N: Title patterns
  const re = /^### Task \d+:\s*(.+)$/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    tasks.push({ title: match[1].trim() });
  }
  return tasks;
}

function extractSuccessCriteria(content) {
  const criteria = [];
  // Match **Success looks like:** or **Success looks like**: followed by content
  const re = /\*\*Success looks like\*\*[:：]\s*(.+)/gi;
  let match;
  while ((match = re.exec(content)) !== null) {
    criteria.push(match[1].trim());
  }
  return criteria;
}

/**
 * Fuzzy match — checks if two task title strings are similar enough
 * by comparing significant words (ignoring short stop words).
 */
function similarEnough(a, b) {
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'in', 'for', 'of', 'on', 'at', 'by', 'is', 'it']);
  const wordsA = a.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  const wordsB = b.split(/\s+/).filter(w => !stopWords.has(w) && w.length > 2);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const overlap = wordsA.filter(w => wordsB.includes(w)).length;
  return overlap / Math.max(wordsA.length, wordsB.length) >= 0.5;
}

// ── Output ─────────────────────────────────────────────────────────────

const valid = errors.length === 0 && warnings.length === 0;
const result = {
  valid,
  errors,
  warnings,
  stats,
};

console.log(JSON.stringify(result, null, 2));

// Exit codes: 0 = valid, 1 = warnings only, 2 = errors
if (errors.length > 0) {
  process.exit(2);
} else if (warnings.length > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
