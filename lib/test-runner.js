#!/usr/bin/env node

/**
 * Test Runner — Tiered test execution with structured output
 *
 * Usage:
 *   node lib/test-runner.js                     # Tier 1: changed files only
 *   node lib/test-runner.js --tier 2            # All unit tests
 *   node lib/test-runner.js --tier 3            # Full suite incl. slow
 *   node lib/test-runner.js --files "a.js,b.js" # Specific test files
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';

const args = process.argv.slice(2);

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
      if (flags[key] !== true) i++;
    }
  }
  return flags;
}

function loadTiers() {
  const tiersPath = resolve('tests/tiers.json');
  if (existsSync(tiersPath)) {
    return JSON.parse(readFileSync(tiersPath, 'utf-8'));
  }
  return { slow: [], skip_in_ci: [] };
}

function getChangedFiles() {
  try {
    const diff = execSync('git diff --name-only HEAD', { encoding: 'utf-8' }).trim();
    const staged = execSync('git diff --name-only --cached', { encoding: 'utf-8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8' }).trim();
    const all = [...new Set([...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')])];
    return all.filter(f => f && (f.endsWith('.js') || f.endsWith('.mjs')));
  } catch {
    return [];
  }
}

function mapToTestFiles(changedFiles) {
  const allTests = readdirSync('tests').filter(f => f.endsWith('.test.js')).map(f => `tests/${f}`);
  const matched = new Set();

  for (const changed of changedFiles) {
    const base = basename(changed, '.js').replace('.test', '');

    // Direct test file match
    const directTest = `tests/${base}.test.js`;
    if (allTests.includes(directTest)) {
      matched.add(directTest);
      continue;
    }

    // Fuzzy: look for test files that contain the base name
    for (const test of allTests) {
      const testBase = basename(test, '.test.js');
      if (testBase.includes(base) || base.includes(testBase)) {
        matched.add(test);
      }
    }
  }

  return [...matched];
}

function getAllUnitTests(tiers) {
  const slow = new Set(tiers.slow || []);
  const skip = new Set(tiers.skip_in_ci || []);
  const excluded = new Set([...slow, ...skip]);

  return readdirSync('tests')
    .filter(f => f.endsWith('.test.js'))
    .map(f => `tests/${f}`)
    .filter(f => !excluded.has(f));
}

function getAllTests() {
  return readdirSync('tests')
    .filter(f => f.endsWith('.test.js'))
    .map(f => `tests/${f}`);
}

function parseTestOutput(output) {
  const lines = output.split('\n');
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const line of lines) {
    // Node test runner output patterns
    if (line.includes('# tests')) {
      const m = line.match(/# tests\s+(\d+)/);
      if (m) total = parseInt(m[1]);
    }
    if (line.includes('# pass')) {
      const m = line.match(/# pass\s+(\d+)/);
      if (m) passed = parseInt(m[1]);
    }
    if (line.includes('# fail')) {
      const m = line.match(/# fail\s+(\d+)/);
      if (m) failed = parseInt(m[1]);
    }
    if (line.includes('# skipped') || line.includes('# todo')) {
      const m = line.match(/# (?:skipped|todo)\s+(\d+)/);
      if (m) skipped += parseInt(m[1]);
    }
  }

  // Extract failure details
  let inFailure = false;
  let currentFailure = null;
  for (const line of lines) {
    if (line.includes('not ok') || line.includes('✖') || line.includes('FAIL')) {
      inFailure = true;
      currentFailure = { name: line.trim(), details: '' };
      continue;
    }
    if (inFailure && currentFailure) {
      if (line.trim() === '' || line.includes('ok ') || line.includes('✓')) {
        if (currentFailure.name) failures.push(currentFailure);
        inFailure = false;
        currentFailure = null;
      } else {
        currentFailure.details += line.trim() + '\n';
      }
    }
  }
  if (inFailure && currentFailure && currentFailure.name) {
    failures.push(currentFailure);
  }

  // Fallback: if we couldn't parse, use exit code
  if (total === 0 && passed === 0 && failed === 0) {
    // Count ok/not ok lines
    for (const line of lines) {
      if (/^\s*ok\s+\d+/.test(line) || line.includes('✓')) passed++;
      if (/^\s*not ok\s+\d+/.test(line) || line.includes('✖')) failed++;
    }
    total = passed + failed;
  }

  return { total, passed, failed, skipped, failures };
}

function runTests(testFiles, tier) {
  if (testFiles.length === 0) {
    return {
      tier,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: 0,
      failures: [],
      message: 'No test files matched',
    };
  }

  const start = Date.now();
  let output = '';
  let exitCode = 0;

  try {
    output = execSync(`node --test ${testFiles.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 300000, // 5 min max
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = (err.stdout || '') + '\n' + (err.stderr || '');
    exitCode = err.status || 1;
  }

  const duration_ms = Date.now() - start;
  const parsed = parseTestOutput(output);

  return {
    tier,
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    duration_ms,
    failures: parsed.failures.slice(0, 10), // Cap at 10 failures
    files: testFiles,
  };
}

// ── Main ──────────────────────────────────────────────────────────────

const flags = parseFlags(args);
const tiers = loadTiers();

let testFiles;
let tier;

if (flags.files) {
  testFiles = flags.files.split(',').map(f => f.trim());
  tier = 0; // explicit files
} else if (flags.tier) {
  tier = parseInt(flags.tier);
  if (tier === 3) {
    testFiles = getAllTests();
  } else if (tier === 2) {
    testFiles = getAllUnitTests(tiers);
  } else {
    tier = 1;
    const changed = getChangedFiles();
    testFiles = mapToTestFiles(changed);
    if (testFiles.length === 0) {
      // Fallback: run all unit tests if no changed files detected
      testFiles = getAllUnitTests(tiers);
      tier = 2;
    }
  }
} else {
  tier = 1;
  const changed = getChangedFiles();
  testFiles = mapToTestFiles(changed);
  if (testFiles.length === 0) {
    testFiles = getAllUnitTests(tiers);
    tier = 2;
  }
}

const result = runTests(testFiles, tier);
console.log(JSON.stringify(result, null, 2));
process.exit(result.failed > 0 ? 1 : 0);
