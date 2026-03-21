#!/usr/bin/env node

/**
 * plan-to-tasks.js — Deterministically extract tasks from a plan file
 * and create them in .goals.json via pipeline-cli.js.
 *
 * Usage:
 *   node lib/plan-to-tasks.js --plan plans/foundation.md --phase <phaseId>
 *   node lib/plan-to-tasks.js --plan plans/foundation.md --phase <phaseId> --dry-run
 *
 * Parses ### Task N: Title sections, extracts description, files, and
 * dependencies, then runs pipeline-cli.js add-task for each.
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const PIPELINE_CLI = resolve('lib/pipeline-cli.js');

// ── Arg parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
let planFile = null;
let phaseId = null;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan' && args[i + 1]) planFile = args[++i];
  else if (args[i] === '--phase' && args[i + 1]) phaseId = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
}

if (!planFile || !phaseId) {
  console.error('Usage: node lib/plan-to-tasks.js --plan <file> --phase <phaseId> [--dry-run]');
  process.exit(1);
}

const planPath = resolve(planFile);
if (!existsSync(planPath)) {
  console.error(`Plan file not found: ${planPath}`);
  process.exit(1);
}

// ── Plan parsing ────────────────────────────────────────────────────

const content = readFileSync(planPath, 'utf-8');
const tasks = [];

// Split on ### Task headings
const sections = content.split(/^### Task \d+:\s*/m).slice(1);
const headingRe = /^### Task \d+:\s*(.+)$/gm;
const titles = [];
let match;
while ((match = headingRe.exec(content)) !== null) {
  titles.push(match[1].trim());
}

for (let i = 0; i < titles.length; i++) {
  const title = titles[i];
  const section = sections[i] || '';

  // Extract description — first paragraph after the title, or **Description**: block
  let description = '';
  const descMatch = section.match(/\*\*Description\*\*[:\s]*([^\n]+(?:\n(?!\*\*)[^\n]+)*)/i);
  if (descMatch) {
    description = descMatch[1].trim().replace(/\n/g, ' ').slice(0, 200);
  } else {
    // First non-empty line that isn't a heading or metadata
    const lines = section.split('\n').filter(l =>
      l.trim() && !l.startsWith('**') && !l.startsWith('---') && !l.startsWith('#')
    );
    description = (lines[0] || '').trim().slice(0, 200);
  }

  // Extract files
  let files = [];
  const filesMatch = section.match(/\*\*Files?\*\*[:\s]*([^\n]+)/i);
  if (filesMatch) {
    files = filesMatch[1]
      .split(/[,;]/)
      .map(f => f.replace(/`/g, '').trim())
      .filter(f => f && f.includes('.') || f.includes('/'));
  }

  // Extract depends on
  let dependsOn = [];
  const depsMatch = section.match(/\*\*Depends? on\*\*[:\s]*([^\n]+)/i);
  if (depsMatch) {
    const depsText = depsMatch[1].trim();
    if (!/nothing|none|n\/a/i.test(depsText)) {
      // Extract task numbers referenced
      const taskRefs = depsText.match(/Task\s*(\d+)/gi);
      if (taskRefs) {
        dependsOn = taskRefs.map(r => r.match(/\d+/)[0]);
      }
    }
  }

  tasks.push({ title, description, files, dependsOn });
}

if (tasks.length === 0) {
  console.error('No tasks found in plan file. Expected format: ### Task N: Title');
  process.exit(1);
}

// ── Create tasks ────────────────────────────────────────────────────

const results = [];

for (const task of tasks) {
  const taskArgs = [
    PIPELINE_CLI, 'add-task', phaseId,
    '--title', task.title,
    '--desc', task.description || task.title,
  ];

  if (task.files.length > 0) {
    taskArgs.push('--files', task.files.join(','));
  }

  if (dryRun) {
    console.log(`DRY RUN: node ${taskArgs.join(' ')}`);
    results.push({ title: task.title, files: task.files, dryRun: true });
  } else {
    try {
      const result = execFileSync('node', taskArgs, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(result);
      console.log(`Created: "${task.title}" → ${parsed.taskId}`);
      results.push({ title: task.title, taskId: parsed.taskId, files: task.files });
    } catch (err) {
      const msg = err.stderr?.trim() || err.message;
      console.error(`Failed: "${task.title}" — ${msg}`);
      results.push({ title: task.title, error: msg });
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────

console.log(JSON.stringify({
  plan: planFile,
  phaseId,
  tasksFound: tasks.length,
  tasksCreated: results.filter(r => r.taskId).length,
  results,
}, null, 2));
