#!/usr/bin/env node

/**
 * render-mockup.js — Render HTML mockup files to PNG screenshots.
 *
 * Usage:
 *   node lib/render-mockup.js --html mockup.html --output mockup.png --viewport 1280x800
 *   node lib/render-mockup.js --html mockup.html --output mockup-mobile.png --viewport 375x812
 *
 * Uses Playwright to render. Gracefully skips if Playwright not installed.
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--html' && args[i + 1]) flags.html = args[++i];
  else if (args[i] === '--output' && args[i + 1]) flags.output = args[++i];
  else if (args[i] === '--viewport' && args[i + 1]) flags.viewport = args[++i];
}

if (!flags.html || !flags.output) {
  console.error('Usage: node lib/render-mockup.js --html <file> --output <png> [--viewport WxH]');
  process.exit(1);
}

const htmlPath = resolve(flags.html);
if (!existsSync(htmlPath)) {
  console.log(JSON.stringify({ error: `HTML file not found: ${htmlPath}` }));
  process.exit(1);
}

const [width, height] = (flags.viewport || '1280x800').split('x').map(Number);
const outputPath = resolve(flags.output);

async function main() {
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.log(JSON.stringify({ skipped: true, reason: 'Playwright not installed' }));
    process.exit(2);
  }

  // Ensure output directory exists
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();

  // Load HTML file
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(500); // let fonts/rendering settle

  // Take screenshot
  await page.screenshot({ path: outputPath, fullPage: true });

  await browser.close();

  const { statSync } = await import('fs');
  const fileSize = statSync(outputPath).size;

  console.log(JSON.stringify({
    output: flags.output,
    viewport: { width, height },
    fileSize,
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
});
