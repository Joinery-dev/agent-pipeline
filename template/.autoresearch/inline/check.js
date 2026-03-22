#!/usr/bin/env node

/**
 * check.js — Experiment engine for inline autoresearch.
 *
 * State machine: IDLE → COLLECTING_BASELINE → PROPOSING → RUNNING → EVALUATING → KEEP/REVERT
 *
 * Called by ship.js lifecycle hooks (iteration-start, phase-complete).
 * Manages experiment state in experiment.json, writes/removes conventions
 * in project-conventions.md.
 *
 * Usage:
 *   node .autoresearch/inline/check.js --check     # Fast deterministic check
 *   node .autoresearch/inline/check.js --status     # Print current state
 *   node .autoresearch/inline/check.js --abort      # Revert active experiment
 *   node .autoresearch/inline/check.js --pause      # Pause without reverting
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

// ── Paths ────────────────────────────────────────────────────────────────

const INLINE_DIR = resolve('.autoresearch/inline');
const SIGNALS_PATH = resolve(INLINE_DIR, 'signals.jsonl');
const EXPERIMENT_PATH = resolve(INLINE_DIR, 'experiment.json');
const HISTORY_DIR = resolve(INLINE_DIR, 'history');
const CONVENTIONS_PATH = resolve('.claude/project-conventions.md');
const CONFIG_PATH = resolve('ship-config.json');

// ── Config ───────────────────────────────────────────────────────────────

function loadConfig() {
  const defaults = {
    enabled: false,
    targetAgent: 'builder',
    targetMetric: 'firstPassQARate',
    windowSize: 5,
    coldStartMinimum: 5,
    significanceThreshold: 0.10,
    maxActiveConventions: 3,
    maxConsecutiveReverts: 3,
    proposalTimeoutMs: 120000,
    conventionMaxLength: 500,
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const loaded = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...defaults, ...(loaded.inlineAutoresearch || {}) };
  } catch {
    return defaults;
  }
}

// ── State management ─────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(EXPERIMENT_PATH)) {
    return {
      state: 'collecting_baseline',
      version: 0,
      activeExperiment: null,
      baseline: null,
      locked: { agents: [], reason: '' },
      history: [],
      globalStats: {
        totalExperiments: 0,
        totalKept: 0,
        totalReverted: 0,
        totalSignals: 0,
        firstSignalAt: null,
        consecutiveReverts: 0,
      },
    };
  }
  try {
    return JSON.parse(readFileSync(EXPERIMENT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  if (!existsSync(INLINE_DIR)) mkdirSync(INLINE_DIR, { recursive: true });
  writeFileSync(EXPERIMENT_PATH, JSON.stringify(state, null, 2));
}

function saveHistory(experiment, result) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const record = {
    ...experiment,
    result,
    completedAt: new Date().toISOString(),
  };
  const filename = `exp-${String(experiment.id).padStart(3, '0')}-${result}.json`;
  writeFileSync(resolve(HISTORY_DIR, filename), JSON.stringify(record, null, 2));
}

// ── Signal reading ───────────────────────────────────────────────────────

function readSignals() {
  if (!existsSync(SIGNALS_PATH)) return [];
  try {
    const lines = readFileSync(SIGNALS_PATH, 'utf-8').trim().split('\n');
    return lines.filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Metrics computation ──────────────────────────────────────────────────

function computeMetrics(signals, config) {
  if (signals.length === 0) return null;

  const metric = config.targetMetric;

  if (metric === 'firstPassQARate') {
    // Complexity-weighted first-pass QA rate
    const avgComplexity = signals.reduce((s, r) => s + (r.complexity || 1), 0) / signals.length;
    let weightedPasses = 0;
    let weightedTotal = 0;
    for (const s of signals) {
      const weight = (s.complexity || 1) / avgComplexity;
      weightedTotal += weight;
      if (s.firstPassQA) weightedPasses += weight;
    }
    return {
      firstPassQARate: weightedTotal > 0 ? weightedPasses / weightedTotal : 0,
      avgFixAttempts: signals.reduce((s, r) => s + (r.fixAttempts || 0), 0) / signals.length,
      dataPoints: signals.length,
    };
  }

  // Fallback: simple rate of the named boolean field
  const passes = signals.filter(s => s[metric] === true).length;
  return {
    [metric]: passes / signals.length,
    dataPoints: signals.length,
  };
}

function significanceThreshold(windowSize) {
  if (windowSize <= 3) return 0.20;
  if (windowSize <= 5) return 0.10;
  return 0.05;
}

// ── Convention file management ───────────────────────────────────────────

function conventionHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function findOurConventions(content) {
  // Find all convention blocks with our source marker
  const blocks = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('### ') && i + 1 < lines.length) {
      const titleLine = i;
      // Look ahead for our source marker
      let j = i + 1;
      let isOurs = false;
      let endLine = i;
      while (j < lines.length && !lines[j].startsWith('### ')) {
        if (lines[j].includes('**Source:** inline-autoresearch')) {
          isOurs = true;
        }
        endLine = j;
        j++;
      }
      if (isOurs) {
        blocks.push({
          startLine: titleLine,
          endLine,
          title: lines[titleLine].replace('### ', ''),
        });
      }
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}

function addConvention(title, conventionText, expId) {
  if (!existsSync(CONVENTIONS_PATH)) return false;

  let content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  const date = new Date().toISOString().split('T')[0];

  const entry = `\n### ${title}\n**Source:** inline-autoresearch exp-${String(expId).padStart(3, '0')} — ${date}\n**Convention:** ${conventionText}\n`;

  // Remove "none yet" placeholder if present
  content = content.replace(/\(none yet[^)]*\)/, '');
  content = content.trimEnd() + '\n' + entry;

  writeFileSync(CONVENTIONS_PATH, content);
  return true;
}

function removeConvention(expId) {
  if (!existsSync(CONVENTIONS_PATH)) return false;

  const content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  const marker = `inline-autoresearch exp-${String(expId).padStart(3, '0')}`;

  if (!content.includes(marker)) return false;

  const lines = content.split('\n');
  const newLines = [];
  let i = 0;
  let removed = false;

  while (i < lines.length) {
    if (lines[i].startsWith('### ')) {
      // Check if the block following this heading contains our marker
      let j = i + 1;
      let blockIsOurs = false;
      while (j < lines.length && !lines[j].startsWith('### ')) {
        if (lines[j].includes(marker)) {
          blockIsOurs = true;
        }
        j++;
      }
      if (blockIsOurs) {
        // Skip this entire block
        i = j;
        removed = true;
        continue;
      }
    }
    newLines.push(lines[i]);
    i++;
  }

  if (removed) {
    // Clean up excessive blank lines
    const cleaned = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
    writeFileSync(CONVENTIONS_PATH, cleaned);
  }
  return removed;
}

function updateConventionSource(expId, improvement) {
  if (!existsSync(CONVENTIONS_PATH)) return;

  const content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  const marker = `inline-autoresearch exp-${String(expId).padStart(3, '0')}`;
  const date = new Date().toISOString().split('T')[0];

  const updated = content.replace(
    new RegExp(`(\\*\\*Source:\\*\\* ${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}) — \\d{4}-\\d{2}-\\d{2}`),
    `$1 — kept ${date}, ${improvement}`
  );

  if (updated !== content) {
    writeFileSync(CONVENTIONS_PATH, updated);
  }
}

function countOurConventions() {
  if (!existsSync(CONVENTIONS_PATH)) return 0;
  const content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  return findOurConventions(content).length;
}

// ── Core state machine ───────────────────────────────────────────────────

function runCheck(config) {
  const state = loadState();
  if (!state) return { action: 'error', reason: 'Could not load state' };

  const signals = readSignals();
  state.globalStats.totalSignals = signals.length;
  if (signals.length > 0 && !state.globalStats.firstSignalAt) {
    state.globalStats.firstSignalAt = signals[0].ts;
  }

  // ── IDLE ──
  if (state.state === 'idle') {
    saveState(state);
    return { action: 'idle', reason: state.pausedReason || 'System is idle' };
  }

  // ── COLLECTING_BASELINE ──
  if (state.state === 'collecting_baseline') {
    const baselineSignals = signals.filter(s => s.protocolVersion === 'baseline');

    // Not enough data yet
    if (baselineSignals.length < config.coldStartMinimum) {
      saveState(state);
      return {
        action: 'collecting',
        dataPoints: baselineSignals.length,
        needed: config.coldStartMinimum,
      };
    }

    // Compute baseline from the last windowSize signals
    const window = baselineSignals.slice(-config.windowSize);
    const baseline = computeMetrics(window, config);

    if (!baseline) {
      saveState(state);
      return { action: 'collecting', reason: 'Could not compute baseline metrics' };
    }

    state.baseline = {
      ...baseline,
      windowStart: baselineSignals.length - config.windowSize,
      windowEnd: baselineSignals.length - 1,
    };

    // Check if metrics warrant experimentation
    // For firstPassQARate < 1.0, there's room to improve
    const metricValue = baseline[config.targetMetric];
    if (metricValue === undefined || metricValue >= 0.95) {
      // Already excellent — keep collecting, check again later
      saveState(state);
      return {
        action: 'collecting',
        reason: `${config.targetMetric} at ${(metricValue * 100).toFixed(0)}% — no experiment needed`,
        baseline,
      };
    }

    // Check max active conventions limit
    if (countOurConventions() >= config.maxActiveConventions) {
      saveState(state);
      return {
        action: 'collecting',
        reason: `Max active conventions (${config.maxActiveConventions}) reached`,
        baseline,
      };
    }

    // Check consecutive reverts pause
    if (state.globalStats.consecutiveReverts >= config.maxConsecutiveReverts) {
      state.state = 'idle';
      state.pausedReason = `${config.maxConsecutiveReverts} consecutive reverts — human review needed`;
      saveState(state);
      return { action: 'paused', reason: state.pausedReason };
    }

    // Ready to propose
    state.state = 'proposing';
    saveState(state);
    return { action: 'needsProposal', baseline };
  }

  // ── PROPOSING ──
  // This state is transient — check.js sets it, propose.js resolves it.
  // If we're still in proposing, it means propose.js hasn't run yet.
  if (state.state === 'proposing') {
    saveState(state);
    return { action: 'needsProposal', baseline: state.baseline };
  }

  // ── RUNNING ──
  if (state.state === 'running') {
    const exp = state.activeExperiment;
    if (!exp) {
      state.state = 'collecting_baseline';
      saveState(state);
      return { action: 'error', reason: 'Running state with no active experiment — resetting' };
    }

    // Count signals collected during this experiment
    const expVersion = `exp-${String(exp.id).padStart(3, '0')}`;
    const expSignals = signals.filter(s => s.protocolVersion === expVersion);
    exp.dataPoints = expSignals.length;

    const targetWindow = exp.extended
      ? exp.windowSize + Math.ceil(exp.windowSize / 2)
      : exp.windowSize;

    if (expSignals.length < targetWindow) {
      saveState(state);
      return {
        action: 'running',
        dataPoints: expSignals.length,
        needed: targetWindow,
        experiment: exp.hypothesis,
      };
    }

    // Window is full — evaluate
    state.state = 'evaluating';
    saveState(state);
    // Fall through to evaluation
  }

  // ── EVALUATING ──
  if (state.state === 'evaluating') {
    const exp = state.activeExperiment;
    if (!exp) {
      state.state = 'collecting_baseline';
      saveState(state);
      return { action: 'error', reason: 'Evaluating state with no active experiment — resetting' };
    }

    const expVersion = `exp-${String(exp.id).padStart(3, '0')}`;
    const expSignals = signals.filter(s => s.protocolVersion === expVersion);
    const expMetrics = computeMetrics(expSignals, config);

    if (!expMetrics || !state.baseline) {
      // Can't evaluate — revert to be safe
      removeConvention(exp.id);
      saveHistory(exp, 'reverted');
      state.history.push({ id: exp.id, hypothesis: exp.hypothesis, result: 'reverted', reason: 'Could not compute metrics' });
      state.globalStats.totalReverted++;
      state.globalStats.consecutiveReverts++;
      state.activeExperiment = null;
      state.state = 'collecting_baseline';
      saveState(state);
      return { action: 'revert', reason: 'Could not compute experiment metrics', hypothesis: exp.hypothesis };
    }

    const baselineValue = state.baseline[config.targetMetric];
    const expValue = expMetrics[config.targetMetric];
    const delta = expValue - baselineValue;
    const threshold = config.significanceThreshold || significanceThreshold(config.windowSize);

    if (delta > threshold) {
      // ── KEEP ──
      const improvement = `+${(delta * 100).toFixed(0)}% ${config.targetMetric}`;
      updateConventionSource(exp.id, improvement);
      saveHistory(exp, 'kept');
      state.history.push({ id: exp.id, hypothesis: exp.hypothesis, result: 'kept', improvement, dataPoints: expSignals.length });
      state.globalStats.totalKept++;
      state.globalStats.totalExperiments++;
      state.globalStats.consecutiveReverts = 0;
      // Advance baseline
      state.baseline = { ...expMetrics, windowStart: 0, windowEnd: expSignals.length - 1 };
      state.activeExperiment = null;
      state.state = 'collecting_baseline';
      state.version++;
      saveState(state);
      return { action: 'keep', improvement, hypothesis: exp.hypothesis };
    }

    if (delta < -threshold) {
      // ── REVERT ──
      removeConvention(exp.id);
      saveHistory(exp, 'reverted');
      const decline = `${(delta * 100).toFixed(0)}% ${config.targetMetric}`;
      state.history.push({ id: exp.id, hypothesis: exp.hypothesis, result: 'reverted', decline, dataPoints: expSignals.length });
      state.globalStats.totalReverted++;
      state.globalStats.totalExperiments++;
      state.globalStats.consecutiveReverts++;
      state.activeExperiment = null;
      state.state = 'collecting_baseline';
      saveState(state);
      return { action: 'revert', decline, hypothesis: exp.hypothesis };
    }

    // ── INCONCLUSIVE — extend or revert ──
    if (!exp.extended) {
      exp.extended = true;
      state.state = 'running';
      saveState(state);
      const extendBy = Math.ceil(config.windowSize / 2);
      return {
        action: 'extend',
        reason: `Delta ${(delta * 100).toFixed(1)}% within noise band (±${(threshold * 100).toFixed(0)}%)`,
        extendBy,
        hypothesis: exp.hypothesis,
      };
    }

    // Already extended once — revert
    removeConvention(exp.id);
    saveHistory(exp, 'reverted');
    state.history.push({ id: exp.id, hypothesis: exp.hypothesis, result: 'reverted', reason: 'Inconclusive after extension' });
    state.globalStats.totalReverted++;
    state.globalStats.totalExperiments++;
    state.globalStats.consecutiveReverts++;
    state.activeExperiment = null;
    state.state = 'collecting_baseline';
    saveState(state);
    return { action: 'revert', reason: 'Inconclusive after extension', hypothesis: exp.hypothesis };
  }

  saveState(state);
  return { action: 'unknown', state: state.state };
}

// ── CLI commands ─────────────────────────────────────────────────────────

function printStatus() {
  const state = loadState();
  const config = loadConfig();
  const signals = readSignals();

  console.log('\n=== Inline Autoresearch Status ===\n');
  console.log(`State: ${state.state}`);
  console.log(`Enabled: ${config.enabled}`);
  console.log(`Target: ${config.targetAgent} / ${config.targetMetric}`);
  console.log(`Window size: ${config.windowSize}`);
  console.log(`Total signals: ${signals.length}`);
  console.log(`Total experiments: ${state.globalStats.totalExperiments}`);
  console.log(`Kept: ${state.globalStats.totalKept} | Reverted: ${state.globalStats.totalReverted}`);
  console.log(`Consecutive reverts: ${state.globalStats.consecutiveReverts}`);

  if (state.baseline) {
    console.log(`\nBaseline ${config.targetMetric}: ${(state.baseline[config.targetMetric] * 100).toFixed(1)}%`);
  }

  if (state.activeExperiment) {
    const exp = state.activeExperiment;
    console.log(`\nActive experiment: exp-${String(exp.id).padStart(3, '0')}`);
    console.log(`  Hypothesis: ${exp.hypothesis}`);
    console.log(`  Data points: ${exp.dataPoints}/${exp.extended ? exp.windowSize + Math.ceil(exp.windowSize / 2) : exp.windowSize}`);
    console.log(`  Started: ${exp.startedAt}`);
  }

  if (state.history.length > 0) {
    console.log('\nRecent experiments:');
    for (const h of state.history.slice(-5)) {
      console.log(`  exp-${String(h.id).padStart(3, '0')}: ${h.result} — ${h.hypothesis}`);
      if (h.improvement) console.log(`    Improvement: ${h.improvement}`);
      if (h.decline) console.log(`    Decline: ${h.decline}`);
      if (h.reason) console.log(`    Reason: ${h.reason}`);
    }
  }

  if (state.pausedReason) {
    console.log(`\nPaused: ${state.pausedReason}`);
  }

  console.log(`\nConventions by inline-autoresearch: ${countOurConventions()}`);
  console.log('');
}

function abort() {
  const state = loadState();
  if (state.activeExperiment) {
    removeConvention(state.activeExperiment.id);
    saveHistory(state.activeExperiment, 'aborted');
    console.log(`Aborted experiment exp-${String(state.activeExperiment.id).padStart(3, '0')}: ${state.activeExperiment.hypothesis}`);
    state.history.push({ id: state.activeExperiment.id, hypothesis: state.activeExperiment.hypothesis, result: 'aborted' });
    state.activeExperiment = null;
  }
  state.state = 'idle';
  state.pausedReason = 'Manually aborted';
  saveState(state);
  console.log('System set to IDLE.');
}

function pause() {
  const state = loadState();
  state.state = 'idle';
  state.pausedReason = 'Manually paused';
  saveState(state);
  console.log('System paused. Active experiment (if any) remains in conventions.');
}

function resume() {
  const state = loadState();
  if (state.state !== 'idle') {
    console.log(`System is not idle (state: ${state.state}) — nothing to resume.`);
    return;
  }
  state.state = 'collecting_baseline';
  state.pausedReason = null;
  state.globalStats.consecutiveReverts = 0;
  saveState(state);
  console.log('System resumed. Collecting baseline.');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const command = args[0] || '--check';

  if (command === '--status') {
    printStatus();
    return;
  }

  if (command === '--abort') {
    abort();
    return;
  }

  if (command === '--pause') {
    pause();
    return;
  }

  if (command === '--resume') {
    resume();
    return;
  }

  if (command === '--check') {
    if (!config.enabled) {
      console.log(JSON.stringify({ action: 'disabled' }));
      return;
    }

    if (!existsSync(INLINE_DIR)) mkdirSync(INLINE_DIR, { recursive: true });

    const result = runCheck(config);
    console.log(JSON.stringify(result));

    // If proposal is needed, try to run propose.js
    if (result.action === 'needsProposal') {
      const proposePath = resolve(INLINE_DIR, 'propose.js');
      if (existsSync(proposePath)) {
        try {
          execFileSync('node', [proposePath], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: config.proposalTimeoutMs || 120000,
          });
        } catch (err) {
          // Proposal failed — revert to collecting_baseline
          const state = loadState();
          if (state.state === 'proposing') {
            state.state = 'collecting_baseline';
            saveState(state);
          }
        }
      }
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Usage: node check.js [--check|--status|--abort|--pause|--resume]');
  process.exit(1);
}

main();

export { runCheck, loadState, saveState, addConvention, removeConvention, computeMetrics, readSignals };
