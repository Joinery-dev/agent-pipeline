#!/usr/bin/env node

/**
 * browser-test.js — Interactive browser scenario runner for QA agents.
 *
 * Executes scenario JSON files against a running app using Playwright.
 * On success, generates a Playwright spec file as a permanent regression test.
 *
 * Usage:
 *   node lib/browser-test.js --scenario .qa/scenarios/phase1/signup-flow.json
 *   node lib/browser-test.js --scenario <file> --phase <phaseId> --port 3000
 *   node lib/browser-test.js --dry-run --scenario <file>
 *
 * Scenario JSON format:
 *   {
 *     "name": "User can sign up",
 *     "steps": [
 *       { "action": "goto", "value": "/signup" },
 *       { "action": "fill", "selector": "input[name='email']", "value": "test@example.com" },
 *       { "action": "click", "selector": "button[type='submit']" },
 *       { "action": "waitForURL", "value": "/dashboard" },
 *       { "action": "assertVisible", "selector": "h1", "text": "Welcome" },
 *       { "action": "screenshot", "name": "after-signup" }
 *     ]
 *   }
 *
 * Exits 0 if scenario passes, 1 if it fails, 2 if skipped.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { spawn } from 'child_process';

// ── CLI Flags ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scenario' && args[i + 1]) flags.scenario = args[++i];
  else if (args[i] === '--phase' && args[i + 1]) flags.phase = args[++i];
  else if (args[i] === '--port' && args[i + 1]) flags.port = parseInt(args[++i]);
  else if (args[i] === '--dry-run') flags.dryRun = true;
}

if (!flags.scenario) {
  console.error('Usage: node lib/browser-test.js --scenario <file.json> [--phase <id>] [--port N] [--dry-run]');
  process.exit(2);
}

// ── Port Detection (reused from visual-check.js pattern) ─────────────────

function detectPort() {
  if (flags.port) return flags.port;
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const devScript = pkg.scripts?.dev || '';
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
    if (devScript.includes('next')) return 3000;
    if (devScript.includes('vite')) return 5173;
  } catch (err) {
    console.error(`[browser-test] detectPort: failed to read/parse package.json: ${err.message}`);
  }
  return 3000;
}

// ── Dev Server Management (reused from visual-check.js pattern) ──────────

async function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.ok || res.status === 404) return true;
    } catch (err) {
      // Server not ready yet — retry (expected during startup)
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function ensureDevServer(port) {
  try {
    const res = await fetch(`http://localhost:${port}`);
    if (res.ok || res.status === 404) return { started: false, running: true };
  } catch (err) {
    // No server running yet — will start one below
  }

  const proc = spawn('npm', ['run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, PORT: String(port) },
  });

  const ready = await waitForServer(port);
  if (!ready) {
    try { proc.kill(); } catch (err) {
      console.error(`[browser-test] ensureDevServer: failed to kill stalled dev server process: ${err.message}`);
    }
    return { started: false, running: false, error: 'Dev server failed to start' };
  }

  return { started: true, running: true, proc };
}

// ── Step Executor ────────────────────────────────────────────────────────

async function executeStep(page, step, port, screenshotDir) {
  const start = Date.now();
  const result = { action: step.action, passed: false, durationMs: 0 };

  try {
    switch (step.action) {
      case 'goto': {
        const url = step.value.startsWith('http') ? step.value : `http://localhost:${port}${step.value}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        result.passed = true;
        break;
      }

      case 'click': {
        if (step.text) {
          await page.getByText(step.text, { exact: step.exact || false }).click({ timeout: 10000 });
        } else {
          await page.locator(step.selector).click({ timeout: 10000 });
        }
        result.passed = true;
        break;
      }

      case 'fill': {
        await page.locator(step.selector).fill(step.value, { timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'select': {
        await page.locator(step.selector).selectOption(step.value, { timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'check': {
        await page.locator(step.selector).check({ timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'uncheck': {
        await page.locator(step.selector).uncheck({ timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'waitForURL': {
        const pattern = step.value.startsWith('http') ? step.value : `**${step.value}`;
        await page.waitForURL(pattern, { timeout: 15000 });
        result.passed = true;
        break;
      }

      case 'waitForSelector': {
        await page.waitForSelector(step.selector, { timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'assertVisible': {
        const locator = step.text
          ? page.locator(step.selector).filter({ hasText: step.text })
          : page.locator(step.selector);
        await locator.first().waitFor({ state: 'visible', timeout: 10000 });
        result.passed = true;
        break;
      }

      case 'assertText': {
        const el = page.locator(step.selector).first();
        await el.waitFor({ state: 'visible', timeout: 10000 });
        const text = await el.textContent();
        if (step.contains) {
          result.passed = text.includes(step.value);
        } else {
          result.passed = text.trim() === step.value;
        }
        if (!result.passed) result.error = `Expected "${step.value}", got "${text?.trim()}"`;
        break;
      }

      case 'assertURL': {
        const url = page.url();
        result.passed = url.includes(step.value);
        if (!result.passed) result.error = `URL "${url}" doesn't match "${step.value}"`;
        break;
      }

      case 'assertNotVisible': {
        const hidden = page.locator(step.selector).first();
        try {
          await hidden.waitFor({ state: 'hidden', timeout: 5000 });
          result.passed = true;
        } catch (err) {
          result.passed = false;
          result.error = `Element "${step.selector}" is still visible`;
        }
        break;
      }

      case 'screenshot': {
        const name = step.name || `step-${Date.now()}`;
        const path = resolve(screenshotDir, `${name}.png`);
        await page.screenshot({ path, fullPage: step.fullPage || false });
        result.passed = true;
        result.screenshot = relative('.', path);
        break;
      }

      case 'wait': {
        await page.waitForTimeout(step.value || 1000);
        result.passed = true;
        break;
      }

      default:
        result.error = `Unknown action: ${step.action}`;
    }
  } catch (err) {
    result.error = err.message;
  }

  result.durationMs = Date.now() - start;
  return result;
}

// ── Spec File Generator ──────────────────────────────────────────────────

function generateSpecFile(scenario, phaseId) {
  const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const prefix = phaseId ? `${phaseId.slice(0, 8)}-` : '';
  const filename = `tests/qa/${prefix}${slug}.spec.js`;

  const steps = scenario.steps
    .filter(s => s.action !== 'screenshot' && s.action !== 'wait')
    .map(step => {
      switch (step.action) {
        case 'goto':
          return `    await page.goto('${step.value}');`;
        case 'click':
          return step.text
            ? `    await page.getByText('${step.text}'${step.exact ? ', { exact: true }' : ''}).click();`
            : `    await page.locator('${step.selector}').click();`;
        case 'fill':
          return `    await page.locator('${step.selector}').fill('${step.value}');`;
        case 'select':
          return `    await page.locator('${step.selector}').selectOption('${step.value}');`;
        case 'check':
          return `    await page.locator('${step.selector}').check();`;
        case 'uncheck':
          return `    await page.locator('${step.selector}').uncheck();`;
        case 'waitForURL':
          return `    await page.waitForURL('**${step.value}');`;
        case 'waitForSelector':
          return `    await page.waitForSelector('${step.selector}');`;
        case 'assertVisible':
          return step.text
            ? `    await expect(page.locator('${step.selector}').filter({ hasText: '${step.text}' })).toBeVisible();`
            : `    await expect(page.locator('${step.selector}')).toBeVisible();`;
        case 'assertText':
          return step.contains
            ? `    await expect(page.locator('${step.selector}')).toContainText('${step.value}');`
            : `    await expect(page.locator('${step.selector}')).toHaveText('${step.value}');`;
        case 'assertURL':
          return `    expect(page.url()).toContain('${step.value}');`;
        case 'assertNotVisible':
          return `    await expect(page.locator('${step.selector}')).not.toBeVisible();`;
        default:
          return `    // Unknown action: ${step.action}`;
      }
    });

  const spec = `// Auto-generated by browser-test.js from scenario: ${scenario.name}
// Phase: ${phaseId || 'unknown'}
// Generated: ${new Date().toISOString()}

import { test, expect } from '@playwright/test';

test('${scenario.name.replace(/'/g, "\\'")}', async ({ page }) => {
${steps.join('\n')}
});
`;

  const dir = dirname(resolve(filename));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(filename), spec);

  return filename;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Load scenario
  const scenarioPath = resolve(flags.scenario);
  if (!existsSync(scenarioPath)) {
    console.log(JSON.stringify({ error: `Scenario file not found: ${scenarioPath}` }));
    process.exit(2);
  }

  let scenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf-8'));
  } catch (err) {
    console.log(JSON.stringify({ error: `Invalid scenario JSON: ${err.message}` }));
    process.exit(2);
  }

  if (!scenario.name || !Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    console.log(JSON.stringify({ error: 'Scenario must have "name" and non-empty "steps" array' }));
    process.exit(2);
  }

  if (flags.dryRun) {
    console.log(JSON.stringify({ dryRun: true, scenario: scenario.name, steps: scenario.steps.length }));
    process.exit(0);
  }

  // Ensure Playwright is available
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch (err) {
    console.error(`[browser-test] Playwright import failed: ${err.message}`);
    console.log(JSON.stringify({ skipped: true, reason: 'Playwright not installed' }));
    process.exit(2);
  }

  // Ensure dev server
  const port = detectPort();
  const server = await ensureDevServer(port);
  if (!server.running) {
    console.log(JSON.stringify({ skipped: true, reason: server.error || 'Cannot start dev server' }));
    process.exit(2);
  }

  // Set up screenshot directory
  const screenshotDir = resolve('.qa/screenshots/interactive');
  if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

  // Launch browser and run scenario
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const startTime = Date.now();
  const stepResults = [];
  const screenshots = [];
  let allPassed = true;

  for (const step of scenario.steps) {
    const result = await executeStep(page, step, port, screenshotDir);
    stepResults.push(result);

    if (result.screenshot) screenshots.push(result.screenshot);

    if (!result.passed) {
      allPassed = false;
      // Take a failure screenshot
      try {
        const failPath = resolve(screenshotDir, `failure-${Date.now()}.png`);
        await page.screenshot({ path: failPath });
        screenshots.push(relative('.', failPath));
      } catch (err) {
        console.error(`[browser-test] failed to capture failure screenshot: ${err.message}`);
      }
      break; // Stop on first failure
    }
  }

  await browser.close();

  // Generate spec file on success
  let specFile = null;
  if (allPassed) {
    specFile = generateSpecFile(scenario, flags.phase);
  }

  const output = {
    passed: allPassed,
    scenario: scenario.name,
    steps: stepResults,
    screenshots,
    specFile,
    durationMs: Date.now() - startTime,
  };

  console.log(JSON.stringify(output, null, 2));

  // Kill server if we started it
  if (server.started && server.proc) {
    try { server.proc.kill(); } catch (err) {
      console.error(`[browser-test] failed to kill dev server on cleanup: ${err.message}`);
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
});
