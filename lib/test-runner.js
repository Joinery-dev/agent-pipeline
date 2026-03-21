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
  if (tier >= 5) {
    // Tier 5: E2E Playwright tests
    testFiles = getAllTests();
    tier = 5;
  } else if (tier === 4) {
    // Tier 4: Production build check
    testFiles = getAllTests();
  } else if (tier === 3) {
    testFiles = getAllTests();
  } else if (tier === 2) {
    testFiles = getAllUnitTests(tiers);
  } else {
    tier = 1;
    const changed = getChangedFiles();
    testFiles = mapToTestFiles(changed);
    if (testFiles.length === 0) {
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

// Run unit/integration tests first (tiers 1-3)
const result = runTests(testFiles, tier);

// Tier 4+: Production build check
if (tier >= 4 && result.failed === 0) {
  const buildResult = runBuildCheck();
  result.buildCheck = buildResult;
  if (!buildResult.passed) {
    result.failed += 1;
    result.failures.push({ name: 'Production build failed', details: buildResult.error });
  }
}

// Tier 5: E2E Playwright tests
if (tier >= 5 && result.failed === 0) {
  const e2eResult = runE2ETests();
  result.e2e = e2eResult;
  if (e2eResult.failed > 0) {
    result.failed += e2eResult.failed;
    result.failures.push(...(e2eResult.failures || []));
  }
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.failed > 0 ? 1 : 0);

// ── Tier 4: Build Check ─────────────────────────────────────────────

function runBuildCheck() {
  // Detect build command
  let buildCmd = null;
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    if (pkg.scripts?.build) buildCmd = 'npm run build';
  } catch {}

  // Detect framework-specific builds
  if (!buildCmd) {
    if (existsSync('next.config.js') || existsSync('next.config.mjs') || existsSync('next.config.ts')) {
      buildCmd = 'npx next build';
    } else if (existsSync('vite.config.js') || existsSync('vite.config.ts')) {
      buildCmd = 'npx vite build';
    }
  }

  if (!buildCmd) return { passed: true, skipped: true, reason: 'No build command detected' };

  try {
    execSync(buildCmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
    return { passed: true, command: buildCmd };
  } catch (err) {
    return { passed: false, command: buildCmd, error: (err.stderr || err.message).slice(0, 500) };
  }
}

// ── Tier 5: E2E Tests ───────────────────────────────────────────────

function runE2ETests() {
  // Check for Playwright tests
  const playwrightConfig = ['playwright.config.js', 'playwright.config.ts', 'playwright.config.cjs']
    .find(f => existsSync(f));

  if (!playwrightConfig) {
    // Check for e2e test directory
    const e2eDir = ['e2e', 'tests/e2e'].find(d => existsSync(d));
    if (!e2eDir) return { total: 0, passed: 0, failed: 0, skipped: true, reason: 'No e2e tests found' };
  }

  try {
    const output = execSync('npx playwright test --reporter=json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
    });
    try {
      const parsed = JSON.parse(output);
      return {
        total: parsed.stats?.expected || 0,
        passed: parsed.stats?.expected || 0,
        failed: parsed.stats?.unexpected || 0,
        failures: (parsed.suites || []).flatMap(s =>
          (s.specs || []).filter(sp => sp.ok === false).map(sp => ({ name: sp.title, details: sp.tests?.[0]?.results?.[0]?.error?.message || '' }))
        ),
      };
    } catch {
      return { total: 0, passed: 0, failed: 0, raw: output.slice(0, 200) };
    }
  } catch (err) {
    return {
      total: 0, passed: 0, failed: 1,
      failures: [{ name: 'Playwright test suite failed', details: (err.stderr || err.message).slice(0, 500) }],
    };
  }
}
