/**
 * pipeline-sync.js — Automated goals sync checks.
 *
 * Runs deterministic checks that the PM used to do via LLM instructions:
 * stale task detection, phase rollup, orphaned plan detection.
 *
 * Usage: node lib/pipeline-sync.js [--stale-days 2]
 * Output: JSON array of findings to stdout.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, relative } from 'path';
import { getAllPhases } from './pipeline.js';

const GOALS_PATH = resolve('.goals.json');
const PLANS_DIR = resolve('plans');

function readGoals() {
  if (!existsSync(GOALS_PATH)) return null;
  return JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
}

// ── Stale task detection ────────────────────────────────────────────────

function detectStaleTasks(goals, staleDays = 2) {
  const findings = [];
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks || []) {
      if (task.status !== 'in-progress') continue;

      const attempts = task.attempts || [];
      if (attempts.length === 0) {
        findings.push({
          type: 'stale',
          severity: 'MEDIUM',
          phase: phase.title,
          task: task.title,
          message: `Task is in-progress but has no attempts`,
        });
        continue;
      }

      const latest = attempts[attempts.length - 1];
      const latestDate = new Date(latest.createdAt);
      if (latestDate < cutoff) {
        const daysSince = Math.round((Date.now() - latestDate.getTime()) / (24 * 60 * 60 * 1000));
        findings.push({
          type: 'stale',
          severity: 'MEDIUM',
          phase: phase.title,
          task: task.title,
          message: `Last attempt was ${daysSince} days ago (${latest.outcome})`,
        });
      }
    }
  }
  return findings;
}

// ── Phase status rollup ─────────────────────────────────────────────────

function rollupPhases(goals) {
  const findings = [];
  let modified = false;

  for (const phase of getAllPhases(goals)) {
    const tasks = phase.tasks || [];
    if (tasks.length === 0) continue;

    const statuses = tasks.map(t => t.status);
    let newStatus = phase.status;

    if (statuses.every(s => s === 'completed')) {
      newStatus = 'completed';
    } else if (statuses.some(s => s === 'blocked')) {
      newStatus = 'blocked';
    } else if (statuses.some(s => s === 'in-progress')) {
      newStatus = 'in-progress';
    } else if (statuses.every(s => s === 'not-started')) {
      newStatus = 'not-started';
    }

    if (newStatus !== phase.status) {
      findings.push({
        type: 'rollup',
        severity: 'INFO',
        phase: phase.title,
        message: `Phase status: ${phase.status} → ${newStatus}`,
      });
      phase.status = newStatus;
      modified = true;
    }
  }

  return { findings, modified, goals };
}

// ── Orphaned plan detection ─────────────────────────────────────────────

function detectOrphanedPlans(goals) {
  const findings = [];

  if (!existsSync(PLANS_DIR)) return findings;

  // Collect all planFile references from goals
  const referenced = new Set();
  for (const phase of getAllPhases(goals)) {
    if (phase.planFile) referenced.add(phase.planFile);
    for (const task of phase.tasks || []) {
      if (task.planFile) referenced.add(task.planFile);
    }
  }

  // Check each plan file in plans/
  const planFiles = readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
  for (const file of planFiles) {
    const relPath = `plans/${file}`;
    if (!referenced.has(relPath)) {
      findings.push({
        type: 'orphan',
        severity: 'LOW',
        message: `Plan file ${relPath} is not referenced by any phase or task in .goals.json`,
        planFile: relPath,
      });
    }
  }

  return findings;
}

// ── Major phase summary rollup ───────────────────────────────────────────

function generateSummaries(goals) {
  if (!Array.isArray(goals.majorPhases)) return { modified: false };

  let modified = false;

  for (const mp of goals.majorPhases) {
    const phases = mp.phases || [];
    if (phases.length === 0) {
      const newSummary = 'No phases defined yet.';
      if (mp.summary !== newSummary) { mp.summary = newSummary; modified = true; }
      continue;
    }

    const total = phases.length;
    const completed = phases.filter(p => p.status === 'completed').length;
    const blocked = phases.filter(p => p.status === 'blocked');
    const inProgress = phases.filter(p => p.status === 'in-progress');

    const parts = [`${completed}/${total} phases complete.`];

    for (const p of inProgress) {
      const tasksDone = (p.tasks || []).filter(t => t.status === 'completed').length;
      const tasksTotal = (p.tasks || []).length;
      parts.push(`${p.title} in-progress (${tasksDone}/${tasksTotal} tasks).`);
    }

    for (const p of blocked) {
      // Check what's blocking it
      if (Array.isArray(p.dependsOn) && p.dependsOn.length > 0) {
        const depNames = p.dependsOn.map(depId => {
          const dep = getAllPhases(goals).find(x => x.id === depId);
          return dep ? dep.title : depId;
        });
        parts.push(`Blocked: ${p.title} (waiting on ${depNames.join(', ')}).`);
      } else {
        parts.push(`Blocked: ${p.title}.`);
      }
    }

    // Interface contracts summary
    const produced = [];
    for (const p of phases) {
      if (p.status === 'completed' && p.interfaceContract?.produces) {
        produced.push(...p.interfaceContract.produces);
      }
    }
    if (produced.length > 0) {
      parts.push(`Interfaces available: ${produced.join(', ')}.`);
    }

    const newSummary = parts.join(' ');
    if (mp.summary !== newSummary) {
      mp.summary = newSummary;
      modified = true;
    }
  }

  return { modified };
}

// ── Main ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const staleDays = args.includes('--stale-days')
  ? parseInt(args[args.indexOf('--stale-days') + 1], 10)
  : 2;

const goals = readGoals();
if (!goals) {
  console.log(JSON.stringify([]));
  process.exit(0);
}

const allFindings = [];

// Stale detection
allFindings.push(...detectStaleTasks(goals, staleDays));

// Orphaned plans
allFindings.push(...detectOrphanedPlans(goals));

// Phase rollup (may modify goals)
const { findings: rollupFindings, modified: rollupModified } = rollupPhases(goals);
allFindings.push(...rollupFindings);

// Major phase summary rollup
const { modified: summaryModified } = generateSummaries(goals);

const modified = rollupModified || summaryModified;

// Write back if anything changed
if (modified) {
  const { writeFileSync } = await import('fs');
  writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
  // Validate
  JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
}

// Output findings
console.log(JSON.stringify(allFindings, null, 2));
