#!/usr/bin/env node

/**
 * link-check.js — Check all internal links and navigation in the product.
 *
 * Crawls every discovered page, finds all internal links (<a href>),
 * and verifies they resolve to actual pages. Reports broken links,
 * orphaned pages (no links point to them), and navigation issues.
 *
 * Usage:
 *   node lib/link-check.js              # check all links
 *   node lib/link-check.js --port 3001  # specify dev server port
 *
 * Output: JSON with broken links, orphaned pages, and navigation summary.
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const portArg = args.indexOf('--port') !== -1 ? args[args.indexOf('--port') + 1] : null;

// ── Discover pages ───────────────────────────────────────────────────────

let discoverPages;
try {
  const vc = await import('./visual-check.js');
  discoverPages = vc.discoverPages;
} catch {
  console.log(JSON.stringify({ error: 'Could not import visual-check.js' }));
  process.exit(1);
}

const pages = discoverPages();
const validRoutes = new Set(pages.map(p => p.route));

if (pages.length === 0) {
  console.log(JSON.stringify({ skipped: true, reason: 'No pages discovered' }));
  process.exit(0);
}

// ── Find dev server ──────────────────────────────────────────────────────

let port = portArg ? parseInt(portArg) : null;

if (!port) {
  for (const p of [3000, 3001, 5173, 4321, 8080]) {
    try {
      execSync(`lsof -i :${p} -t`, { stdio: 'pipe' });
      port = p;
      break;
    } catch { /* not listening */ }
  }
}

if (!port) {
  console.log(JSON.stringify({ skipped: true, reason: 'No dev server running' }));
  process.exit(0);
}

// ── Crawl pages for links ────────────────────────────────────────────────

let chromium;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch {
  console.log(JSON.stringify({ skipped: true, reason: 'Playwright not installed' }));
  process.exit(2);
}

const browser = await chromium.launch();
const brokenLinks = [];
const allLinksTo = new Set();
const pageLinks = {};

for (const page of pages) {
  if (page.route.includes('[')) continue;

  const url = `http://localhost:${port}${page.route}`;

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tab = await ctx.newPage();
    await tab.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

    // Extract all internal links
    const links = await tab.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => ({
        href: a.getAttribute('href'),
        text: a.textContent?.trim().slice(0, 50) || '',
        resolved: a.href,
      })).filter(l =>
        l.href &&
        !l.href.startsWith('http') &&
        !l.href.startsWith('mailto:') &&
        !l.href.startsWith('tel:') &&
        !l.href.startsWith('#')
      );
    });

    pageLinks[page.route] = links;

    for (const link of links) {
      // Normalize the href
      const target = link.href.split('?')[0].split('#')[0];
      const normalized = target.startsWith('/') ? target : `/${target}`;
      allLinksTo.add(normalized);

      // Check if target exists
      if (!validRoutes.has(normalized) && normalized !== '/') {
        brokenLinks.push({
          from: page.route,
          to: normalized,
          text: link.text,
        });
      }
    }

    await ctx.close();
  } catch (err) {
    brokenLinks.push({
      from: page.route,
      to: null,
      text: `Page failed to load: ${err.message}`,
    });
  }
}

await browser.close();

// ── Find orphaned pages ──────────────────────────────────────────────────

const orphanedPages = pages
  .filter(p => !p.route.includes('['))
  .filter(p => p.route !== '/') // home is never orphaned
  .filter(p => !allLinksTo.has(p.route))
  .map(p => p.route);

// ── Content check (placeholder text) ─────────────────────────────────────

const contentIssues = [];
const browser2 = await chromium.launch();

for (const page of pages) {
  if (page.route.includes('[')) continue;

  const url = `http://localhost:${port}${page.route}`;

  try {
    const ctx = await browser2.newContext({ viewport: { width: 1280, height: 800 } });
    const tab = await ctx.newPage();
    await tab.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

    const issues = await tab.evaluate(() => {
      const found = [];
      const body = document.body.innerText || '';

      // Check for placeholder text
      const placeholders = [
        /lorem ipsum/i,
        /dolor sit amet/i,
        /TODO/,
        /FIXME/,
        /placeholder/i,
        /coming soon/i,
        /under construction/i,
        /\[insert/i,
        /\{.*\}/,  // template variables like {name}
      ];

      for (const pattern of placeholders) {
        const match = body.match(pattern);
        if (match) {
          found.push(`Placeholder text: "${match[0]}"`);
        }
      }

      // Check for broken images
      const images = document.querySelectorAll('img');
      for (const img of images) {
        if (!img.complete || img.naturalHeight === 0) {
          found.push(`Broken image: ${img.src || img.alt || '(no src)'}`);
        }
      }

      // Check for empty sections
      const sections = document.querySelectorAll('main > *, section');
      for (const section of sections) {
        const text = section.textContent?.trim() || '';
        if (text.length === 0 && section.querySelectorAll('img, svg, canvas, video').length === 0) {
          const id = section.id || section.className?.toString().split(' ')[0] || section.tagName;
          found.push(`Empty section: ${id}`);
        }
      }

      return found;
    });

    if (issues.length > 0) {
      contentIssues.push({ route: page.route, issues });
    }

    await ctx.close();
  } catch {
    // Skip failed pages — already caught by link check
  }
}

await browser2.close();

// ── Output ───────────────────────────────────────────────────────────────

const output = {
  pagesChecked: pages.filter(p => !p.route.includes('[')).length,
  totalLinks: Object.values(pageLinks).reduce((sum, links) => sum + links.length, 0),
  brokenLinks,
  orphanedPages,
  contentIssues,
  summary: {
    broken: brokenLinks.length,
    orphaned: orphanedPages.length,
    contentProblems: contentIssues.reduce((sum, p) => sum + p.issues.length, 0),
  },
};

console.log(JSON.stringify(output, null, 2));
