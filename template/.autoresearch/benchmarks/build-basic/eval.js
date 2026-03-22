#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for build-basic.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a Builder agent has run, producing a single
 * score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Test pass rate:          50% weight
 *   - Expected files created:  30% weight
 *   - .goals.json state:       20% weight
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

function evaluate(dir) {
  const details = {
    testsTotal: 0,
    testsPassed: 0,
    testsRan: false,
    filesExpected: ['lib/util.js'],
    filesFound: [],
    goalsUpdated: false,
    hasAttempt: false,
    pipelineState: null,
  };

  // ── 1. Test pass rate (weight: 0.5) ──────────────────────────────

  let testScore = 0;

  try {
    // Node test runner outputs to stderr; capture both stdout and stderr
    const testResult = execSync('node --test tests/util.test.js', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    details.testsRan = true;
    const parsed = parseTestOutput(testResult);
    details.testsTotal = parsed.total;
    details.testsPassed = parsed.passed;
    testScore = parsed.total > 0 ? parsed.passed / parsed.total : 0;
  } catch (err) {
    // Tests ran but some failed, or all passed but output is on stderr
    const output = (err.stdout || '') + (err.stderr || '');
    details.testsRan = output.length > 0;
    if (details.testsRan) {
      const parsed = parseTestOutput(output);
      details.testsTotal = parsed.total;
      details.testsPassed = parsed.passed;
      testScore = parsed.total > 0 ? parsed.passed / parsed.total : 0;
    }
  }

  // Fallback: if no tests were parsed, try running with shell redirect
  if (!details.testsRan || details.testsTotal === 0) {
    try {
      const fallback = execSync('node --test tests/util.test.js 2>&1 || true', {
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
        testScore = parsed.total > 0 ? parsed.passed / parsed.total : 0;
      }
    } catch {
      // Final fallback failed — leave score at 0
    }
  }

  // ── 2. Expected files created (weight: 0.3) ─────────────────────

  let fileScore = 0;
  for (const f of details.filesExpected) {
    if (existsSync(resolve(dir, f))) {
      details.filesFound.push(f);
    }
  }
  fileScore = details.filesExpected.length > 0
    ? details.filesFound.length / details.filesExpected.length
    : 0;

  // ── 3. .goals.json state updates (weight: 0.2) ──────────────────

  let stateScore = 0;
  try {
    const goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
    const phases = goals.majorPhases?.[0]?.phases || goals.phases || [];
    const tasks = phases.flatMap(p => p.tasks || []);
    const task = tasks[0];

    if (task) {
      // Check if task status was updated from not-started
      if (task.status !== 'not-started') {
        details.goalsUpdated = true;
        stateScore += 0.3;
      }

      // Check if a build attempt was logged
      const buildAttempts = (task.attempts || []).filter(a => a.type === 'build');
      if (buildAttempts.length > 0) {
        details.hasAttempt = true;
        stateScore += 0.4;

        // Check if attempt has a success outcome
        if (buildAttempts.some(a => a.outcome === 'success')) {
          stateScore += 0.3;
        }
      }
    }

    // Check pipeline state
    const phase = phases[0];
    if (phase?.pipeline?.state) {
      details.pipelineState = phase.pipeline.state;
      // Bonus for setting pipeline to awaiting-qa
      if (phase.pipeline.state === 'awaiting-qa') {
        stateScore = Math.min(1.0, stateScore + 0.1);
      }
    }
  } catch {
    // .goals.json not readable or malformed
  }

  stateScore = Math.min(1.0, stateScore);

  // ── Final score ─────────────────────────────────────────────────

  const score = (testScore * 0.5) + (fileScore * 0.3) + (stateScore * 0.2);

  return {
    score: Math.round(score * 1000) / 1000, // 3 decimal places
    details,
  };
}

function parseTestOutput(output) {
  let total = 0;
  let passed = 0;

  // Node.js test runner output format
  const totalMatch = output.match(/tests\s+(\d+)/i) || output.match(/# tests\s+(\d+)/);
  const passMatch = output.match(/pass\s+(\d+)/i) || output.match(/# pass\s+(\d+)/);
  const failMatch = output.match(/fail\s+(\d+)/i) || output.match(/# fail\s+(\d+)/);

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
