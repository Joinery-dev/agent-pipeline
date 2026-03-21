#!/usr/bin/env node

/**
 * lessons-sync.js — Graduates QA patterns and regressions to project conventions.
 *
 * Reads .qa/memory/patterns.md and regressions.md, identifies items that
 * have been seen enough times to be considered project-wide conventions,
 * and appends them to .claude/project-conventions.md.
 *
 * Usage:
 *   node lib/lessons-sync.js              # graduate new lessons
 *   node lib/lessons-sync.js --dry-run    # show what would be added
 *
 * Framework-agnostic: works with any project that has .qa/memory/ and
 * .claude/project-conventions.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PATTERNS_PATH = resolve('.qa/memory/patterns.md');
const REGRESSIONS_PATH = resolve('.qa/memory/regressions.md');
const CONVENTIONS_PATH = resolve('.claude/project-conventions.md');

const PATTERN_THRESHOLD = 3;    // seen in N+ rounds → graduate
const REGRESSION_THRESHOLD = 2; // broken N+ times → graduate

const dryRun = process.argv.includes('--dry-run');

// ── Parsers ──────────────────────────────────────────────────────────────

function parsePatterns(content) {
  const patterns = [];
  const sections = content.split(/^## /m).slice(1); // split on ## headings

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const title = lines[0].trim();

    // Find "Seen in:" line and count rounds
    const seenLine = lines.find(l => l.startsWith('**Seen in:**'));
    if (!seenLine) continue;

    const rounds = seenLine.match(/Round \d+/g) || [];
    const fixLine = lines.find(l => l.startsWith('**Fix:**'));
    const fix = fixLine ? fixLine.replace('**Fix:**', '').trim() : '';

    patterns.push({ title, roundCount: rounds.length, fix, type: 'pattern' });
  }

  return patterns;
}

function parseRegressions(content) {
  const regressions = [];
  const sections = content.split(/^## /m).slice(1);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const title = lines[0].trim();

    const timesLine = lines.find(l => l.startsWith('**Times broken:**'));
    if (!timesLine) continue;

    const match = timesLine.match(/\d+/);
    const timesBroken = match ? parseInt(match[0]) : 0;

    const checkLine = lines.find(l => l.startsWith('**Check:**'));
    const check = checkLine ? checkLine.replace('**Check:**', '').trim() : '';

    const statusLine = lines.find(l => l.startsWith('**Status:**'));
    const isActive = statusLine ? statusLine.includes('ACTIVE') : true;

    if (isActive) {
      regressions.push({ title, timesBroken, check, type: 'regression' });
    }
  }

  return regressions;
}

// ── Main ─────────────────────────────────────────────────────────────────

const results = { graduated: [], skipped: [], alreadyExists: [] };

// Read existing conventions to avoid duplicates
const conventionsContent = existsSync(CONVENTIONS_PATH)
  ? readFileSync(CONVENTIONS_PATH, 'utf-8')
  : '';

function isAlreadyConvention(title) {
  return conventionsContent.includes(title);
}

// Process patterns
if (existsSync(PATTERNS_PATH)) {
  const patterns = parsePatterns(readFileSync(PATTERNS_PATH, 'utf-8'));

  for (const p of patterns) {
    if (p.roundCount >= PATTERN_THRESHOLD) {
      if (isAlreadyConvention(p.title)) {
        results.alreadyExists.push(p.title);
      } else {
        results.graduated.push({
          title: p.title,
          source: `pattern (seen ${p.roundCount} times)`,
          convention: p.fix || `Avoid: ${p.title}`,
        });
      }
    } else {
      results.skipped.push({ title: p.title, reason: `only ${p.roundCount} rounds (need ${PATTERN_THRESHOLD})` });
    }
  }
}

// Process regressions
if (existsSync(REGRESSIONS_PATH)) {
  const regressions = parseRegressions(readFileSync(REGRESSIONS_PATH, 'utf-8'));

  for (const r of regressions) {
    if (r.timesBroken >= REGRESSION_THRESHOLD) {
      if (isAlreadyConvention(r.title)) {
        results.alreadyExists.push(r.title);
      } else {
        results.graduated.push({
          title: r.title,
          source: `regression (broken ${r.timesBroken} times)`,
          convention: r.check || `Watch for: ${r.title}`,
        });
      }
    } else {
      results.skipped.push({ title: r.title, reason: `only ${r.timesBroken} breaks (need ${REGRESSION_THRESHOLD})` });
    }
  }
}

// Process design findings — graduate recurring design issues
const DESIGN_FINDINGS_PATH = resolve('.design/memory/findings.md');
const DESIGN_THRESHOLD = 3; // seen in 3+ phase findings → graduate

if (existsSync(DESIGN_FINDINGS_PATH)) {
  const content = readFileSync(DESIGN_FINDINGS_PATH, 'utf-8');
  // Count how many phases each finding type appears in
  const findingCounts = new Map();
  const phases = content.split(/^## Phase:/m).slice(1);

  for (const phase of phases) {
    const findings = phase.match(/\[(SHIP-BLOCKER|QUALITY|RECURRING)\]\s*(.+)/g) || [];
    for (const f of findings) {
      const desc = f.replace(/\[(SHIP-BLOCKER|QUALITY|RECURRING)\]\s*/, '').trim();
      // Normalize: lowercase, remove dates, trim
      const key = desc.toLowerCase().replace(/\d{4}-\d{2}-\d{2}/g, '').trim();
      findingCounts.set(key, (findingCounts.get(key) || 0) + 1);
    }
  }

  for (const [finding, count] of findingCounts) {
    if (count >= DESIGN_THRESHOLD) {
      if (!isAlreadyConvention(finding)) {
        results.graduated.push({
          title: finding,
          source: `design finding (seen in ${count} phases)`,
          convention: `Design rule: ${finding}`,
        });
      } else {
        results.alreadyExists.push(finding);
      }
    }
  }
}

// Write graduated conventions
if (results.graduated.length > 0 && !dryRun) {
  let content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  const date = new Date().toISOString().split('T')[0];

  for (const g of results.graduated) {
    const entry = `\n### ${g.title}\n**Source:** ${g.source} — graduated ${date}\n**Convention:** ${g.convention}\n`;
    content = content.replace(
      /\(none yet[^)]*\)/,
      '' // remove the "none yet" placeholder if present
    );
    content = content.trimEnd() + '\n' + entry;
  }

  writeFileSync(CONVENTIONS_PATH, content);
}

// Output
console.log(JSON.stringify({
  graduated: results.graduated.map(g => g.title),
  skipped: results.skipped,
  alreadyExists: results.alreadyExists,
  total: results.graduated.length,
  dryRun,
}, null, 2));
