#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for resolve-precision.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a Resolver agent has run, producing a single
 * score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Bug fixed (failing test passes):      40% weight
 *   - No regression (other 3 tests pass):   20% weight
 *   - Scope check (only formatter.js mod):  20% weight
 *   - .goals.json has build-fix attempt:    10% weight
 *   - Pipeline state set to awaiting-qa:    10% weight
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

function evaluate(dir) {
  const details = {
    bugFixed: false,
    noRegression: false,
    testsTotal: 0,
    testsPassed: 0,
    testsRan: false,
    scopeClean: false,
    modifiedFiles: [],
    hasBuildFixAttempt: false,
    pipelineState: null,
  };

  // ── 1. Run tests to check bug fix + regression (weight: 0.4 + 0.2) ──

  let testScore = 0;
  let bugFixScore = 0;
  let regressionScore = 0;

  try {
    const testResult = execSync('node --test tests/formatter.test.js', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    details.testsRan = true;
    const parsed = parseTestOutput(testResult);
    details.testsTotal = parsed.total;
    details.testsPassed = parsed.passed;
  } catch (err) {
    const output = (err.stdout || '') + (err.stderr || '');
    details.testsRan = output.length > 0;
    if (details.testsRan) {
      const parsed = parseTestOutput(output);
      details.testsTotal = parsed.total;
      details.testsPassed = parsed.passed;
    }
  }

  // Fallback: try with shell redirect
  if (!details.testsRan || details.testsTotal === 0) {
    try {
      const fallback = execSync('node --test tests/formatter.test.js 2>&1 || true', {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 30000,
        shell: true,
      });
      if (fallback.includes('tests') || fallback.includes('pass')) {
        details.testsRan = true;
        const parsed = parseTestOutput(fallback);
        details.testsTotal = parsed.total;
        details.testsPassed = parsed.passed;
      }
    } catch {
      // Final fallback failed
    }
  }

  // All 4 tests passing means bug fixed + no regression
  if (details.testsTotal === 4 && details.testsPassed === 4) {
    details.bugFixed = true;
    details.noRegression = true;
    bugFixScore = 1.0;
    regressionScore = 1.0;
  } else if (details.testsTotal > 0) {
    // Check if the negative number test specifically passes
    // If 4/4 isn't met, check if at least 3 non-bug tests pass (regression check)
    if (details.testsPassed >= 3) {
      // At least 3 pass — likely no regression but bug may still exist
      regressionScore = 1.0;
      details.noRegression = true;
      if (details.testsPassed === 4) {
        bugFixScore = 1.0;
        details.bugFixed = true;
      }
    } else if (details.testsPassed > 0) {
      regressionScore = (details.testsPassed - 1) / 3; // partial regression credit
    }
  }

  // ── 2. Scope check: only lib/formatter.js modified (weight: 0.2) ────
  //
  // Compare known scaffold files against their original content.
  // Files that should NOT be modified (only lib/formatter.js and .goals.json
  // are expected to change).

  let scopeScore = 0;

  const guardedFiles = {
    'tests/formatter.test.js': "import { describe, it } from 'node:test';",
    'plans/formatter.md': '# Plan: Formatter Module',
    'package.json': '{\n  "type": "module"\n}\n',
    'lib/pipeline.js': null, // just check existence, not content
    'lib/pipeline-cli.js': null,
  };

  for (const [relPath, sentinel] of Object.entries(guardedFiles)) {
    const fullPath = resolve(dir, relPath);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, 'utf-8');
      let modified = false;
      if (sentinel === null) {
        // Existence-only check — these shouldn't be deleted but content doesn't matter
        continue;
      } else if (relPath === 'package.json') {
        modified = content.trim() !== sentinel.trim();
      } else {
        // Check if file still starts with the expected sentinel
        modified = !content.startsWith(sentinel);
      }
      if (modified) {
        details.modifiedFiles.push(relPath);
      }
    } catch {
      // Can't read file — skip
    }
  }

  // Also check if new unexpected files were created
  try {
    const knownFiles = new Set([
      'lib/formatter.js', 'lib/pipeline.js', 'lib/pipeline-cli.js',
      'tests/formatter.test.js', 'plans/formatter.md',
      'package.json', '.goals.json',
    ]);
    const checkDirs = ['lib', 'tests', 'plans'];
    for (const subdir of checkDirs) {
      const subdirPath = resolve(dir, subdir);
      if (!existsSync(subdirPath)) continue;
      const files = readdirSync(subdirPath);
      for (const f of files) {
        const rel = `${subdir}/${f}`;
        if (!knownFiles.has(rel)) {
          details.modifiedFiles.push(`NEW: ${rel}`);
        }
      }
    }
  } catch {
    // Directory listing failed
  }

  if (details.modifiedFiles.length === 0) {
    scopeScore = 1.0;
    details.scopeClean = true;
  } else {
    // Deduct for each extra file modified
    scopeScore = Math.max(0, 1.0 - (details.modifiedFiles.length * 0.5));
  }

  // ── 3. .goals.json: build-fix attempt (weight: 0.1) ────────────────

  let attemptScore = 0;

  try {
    const goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
    const phases = goals.majorPhases?.[0]?.phases || goals.phases || [];
    const tasks = phases.flatMap(p => p.tasks || []);
    const task = tasks[0];

    if (task) {
      const buildFixAttempts = (task.attempts || []).filter(a => a.type === 'build-fix');
      if (buildFixAttempts.length > 0) {
        details.hasBuildFixAttempt = true;
        attemptScore = 1.0;
      }
    }

    // ── 4. Pipeline state set to awaiting-qa (weight: 0.1) ─────────

    const phase = phases[0];
    if (phase?.pipeline?.state) {
      details.pipelineState = phase.pipeline.state;
    }
  } catch {
    // .goals.json not readable or malformed
  }

  let pipelineScore = details.pipelineState === 'awaiting-qa' ? 1.0 : 0;

  // ── Final score ─────────────────────────────────────────────────

  const score =
    (bugFixScore * 0.4) +
    (regressionScore * 0.2) +
    (scopeScore * 0.2) +
    (attemptScore * 0.1) +
    (pipelineScore * 0.1);

  return {
    score: Math.round(score * 1000) / 1000,
    details,
  };
}

function parseTestOutput(output) {
  let total = 0;
  let passed = 0;

  const totalMatch = output.match(/tests\s+(\d+)/i) || output.match(/# tests\s+(\d+)/);
  const passMatch = output.match(/pass\s+(\d+)/i) || output.match(/# pass\s+(\d+)/);

  if (totalMatch) total = parseInt(totalMatch[1]);
  if (passMatch) passed = parseInt(passMatch[1]);

  // Fallback: count checkmarks and x marks
  if (total === 0) {
    const checks = (output.match(/✔/g) || []).length;
    const fails = (output.match(/✖/g) || []).length;
    total = checks + fails;
    passed = checks;
  }

  return { total, passed };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
