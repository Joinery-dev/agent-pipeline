#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for qa-false-positives.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a QA agent has run on mostly-working code
 * with 1 subtle bug, producing a single score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Detected the groupBy bug (task marked as failed):       30% weight
 *   - Did NOT false-positive slugify (passed or not failed):   15% weight
 *   - Did NOT false-positive truncate:                         10% weight
 *   - Did NOT false-positive unique:                           10% weight
 *   - Did NOT false-positive flatten:                          10% weight
 *   - Diagnosis mentions "null" or "undefined" or "key":       15% weight
 *   - Pipeline state set to qa-failed:                         10% weight
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

// ── Task IDs and expected outcomes ──────────────────────────────────

const BUGGY_TASK = 'qa-fp-task-groupby';

const WORKING_TASKS = [
  'qa-fp-task-slugify',
  'qa-fp-task-truncate',
  'qa-fp-task-unique',
  'qa-fp-task-flatten',
];

// Weights for each working task's false-positive check
const WORKING_TASK_WEIGHTS = {
  'qa-fp-task-slugify': 0.15,
  'qa-fp-task-truncate': 0.10,
  'qa-fp-task-unique': 0.10,
  'qa-fp-task-flatten': 0.10,
};

// Keywords that indicate the QA agent diagnosed the actual groupBy bug
const DIAGNOSIS_KEYWORDS = [
  'null', 'undefined', 'key', 'null.*key', 'undefined.*key',
  'skip.*null', 'skip.*undefined', 'coerce', 'string.*null',
  'string.*undefined', 'excluded', 'exclude',
];

function evaluate(dir) {
  const details = {
    bugDetected: false,
    falsePositives: [],
    correctPasses: [],
    diagnosisScore: 0,
    pipelineState: null,
    pipelineCorrect: false,
    qaAttempts: {},
  };

  let goals;
  try {
    goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
  } catch {
    return { score: 0, details: { ...details, error: '.goals.json not readable' } };
  }

  // Extract all tasks from the phase
  const phases = goals.majorPhases?.[0]?.phases || goals.phases || [];
  const phase = phases.find(p => p.id === 'qa-fp-phase');
  if (!phase) {
    return { score: 0, details: { ...details, error: 'qa-fp-phase not found in .goals.json' } };
  }

  const tasks = phase.tasks || [];

  // ── 1. Bug detection: did QA mark groupBy as failed? (weight: 0.30) ──

  let bugDetectionScore = 0;

  const buggyTask = tasks.find(t => t.id === BUGGY_TASK);
  if (buggyTask) {
    const qaAttempts = (buggyTask.attempts || []).filter(a =>
      a.type === 'qa' || a.type === 'qa-recheck'
    );
    details.qaAttempts[BUGGY_TASK] = qaAttempts.map(a => ({
      outcome: a.outcome,
      notes: a.notes || '',
    }));

    const hasFailure = qaAttempts.some(a => a.outcome === 'failure');
    if (hasFailure) {
      details.bugDetected = true;
      bugDetectionScore = 1.0;
    }
  }

  // ── 2. False positive checks for each working task ──

  let falsePositiveScore = 0;

  for (const workingId of WORKING_TASKS) {
    const task = tasks.find(t => t.id === workingId);
    const weight = WORKING_TASK_WEIGHTS[workingId];

    if (!task) {
      // Task not found — no false positive, partial credit
      details.correctPasses.push(workingId);
      falsePositiveScore += weight;
      continue;
    }

    const qaAttempts = (task.attempts || []).filter(a =>
      a.type === 'qa' || a.type === 'qa-recheck'
    );
    details.qaAttempts[workingId] = qaAttempts.map(a => ({
      outcome: a.outcome,
      notes: a.notes || '',
    }));

    const hasFailure = qaAttempts.some(a => a.outcome === 'failure');

    if (hasFailure) {
      // False positive: marked working task as failed
      details.falsePositives.push(workingId);
      // No credit for this task
    } else {
      // Correctly did not fail the working task
      details.correctPasses.push(workingId);
      falsePositiveScore += weight;
    }
  }

  // ── 3. Diagnosis quality: do notes mention the actual bug? (weight: 0.15) ──

  let diagnosisScore = 0;

  if (buggyTask) {
    const qaAttempts = (buggyTask.attempts || []).filter(a =>
      (a.type === 'qa' || a.type === 'qa-recheck') && a.outcome === 'failure'
    );

    for (const attempt of qaAttempts) {
      const notes = (attempt.notes || '').toLowerCase();
      for (const keyword of DIAGNOSIS_KEYWORDS) {
        if (new RegExp(keyword, 'i').test(notes)) {
          diagnosisScore = 1.0;
          break;
        }
      }
      if (diagnosisScore > 0) break;
    }
  }

  details.diagnosisScore = diagnosisScore;

  // ── 4. Pipeline state updated correctly (weight: 0.10) ──

  let pipelineScore = 0;

  const pipelineState = phase.pipeline?.state;
  details.pipelineState = pipelineState;

  if (pipelineState === 'qa-failed') {
    details.pipelineCorrect = true;
    pipelineScore = 1.0;
  } else if (pipelineState === 'complete') {
    // Wrong: there is a bug, pipeline should not be complete
    details.pipelineCorrect = false;
    pipelineScore = 0;
  } else if (pipelineState === 'awaiting-qa') {
    // QA didn't update the pipeline state at all
    details.pipelineCorrect = false;
    pipelineScore = 0;
  }

  // ── Final score ───────────────────────────────────────────────────

  const score =
    (bugDetectionScore * 0.30) +
    falsePositiveScore +
    (diagnosisScore * 0.15) +
    (pipelineScore * 0.10);

  return {
    score: Math.round(score * 1000) / 1000, // 3 decimal places
    details,
  };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
