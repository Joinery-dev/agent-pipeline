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
 *   node lib/visual-check.js --mockup-compare           # compare screenshots vs mockup illustrations
 *   node lib/visual-check.js --phase <phaseId>          # tag screenshots with phase
 *   node lib/visual-check.js --port 3000                # override dev server port
 *   node lib/visual-check.js --dry-run                  # show what would be checked
 *
 * Exits 0 if all checks pass, 1 if issues found, 2 if skipped (no UI project).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join, relative } from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// ── Config ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline') flags.baseline = true;
  else if (args[i] === '--compare') flags.compare = true;
  else if (args[i] === '--mockup-compare') flags.mockupCompare = true;
  else if (args[i] === '--dry-run') flags.dryRun = true;
  else if (args[i] === '--phase' && args[i + 1]) flags.phase = args[++i];
  else if (args[i] === '--port' && args[i + 1]) flags.port = parseInt(args[++i]);
}

const SCREENSHOTS_DIR = resolve('.qa/screenshots');
const BASELINE_FILE = resolve('.qa/screenshots/baseline.json');

// Auto-detect port from package.json dev script or use default
function detectPort() {
  if (flags.port) return flags.port;
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const devScript = pkg.scripts?.dev || '';
    // Match --port or -p followed by a number
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/);
    if (portMatch) return parseInt(portMatch[1]);
    // Next.js default
    if (devScript.includes('next')) return 3000;
    // Vite default
    if (devScript.includes('vite')) return 5173;
  } catch (err) {
    console.error(`[visual-check] detectPort: failed to read/parse package.json: ${err.message}`);
  }
  return 3000;
}

const PORT = detectPort();

// ── Page Discovery ──────────────────────────────────────────────────────

export function discoverPages(baseDir = '.') {
  const appDir = resolve(baseDir, 'app');
  if (!existsSync(appDir)) return [];

  const pages = [];

  function walk(dir, routePath) {
    const entries = readdirSync(dir);

    // Check for page.js/page.tsx/page.jsx
    const hasPage = entries.some(e => /^page\.(js|jsx|ts|tsx)$/.test(e));
    if (hasPage) {
      pages.push({
        route: routePath || '/',
        file: relative(baseDir, join(dir, entries.find(e => /^page\./.test(e)))),
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
    } catch (err) {
      // Server not ready yet — retry (expected during startup)
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function ensureDevServer(port) {
  // Check if already running
  try {
    const res = await fetch(`http://localhost:${port}`);
    if (res.ok || res.status === 404) return { started: false, running: true };
  } catch (err) {
    // No server running yet — will start one below
  }

  // Try to start it — store PID so we can clean up reliably
  const proc = spawn('npm', ['run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false, // Don't orphan — we'll clean up ourselves
    env: { ...process.env, PORT: String(port) },
  });

  const ready = await waitForServer(port);
  if (!ready) {
    try { proc.kill(); } catch (err) {
      console.error(`[visual-check] ensureDevServer: failed to kill stalled dev server process: ${err.message}`);
    }
    return { started: false, running: false, error: 'Dev server failed to start' };
  }

  return { started: true, running: true, proc };
}

// ── Screenshot & Visibility Check ───────────────────────────────────────

async function checkPages(pages, port) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch (err) {
    console.error(`[visual-check] Playwright import failed: ${err.message}`);
    return { skipped: true, reason: 'Playwright not installed' };
  }

  const browser = await chromium.launch({ headless: true });
  const results = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shotDir = join(SCREENSHOTS_DIR, flags.phase ? `${flags.phase}-${timestamp}` : timestamp);
  mkdirSync(shotDir, { recursive: true });

  // Cleanup runs after screenshots are taken (see cleanupScreenshots below)

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

  // Clean up: delete 404/error screenshots from this run, then dedupe across all dirs
  cleanupScreenshots(shotDir, results);

  return { skipped: false, results, screenshotDir: relative('.', shotDir) };
}

/**
 * Remove screenshots that are 404s/errors and exact duplicates across dirs.
 * Keeps all unique screenshots as visual history.
 */
function cleanupScreenshots(currentDir, results) {
  try {
    // 1. Delete screenshots from this run where the page failed to load
    let deletedErrors = 0;
    for (const r of results) {
      if (r.error && r.screenshot) {
        try { unlinkSync(resolve(r.screenshot)); deletedErrors++; } catch (err) {
          console.error(`[visual-check] cleanupScreenshots: failed to delete error screenshot ${r.screenshot}: ${err.message}`);
        }
      }
    }

    // 2. Delete exact duplicate screenshots across all dirs.
    // Hash every .png in SCREENSHOTS_DIR, delete files with matching hashes
    // in older dirs (keep the newest copy).
    const allDirs = readdirSync(SCREENSHOTS_DIR).filter(d => {
      try { return statSync(join(SCREENSHOTS_DIR, d)).isDirectory(); } catch (err) {
        console.error(`[visual-check] cleanupScreenshots: failed to stat dir ${d}: ${err.message}`);
        return false;
      }
    }).sort(); // lexicographic = oldest first

    // Build hash → [{ path, dir }] mapping
    const hashMap = new Map();
    for (const dir of allDirs) {
      const dirPath = join(SCREENSHOTS_DIR, dir);
      let files;
      try { files = readdirSync(dirPath).filter(f => f.endsWith('.png')); } catch (err) {
        console.error(`[visual-check] cleanupScreenshots: failed to read dir ${dirPath}: ${err.message}`);
        continue;
      }
      for (const file of files) {
        const filePath = join(dirPath, file);
        try {
          const content = readFileSync(filePath);
          const hash = createHash('md5').update(content).digest('hex');
          if (!hashMap.has(hash)) hashMap.set(hash, []);
          hashMap.get(hash).push({ path: filePath, dir });
        } catch (err) {
          console.error(`[visual-check] cleanupScreenshots: failed to hash ${filePath}: ${err.message}`);
        }
      }
    }

    // For each hash with multiple files, keep only the newest (last in sorted order)
    let deletedDupes = 0;
    for (const [, entries] of hashMap) {
      if (entries.length <= 1) continue;
      // Keep the last one (newest dir), delete the rest
      for (const entry of entries.slice(0, -1)) {
        try { unlinkSync(entry.path); deletedDupes++; } catch (err) {
          console.error(`[visual-check] cleanupScreenshots: failed to delete duplicate ${entry.path}: ${err.message}`);
        }
      }
    }

    // 3. Remove any now-empty dirs
    for (const dir of allDirs) {
      const dirPath = join(SCREENSHOTS_DIR, dir);
      try {
        const remaining = readdirSync(dirPath);
        if (remaining.length === 0) rmSync(dirPath, { recursive: true, force: true });
      } catch (err) {
        console.error(`[visual-check] cleanupScreenshots: failed to remove empty dir ${dirPath}: ${err.message}`);
      }
    }

    if (deletedErrors > 0 || deletedDupes > 0) {
      // Log is not available here (not imported), just silently clean up
    }
  } catch (err) {
    console.error(`[visual-check] cleanupScreenshots: unexpected error during cleanup: ${err.message}`);
  }
}

// ── Baseline Management ─────────────────────────────────────────────────

export function saveBaseline(results, baselineFile = BASELINE_FILE) {
  const baseline = {};
  for (const r of results) {
    baseline[r.route] = {
      visibleSections: r.visibleSections,
      totalSections: r.totalSections,
      screenshot: r.screenshot,
      timestamp: new Date().toISOString(),
    };
  }
  mkdirSync(resolve(baselineFile, '..'), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
  return baseline;
}

export function compareToBaseline(results, baselineFile = BASELINE_FILE) {
  if (!existsSync(baselineFile)) return { compared: false, reason: 'No baseline exists' };

  const baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
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

// ── Mockup Comparison ───────────────────────────────────────────────────

/**
 * Load all illustrations from .goals.json with source context.
 */
export function loadIllustrations(goalsPath = '.goals.json') {
  const resolved = resolve(goalsPath);
  if (!existsSync(resolved)) return [];

  const goals = JSON.parse(readFileSync(resolved, 'utf-8'));
  const illustrations = [];

  function collect(entity, context) {
    if (Array.isArray(entity.illustrations)) {
      for (const ill of entity.illustrations) {
        illustrations.push({ ...ill, _source: context });
      }
    }
  }

  collect(goals, { type: 'project', name: goals.name });

  if (Array.isArray(goals.majorPhases)) {
    for (const mp of goals.majorPhases) {
      collect(mp, { type: 'majorPhase', name: mp.title });
      if (Array.isArray(mp.phases)) {
        for (const phase of mp.phases) {
          collect(phase, { type: 'phase', name: phase.title });
        }
      }
    }
  }

  if (Array.isArray(goals.phases)) {
    for (const phase of goals.phases) {
      collect(phase, { type: 'phase', name: phase.title });
    }
  }

  return illustrations;
}

/**
 * Slugify a string for route matching.
 */
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Match illustrations to screenshot results by route/name heuristic.
 */
export function matchIllustrationsToScreenshots(illustrations, results) {
  const matched = [];
  const unmatchedIllustrations = [];
  const matchedRoutes = new Set();

  for (const ill of illustrations) {
    const nameSlug = slugify(ill._source.name);
    const nameSlugNoPage = nameSlug.replace(/-page$/, '');
    let bestMatch = null;

    for (const r of results) {
      const routeSlug = r.route === '/' ? '' : slugify(r.route.replace(/^\//, ''));
      // Root route: match "homepage", "home-page", "index", or project-level illustrations
      if (r.route === '/' && (nameSlugNoPage === 'home' || nameSlugNoPage === 'homepage' ||
          nameSlug === 'index' || ill._source.type === 'project')) {
        bestMatch = r;
        break;
      }
      // Match if the route slug appears in the source name slug or vice versa
      if (routeSlug && (nameSlug.includes(routeSlug) || routeSlug.includes(nameSlugNoPage) ||
          nameSlugNoPage === routeSlug)) {
        bestMatch = r;
        break;
      }
    }

    if (bestMatch) {
      matched.push({ illustration: ill, screenshot: bestMatch, route: bestMatch.route });
      matchedRoutes.add(bestMatch.route);
    } else {
      unmatchedIllustrations.push(ill);
    }
  }

  const unmatchedScreenshots = results.filter(r => !matchedRoutes.has(r.route));

  return { matched, unmatchedIllustrations, unmatchedScreenshots };
}

/**
 * Compare a mockup illustration against a built screenshot structurally.
 * Returns metadata for human/agent review — no pixel diffing.
 */
export async function compareStructural(mockupPath, screenshotPath, browser) {
  const result = {
    mockup: { path: mockupPath, fileSize: 0 },
    screenshot: { path: screenshotPath, fileSize: 0 },
    aspectRatioMatch: null,
    sideBySidePath: null,
  };

  // File size comparison
  try {
    result.mockup.fileSize = statSync(resolve(mockupPath)).size;
  } catch (err) {
    console.error(`[visual-check] compareStructural: could not stat mockup ${mockupPath}: ${err.message}`);
  }
  try {
    result.screenshot.fileSize = statSync(resolve(screenshotPath)).size;
  } catch (err) {
    console.error(`[visual-check] compareStructural: could not stat screenshot ${screenshotPath}: ${err.message}`);
  }

  // Generate side-by-side if Playwright browser available
  if (browser) {
    try {
      const slug = screenshotPath.replace(/[/\\]/g, '-').replace(/\.png$/, '');
      const sideBySidePath = join(SCREENSHOTS_DIR, `compare-${slug}.png`);
      mkdirSync(resolve(SCREENSHOTS_DIR), { recursive: true });

      const mockupAbsolute = resolve(mockupPath);
      const screenshotAbsolute = resolve(screenshotPath);

      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#111;display:flex;gap:20px;align-items:flex-start;">
  <div style="flex:1;min-width:0;">
    <div style="color:#666;font-size:12px;font-family:system-ui;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">Mockup</div>
    <img src="file://${mockupAbsolute}" style="width:100%;display:block;border-radius:4px;" />
  </div>
  <div style="flex:1;min-width:0;">
    <div style="color:#666;font-size:12px;font-family:system-ui;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">Built</div>
    <img src="file://${screenshotAbsolute}" style="width:100%;display:block;border-radius:4px;" />
  </div>
</body></html>`;

      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.screenshot({ path: sideBySidePath, fullPage: true });
      await ctx.close();

      result.sideBySidePath = relative('.', sideBySidePath);
    } catch (err) {
      // Side-by-side generation failed — non-fatal
      console.error(`[visual-check] compareStructural: side-by-side generation failed: ${err.message}`);
    }
  }

  return result;
}

/**
 * Write comparison manifest to stable path for downstream consumers.
 */
export function generateComparisonManifest(comparisons, matchResult, shotDir) {
  const manifest = {
    timestamp: new Date().toISOString(),
    comparisons: comparisons.map((c, i) => ({
      ...c,
      route: matchResult.matched[i]?.route,
      illustrationId: matchResult.matched[i]?.illustration.id,
      illustrationTitle: matchResult.matched[i]?.illustration.title,
    })),
    summary: {
      matched: matchResult.matched.length,
      unmatchedIllustrations: matchResult.unmatchedIllustrations.length,
      unmatchedScreenshots: matchResult.unmatchedScreenshots.length,
    },
  };

  // Write to the specific shot directory
  if (shotDir) {
    const dirManifest = join(shotDir, 'comparison.json');
    mkdirSync(resolve(shotDir), { recursive: true });
    writeFileSync(dirManifest, JSON.stringify(manifest, null, 2));
  }

  // Write to stable path for the Goals Side Panel to consume
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  writeFileSync(join(SCREENSHOTS_DIR, 'comparison.json'), JSON.stringify(manifest, null, 2));

  return manifest;
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
    console.log(JSON.stringify({ dryRun: true, pages, port: PORT, mockupCompare: !!flags.mockupCompare }, null, 2));
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
    if (server.started && server.proc) try { server.proc.kill(); } catch (err) {
      console.error(`[visual-check] failed to kill dev server on cleanup: ${err.message}`);
    }
    process.exit(2);
  }

  const output = {
    pages: check.results.length,
    screenshotDir: check.screenshotDir,
    results: check.results,
    issues: check.results.flatMap(r => r.issues || []),
  };

  // Register screenshots in .goals.json if phase is known
  if (flags.phase && check.results.length > 0) {
    const cliPath = resolve('lib/pipeline-cli.js');
    if (existsSync(cliPath)) {
      let registered = 0;
      for (const r of check.results) {
        if (!r.screenshot) continue;
        try {
          execSync(`node "${cliPath}" add-screenshot "${flags.phase}" --route "${r.route}" --imagePath "${r.screenshot}" --viewport 1280x800 --agent qa`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
          });
          registered++;
        } catch (err) {
          console.error(`[visual-check] failed to register screenshot for route ${r.route}: ${err.message}${err.stderr ? ' | stderr: ' + err.stderr.toString().slice(0, 200) : ''}`);
        }
      }
      if (registered > 0) output.registered = registered;
    }
  }

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

  // Compare against mockup illustrations if requested
  if (flags.mockupCompare) {
    const illustrations = loadIllustrations();
    if (illustrations.length > 0) {
      const matchResult = matchIllustrationsToScreenshots(illustrations, check.results);

      // Try to get a Playwright browser for side-by-side generation
      let browser = null;
      try {
        const pw = await import('playwright');
        browser = await pw.chromium.launch({ headless: true });
      } catch (err) {
        // Playwright not available — comparisons still work, just no side-by-side PNGs
        console.error(`[visual-check] Playwright unavailable for mockup comparison: ${err.message}`);
      }

      const comparisons = [];
      for (const match of matchResult.matched) {
        const comp = await compareStructural(
          match.illustration.imagePath,
          match.screenshot.screenshot,
          browser,
        );
        comparisons.push(comp);
      }

      if (browser) try { await browser.close(); } catch (err) {
        console.error(`[visual-check] failed to close Playwright browser: ${err.message}`);
      }

      output.mockupComparison = generateComparisonManifest(comparisons, matchResult, check.screenshotDir);
    } else {
      output.mockupComparison = { skipped: true, reason: 'No illustrations in .goals.json' };
    }
  }

  // Determine pass/fail
  const hasIssues = output.issues.length > 0;
  const hasRegressions = (output.regressions || []).length > 0;
  output.passed = !hasIssues && !hasRegressions;

  console.log(JSON.stringify(output, null, 2));

  // Kill server if we started it
  if (server.started && server.pid) try { process.kill(-server.pid); } catch (err) {
    console.error(`[visual-check] failed to kill dev server (pid ${server.pid}) on exit: ${err.message}`);
  }

  process.exit(output.passed ? 0 : 1);
}

// Only run main() when executed as a CLI script, not when imported
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.log(JSON.stringify({ skipped: true, reason: err.message }, null, 2));
    process.exit(2);
  });
}
