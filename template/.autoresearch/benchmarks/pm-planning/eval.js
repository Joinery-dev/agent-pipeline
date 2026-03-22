#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for pm-planning.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a PM agent has run, producing a single
 * score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Plan file created in plans/:                               15% weight
 *   - Sub-phases created in .goals.json (at least 2):            15% weight
 *   - Tasks created (at least 3):                                15% weight
 *   - Each task has non-empty title, description, and files[]:   20% weight
 *   - Plan file has success criteria section:                    15% weight
 *   - Tasks have descriptive titles (>10 chars, not generic):   10% weight
 *   - Plan file references produces/consumes:                    10% weight
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

function evaluate(dir) {
  const details = {
    planFileCreated: false,
    planFilePath: null,
    subPhasesCount: 0,
    tasksCount: 0,
    tasksWithFullFields: 0,
    planHasSuccessCriteria: false,
    descriptiveTitles: 0,
    planReferencesContract: false,
  };

  // ── 1. Plan file created in plans/ (weight: 0.15) ─────────────────

  let planScore = 0;
  let planContent = '';

  try {
    const plansDir = resolve(dir, 'plans');
    if (existsSync(plansDir)) {
      const planFiles = readdirSync(plansDir).filter(f => f.endsWith('.md'));
      if (planFiles.length > 0) {
        details.planFileCreated = true;
        details.planFilePath = `plans/${planFiles[0]}`;
        planContent = readFileSync(join(plansDir, planFiles[0]), 'utf-8');
        planScore = 1.0;
      }
    }
  } catch {
    // plans/ directory issue
  }

  // ── 2. Sub-phases created (weight: 0.15) ─────────────────────────

  let phaseScore = 0;
  let tasks = [];

  try {
    const goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
    const majorPhase = goals.majorPhases?.[0];

    if (majorPhase && Array.isArray(majorPhase.phases)) {
      details.subPhasesCount = majorPhase.phases.length;
      if (details.subPhasesCount >= 2) {
        phaseScore = 1.0;
      } else if (details.subPhasesCount === 1) {
        phaseScore = 0.5;
      }

      // Collect all tasks from sub-phases
      for (const phase of majorPhase.phases) {
        if (Array.isArray(phase.tasks)) {
          tasks.push(...phase.tasks);
        }
      }
    }
  } catch {
    // .goals.json not readable
  }

  // ── 3. Tasks created (weight: 0.15) ──────────────────────────────

  let taskCountScore = 0;
  details.tasksCount = tasks.length;

  if (tasks.length >= 3) {
    taskCountScore = 1.0;
  } else if (tasks.length === 2) {
    taskCountScore = 0.6;
  } else if (tasks.length === 1) {
    taskCountScore = 0.3;
  }

  // ── 4. Task field completeness (weight: 0.20) ────────────────────

  let fieldScore = 0;

  for (const task of tasks) {
    const hasTitle = task.title && task.title.trim().length > 0;
    const hasDesc = task.description && task.description.trim().length > 0;
    const hasFiles = Array.isArray(task.files) && task.files.length > 0;

    if (hasTitle && hasDesc && hasFiles) {
      details.tasksWithFullFields++;
    }
  }

  if (tasks.length > 0) {
    fieldScore = details.tasksWithFullFields / tasks.length;
  }

  // ── 5. Plan has success criteria (weight: 0.15) ──────────────────

  let criteriaScore = 0;

  if (planContent) {
    const lower = planContent.toLowerCase();
    if (lower.includes('success') || lower.includes('criteria') || lower.includes('## tasks')) {
      details.planHasSuccessCriteria = true;
      criteriaScore = 1.0;
    }
  }

  // ── 6. Descriptive task titles (weight: 0.10) ────────────────────

  let titleScore = 0;
  const genericPatterns = /^task\s*\d+$/i;

  for (const task of tasks) {
    if (task.title && task.title.length > 10 && !genericPatterns.test(task.title.trim())) {
      details.descriptiveTitles++;
    }
  }

  if (tasks.length > 0) {
    titleScore = details.descriptiveTitles / tasks.length;
  }

  // ── 7. Plan references produces/consumes (weight: 0.10) ──────────

  let contractScore = 0;

  if (planContent) {
    const lower = planContent.toLowerCase();
    // Check if plan mentions any of the contract terms
    const contractTerms = ['auth-middleware', 'user-model', 'auth-routes', 'jwt-utils', 'database-connection',
                           'produces', 'consumes', 'interface contract'];
    const matches = contractTerms.filter(term => lower.includes(term.toLowerCase()));
    if (matches.length >= 2) {
      details.planReferencesContract = true;
      contractScore = 1.0;
    } else if (matches.length === 1) {
      contractScore = 0.5;
    }
  }

  // ── Final score ─────────────────────────────────────────────────

  const score =
    (planScore * 0.15) +
    (phaseScore * 0.15) +
    (taskCountScore * 0.15) +
    (fieldScore * 0.20) +
    (criteriaScore * 0.15) +
    (titleScore * 0.10) +
    (contractScore * 0.10);

  return {
    score: Math.round(score * 1000) / 1000,
    details,
  };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
