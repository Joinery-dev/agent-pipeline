/**
 * Tests for visual-check.js exported functions.
 *
 * Run: node --test tests/visual-check.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  discoverPages,
  loadIllustrations,
  matchIllustrationsToScreenshots,
  saveBaseline,
  compareToBaseline,
} from '../lib/visual-check.js';

// ── discoverPages ────────────────────────────────────────────────────────

describe('discoverPages', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'discover-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no app/ directory', () => {
    const pages = discoverPages(tmpDir);
    assert.deepEqual(pages, []);
  });

  it('discovers root page.js as route /', () => {
    mkdirSync(join(tmpDir, 'app'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'page.js'), 'export default function Home() {}');
    const pages = discoverPages(tmpDir);
    assert.ok(pages.some(p => p.route === '/'));
  });

  it('discovers nested page.tsx as /about', () => {
    mkdirSync(join(tmpDir, 'app', 'about'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'about', 'page.tsx'), 'export default function About() {}');
    const pages = discoverPages(tmpDir);
    assert.ok(pages.some(p => p.route === '/about'));
  });

  it('skips api/ directories', () => {
    mkdirSync(join(tmpDir, 'app', 'api', 'health'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'api', 'health', 'page.js'), '');
    const pages = discoverPages(tmpDir);
    assert.ok(!pages.some(p => p.route.includes('api')));
  });

  it('skips _internal directories', () => {
    mkdirSync(join(tmpDir, 'app', '_internal'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', '_internal', 'page.js'), '');
    const pages = discoverPages(tmpDir);
    assert.ok(!pages.some(p => p.route.includes('_internal')));
  });

  it('discovers dynamic routes', () => {
    mkdirSync(join(tmpDir, 'app', 'blog', '[slug]'), { recursive: true });
    writeFileSync(join(tmpDir, 'app', 'blog', '[slug]', 'page.js'), '');
    const pages = discoverPages(tmpDir);
    assert.ok(pages.some(p => p.route === '/blog/[slug]'));
  });
});

// ── loadIllustrations ────────────────────────────────────────────────────

describe('loadIllustrations', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'load-ill-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no .goals.json', () => {
    const result = loadIllustrations(join(tmpDir, '.goals.json'));
    assert.deepEqual(result, []);
  });

  it('collects illustrations from all entity levels', () => {
    const goals = {
      id: 'p1', name: 'Project',
      illustrations: [{ id: 'ill-proj', title: 'Project Overview', imagePath: 'a.png', createdAt: 'x', updatedAt: 'x' }],
      majorPhases: [{
        id: 'mp1', title: 'Major Phase 1', status: 'not-started',
        illustrations: [{ id: 'ill-mp', title: 'MP Mockup', imagePath: 'b.png', createdAt: 'x', updatedAt: 'x' }],
        phases: [{
          id: 'ph1', title: 'Phase 1', status: 'not-started', order: 0, tasks: [],
          illustrations: [{ id: 'ill-ph', title: 'Phase Mockup', imagePath: 'c.png', createdAt: 'x', updatedAt: 'x' }],
        }],
      }],
    };
    const goalsPath = join(tmpDir, '.goals.json');
    writeFileSync(goalsPath, JSON.stringify(goals));

    const result = loadIllustrations(goalsPath);
    assert.equal(result.length, 3);
    assert.ok(result.some(i => i._source.type === 'project'));
    assert.ok(result.some(i => i._source.type === 'majorPhase'));
    assert.ok(result.some(i => i._source.type === 'phase'));
  });

  it('handles legacy phases[] at top level', () => {
    const goals = {
      id: 'p2', name: 'Legacy',
      phases: [{
        id: 'lp1', title: 'Legacy Phase', status: 'not-started', order: 0, tasks: [],
        illustrations: [{ id: 'ill-lp', title: 'Legacy', imagePath: 'd.png', createdAt: 'x', updatedAt: 'x' }],
      }],
    };
    const goalsPath = join(tmpDir, 'legacy.json');
    writeFileSync(goalsPath, JSON.stringify(goals));

    const result = loadIllustrations(goalsPath);
    assert.equal(result.length, 1);
    assert.equal(result[0]._source.type, 'phase');
  });
});

// ── matchIllustrationsToScreenshots ──────────────────────────────────────

describe('matchIllustrationsToScreenshots', () => {

  it('matches by slugified source name to route', () => {
    const illustrations = [
      { id: 'i1', _source: { type: 'phase', name: 'About Page' } },
      { id: 'i2', _source: { type: 'phase', name: 'Homepage' } },
    ];
    const results = [
      { route: '/', screenshot: 'index.png' },
      { route: '/about', screenshot: 'about.png' },
    ];

    const match = matchIllustrationsToScreenshots(illustrations, results);
    assert.equal(match.matched.length, 2);
    assert.ok(match.matched.some(m => m.route === '/about'));
  });

  it('reports unmatched illustrations', () => {
    const illustrations = [
      { id: 'i1', _source: { type: 'phase', name: 'Contact Page' } },
    ];
    const results = [
      { route: '/', screenshot: 'index.png' },
    ];

    const match = matchIllustrationsToScreenshots(illustrations, results);
    assert.equal(match.matched.length, 0);
    assert.equal(match.unmatchedIllustrations.length, 1);
  });

  it('reports unmatched screenshots', () => {
    const illustrations = [];
    const results = [
      { route: '/', screenshot: 'index.png' },
      { route: '/about', screenshot: 'about.png' },
    ];

    const match = matchIllustrationsToScreenshots(illustrations, results);
    assert.equal(match.unmatchedScreenshots.length, 2);
  });
});

// ── Baseline management ──────────────────────────────────────────────────

describe('saveBaseline and compareToBaseline', () => {
  let tmpDir;
  let baselineFile;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'baseline-'));
    baselineFile = join(tmpDir, 'baseline.json');
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compareToBaseline returns compared:false when no baseline', () => {
    const result = compareToBaseline([], join(tmpDir, 'nonexistent.json'));
    assert.equal(result.compared, false);
  });

  it('round-trip: save then compare with same data — no regressions', () => {
    const results = [
      { route: '/', visibleSections: 5, totalSections: 5, screenshot: 'index.png', hiddenSections: [] },
    ];
    saveBaseline(results, baselineFile);
    const comparison = compareToBaseline(results, baselineFile);
    assert.equal(comparison.compared, true);
    assert.equal(comparison.regressions.length, 0);
  });

  it('detects regression when visible sections decrease', () => {
    const original = [
      { route: '/', visibleSections: 5, totalSections: 5, screenshot: 'index.png', hiddenSections: [] },
    ];
    saveBaseline(original, baselineFile);

    const regressed = [
      { route: '/', visibleSections: 3, totalSections: 5, screenshot: 'index.png', hiddenSections: [] },
    ];
    const comparison = compareToBaseline(regressed, baselineFile);
    assert.equal(comparison.compared, true);
    assert.ok(comparison.regressions.length > 0);
    assert.ok(comparison.regressions.some(r => r.type === 'section-regression'));
  });

  it('detects hidden content', () => {
    const original = [
      { route: '/', visibleSections: 5, totalSections: 5, screenshot: 'index.png', hiddenSections: [] },
    ];
    saveBaseline(original, baselineFile);

    const hidden = [
      {
        route: '/', visibleSections: 5, totalSections: 6, screenshot: 'index.png',
        hiddenSections: [{ tag: 'section', className: 'hero', reason: 'opacity:0' }],
      },
    ];
    const comparison = compareToBaseline(hidden, baselineFile);
    assert.ok(comparison.regressions.some(r => r.type === 'hidden-content'));
  });
});
