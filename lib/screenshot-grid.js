#!/usr/bin/env node

/**
 * screenshot-grid.js — Generate a visual overview of the entire product.
 *
 * Takes screenshots of all pages and composites them into a single grid image.
 * Used by the exec final review to see the whole product at a glance.
 *
 * Usage:
 *   node lib/screenshot-grid.js                          # screenshot all pages, generate grid
 *   node lib/screenshot-grid.js --from-dir .qa/screenshots/latest  # grid from existing screenshots
 *   node lib/screenshot-grid.js --output path/to/grid.png
 *
 * Output: .qa/screenshots/product-grid.png (default)
 *         .qa/screenshots/product-grid.html (the HTML source)
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { resolve, join, relative, basename } from 'path';

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const fromDir = getArg('from-dir');
const outputPath = resolve(getArg('output') || '.qa/screenshots/product-grid.png');
const outputHtml = outputPath.replace(/\.png$/, '.html');

// ── Discover or reuse screenshots ────────────────────────────────────────

async function getScreenshots() {
  if (fromDir) {
    // Use existing screenshots from a directory
    const dir = resolve(fromDir);
    if (!existsSync(dir)) {
      console.log(JSON.stringify({ error: `Directory not found: ${dir}` }));
      process.exit(1);
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
    return files.map(f => ({
      route: '/' + f.replace('.png', '').replace(/^index$/, '').replace(/-/g, '/'),
      path: resolve(join(dir, f)),
    }));
  }

  // Take fresh screenshots using visual-check's discoverPages + Playwright
  let discoverPages, startDevServer;
  try {
    const vc = await import('./visual-check.js');
    discoverPages = vc.discoverPages;
  } catch {
    console.log(JSON.stringify({ error: 'Could not import visual-check.js' }));
    process.exit(1);
  }

  const pages = discoverPages();
  if (pages.length === 0) {
    console.log(JSON.stringify({ skipped: true, reason: 'No pages discovered' }));
    process.exit(0);
  }

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.log(JSON.stringify({ skipped: true, reason: 'Playwright not installed' }));
    process.exit(2);
  }

  // Find or start dev server
  const { execSync } = await import('child_process');
  let port = null;

  // Check common dev server ports
  for (const p of [3000, 3001, 5173, 4321, 8080]) {
    try {
      execSync(`lsof -i :${p} -t`, { stdio: 'pipe' });
      port = p;
      break;
    } catch { /* not listening */ }
  }

  if (!port) {
    console.log(JSON.stringify({ skipped: true, reason: 'No dev server running. Start one first.' }));
    process.exit(0);
  }

  const screenshotDir = resolve('.qa/screenshots/grid-source');
  if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

  const browser = await chromium.launch();
  const screenshots = [];

  for (const page of pages) {
    if (page.route.includes('[')) continue; // skip dynamic routes

    const url = `http://localhost:${port}${page.route}`;
    const shotName = page.route === '/' ? 'index' : page.route.replace(/\//g, '-').slice(1);
    const shotPath = join(screenshotDir, `${shotName}.png`);

    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const tab = await ctx.newPage();
      await tab.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await tab.waitForTimeout(1000);
      await tab.screenshot({ path: shotPath, fullPage: false }); // viewport only, not full page
      await ctx.close();

      screenshots.push({ route: page.route, path: resolve(shotPath) });
    } catch (err) {
      // Skip failed pages
    }
  }

  await browser.close();
  return screenshots;
}

// ── Generate grid HTML ───────────────────────────────────────────────────

function generateGridHtml(screenshots) {
  const cols = screenshots.length <= 4 ? 2 : screenshots.length <= 9 ? 3 : 4;

  const imageCards = screenshots.map(s => {
    const label = s.route === '/' ? 'Home' : s.route.replace(/\//g, ' / ').trim();
    return `
      <div style="background:#1a1a2e;border-radius:8px;overflow:hidden;border:1px solid #333;">
        <img src="file://${s.path}" style="width:100%;display:block;" />
        <div style="padding:8px 12px;color:#c0c0d8;font-size:13px;font-family:system-ui,sans-serif;border-top:1px solid #333;">
          ${label}
        </div>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Product Overview</title></head>
<body style="margin:0;padding:24px;background:#0d0d1a;min-height:100vh;">
  <div style="
    display:grid;
    grid-template-columns:repeat(${cols}, 1fr);
    gap:16px;
    max-width:${cols * 350}px;
    margin:0 auto;
  ">
    ${imageCards}
  </div>
</body>
</html>`;
}

// ── Render grid to PNG ───────────────────────────────────────────────────

async function renderGrid(htmlPath, pngPath, screenshotCount) {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.log(JSON.stringify({ gridHtml: htmlPath, gridPng: null, reason: 'Playwright not installed — HTML grid generated but not rendered to PNG' }));
    return false;
  }

  const cols = screenshotCount <= 4 ? 2 : screenshotCount <= 9 ? 3 : 4;
  const rows = Math.ceil(screenshotCount / cols);
  const width = cols * 350 + 48 + (cols - 1) * 16;
  const height = rows * 280 + 48 + (rows - 1) * 16;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(`file://${resolve(htmlPath)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const screenshots = await getScreenshots();

  if (screenshots.length === 0) {
    console.log(JSON.stringify({ skipped: true, reason: 'No screenshots to grid' }));
    process.exit(0);
  }

  // Ensure output directory exists
  const outDir = resolve(outputPath, '..');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // Generate HTML grid
  const html = generateGridHtml(screenshots);
  writeFileSync(outputHtml, html);

  // Render to PNG
  const rendered = await renderGrid(outputHtml, outputPath, screenshots.length);

  console.log(JSON.stringify({
    pages: screenshots.length,
    routes: screenshots.map(s => s.route),
    gridHtml: relative('.', outputHtml),
    gridPng: rendered ? relative('.', outputPath) : null,
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
});
