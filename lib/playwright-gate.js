#!/usr/bin/env node

/**
 * playwright-gate.js — Discovers and runs Playwright spec tests.
 *
 * Runs QA-written forest tests (tests/qa/) and Design-written visual
 * assertion tests (tests/design/). Returns structured JSON for ship.js.
 *
 * Usage:
 *   node lib/playwright-gate.js                              # all specs
 *   node lib/playwright-gate.js --dir tests/qa               # QA specs only
 *   node lib/playwright-gate.js --files "tests/qa/p1.spec.js,tests/design/p1.spec.js"
 *
 * Output (JSON):
 *   { passed, total, pass, fail, failingFiles, skipped, reason, duration_ms }
 *
 * Exit codes: 0 = all pass, 1 = failures found, 2 = skipped (no tests or no Playwright)
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

// ── Discover spec files ──────────────────────────────────────────────────

function discoverSpecs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.spec.js'))
    .map(f => join(dir, f));
}

function getTestFiles() {
  const dirArg = getArg('dir');
  const filesArg = getArg('files');

  if (filesArg) {
    return filesArg.split(',').map(f => f.trim()).filter(f => existsSync(f));
  }

  if (dirArg) {
    return discoverSpecs(dirArg);
  }

  // Default: discover all
  return [
    ...discoverSpecs('tests/qa'),
    ...discoverSpecs('tests/design'),
  ];
}

// ── Check Playwright availability ────────────────────────────────────────

function isPlaywrightAvailable() {
  try {
    execSync('npx playwright --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Run tests ────────────────────────────────────────────────────────────

function runSpecs(testFiles) {
  const start = Date.now();

  try {
    const output = execSync(
      `npx playwright test ${testFiles.join(' ')} --reporter=json`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      }
    );

    const duration_ms = Date.now() - start;

    // Parse JSON reporter output
    try {
      const report = JSON.parse(output);
      const total = (report.stats?.expected || 0) + (report.stats?.unexpected || 0) + (report.stats?.skipped || 0);
      const pass = report.stats?.expected || 0;
      const fail = report.stats?.unexpected || 0;

      return {
        passed: fail === 0,
        total,
        pass,
        fail,
        failingFiles: [],
        skipped: false,
        duration_ms,
      };
    } catch {
      // JSON parse failed but command succeeded — assume pass
      return { passed: true, total: testFiles.length, pass: testFiles.length, fail: 0, failingFiles: [], skipped: false, duration_ms };
    }
  } catch (err) {
    const duration_ms = Date.now() - start;
    const output = (err.stdout || '') + (err.stderr || '');

    // Try to parse JSON reporter output from failure
    let total = 0, pass = 0, fail = 0;
    const failingFiles = [];

    try {
      const report = JSON.parse(err.stdout || '{}');
      total = (report.stats?.expected || 0) + (report.stats?.unexpected || 0) + (report.stats?.skipped || 0);
      pass = report.stats?.expected || 0;
      fail = report.stats?.unexpected || 0;

      // Extract failing file paths from suites
      if (report.suites) {
        for (const suite of report.suites) {
          const hasFailure = (suite.specs || []).some(s => !s.ok);
          if (hasFailure && suite.file) {
            failingFiles.push(suite.file);
          }
        }
      }
    } catch {
      // Couldn't parse JSON — count from test files
      fail = testFiles.length;
      total = testFiles.length;
      failingFiles.push(...testFiles);
    }

    return {
      passed: false,
      total,
      pass,
      fail,
      failingFiles: failingFiles.length > 0 ? failingFiles : testFiles,
      skipped: false,
      duration_ms,
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const testFiles = getTestFiles();

if (testFiles.length === 0) {
  const result = { passed: true, total: 0, pass: 0, fail: 0, failingFiles: [], skipped: true, reason: 'no spec files found' };
  console.log(JSON.stringify(result));
  process.exit(2);
}

if (!isPlaywrightAvailable()) {
  const result = { passed: true, total: 0, pass: 0, fail: 0, failingFiles: [], skipped: true, reason: 'playwright not installed' };
  console.log(JSON.stringify(result));
  process.exit(2);
}

const result = runSpecs(testFiles);
console.log(JSON.stringify(result));
process.exit(result.passed ? 0 : 1);
