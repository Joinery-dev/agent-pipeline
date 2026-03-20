#!/usr/bin/env node

/**
 * Memory Hygiene — Automated memory maintenance
 *
 * Usage:
 *   node lib/memory-hygiene.js              # Run all operations
 *   node lib/memory-hygiene.js --archive    # Archive only
 *   node lib/memory-hygiene.js --validate   # Validate only
 *   node lib/memory-hygiene.js --report     # Report only (dry run)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) flags[arg.slice(2)] = true;
}

const runAll = Object.keys(flags).length === 0;
const results = {
  archived: { decisions: 0, reviews: 0, learnings: 0 },
  stale_concerns: [],
  empty_warnings: [],
  actions_taken: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────

function safeRead(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function splitEntries(content, separator) {
  // Split on ## headings or --- separators
  const parts = content.split(separator).filter(p => p.trim());
  return parts;
}

function countShipRuns() {
  const log = safeRead('.ship/latest.log');
  if (!log) return 0;
  return (log.match(/🚀 ship\.js/g) || []).length || 1;
}

// ── Archive: enforce size caps ──────────────────────────────────────

function archiveEntries(filePath, archivePath, maxEntries, separator = /\n(?=## )/) {
  const content = safeRead(filePath);
  if (!content) return 0;

  const entries = content.split(separator).filter(e => e.trim());
  if (entries.length <= maxEntries) return 0;

  const toArchive = entries.slice(0, entries.length - maxEntries);
  const toKeep = entries.slice(entries.length - maxEntries);

  // Append archived entries
  const archiveContent = safeRead(archivePath) || '';
  writeFileSync(archivePath, archiveContent + '\n' + toArchive.join('\n## '));

  // Rewrite file with kept entries
  const prefix = entries[0].startsWith('## ') ? '' : '## ';
  writeFileSync(filePath, toKeep.map((e, i) => (i === 0 && !e.startsWith('## ') ? e : e)).join('\n## '));

  return toArchive.length;
}

function runArchive() {
  // decisions.md: keep last 20
  const decisionsArchived = archiveEntries(
    '.pm/memory/decisions.md',
    '.pm/memory/decisions-archive.md',
    20
  );
  results.archived.decisions = decisionsArchived;
  results.actions_taken += decisionsArchived;

  // reviews.md: keep last 15
  const reviewsArchived = archiveEntries(
    '.pm/memory/reviews.md',
    '.pm/memory/reviews-archive.md',
    15
  );
  results.archived.reviews = reviewsArchived;
  results.actions_taken += reviewsArchived;

  // learnings.txt: keep last 30 (split on ---)
  const learningsArchived = archiveEntries(
    '.qa/memory/learnings.txt',
    '.qa/memory/learnings-archive.txt',
    30,
    /\n(?=---)/
  );
  results.archived.learnings = learningsArchived;
  results.actions_taken += learningsArchived;
}

// ── Age: detect stale concerns ──────────────────────────────────────

function runAge() {
  const content = safeRead('.pm/memory/concerns.md');
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  let modified = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.includes('**Status:** OPEN')) continue;

    // Check if opened date is old (> 3 days as proxy for 3 sessions)
    const openedMatch = entry.match(/\*\*Opened:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (!openedMatch) continue;

    const openedDate = new Date(openedMatch[1]);
    const daysSinceOpened = (Date.now() - openedDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceOpened > 3) {
      results.stale_concerns.push(
        entry.split('\n')[0].replace('## ', '').trim()
      );
      results.actions_taken++;
    }
  }
}

// ── Validate: check empty memory ────────────────────────────────────

function runValidate() {
  const shipRuns = countShipRuns();

  // Check QA patterns
  const patterns = safeRead('.qa/memory/patterns.md');
  if (patterns && patterns.trim().length < 50) {
    results.empty_warnings.push(
      `patterns.md is nearly empty (${patterns.trim().length} chars)${shipRuns > 2 ? ` after ${shipRuns}+ runs` : ''}`
    );
    results.actions_taken++;
  }

  // Check QA regressions
  const regressions = safeRead('.qa/memory/regressions.md');
  if (regressions && regressions.trim().length < 50) {
    results.empty_warnings.push(
      `regressions.md is nearly empty (${regressions.trim().length} chars)`
    );
    results.actions_taken++;
  }

  // Check QA status
  const status = safeRead('.qa/memory/status.json');
  if (status && (status.trim() === '{}' || status.trim().length < 10)) {
    results.empty_warnings.push(
      'status.json is empty — no QA trajectory recorded'
    );
    results.actions_taken++;
  }

  // Check QA learnings
  const learnings = safeRead('.qa/memory/learnings.txt');
  if (learnings && learnings.trim().length < 30) {
    results.empty_warnings.push(
      'learnings.txt is nearly empty — no QA discoveries recorded'
    );
    results.actions_taken++;
  }

  // Check PM status freshness
  const pmStatus = safeRead('.pm/memory/status.md');
  if (pmStatus) {
    const dateMatch = pmStatus.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const statusDate = new Date(dateMatch[1]);
      const daysSince = (Date.now() - statusDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 3) {
        results.empty_warnings.push(
          `status.md last updated ${Math.round(daysSince)} days ago — may be stale`
        );
        results.actions_taken++;
      }
    }
  }
}

// ── Report: log to .ship/ ───────────────────────────────────────────

function logReport() {
  const timestamp = new Date().toISOString();
  const summary = [
    `[${timestamp}] Memory hygiene run:`,
    `  Archived: ${results.archived.decisions} decisions, ${results.archived.reviews} reviews, ${results.archived.learnings} learnings`,
    `  Stale concerns: ${results.stale_concerns.length > 0 ? results.stale_concerns.join(', ') : 'none'}`,
    `  Empty warnings: ${results.empty_warnings.length > 0 ? results.empty_warnings.join('; ') : 'none'}`,
    `  Actions: ${results.actions_taken}`,
    '',
  ].join('\n');

  if (existsSync('.ship')) {
    try {
      appendFileSync('.ship/latest.log', summary);
    } catch { /* ignore write errors */ }
  }
}

// ── Main ────────────────────────────────────────────────────────────

if (runAll || flags.archive) runArchive();
if (runAll || flags.validate) runValidate();
if (runAll || flags.age) runAge();

logReport();

console.log(JSON.stringify(results, null, 2));
process.exit(results.empty_warnings.length > 0 || results.stale_concerns.length > 0 ? 1 : 0);
