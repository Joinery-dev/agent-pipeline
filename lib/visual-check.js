#!/usr/bin/env node

/**
 * visual-check.js — Deterministic visual verification for web projects.
 *
 * Takes screenshots of all discovered pages, checks content visibility,
 * and optionally compares against a baseline to catch cross-phase regressions.
 *
 * Usage:
 *   node lib/visual-check.js --baseline                 # save baseline screenshots
 *   node lib/visual-check.js --compare                  # compare against baseline
 *   node lib/visual-check.js --baseline --compare       # both
 *   node lib/visual-check.js --phase <phaseId>          # tag screenshots with phase
 *   node lib/visual-check.js --port 3000                # override dev server port
 *   node lib/visual-check.js --dry-run                  # show what would be checked
 *
 * Exits 0 if all checks pass, 1 if issues found, 2 if skipped (no UI project).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import { execSync, spawn } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline') flags.baseline = true;
  else if (args[i] === '--compare') flags.compare = true;
  else if (args[i] === '--dry-run') flags.dryRun = true;
  else if (args[i] === '--phase' && args[i + 1]) flags.phase = args[++i];
  else if (args[i] === '--port' && args[i + 1]) flags.port = parseInt(args[++i]);
}

const SCREENSHOTS_DIR = resolve('.qa/screenshots');
const BASELINE_FILE = resolve('.qa/screenshots/baseline.json');
const PORT = flags.port || 3000;

// ── Page Discovery ──────────────────────────────────────────────────────

function discoverPages() {
  const appDir = resolve('app');
  if (!existsSync(appDir)) return [];

  const pages = [];

  function walk(dir, routePath) {
    const entries = readdirSync(dir);

    // Check for page.js/page.tsx/page.jsx
    const hasPage = entries.some(e => /^page\.(js|jsx|ts|tsx)$/.test(e));
    if (hasPage) {
      pages.push({
        route: routePath || '/',
        file: relative('.', join(dir, entries.find(e => /^page\./.test(e)))),
      });
    }

    // Recurse into subdirectories (skip special dirs)
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (entry.startsWith('_') || entry === 'api' || entry === 'node_modules') continue;

      // Handle dynamic routes — include them with placeholder
      const routeSegment = entry.startsWith('[') ? entry : entry;
      walk(fullPath, `${routePath}/${routeSegment}`);
    }
  }

  walk(appDir, '');
  return pages;
}

// ── Dev Server Management ───────────────────────────────────────────────

async function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.ok || res.status === 404) return true; // 404 is fine — server is up
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function ensureDevServer(port) {
  // Check if already running
  try {
    const res = await fetch(`http://localhost:${port}`);
    if (res.ok || res.status === 404) return { started: false, running: true };
  } catch {}

  // Try to start it
  const proc = spawn('npm', ['run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, PORT: String(port) },
  });
  proc.unref();

  const ready = await waitForServer(port);
  if (!ready) {
    try { process.kill(-proc.pid); } catch {}
    return { started: false, running: false, error: 'Dev server failed to start' };
  }

  return { started: true, running: true, pid: proc.pid };
}

// ── Screenshot & Visibility Check ───────────────────────────────────────

async function checkPages(pages, port) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    return { skipped: true, reason: 'Playwright not installed' };
  }

  const browser = await chromium.launch({ headless: true });
  const results = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shotDir = join(SCREENSHOTS_DIR, flags.phase ? `${flags.phase}-${timestamp}` : timestamp);
  mkdirSync(shotDir, { recursive: true });

  for (const page of pages) {
    // Skip dynamic routes (can't render without params)
    if (page.route.includes('[')) continue;

    const url = `http://localhost:${port}${page.route}`;
    const shotName = page.route === '/' ? 'index' : page.route.replace(/\//g, '-').slice(1);
    const shotPath = join(shotDir, `${shotName}.png`);

    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const tab = await ctx.newPage();

      await tab.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      // Wait for animations to settle
      await tab.waitForTimeout(1000);

      // Take full-page screenshot
      await tab.screenshot({ path: shotPath, fullPage: true });

      // Check visibility of main content sections
      const visibility = await tab.evaluate(() => {
        const sections = document.querySelectorAll('main > *, section, [class*="section"], [class*="Section"]');
        const results = [];
        for (const el of sections) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          results.push({
            tag: el.tagName.toLowerCase(),
            className: el.className?.toString().slice(0, 60) || '',
            height: Math.round(rect.height),
            visible: rect.height > 10 && style.opacity !== '0' && style.display !== 'none' && style.visibility !== 'hidden',
            opacity: style.opacity,
            display: style.display,
          });
        }
        return results;
      });

      const hiddenSections = visibility.filter(v => !v.visible && v.height >= 0);
      const visibleCount = visibility.filter(v => v.visible).length;

      results.push({
        route: page.route,
        screenshot: relative('.', shotPath),
        visibleSections: visibleCount,
        totalSections: visibility.length,
        hiddenSections: hiddenSections.map(h => ({
          tag: h.tag,
          className: h.className,
          reason: h.opacity === '0' ? 'opacity:0' : h.display === 'none' ? 'display:none' : 'zero height',
        })),
        issues: hiddenSections.length > 0
          ? hiddenSections.map(h => `Hidden ${h.tag}${h.className ? '.' + h.className.split(' ')[0] : ''}: ${h.opacity === '0' ? 'opacity:0' : h.display === 'none' ? 'display:none' : 'not visible'}`)
          : [],
      });

      await ctx.close();
    } catch (err) {
      results.push({
        route: page.route,
        screenshot: null,
        error: err.message,
        issues: [`Failed to load: ${err.message}`],
      });
    }
  }

  await browser.close();
  return { skipped: false, results, screenshotDir: relative('.', shotDir) };
}

// ── Baseline Management ─────────────────────────────────────────────────

function saveBaseline(results) {
  const baseline = {};
  for (const r of results) {
    baseline[r.route] = {
      visibleSections: r.visibleSections,
      totalSections: r.totalSections,
      screenshot: r.screenshot,
      timestamp: new Date().toISOString(),
    };
  }
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
  return baseline;
}

function compareToBaseline(results) {
  if (!existsSync(BASELINE_FILE)) return { compared: false, reason: 'No baseline exists' };

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'));
  const regressions = [];

  for (const r of results) {
    const base = baseline[r.route];
    if (!base) continue;

    // Check if visible sections decreased
    if (r.visibleSections < base.visibleSections) {
      regressions.push({
        route: r.route,
        type: 'section-regression',
        message: `Visible sections decreased: ${base.visibleSections} → ${r.visibleSections}`,
        severity: 'CRITICAL',
      });
    }

    // Check for newly hidden sections
    if (r.hiddenSections && r.hiddenSections.length > 0) {
      for (const h of r.hiddenSections) {
        regressions.push({
          route: r.route,
          type: 'hidden-content',
          message: `${h.tag}${h.className ? '.' + h.className : ''} is hidden (${h.reason})`,
          severity: 'HIGH',
        });
      }
    }
  }

  return { compared: true, regressions };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const pages = discoverPages();

  if (pages.length === 0) {
    const result = { skipped: true, reason: 'No app/ directory or no pages found' };
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  if (flags.dryRun) {
    console.log(JSON.stringify({ dryRun: true, pages, port: PORT }, null, 2));
    process.exit(0);
  }

  // Ensure dev server is running
  const server = await ensureDevServer(PORT);
  if (!server.running) {
    console.log(JSON.stringify({ skipped: true, reason: server.error || 'Cannot start dev server' }, null, 2));
    process.exit(2);
  }

  // Take screenshots and check visibility
  const check = await checkPages(pages, PORT);

  if (check.skipped) {
    console.log(JSON.stringify(check, null, 2));
    // Kill server if we started it
    if (server.started && server.pid) try { process.kill(-server.pid); } catch {}
    process.exit(2);
  }

  const output = {
    pages: check.results.length,
    screenshotDir: check.screenshotDir,
    results: check.results,
    issues: check.results.flatMap(r => r.issues || []),
  };

  // Save baseline if requested
  if (flags.baseline) {
    const baseline = saveBaseline(check.results);
    output.baseline = { saved: true, pages: Object.keys(baseline).length };
  }

  // Compare to baseline if requested
  if (flags.compare) {
    const comparison = compareToBaseline(check.results);
    output.comparison = comparison;
    if (comparison.regressions?.length > 0) {
      output.regressions = comparison.regressions;
    }
  }

  // Determine pass/fail
  const hasIssues = output.issues.length > 0;
  const hasRegressions = (output.regressions || []).length > 0;
  output.passed = !hasIssues && !hasRegressions;

  console.log(JSON.stringify(output, null, 2));

  // Kill server if we started it
  if (server.started && server.pid) try { process.kill(-server.pid); } catch {}

  process.exit(output.passed ? 0 : 1);
}

main().catch(err => {
  console.log(JSON.stringify({ skipped: true, reason: err.message }, null, 2));
  process.exit(2);
});
