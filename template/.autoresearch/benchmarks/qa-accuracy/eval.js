#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for qa-accuracy.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a QA agent has run, producing a single
 * score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Bug detection (2 buggy tasks marked failed):   40% weight
 *   - Correct pass (working task not failed):         20% weight
 *   - Diagnosis quality (notes mention actual bug):   20% weight
 *   - Pipeline state updated (qa-failed):             10% weight
 *   - QA memory updated (status.json has verdict):    10% weight
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

const BUGGY_TASKS = ['qa-task-validate', 'qa-task-count'];
const WORKING_TASK = 'qa-task-format';

// Keywords that indicate the QA agent diagnosed the actual bug
const DIAGNOSIS_KEYWORDS = {
  'qa-task-validate': ['empty', 'empty string', 'not be empty', 'empty input', 'missing.*empty', 'does not reject', 'does not check'],
  'qa-task-count': ['off-by-one', 'off by one', 'index 1', 'index 0', 'skip', 'first element', 'starts at 1', 'i = 1'],
};

function evaluate(dir) {
  const details = {
    buggyTasksDetected: [],
    buggyTasksMissed: [],
    workingTaskCorrect: false,
    workingTaskFalsePositive: false,
    diagnosisScores: {},
    pipelineState: null,
    pipelineCorrect: false,
    memoryUpdated: false,
    qaAttempts: {},
  };

  let goals;
  try {
    goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
  } catch {
    // .goals.json not readable — score 0
    return { score: 0, details: { ...details, error: '.goals.json not readable' } };
  }

  // Extract all tasks from the phase
  const phases = goals.majorPhases?.[0]?.phases || goals.phases || [];
  const phase = phases.find(p => p.id === 'qa-phase');
  if (!phase) {
    return { score: 0, details: { ...details, error: 'qa-phase not found in .goals.json' } };
  }

  const tasks = phase.tasks || [];

  // ── 1. Bug detection: did QA mark buggy tasks as failed? (weight: 0.4) ──

  let bugDetectionScore = 0;

  for (const buggyId of BUGGY_TASKS) {
    const task = tasks.find(t => t.id === buggyId);
    if (!task) continue;

    const qaAttempts = (task.attempts || []).filter(a =>
      a.type === 'qa' || a.type === 'qa-recheck'
    );
    details.qaAttempts[buggyId] = qaAttempts.map(a => ({
      outcome: a.outcome,
      notes: a.notes || '',
    }));

    // Check if any QA attempt has outcome 'failure'
    const hasFailure = qaAttempts.some(a => a.outcome === 'failure');
    if (hasFailure) {
      details.buggyTasksDetected.push(buggyId);
      bugDetectionScore += 0.5; // 0.5 per bug found (2 bugs = 1.0)
    } else {
      details.buggyTasksMissed.push(buggyId);
    }
  }

  // ── 2. Correct pass: did QA pass the working task? (weight: 0.2) ──

  let correctPassScore = 0;

  const workingTask = tasks.find(t => t.id === WORKING_TASK);
  if (workingTask) {
    const qaAttempts = (workingTask.attempts || []).filter(a =>
      a.type === 'qa' || a.type === 'qa-recheck'
    );
    details.qaAttempts[WORKING_TASK] = qaAttempts.map(a => ({
      outcome: a.outcome,
      notes: a.notes || '',
    }));

    const hasSuccess = qaAttempts.some(a => a.outcome === 'success');
    const hasFailure = qaAttempts.some(a => a.outcome === 'failure');

    if (hasSuccess && !hasFailure) {
      // Correctly passed the working task
      details.workingTaskCorrect = true;
      correctPassScore = 1.0;
    } else if (!hasFailure) {
      // No QA attempt at all — partial credit for not false-positiving
      details.workingTaskCorrect = true;
      correctPassScore = 0.5;
    } else {
      // False positive: marked working task as failed
      details.workingTaskFalsePositive = true;
      correctPassScore = 0;
    }
  }

  // ── 3. Diagnosis quality: do notes mention the actual bug? (weight: 0.2) ──

  let diagnosisScore = 0;
  let diagnosisCount = 0;

  for (const buggyId of BUGGY_TASKS) {
    const task = tasks.find(t => t.id === buggyId);
    if (!task) continue;

    const qaAttempts = (task.attempts || []).filter(a =>
      (a.type === 'qa' || a.type === 'qa-recheck') && a.outcome === 'failure'
    );

    const keywords = DIAGNOSIS_KEYWORDS[buggyId] || [];
    let taskDiagScore = 0;

    for (const attempt of qaAttempts) {
      const notes = (attempt.notes || '').toLowerCase();
      for (const keyword of keywords) {
        if (new RegExp(keyword, 'i').test(notes)) {
          taskDiagScore = 1.0;
          break;
        }
      }
      if (taskDiagScore > 0) break;
    }

    details.diagnosisScores[buggyId] = taskDiagScore;
    diagnosisScore += taskDiagScore;
    diagnosisCount++;
  }

  if (diagnosisCount > 0) {
    diagnosisScore = diagnosisScore / diagnosisCount;
  }

  // ── 4. Pipeline state updated correctly (weight: 0.1) ──

  let pipelineScore = 0;

  const pipelineState = phase.pipeline?.state;
  details.pipelineState = pipelineState;

  if (pipelineState === 'qa-failed') {
    // Correct: there are bugs, so pipeline should be qa-failed
    details.pipelineCorrect = true;
    pipelineScore = 1.0;
  } else if (pipelineState === 'complete') {
    // Wrong: there are bugs, pipeline should not be complete
    details.pipelineCorrect = false;
    pipelineScore = 0;
  } else if (pipelineState === 'awaiting-qa') {
    // QA didn't update the pipeline state at all
    details.pipelineCorrect = false;
    pipelineScore = 0;
  }

  // ── 5. QA memory updated (weight: 0.1) ──

  let memoryScore = 0;

  try {
    const statusPath = resolve(dir, '.qa/memory/status.json');
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'));
      // Check if verdict was set (anything other than initial null)
      if (status.verdict !== null && status.verdict !== undefined) {
        details.memoryUpdated = true;
        memoryScore = 1.0;
      } else if (status.rounds > 0 || (status.taskResults && status.taskResults.length > 0)) {
        // Partial credit: updated something but not the verdict
        details.memoryUpdated = true;
        memoryScore = 0.5;
      }
    }
  } catch {
    // status.json not readable
  }

  // ── Final score ───────────────────────────────────────────────────

  const score =
    (bugDetectionScore * 0.4) +
    (correctPassScore * 0.2) +
    (diagnosisScore * 0.2) +
    (pipelineScore * 0.1) +
    (memoryScore * 0.1);

  return {
    score: Math.round(score * 1000) / 1000, // 3 decimal places
    details,
  };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
