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
  archived: { decisions: 0, reviews: 0, learnings: 0, regressions: 0, findings: 0, visual_drift: 0, concerns_resolved: 0 },
  retired_regressions: [],
  obsolete_regressions: [],
  merged_patterns: [],
  archive_recurrences: [],
  stale_concerns: [],
  stale_drift: [],
  trajectory_capped: { qa: false, design: false },
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

function safeJsonRead(path) {
  const content = safeRead(path);
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return -1;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Compute title similarity — ratio of shared characters (case-insensitive).
 * Returns a value between 0 and 1.
 */
function titleSimilarity(a, b) {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  // Use longest common substring length as a ratio
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  // Substring containment check
  if (longer.includes(shorter)) return shorter.length / longer.length;
  // Bigram overlap
  const bigramsA = new Set();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  let shared = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    if (bigramsA.has(nb.slice(i, i + 2))) shared++;
  }
  const totalBigrams = Math.max(bigramsA.size, nb.length - 1);
  return totalBigrams > 0 ? shared / totalBigrams : 0;
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

  // learnings.txt: keep last 30 (split on ## Round headings)
  const learningsArchived = archiveEntries(
    '.qa/memory/learnings.txt',
    '.qa/memory/learnings-archive.txt',
    30,
    /\n(?=## )/
  );
  results.archived.learnings = learningsArchived;
  results.actions_taken += learningsArchived;

  // findings.md: keep last 20 phase sections (Rule 6)
  const findingsArchived = archiveEntries(
    '.design/memory/findings.md',
    '.design/memory/findings-archive.md',
    20,
    /\n(?=## Phase:)/
  );
  results.archived.findings = findingsArchived;
  results.actions_taken += findingsArchived;
}

// ── Rule 1: Regressions retire after 5 consecutive passes ───────────

function runRegressionRetirement() {
  const regressionsPath = '.qa/memory/regressions.md';
  const content = safeRead(regressionsPath);
  if (!content) return;

  const qaStatus = safeJsonRead('.qa/memory/status.json');
  const trajectory = qaStatus?.trajectory || [];

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  let modified = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.includes('**Status:** ACTIVE')) continue;

    // Count consecutive passing rounds from the end of trajectory
    let consecutivePasses = 0;
    for (let j = trajectory.length - 1; j >= 0; j--) {
      const t = trajectory[j];
      // A trajectory entry is "passing" if passing === total (schema: { round, passing, total, delta })
      const passing = (t.passing > 0 && t.passing === t.total);
      if (passing) {
        consecutivePasses++;
      } else {
        break;
      }
    }

    if (consecutivePasses >= 5) {
      entries[i] = entry.replace(
        '**Status:** ACTIVE',
        `**Status:** RETIRED\n**Retired:** ${todayStr()} — 5+ consecutive passing QA rounds`
      );
      const title = entry.split('\n')[0].replace('## ', '').trim();
      results.retired_regressions.push(title);
      results.actions_taken++;
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(regressionsPath, entries.join('\n'));
  }
}

// ── Rule 2: RETIRED regressions archive after 60 days ───────────────

function runRegressionArchive() {
  const regressionsPath = '.qa/memory/regressions.md';
  const content = safeRead(regressionsPath);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    if (!entry.includes('**Status:** RETIRED')) {
      toKeep.push(entry);
      continue;
    }

    // Find retirement date
    const retiredMatch = entry.match(/\*\*Retired:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (retiredMatch && daysSince(retiredMatch[1]) > 60) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length > 0) {
    const archivePath = '.qa/memory/regressions-archive.md';
    const archiveContent = safeRead(archivePath) || '# Regressions Archive\n';
    writeFileSync(archivePath, archiveContent + '\n' + toArchive.join('\n'));
    writeFileSync(regressionsPath, toKeep.join('\n'));
    results.archived.regressions = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

// ── Rule 3: Patterns merge duplicates ───────────────────────────────

function runPatternDedup() {
  const patternsPath = '.qa/memory/patterns.md';
  const content = safeRead(patternsPath);
  if (!content) return;

  const sections = content.split(/\n(?=## )/).filter(e => e.trim());
  if (sections.length < 2) return;

  // Parse sections into objects
  const parsed = sections.map((s, idx) => {
    const lines = s.trim().split('\n');
    const title = lines[0].replace(/^## /, '').trim();
    const seenMatch = s.match(/\*\*Seen in:\*\*(.*)/);
    const rounds = seenMatch ? (seenMatch[1].match(/Round \d+/g) || []) : [];
    return { title, raw: s, rounds, idx, charCount: s.length, removed: false };
  });

  let modified = false;

  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].removed) continue;
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[j].removed) continue;

      const sim = titleSimilarity(parsed[i].title, parsed[j].title);
      if (sim < 0.8) continue;

      // Merge: keep the one with more detail (longer content), merge round lists
      const keeper = parsed[i].charCount >= parsed[j].charCount ? parsed[i] : parsed[j];
      const donor = keeper === parsed[i] ? parsed[j] : parsed[i];

      // Merge round lists into keeper
      const allRounds = new Set([...keeper.rounds, ...donor.rounds]);
      const sortedRounds = [...allRounds].sort((a, b) => {
        const na = parseInt(a.replace('Round ', ''));
        const nb = parseInt(b.replace('Round ', ''));
        return na - nb;
      });
      const newSeenLine = `**Seen in:** ${sortedRounds.join(', ')}`;

      // Update the keeper's raw text
      if (keeper.raw.match(/\*\*Seen in:\*\*.*/)) {
        keeper.raw = keeper.raw.replace(/\*\*Seen in:\*\*.*/, newSeenLine);
      } else {
        keeper.raw = keeper.raw.trimEnd() + '\n' + newSeenLine;
      }

      donor.removed = true;
      results.merged_patterns.push(`"${donor.title}" merged into "${keeper.title}"`);
      results.actions_taken++;
      modified = true;
    }
  }

  if (modified) {
    const kept = parsed.filter(p => !p.removed).map(p => p.raw);
    writeFileSync(patternsPath, kept.join('\n'));
  }
}

// ── Rule 10: Archive recurrence check ────────────────────────────────
// When a new active entry matches an archived entry (>0.8 title similarity),
// annotate it as RECURRING so agents know it's a returning problem.

function runArchiveRecurrenceCheck() {
  checkRecurrence(
    '.qa/memory/patterns.md',
    '.qa/memory/patterns-archive.md',
    /\n(?=## )/
  );
  checkRecurrence(
    '.qa/memory/regressions.md',
    '.qa/memory/regressions-archive.md',
    /\n(?=## )/
  );
  checkRecurrence(
    '.design/memory/findings.md',
    '.design/memory/findings-archive.md',
    /\n(?=## Phase:)/
  );
}

function checkRecurrence(activePath, archivePath, separator) {
  const activeContent = safeRead(activePath);
  const archiveContent = safeRead(archivePath);
  if (!activeContent || !archiveContent) return;

  const activeEntries = activeContent.split(separator).filter(e => e.trim());
  const archiveEntries = archiveContent.split(separator).filter(e => e.trim());
  if (activeEntries.length === 0 || archiveEntries.length === 0) return;

  // Parse archive titles once
  const archiveTitles = archiveEntries.map(e => {
    const firstLine = e.trim().split('\n')[0];
    return firstLine.replace(/^## (?:Phase:\s*)?/, '').trim();
  });

  let modified = false;

  for (let i = 0; i < activeEntries.length; i++) {
    const entry = activeEntries[i];
    // Skip entries already tagged as recurring
    if (entry.includes('**Recurrence:**')) continue;

    const activeTitle = entry.trim().split('\n')[0].replace(/^## (?:Phase:\s*)?/, '').trim();

    for (const archiveTitle of archiveTitles) {
      if (titleSimilarity(activeTitle, archiveTitle) >= 0.8) {
        // Annotate after the first line
        const lines = activeEntries[i].split('\n');
        const insertIdx = Math.min(1, lines.length);
        lines.splice(insertIdx, 0, `**Recurrence:** Previously archived (matched: "${archiveTitle}") — flagged ${todayStr()}`);
        activeEntries[i] = lines.join('\n');

        results.archive_recurrences.push(`"${activeTitle}" matches archived "${archiveTitle}" in ${activePath}`);
        results.actions_taken++;
        modified = true;
        break; // One match is enough
      }
    }
  }

  if (modified) {
    writeFileSync(activePath, activeEntries.join('\n'));
  }
}

// ── Rule 4 & 5: Status.json trajectory cap at 20 ────────────────────

function runTrajectoryCap() {
  // Rule 4: QA status.json
  const qaPath = '.qa/memory/status.json';
  const qaStatus = safeJsonRead(qaPath);
  if (qaStatus?.trajectory && qaStatus.trajectory.length > 20) {
    qaStatus.trajectory = qaStatus.trajectory.slice(-20);
    writeFileSync(qaPath, JSON.stringify(qaStatus, null, 2));
    results.trajectory_capped.qa = true;
    results.actions_taken++;
  }

  // Rule 5: Design status.json
  const designPath = '.design/memory/status.json';
  const designStatus = safeJsonRead(designPath);
  if (designStatus?.trajectory && designStatus.trajectory.length > 20) {
    designStatus.trajectory = designStatus.trajectory.slice(-20);
    writeFileSync(designPath, JSON.stringify(designStatus, null, 2));
    results.trajectory_capped.design = true;
    results.actions_taken++;
  }
}

// ── Rule 7: Visual-drift resolve/archive ────────────────────────────

function runVisualDriftHygiene() {
  const driftPath = '.design/memory/visual-drift.md';
  const content = safeRead(driftPath);
  if (!content) return;

  const entries = content.split(/\n(?=### )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];
  let modified = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Check for RESOLVED entries older than 60 days
    if (entry.includes('STATUS: RESOLVED')) {
      const dateMatch = entry.match(/###\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && daysSince(dateMatch[1]) > 60) {
        toArchive.push(entry);
        modified = true;
        continue;
      }
    }

    // Check for DRIFTING entries not updated in 60 days — flag as stale
    if (entry.includes('STATUS: DRIFTING')) {
      const dateMatch = entry.match(/###\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && daysSince(dateMatch[1]) > 60) {
        if (!entry.includes('STALE')) {
          entries[i] = entry.replace(
            'STATUS: DRIFTING',
            'STATUS: DRIFTING (STALE — not updated in 60+ days)'
          );
          const title = entry.split('\n')[0].replace('### ', '').trim();
          results.stale_drift.push(title);
          results.actions_taken++;
          modified = true;
        }
      }
    }

    toKeep.push(entries[i]);
  }

  if (toArchive.length > 0) {
    const archivePath = '.design/memory/visual-drift-archive.md';
    const archiveContent = safeRead(archivePath) || '# Visual Drift Archive\n';
    writeFileSync(archivePath, archiveContent + '\n' + toArchive.join('\n'));
    results.archived.visual_drift = toArchive.length;
    results.actions_taken += toArchive.length;
  }

  if (modified) {
    writeFileSync(driftPath, toKeep.join('\n'));
  }
}

// ── Rule 8: Regression staleness audit ──────────────────────────────

function runRegressionStalenessAudit() {
  const regressionsPath = '.qa/memory/regressions.md';
  const content = safeRead(regressionsPath);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  let modified = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.includes('**Status:** ACTIVE')) continue;

    // Look for file references in the entry (common patterns: **File:** path, `path`, or **Check:** references)
    const fileMatches = entry.match(/(?:\*\*File:\*\*\s*|`)([\w./-]+\.(?:js|ts|jsx|tsx|vue|svelte|css|json|md))/g);
    if (!fileMatches) continue;

    for (const match of fileMatches) {
      const filePath = match.replace(/^\*\*File:\*\*\s*/, '').replace(/^`/, '').replace(/`$/, '');
      if (filePath && !existsSync(filePath)) {
        entries[i] = entry.replace(
          '**Status:** ACTIVE',
          `**Status:** OBSOLETE — referenced file no longer exists (${filePath})`
        );
        const title = entry.split('\n')[0].replace('## ', '').trim();
        results.obsolete_regressions.push(title);
        results.actions_taken++;
        modified = true;
        break; // Only mark once per entry
      }
    }
  }

  if (modified) {
    writeFileSync(regressionsPath, entries.join('\n'));
  }
}

// ── Rule 9: Concerns RESOLVED archival (30 day rule) ────────────────

function runConcernsResolvedArchival() {
  const concernsPath = '.pm/memory/concerns.md';
  const content = safeRead(concernsPath);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    if (!entry.includes('**Status:** RESOLVED')) {
      toKeep.push(entry);
      continue;
    }

    // Look for resolved date or opened date as fallback
    const resolvedMatch = entry.match(/\*\*(?:Resolved|Resolution):\*\*\s*(\d{4}-\d{2}-\d{2})/);
    const openedMatch = entry.match(/\*\*Opened:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    const dateStr = resolvedMatch ? resolvedMatch[1] : openedMatch ? openedMatch[1] : null;

    if (dateStr && daysSince(dateStr) > 30) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length > 0) {
    const archivePath = '.pm/memory/concerns-archive.md';
    const archiveContent = safeRead(archivePath) || '# Concerns Archive\n';
    writeFileSync(archivePath, archiveContent + '\n' + toArchive.join('\n'));
    writeFileSync(concernsPath, toKeep.join('\n'));
    results.archived.concerns_resolved = toArchive.length;
    results.actions_taken += toArchive.length;
  }
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
    `  Archived: ${results.archived.decisions} decisions, ${results.archived.reviews} reviews, ${results.archived.learnings} learnings, ${results.archived.regressions} regressions, ${results.archived.findings} findings, ${results.archived.visual_drift} visual-drift, ${results.archived.concerns_resolved} resolved-concerns`,
    `  Retired regressions: ${results.retired_regressions.length > 0 ? results.retired_regressions.join(', ') : 'none'}`,
    `  Obsolete regressions: ${results.obsolete_regressions.length > 0 ? results.obsolete_regressions.join(', ') : 'none'}`,
    `  Merged patterns: ${results.merged_patterns.length > 0 ? results.merged_patterns.join(', ') : 'none'}`,
    `  Archive recurrences: ${results.archive_recurrences.length > 0 ? results.archive_recurrences.join(', ') : 'none'}`,
    `  Trajectory capped: QA=${results.trajectory_capped.qa}, Design=${results.trajectory_capped.design}`,
    `  Stale drift: ${results.stale_drift.length > 0 ? results.stale_drift.join(', ') : 'none'}`,
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

if (runAll || flags.archive) {
  runArchive();
  runRegressionRetirement();
  runRegressionArchive();
  runPatternDedup();
  runArchiveRecurrenceCheck();
  runTrajectoryCap();
  runVisualDriftHygiene();
  runConcernsResolvedArchival();
}
if (runAll || flags.validate) {
  runValidate();
  runRegressionStalenessAudit();
}
if (runAll || flags.age) runAge();

logReport();

console.log(JSON.stringify(results, null, 2));
process.exit(results.empty_warnings.length > 0 || results.stale_concerns.length > 0 ? 1 : 0);
