#!/usr/bin/env node

/**
 * Memory Hygiene — Intelligent memory maintenance
 *
 * No hardcoded entry caps. Instead:
 * 1. Memory files grow uncapped
 * 2. Every 5K tokens added, run per-file cleanup strategies
 * 3. Cleanup = lifecycle advancement, dedup, dead ref removal (never arbitrary eviction)
 *
 * Usage:
 *   node lib/memory-hygiene.js              # Run all operations
 *   node lib/memory-hygiene.js --archive    # Archive only
 *   node lib/memory-hygiene.js --validate   # Validate only
 *   node lib/memory-hygiene.js --report     # Report only (dry run)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';

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
  stale_concerns: [],
  stale_drift: [],
  trajectory_capped: { qa: false, design: false },
  empty_warnings: [],
  cleanup_triggered: {},
  actions_taken: 0,
};

// ── Helpers ─────────────────────────────────────────────────────────

function safeRead(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function safeJsonRead(path) {
  const content = safeRead(path);
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function estimateTokens(content) {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
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
 * Compute title similarity — bigram overlap ratio (0-1).
 */
function titleSimilarity(a, b) {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  if (na.length > nb.length ? na.includes(nb) : nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }
  const bigramsA = new Set();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  let shared = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    if (bigramsA.has(nb.slice(i, i + 2))) shared++;
  }
  const totalBigrams = Math.max(bigramsA.size, nb.length - 1);
  return totalBigrams > 0 ? shared / totalBigrams : 0;
}

function countShipRuns() {
  const log = safeRead('.ship/latest.log');
  if (!log) return 0;
  return (log.match(/🚀 ship\.js/g) || []).length || 1;
}

function loadGoals() {
  return safeJsonRead('.goals.json');
}

function getAllPhases(goals) {
  if (!goals?.majorPhases) return [];
  const phases = [];
  for (const mp of goals.majorPhases) {
    for (const p of (mp.phases || [])) phases.push(p);
  }
  return phases;
}

function getCompletedPhaseIds(goals) {
  return new Set(getAllPhases(goals).filter(p => p.status === 'completed').map(p => p.id));
}

function archiveTo(archivePath, entries) {
  const existing = safeRead(archivePath) || '';
  writeFileSync(archivePath, existing + '\n' + entries.join('\n'));
}

// ── Token Threshold Tracking ────────────────────────────────────────

const TOKEN_STATE_PATH = '.ship/memory-tokens.json';
const CLEANUP_THRESHOLD = 5000; // tokens

function loadTokenState() {
  return safeJsonRead(TOKEN_STATE_PATH) || {};
}

function saveTokenState(state) {
  mkdirSync('.ship', { recursive: true });
  writeFileSync(TOKEN_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Check if a file has crossed a 5K token threshold since last cleanup.
 * Returns true if cleanup should run for this file.
 */
function shouldCleanup(filePath, tokenState) {
  const content = safeRead(filePath);
  if (!content) return false;

  const currentTokens = estimateTokens(content);
  const lastCleanupTokens = tokenState[filePath] || 0;

  return currentTokens - lastCleanupTokens >= CLEANUP_THRESHOLD;
}

function markCleaned(filePath, tokenState) {
  const content = safeRead(filePath);
  tokenState[filePath] = content ? estimateTokens(content) : 0;
}

// ── Per-File Cleanup Strategies ─────────────────────────────────────

/**
 * concerns.md — Lifecycle-based.
 * RESOLVED concerns >30 days → archive. OPEN concerns never evict.
 */
function cleanupConcerns() {
  const path = '.pm/memory/concerns.md';
  const content = safeRead(path);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    if (!entry.includes('**Status:** RESOLVED')) {
      toKeep.push(entry);
      continue;
    }
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
    archiveTo('.pm/memory/concerns-archive.md', toArchive);
    writeFileSync(path, toKeep.join('\n'));
    results.archived.concerns_resolved = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

/**
 * decisions.md — Condense, never delete.
 * Decisions for completed phases get condensed into a summary line.
 * Architectural decisions (mentioning "architecture", "pattern", "convention") stay full.
 */
function cleanupDecisions() {
  const path = '.pm/memory/decisions.md';
  const content = safeRead(path);
  if (!content) return;

  const goals = loadGoals();
  const completedIds = getCompletedPhaseIds(goals);
  const completedTitles = new Set(
    getAllPhases(goals).filter(p => p.status === 'completed').map(p => p.title.toLowerCase())
  );

  const architecturalKeywords = /architect|pattern|convention|standard|approach|strategy|framework|stack|structure/i;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  let condensed = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Already condensed
    if (entry.includes('[condensed]')) continue;
    // Architectural — keep full
    if (architecturalKeywords.test(entry)) continue;

    // Check if this decision references only completed phases
    const referencesActivePhase = getAllPhases(goals || {}).some(p =>
      p.status !== 'completed' && entry.toLowerCase().includes(p.title.toLowerCase())
    );
    if (referencesActivePhase) continue;

    const referencesCompletedPhase = [...completedTitles].some(t => entry.toLowerCase().includes(t));
    if (!referencesCompletedPhase) continue;

    // Condense: keep first line (title) + first sentence of body
    const lines = entry.split('\n');
    const title = lines[0];
    const body = lines.slice(1).join(' ').trim();
    const firstSentence = body.match(/^[^.!?]*[.!?]/)?.[0] || body.slice(0, 150);

    entries[i] = `${title}\n${firstSentence} [condensed]\n`;
    condensed++;
  }

  if (condensed > 0) {
    writeFileSync(path, entries.join('\n'));
    results.archived.decisions = condensed;
    results.actions_taken += condensed;
  }
}

/**
 * reviews.md — Phase-scoped.
 * Reviews for completed+merged phases → archive.
 */
function cleanupReviews() {
  const path = '.pm/memory/reviews.md';
  const content = safeRead(path);
  if (!content) return;

  const goals = loadGoals();
  const completedTitles = new Set(
    getAllPhases(goals).filter(p => p.status === 'completed').map(p => p.title.toLowerCase())
  );

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    const referencesActivePhase = getAllPhases(goals || {}).some(p =>
      p.status !== 'completed' && entry.toLowerCase().includes(p.title.toLowerCase())
    );

    if (referencesActivePhase) {
      toKeep.push(entry);
    } else {
      const referencesCompleted = [...completedTitles].some(t => entry.toLowerCase().includes(t));
      if (referencesCompleted) {
        toArchive.push(entry);
      } else {
        toKeep.push(entry); // keep if we can't determine scope
      }
    }
  }

  if (toArchive.length > 0) {
    archiveTo('.pm/memory/reviews-archive.md', toArchive);
    writeFileSync(path, toKeep.join('\n'));
    results.archived.reviews = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

/**
 * patterns.md — Deduplicate. Retire dead references.
 * Never evict — these ARE the project's conventions.
 */
function cleanupPatterns() {
  const path = '.qa/memory/patterns.md';
  const content = safeRead(path);
  if (!content) return;

  const sections = content.split(/\n(?=## )/).filter(e => e.trim());
  if (sections.length < 2) return;

  const parsed = sections.map((s, idx) => {
    const lines = s.trim().split('\n');
    const title = lines[0].replace(/^## /, '').trim();
    const seenMatch = s.match(/\*\*Seen in:\*\*(.*)/);
    const rounds = seenMatch ? (seenMatch[1].match(/Round \d+/g) || []) : [];
    return { title, raw: s, rounds, idx, charCount: s.length, removed: false };
  });

  let modified = false;

  // Deduplicate
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].removed) continue;
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[j].removed) continue;
      if (titleSimilarity(parsed[i].title, parsed[j].title) < 0.8) continue;

      const keeper = parsed[i].charCount >= parsed[j].charCount ? parsed[i] : parsed[j];
      const donor = keeper === parsed[i] ? parsed[j] : parsed[i];
      const allRounds = new Set([...keeper.rounds, ...donor.rounds]);
      const sortedRounds = [...allRounds].sort((a, b) =>
        parseInt(a.replace('Round ', '')) - parseInt(b.replace('Round ', ''))
      );
      const newSeenLine = `**Seen in:** ${sortedRounds.join(', ')}`;
      keeper.raw = keeper.raw.match(/\*\*Seen in:\*\*.*/)
        ? keeper.raw.replace(/\*\*Seen in:\*\*.*/, newSeenLine)
        : keeper.raw.trimEnd() + '\n' + newSeenLine;

      donor.removed = true;
      results.merged_patterns.push(`"${donor.title}" merged into "${keeper.title}"`);
      results.actions_taken++;
      modified = true;
    }
  }

  // Retire patterns referencing files that no longer exist
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].removed) continue;
    const fileMatches = parsed[i].raw.match(/`([\w./-]+\.(?:js|ts|jsx|tsx|vue|svelte|css))`/g);
    if (!fileMatches) continue;
    const allGone = fileMatches.every(m => {
      const f = m.replace(/`/g, '');
      return !existsSync(f);
    });
    if (allGone && fileMatches.length > 0) {
      parsed[i].removed = true;
      results.actions_taken++;
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(path, parsed.filter(p => !p.removed).map(p => p.raw).join('\n'));
  }
}

/**
 * learnings.txt — Phase-scoped.
 * Learnings from completed phases that didn't become patterns or regressions → archive.
 */
function cleanupLearnings() {
  const path = '.qa/memory/learnings.txt';
  const content = safeRead(path);
  if (!content) return;

  const goals = loadGoals();
  const completedTitles = new Set(
    getAllPhases(goals).filter(p => p.status === 'completed').map(p => p.title.toLowerCase())
  );

  // Read patterns and regressions to check if a learning "graduated"
  const patterns = (safeRead('.qa/memory/patterns.md') || '').toLowerCase();
  const regressions = (safeRead('.qa/memory/regressions.md') || '').toLowerCase();

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    const lower = entry.toLowerCase();

    // Keep if it references an active phase
    const referencesActive = getAllPhases(goals || {}).some(p =>
      p.status !== 'completed' && lower.includes(p.title.toLowerCase())
    );
    if (referencesActive) { toKeep.push(entry); continue; }

    // Keep if it graduated to a pattern or regression
    const titleLine = entry.split('\n')[0].replace(/^## /, '').trim().toLowerCase();
    const graduated = patterns.includes(titleLine.slice(0, 30)) || regressions.includes(titleLine.slice(0, 30));

    const referencesCompleted = [...completedTitles].some(t => lower.includes(t));

    if (referencesCompleted && !graduated) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length > 0) {
    archiveTo('.qa/memory/learnings-archive.txt', toArchive);
    writeFileSync(path, toKeep.join('\n'));
    results.archived.learnings = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

/**
 * findings.md — Phase-scoped.
 * Findings for completed phases where issues were resolved → archive.
 */
function cleanupFindings() {
  const path = '.design/memory/findings.md';
  const content = safeRead(path);
  if (!content) return;

  const goals = loadGoals();
  const completedTitles = new Set(
    getAllPhases(goals).filter(p => p.status === 'completed').map(p => p.title.toLowerCase())
  );

  const entries = content.split(/\n(?=## Phase:)/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    // Archive findings for completed phases that have no unresolved items
    const referencesCompleted = [...completedTitles].some(t => lower.includes(t));
    const hasUnresolved = /ship-blocker|unresolved|open/i.test(entry) && !/resolved|fixed/i.test(entry);

    if (referencesCompleted && !hasUnresolved) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length > 0) {
    archiveTo('.design/memory/findings-archive.md', toArchive);
    writeFileSync(path, toKeep.join('\n'));
    results.archived.findings = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

// ── Lifecycle Rules (always run, not threshold-gated) ───────────────

/**
 * Regressions retire after 5 consecutive passing QA rounds.
 */
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

    let consecutivePasses = 0;
    for (let j = trajectory.length - 1; j >= 0; j--) {
      if (trajectory[j].passing > 0 && trajectory[j].passing === trajectory[j].total) {
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
      results.retired_regressions.push(entry.split('\n')[0].replace('## ', '').trim());
      results.actions_taken++;
      modified = true;
    }
  }

  if (modified) writeFileSync(regressionsPath, entries.join('\n'));
}

/**
 * RETIRED regressions archive after 60 days.
 */
function runRegressionArchive() {
  const regressionsPath = '.qa/memory/regressions.md';
  const content = safeRead(regressionsPath);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  const toKeep = [];
  const toArchive = [];

  for (const entry of entries) {
    if (!entry.includes('**Status:** RETIRED')) { toKeep.push(entry); continue; }
    const retiredMatch = entry.match(/\*\*Retired:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (retiredMatch && daysSince(retiredMatch[1]) > 60) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length > 0) {
    archiveTo('.qa/memory/regressions-archive.md', toArchive);
    writeFileSync(regressionsPath, toKeep.join('\n'));
    results.archived.regressions = toArchive.length;
    results.actions_taken += toArchive.length;
  }
}

/**
 * Regression staleness — mark ACTIVE regressions referencing deleted files as OBSOLETE.
 */
function runRegressionStalenessAudit() {
  const regressionsPath = '.qa/memory/regressions.md';
  const content = safeRead(regressionsPath);
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());
  let modified = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.includes('**Status:** ACTIVE')) continue;

    const fileMatches = entry.match(/(?:\*\*File:\*\*\s*|`)([\w./-]+\.(?:js|ts|jsx|tsx|vue|svelte|css|json|md))/g);
    if (!fileMatches) continue;

    for (const match of fileMatches) {
      const filePath = match.replace(/^\*\*File:\*\*\s*/, '').replace(/^`/, '').replace(/`$/, '');
      if (filePath && !existsSync(filePath)) {
        entries[i] = entry.replace(
          '**Status:** ACTIVE',
          `**Status:** OBSOLETE — referenced file no longer exists (${filePath})`
        );
        results.obsolete_regressions.push(entry.split('\n')[0].replace('## ', '').trim());
        results.actions_taken++;
        modified = true;
        break;
      }
    }
  }

  if (modified) writeFileSync(regressionsPath, entries.join('\n'));
}

/**
 * Visual-drift resolve/archive.
 */
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

    if (entry.includes('STATUS: RESOLVED')) {
      const dateMatch = entry.match(/###\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && daysSince(dateMatch[1]) > 60) {
        toArchive.push(entry);
        modified = true;
        continue;
      }
    }

    if (entry.includes('STATUS: DRIFTING')) {
      const dateMatch = entry.match(/###\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && daysSince(dateMatch[1]) > 60 && !entry.includes('STALE')) {
        entries[i] = entry.replace(
          'STATUS: DRIFTING',
          'STATUS: DRIFTING (STALE — not updated in 60+ days)'
        );
        results.stale_drift.push(entry.split('\n')[0].replace('### ', '').trim());
        results.actions_taken++;
        modified = true;
      }
    }

    toKeep.push(entries[i]);
  }

  if (toArchive.length > 0) {
    archiveTo('.design/memory/visual-drift-archive.md', toArchive);
    results.archived.visual_drift = toArchive.length;
    results.actions_taken += toArchive.length;
  }
  if (modified) writeFileSync(driftPath, toKeep.join('\n'));
}

// ── Stale Concern Detection ─────────────────────────────────────────

function runAge() {
  const content = safeRead('.pm/memory/concerns.md');
  if (!content) return;

  const entries = content.split(/\n(?=## )/).filter(e => e.trim());

  for (const entry of entries) {
    if (!entry.includes('**Status:** OPEN')) continue;
    const openedMatch = entry.match(/\*\*Opened:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    if (!openedMatch) continue;
    if (daysSince(openedMatch[1]) > 3) {
      results.stale_concerns.push(entry.split('\n')[0].replace('## ', '').trim());
      results.actions_taken++;
    }
  }
}

// ── Validate: check empty memory ────────────────────────────────────

function runValidate() {
  const shipRuns = countShipRuns();

  const patterns = safeRead('.qa/memory/patterns.md');
  if (patterns && patterns.trim().length < 50) {
    results.empty_warnings.push(
      `patterns.md is nearly empty (${patterns.trim().length} chars)${shipRuns > 2 ? ` after ${shipRuns}+ runs` : ''}`
    );
    results.actions_taken++;
  }

  const regressions = safeRead('.qa/memory/regressions.md');
  if (regressions && regressions.trim().length < 50) {
    results.empty_warnings.push(`regressions.md is nearly empty (${regressions.trim().length} chars)`);
    results.actions_taken++;
  }

  const status = safeRead('.qa/memory/status.json');
  if (status && (status.trim() === '{}' || status.trim().length < 10)) {
    results.empty_warnings.push('status.json is empty — no QA trajectory recorded');
    results.actions_taken++;
  }

  const learnings = safeRead('.qa/memory/learnings.txt');
  if (learnings && learnings.trim().length < 30) {
    results.empty_warnings.push('learnings.txt is nearly empty — no QA discoveries recorded');
    results.actions_taken++;
  }

  const pmStatus = safeRead('.pm/memory/status.md');
  if (pmStatus) {
    const dateMatch = pmStatus.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && daysSince(dateMatch[1]) > 3) {
      results.empty_warnings.push(`status.md last updated ${Math.round(daysSince(dateMatch[1]))} days ago — may be stale`);
      results.actions_taken++;
    }
  }
}

// ── Threshold-Gated Cleanup ─────────────────────────────────────────

const MEMORY_FILES = [
  { path: '.pm/memory/concerns.md', cleanup: cleanupConcerns },
  { path: '.pm/memory/decisions.md', cleanup: cleanupDecisions },
  { path: '.pm/memory/reviews.md', cleanup: cleanupReviews },
  { path: '.qa/memory/patterns.md', cleanup: cleanupPatterns },
  { path: '.qa/memory/learnings.txt', cleanup: cleanupLearnings },
  { path: '.design/memory/findings.md', cleanup: cleanupFindings },
];

function runThresholdCleanup() {
  const tokenState = loadTokenState();

  for (const { path, cleanup } of MEMORY_FILES) {
    if (shouldCleanup(path, tokenState)) {
      const before = estimateTokens(safeRead(path));
      cleanup();
      const after = estimateTokens(safeRead(path));
      markCleaned(path, tokenState);
      results.cleanup_triggered[path] = { before, after, reduced: before - after };
    }
  }

  saveTokenState(tokenState);
}

// ── Report ──────────────────────────────────────────────────────────

function logReport() {
  const timestamp = new Date().toISOString();
  const cleanupSummary = Object.entries(results.cleanup_triggered)
    .map(([path, { before, after, reduced }]) => `    ${path}: ${before}→${after} tokens (−${reduced})`)
    .join('\n');

  const summary = [
    `[${timestamp}] Memory hygiene run:`,
    `  Archived: ${results.archived.decisions} decisions condensed, ${results.archived.reviews} reviews, ${results.archived.learnings} learnings, ${results.archived.regressions} regressions, ${results.archived.findings} findings, ${results.archived.visual_drift} visual-drift, ${results.archived.concerns_resolved} resolved-concerns`,
    `  Retired regressions: ${results.retired_regressions.length > 0 ? results.retired_regressions.join(', ') : 'none'}`,
    `  Obsolete regressions: ${results.obsolete_regressions.length > 0 ? results.obsolete_regressions.join(', ') : 'none'}`,
    `  Merged patterns: ${results.merged_patterns.length > 0 ? results.merged_patterns.join(', ') : 'none'}`,
    `  Stale drift: ${results.stale_drift.length > 0 ? results.stale_drift.join(', ') : 'none'}`,
    `  Stale concerns: ${results.stale_concerns.length > 0 ? results.stale_concerns.join(', ') : 'none'}`,
    `  Empty warnings: ${results.empty_warnings.length > 0 ? results.empty_warnings.join('; ') : 'none'}`,
    cleanupSummary ? `  Threshold cleanup:\n${cleanupSummary}` : '  Threshold cleanup: none triggered',
    `  Actions: ${results.actions_taken}`,
    '',
  ].join('\n');

  if (existsSync('.ship')) {
    try { appendFileSync('.ship/latest.log', summary); } catch {}
  }
}

// ── Main ────────────────────────────────────────────────────────────

if (runAll || flags.archive) {
  // Lifecycle rules (always run)
  runRegressionRetirement();
  runRegressionArchive();
  runVisualDriftHygiene();

  // Threshold-gated per-file cleanup
  runThresholdCleanup();
}
if (runAll || flags.validate) {
  runValidate();
  runRegressionStalenessAudit();
}
if (runAll || flags.age) runAge();

logReport();

console.log(JSON.stringify(results, null, 2));
process.exit(results.empty_warnings.length > 0 || results.stale_concerns.length > 0 ? 1 : 0);
