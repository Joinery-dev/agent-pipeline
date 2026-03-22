#!/usr/bin/env node

/**
 * propose.js — LLM proposer for inline autoresearch.
 *
 * Makes a single LLM call via spawnAgent to propose a convention
 * based on signal data, failure categories, and experiment history.
 *
 * Called by check.js when the state machine enters PROPOSING.
 * Reads experiment.json, signals.jsonl, QA patterns, and builder-program.md.
 * Writes a new convention to project-conventions.md and updates state.
 *
 * Usage:
 *   node .autoresearch/inline/propose.js
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { spawnAgent } from '../../lib/agent-runner.js';

// ── Paths ────────────────────────────────────────────────────────────────

const INLINE_DIR = resolve('.autoresearch/inline');
const EXPERIMENT_PATH = resolve(INLINE_DIR, 'experiment.json');
const SIGNALS_PATH = resolve(INLINE_DIR, 'signals.jsonl');
const CONVENTIONS_PATH = resolve('.claude/project-conventions.md');
const PATTERNS_PATH = resolve('.qa/memory/patterns.md');
const REGRESSIONS_PATH = resolve('.qa/memory/regressions.md');
const CONFIG_PATH = resolve('ship-config.json');

// ── Config ───────────────────────────────────────────────────────────────

function loadConfig() {
  const defaults = {
    enabled: false,
    targetAgent: 'builder',
    targetMetric: 'firstPassQARate',
    windowSize: 5,
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

// ── State ────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(EXPERIMENT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(EXPERIMENT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(EXPERIMENT_PATH, JSON.stringify(state, null, 2));
}

// ── Signal reading ───────────────────────────────────────────────────────

function readSignals() {
  if (!existsSync(SIGNALS_PATH)) return [];
  try {
    return readFileSync(SIGNALS_PATH, 'utf-8').trim().split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function aggregateFailureCategories(signals) {
  const counts = {};
  for (const s of signals) {
    for (const cat of s.failureCategories || []) {
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
}

function formatSignalTable(signals) {
  if (signals.length === 0) return '(no signal data)';
  return signals.map(s =>
    `- ${s.taskTitle || s.taskId}: firstPassQA=${s.firstPassQA}, buildAttempts=${s.buildAttempts}, fixAttempts=${s.fixAttempts}, failures=[${(s.failureCategories || []).join(', ')}], complexity=${s.complexity}`
  ).join('\n');
}

// ── Context reading ──────────────────────────────────────────────────────

function readProgram(agent) {
  const programPath = resolve(INLINE_DIR, `${agent}-program.md`);
  if (!existsSync(programPath)) {
    return `# ${agent} Protocol Optimization

## Metric
firstPassQARate — percentage of tasks passing QA without a resolve cycle

## What can change
- Wording and specificity of behavioral conventions
- Adding sub-checks or references to common failure patterns
- Removing vague guidance that doesn't correlate with outcomes

## What must NOT change
- Protocol file structure or step sequence
- Pipeline CLI usage patterns
- Test-running requirements

## Strategy
- One hypothesis per experiment (single change)
- Prioritize targeting failure categories seen 2+ times
- Prefer adding specificity over adding steps
- Keep conventions under 500 characters`;
  }
  return readFileSync(programPath, 'utf-8');
}

function readQAPatterns() {
  if (!existsSync(PATTERNS_PATH)) return '(no QA patterns recorded yet)';
  try {
    const content = readFileSync(PATTERNS_PATH, 'utf-8');
    // Truncate if very long
    return content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content;
  } catch {
    return '(could not read patterns)';
  }
}

function readConventions() {
  if (!existsSync(CONVENTIONS_PATH)) return '(no conventions file)';
  try {
    return readFileSync(CONVENTIONS_PATH, 'utf-8');
  } catch {
    return '(could not read conventions)';
  }
}

// ── Prompt building ──────────────────────────────────────────────────────

function buildPrompt(config, state, signals) {
  const recentSignals = signals.slice(-config.windowSize * 2);
  const failureCategories = aggregateFailureCategories(recentSignals);
  const program = readProgram(config.targetAgent);
  const conventions = readConventions();
  const patterns = readQAPatterns();
  const baselineValue = state.baseline?.[config.targetMetric];

  const experimentHistory = (state.history || []).slice(-5)
    .map(h => `- exp-${String(h.id).padStart(3, '0')}: ${h.result} — "${h.hypothesis}"${h.improvement ? ` (${h.improvement})` : ''}${h.reason ? ` (${h.reason})` : ''}`)
    .join('\n') || '(no previous experiments)';

  return `You are optimizing the ${config.targetAgent} agent's behavior in an autonomous software pipeline.
Your goal: propose ONE convention that will improve the ${config.targetMetric} metric.

## Constraints (DO NOT VIOLATE)
${program}

## Metric Being Optimized
${config.targetMetric}: currently ${baselineValue !== undefined ? (baselineValue * 100).toFixed(1) + '%' : 'unknown'} (${state.baseline?.dataPoints || 0} data points)

## Current Conventions
${conventions}

## Recent Signal Data (task outcomes)
${formatSignalTable(recentSignals)}

## Top Failure Categories in Current Window
${failureCategories.length > 0 ? failureCategories.map(f => `- ${f.category}: ${f.count} occurrences`).join('\n') : '(no failures recorded)'}

## QA Patterns (recurring issues found by QA agent)
${patterns}

## Previous Experiments
${experimentHistory}

## Instructions

Based on the signal data and failure categories, propose ONE convention that would
prevent the most common failure mode. The convention must be:

1. A single, specific behavioral instruction (not vague guidance)
2. Under ${config.conventionMaxLength} characters
3. Testable — an observer could verify whether the agent followed it
4. Additive — it tells the agent what TO DO, not what to remove
5. General — it must help across different tasks, not just recent ones

Output format (use EXACTLY this format):

HYPOTHESIS: <one sentence explaining what you think will improve>
CONVENTION_TITLE: <short title, under 60 characters>
---CONVENTION---
<the convention text, under ${config.conventionMaxLength} characters>`;
}

// ── Output parsing ───────────────────────────────────────────────────────

function parseProposalOutput(output) {
  let textContent = '';

  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && event.message) textContent += event.message;
      if (event.type === 'content_block_delta' && event.delta?.text) textContent += event.delta.text;
      if (event.type === 'result' && event.result) textContent = event.result;
    } catch {
      if (!line.startsWith('{')) textContent += line + '\n';
    }
  }

  if (!textContent) {
    return { success: false, error: 'No output from proposer' };
  }

  // Extract fields
  const hypothesisMatch = textContent.match(/HYPOTHESIS:\s*(.+)/);
  const titleMatch = textContent.match(/CONVENTION_TITLE:\s*(.+)/);
  const conventionMarker = '---CONVENTION---';
  const conventionIdx = textContent.indexOf(conventionMarker);

  if (!hypothesisMatch || !titleMatch || conventionIdx === -1) {
    return { success: false, error: 'Could not parse proposal output format' };
  }

  const hypothesis = hypothesisMatch[1].trim();
  const title = titleMatch[1].trim();
  const conventionText = textContent.slice(conventionIdx + conventionMarker.length).trim();

  return { success: true, hypothesis, title, conventionText };
}

// ── Convention writing (duplicated from check.js to avoid circular import) ──

function addConvention(title, conventionText, expId) {
  if (!existsSync(CONVENTIONS_PATH)) return false;

  let content = readFileSync(CONVENTIONS_PATH, 'utf-8');
  const date = new Date().toISOString().split('T')[0];

  const entry = `\n### ${title}\n**Source:** inline-autoresearch exp-${String(expId).padStart(3, '0')} — ${date}\n**Convention:** ${conventionText}\n`;

  content = content.replace(/\(none yet[^)]*\)/, '');
  content = content.trimEnd() + '\n' + entry;

  writeFileSync(CONVENTIONS_PATH, content);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const state = loadState();

  if (!state || state.state !== 'proposing') {
    console.log(JSON.stringify({ action: 'skip', reason: 'Not in proposing state' }));
    return;
  }

  if (!state.baseline) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'skip', reason: 'No baseline — reverting to collecting' }));
    return;
  }

  const signals = readSignals();
  const prompt = buildPrompt(config, state, signals);

  // Make the LLM call
  let result;
  try {
    result = await spawnAgent(prompt, {
      timeoutMs: config.proposalTimeoutMs || 120000,
    });
  } catch (err) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'error', reason: `spawnAgent failed: ${err.message}` }));
    return;
  }

  if (!result.success && !result.output) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'error', reason: 'Proposer returned no output' }));
    return;
  }

  // Parse the proposal
  const proposal = parseProposalOutput(result.output || '');

  if (!proposal.success) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'error', reason: proposal.error }));
    return;
  }

  // Validate constraints
  if (proposal.title.length > 60) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'rejected', reason: `Title too long: ${proposal.title.length} chars (max 60)` }));
    return;
  }

  if (proposal.conventionText.length > config.conventionMaxLength) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'rejected', reason: `Convention too long: ${proposal.conventionText.length} chars (max ${config.conventionMaxLength})` }));
    return;
  }

  if (!proposal.conventionText.trim()) {
    state.state = 'collecting_baseline';
    saveState(state);
    console.log(JSON.stringify({ action: 'rejected', reason: 'Empty convention text' }));
    return;
  }

  // Create experiment
  const expId = (state.globalStats.totalExperiments || 0) + 1;
  const failureCategories = aggregateFailureCategories(signals.slice(-config.windowSize));

  state.activeExperiment = {
    id: expId,
    agent: config.targetAgent,
    hypothesis: proposal.hypothesis,
    conventionTitle: proposal.title,
    conventionText: proposal.conventionText,
    startedAt: new Date().toISOString(),
    dataPoints: 0,
    windowSize: config.windowSize,
    extended: false,
    targetMetric: config.targetMetric,
    proposalContext: {
      topFailureCategories: failureCategories.slice(0, 3),
      baselineMetric: state.baseline[config.targetMetric],
    },
  };

  state.locked = {
    agents: ['qa', 'resolve', 'pm', 'exec'].filter(a => a !== config.targetAgent),
    reason: `${config.targetAgent} experiment in progress`,
  };

  // Write the convention
  const written = addConvention(proposal.title, proposal.conventionText, expId);
  if (!written) {
    state.state = 'collecting_baseline';
    state.activeExperiment = null;
    saveState(state);
    console.log(JSON.stringify({ action: 'error', reason: 'Could not write convention to file' }));
    return;
  }

  state.state = 'running';
  saveState(state);

  console.log(JSON.stringify({
    action: 'proposed',
    expId,
    hypothesis: proposal.hypothesis,
    title: proposal.title,
    convention: proposal.conventionText.slice(0, 100) + (proposal.conventionText.length > 100 ? '...' : ''),
  }));
}

main().catch(err => {
  // On any unhandled error, revert to collecting_baseline
  try {
    const state = JSON.parse(readFileSync(resolve('.autoresearch/inline/experiment.json'), 'utf-8'));
    if (state.state === 'proposing') {
      state.state = 'collecting_baseline';
      writeFileSync(resolve('.autoresearch/inline/experiment.json'), JSON.stringify(state, null, 2));
    }
  } catch {}
  console.error(`Propose error: ${err.message}`);
  process.exit(1);
});
