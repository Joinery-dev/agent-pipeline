#!/usr/bin/env node

/**
 * autoresearch-nightly.js — Nightly protocol optimization orchestrator.
 *
 * Cycles through all protocol/benchmark pairs, allocating budget based on
 * LLM-generated priorities. After each cycle, runs an LLM evaluation that
 * analyzes results, updates priorities, and tracks trends over time.
 *
 * Usage:
 *   node lib/autoresearch-nightly.js                     # full nightly cycle
 *   node lib/autoresearch-nightly.js --budget-hours 8    # override total budget
 *   node lib/autoresearch-nightly.js --candidates 3      # candidates per iteration
 *   node lib/autoresearch-nightly.js --status             # print trend summary
 *   node lib/autoresearch-nightly.js --dry-run            # show what would run
 *
 * Scheduling:
 *   Install launchd plist: see scheduling/com.agent-pipeline.autoresearch-nightly.plist
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync } from 'fs';
import { resolve, join, basename } from 'path';
import { spawnAgent } from './agent-runner.js';
import { run as runAutoresearch } from './autoresearch.js';

// ── Constants ─────────────────────────────────────────────────────────────

const NIGHTLY_DIR = resolve('.autoresearch/nightly');
const STATE_PATH = resolve(NIGHTLY_DIR, 'state.json');
const PRIORITIES_PATH = resolve(NIGHTLY_DIR, 'priorities.json');
const TREND_PATH = resolve(NIGHTLY_DIR, 'trend.tsv');
const TREND_SUMMARY_PATH = resolve(NIGHTLY_DIR, 'trend-summary.md');
const EVALUATIONS_DIR = resolve(NIGHTLY_DIR, 'evaluations');
const LOCK_PATH = resolve(NIGHTLY_DIR, '.lock');
const BENCHMARKS_DIR = resolve('.autoresearch/benchmarks');

const DEFAULT_BUDGET_HOURS = 8;
const DEFAULT_CANDIDATES = 3;
const DEFAULT_ITERATIONS_PER_PROTOCOL = 15;
const DEFAULT_TIMEOUT_MIN = 5;

// ── Logging ───────────────────────────────────────────────────────────────

function log(level, msg) {
  const icons = { nightly: '🌙', eval: '🔍', trend: '📈', error: '❌', info: 'ℹ️', done: '✅' };
  const ts = new Date().toLocaleTimeString();
  console.log(`${ts}  ${icons[level] || '  '} [${level.toUpperCase()}]  ${msg}`);
}

// ── Discovery ─────────────────────────────────────────────────────────────

function discoverBenchmarks() {
  if (!existsSync(BENCHMARKS_DIR)) return [];

  const benchmarks = [];
  for (const name of readdirSync(BENCHMARKS_DIR)) {
    const metaPath = resolve(BENCHMARKS_DIR, name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      benchmarks.push({ name, ...meta });
    } catch {}
  }
  return benchmarks;
}

// ── Priority Management ───────────────────────────────────────────────────

function loadPriorities() {
  if (!existsSync(PRIORITIES_PATH)) return null;
  try { return JSON.parse(readFileSync(PRIORITIES_PATH, 'utf-8')); } catch { return null; }
}

function savePriorities(priorities) {
  writeFileSync(PRIORITIES_PATH, JSON.stringify(priorities, null, 2));
}

/**
 * Allocate budget hours across protocols based on priorities.
 * If no priorities exist, distribute evenly.
 */
function allocateBudget(benchmarks, totalHours) {
  const priorities = loadPriorities();

  if (!priorities || !priorities.priorities?.length) {
    // Even distribution
    const perProtocol = totalHours / benchmarks.length;
    return benchmarks.map(b => ({
      ...b,
      budgetHours: perProtocol,
      suggestedOperators: null,
    }));
  }

  // Match priorities to benchmarks, fall back to equal share for unmatched
  const priorityMap = new Map(priorities.priorities.map(p => [p.benchmark, p]));
  const totalShare = priorities.priorities.reduce((s, p) => s + (p.budgetShare || 0), 0) || 1;

  return benchmarks.map(b => {
    const p = priorityMap.get(b.name);
    return {
      ...b,
      budgetHours: p ? (p.budgetShare / totalShare) * totalHours : totalHours / benchmarks.length,
      suggestedOperators: p?.suggestedOperators || null,
    };
  });
}

// ── Nightly State ─────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { return null; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Lock File (prevent overlapping runs) ──────────────────────────────────

function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const lockContent = readFileSync(LOCK_PATH, 'utf-8');
    const lockTime = new Date(lockContent.trim());
    const ageHours = (Date.now() - lockTime.getTime()) / 3600000;
    if (ageHours < 12) {
      log('error', `Lock file exists (${ageHours.toFixed(1)}h old). Another run may be active.`);
      log('info', `Remove ${LOCK_PATH} to force.`);
      return false;
    }
    log('info', 'Stale lock file found (>12h) — removing');
  }
  writeFileSync(LOCK_PATH, new Date().toISOString());
  return true;
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ── Trend Tracking ────────────────────────────────────────────────────────

const TREND_HEADER = 'date\tbuild-basic\tqa-accuracy\tresolve-precision\texec-decompose\tpm-planning\ttotal_keeps\ttotal_reverts\tnotes';

function appendTrendRow(results) {
  if (!existsSync(TREND_PATH)) {
    writeFileSync(TREND_PATH, TREND_HEADER + '\n');
  }

  const date = new Date().toISOString().split('T')[0];
  const scores = {};
  let totalKeeps = 0;
  let totalReverts = 0;
  const notes = [];

  for (const r of results) {
    scores[r.benchmark] = r.bestScore?.toFixed(3) || '-';
    totalKeeps += r.keeps || 0;
    totalReverts += r.reverts || 0;
    if (r.saturated) notes.push(`${r.benchmark}:saturated`);
  }

  const row = [
    date,
    scores['build-basic'] || '-',
    scores['qa-accuracy'] || '-',
    scores['resolve-precision'] || '-',
    scores['exec-decompose'] || '-',
    scores['pm-planning'] || '-',
    totalKeeps,
    totalReverts,
    notes.join('; ') || 'ok',
  ].join('\t');

  appendFileSync(TREND_PATH, row + '\n');
}

function generateTrendSummary() {
  if (!existsSync(TREND_PATH)) {
    writeFileSync(TREND_SUMMARY_PATH, '# Nightly Trend Summary\n\nNo data yet.\n');
    return;
  }

  const lines = readFileSync(TREND_PATH, 'utf-8').trim().split('\n');
  if (lines.length < 2) {
    writeFileSync(TREND_SUMMARY_PATH, '# Nightly Trend Summary\n\nNo data yet.\n');
    return;
  }

  const header = lines[0].split('\t');
  const rows = lines.slice(1).map(l => l.split('\t'));
  const last7 = rows.slice(-7);

  let summary = '# Nightly Trend Summary\n\n';
  summary += `**Last updated:** ${new Date().toISOString().split('T')[0]}\n`;
  summary += `**Total nights:** ${rows.length}\n\n`;

  // Per-protocol trajectory
  summary += '## Score Trajectory (last 7 nights)\n\n';
  summary += '| Date |';
  for (let i = 1; i <= 5; i++) summary += ` ${header[i]} |`;
  summary += '\n|------|';
  for (let i = 1; i <= 5; i++) summary += '------|';
  summary += '\n';

  for (const row of last7) {
    summary += `| ${row[0]} |`;
    for (let i = 1; i <= 5; i++) summary += ` ${row[i]} |`;
    summary += '\n';
  }

  // Overall improvement
  if (rows.length >= 2) {
    summary += '\n## Overall Change (first → latest)\n\n';
    const first = rows[0];
    const latest = rows[rows.length - 1];
    for (let i = 1; i <= 5; i++) {
      const f = parseFloat(first[i]);
      const l = parseFloat(latest[i]);
      if (!isNaN(f) && !isNaN(l) && f > 0) {
        const change = ((l - f) / f * 100).toFixed(1);
        summary += `- **${header[i]}:** ${first[i]} → ${latest[i]} (${change >= 0 ? '+' : ''}${change}%)\n`;
      }
    }
  }

  writeFileSync(TREND_SUMMARY_PATH, summary);
}

function printTrendSummary() {
  generateTrendSummary();
  if (existsSync(TREND_SUMMARY_PATH)) {
    console.log(readFileSync(TREND_SUMMARY_PATH, 'utf-8'));
  } else {
    console.log('No trend data yet.');
  }
}

// ── LLM Evaluation ───────────────────────────────────────────────────────

async function runLLMEvaluation(results) {
  if (!existsSync(EVALUATIONS_DIR)) mkdirSync(EVALUATIONS_DIR, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const evalPath = resolve(EVALUATIONS_DIR, `${date}.md`);

  // Read previous evaluation for context
  let previousEval = '';
  const evalFiles = existsSync(EVALUATIONS_DIR) ? readdirSync(EVALUATIONS_DIR).filter(f => f.endsWith('.md')).sort() : [];
  if (evalFiles.length > 0) {
    const lastEval = evalFiles[evalFiles.length - 1];
    if (lastEval !== `${date}.md`) {
      previousEval = readFileSync(resolve(EVALUATIONS_DIR, lastEval), 'utf-8');
    }
  }

  // Build results summary for the LLM
  const resultsSummary = results.map(r => `### ${r.target} (${r.benchmark})
- Best score: ${r.bestScore?.toFixed(3) || 'N/A'}
- Baseline: ${r.baseline?.toFixed(3) || 'N/A'}
- Iterations: ${r.iterations || 0}
- Kept: ${r.keeps || 0}, Reverted: ${r.reverts || 0}
- Saturated: ${r.saturated ? 'yes' : 'no'}`).join('\n\n');

  // Read trend data
  const trendData = existsSync(TREND_PATH) ? readFileSync(TREND_PATH, 'utf-8') : '(no trend data)';

  const prompt = `You are analyzing tonight's autoresearch protocol optimization results.

## Tonight's Results
${resultsSummary}

## Trend Data (score history)
\`\`\`
${trendData}
\`\`\`

${previousEval ? `## Previous Night's Evaluation\n${previousEval}\n` : ''}

## Your Tasks

1. **Write an evaluation report** analyzing:
   - Which protocols improved and why
   - Which are stuck/saturated and what might help
   - Emerging patterns across protocols
   - What the LLM optimizer is struggling with

2. **Update priorities** — decide budget allocation for next night:
   - Protocols with low scores and high improvement potential get more budget
   - Saturated protocols get less (but don't zero them out — other protocol improvements may unlock new gains)
   - Suggest specific mutation operators to try for stuck protocols

## Output Format

Write your evaluation report first (markdown), then output the priorities JSON:

---EVALUATION---
<markdown evaluation report>
---PRIORITIES---
<JSON object with this schema:>
{
  "updatedAt": "<ISO date>",
  "priorities": [
    { "target": "<file>", "benchmark": "<name>", "budgetShare": <0.0-1.0>, "reason": "<why>", "suggestedOperators": ["<op1>", "<op2>"] }
  ]
}`;

  log('eval', 'Running LLM evaluation of tonight\'s results...');

  const result = await spawnAgent(prompt, {
    timeoutMs: 5 * 60 * 1000,
  });

  if (!result.success && !result.output) {
    log('error', 'LLM evaluation failed — skipping');
    return;
  }

  // Parse output
  const output = result.output || '';
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

  // Extract evaluation
  const evalMarker = '---EVALUATION---';
  const priMarker = '---PRIORITIES---';
  const evalIdx = textContent.indexOf(evalMarker);
  const priIdx = textContent.indexOf(priMarker);

  if (evalIdx !== -1) {
    const evalContent = priIdx !== -1
      ? textContent.slice(evalIdx + evalMarker.length, priIdx).trim()
      : textContent.slice(evalIdx + evalMarker.length).trim();
    writeFileSync(evalPath, `# Nightly Evaluation — ${date}\n\n${evalContent}\n`);
    log('eval', `Evaluation written: ${evalPath}`);
  }

  // Extract and save priorities
  if (priIdx !== -1) {
    const priContent = textContent.slice(priIdx + priMarker.length).trim();
    try {
      // Find JSON in the content
      const jsonMatch = priContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const priorities = JSON.parse(jsonMatch[0]);
        savePriorities(priorities);
        log('eval', `Priorities updated: ${priorities.priorities?.length || 0} entries`);
      }
    } catch (err) {
      log('error', `Failed to parse priorities JSON: ${err.message}`);
    }
  }
}

// ── Main Cycle ────────────────────────────────────────────────────────────

async function runNightlyCycle(options = {}) {
  const {
    budgetHours = DEFAULT_BUDGET_HOURS,
    candidates = DEFAULT_CANDIDATES,
    iterationsPerProtocol = DEFAULT_ITERATIONS_PER_PROTOCOL,
    timeoutMin = DEFAULT_TIMEOUT_MIN,
    dryRun = false,
  } = options;

  // Ensure directories
  mkdirSync(NIGHTLY_DIR, { recursive: true });
  mkdirSync(EVALUATIONS_DIR, { recursive: true });

  // Discover all benchmarks
  const benchmarks = discoverBenchmarks();
  if (benchmarks.length === 0) {
    log('error', 'No benchmarks found in .autoresearch/benchmarks/');
    return;
  }

  // Allocate budget
  const allocated = allocateBudget(benchmarks, budgetHours);

  log('nightly', `═══ Nightly Auto-Research Cycle ═══`);
  log('nightly', `Protocols: ${benchmarks.length}`);
  log('nightly', `Total budget: ${budgetHours}h`);
  log('nightly', `Candidates per iteration: ${candidates}`);
  log('nightly', '');

  for (const a of allocated) {
    log('nightly', `  ${a.targetProtocol} (${a.name}): ${a.budgetHours.toFixed(1)}h${a.suggestedOperators ? ` [${a.suggestedOperators.join(', ')}]` : ''}`);
  }

  if (dryRun) {
    log('info', '\nDRY RUN — would run the above. Exiting.');
    return;
  }

  // Acquire lock
  if (!acquireLock()) return;

  // Initialize nightly state
  const nightlyState = {
    startedAt: new Date().toISOString(),
    protocols: allocated.map(a => ({
      target: a.targetProtocol,
      benchmark: a.name,
      status: 'pending',
      budgetHours: a.budgetHours,
    })),
  };
  saveState(nightlyState);

  // Run each protocol
  const results = [];

  for (const protocol of allocated) {
    const stateDir = resolve(NIGHTLY_DIR, protocol.name);
    mkdirSync(stateDir, { recursive: true });

    log('nightly', `\n═══ Optimizing: ${protocol.targetProtocol} (${protocol.name}) — ${protocol.budgetHours.toFixed(1)}h ═══`);

    // Update nightly state
    const entry = nightlyState.protocols.find(p => p.benchmark === protocol.name);
    if (entry) entry.status = 'running';
    saveState(nightlyState);

    try {
      const result = await runAutoresearch(protocol.targetProtocol, protocol.name, {
        maxIterations: iterationsPerProtocol,
        candidates,
        timeoutMs: timeoutMin * 60 * 1000,
        budgetHours: protocol.budgetHours,
        stateDir,
        branchPrefix: 'autoresearch-nightly',
      });

      results.push({
        target: protocol.targetProtocol,
        benchmark: protocol.name,
        ...result,
      });

      if (entry) {
        entry.status = 'completed';
        entry.bestScore = result?.bestScore;
        entry.saturated = result?.saturated;
        entry.iterations = result?.iterations;
        entry.keeps = result?.keeps;
        entry.reverts = result?.reverts;
      }
    } catch (err) {
      log('error', `Protocol ${protocol.name} failed: ${err.message}`);
      results.push({
        target: protocol.targetProtocol,
        benchmark: protocol.name,
        bestScore: 0,
        saturated: false,
        error: err.message,
      });
      if (entry) entry.status = 'error';
    }

    saveState(nightlyState);
  }

  // ── LLM Evaluation ──
  await runLLMEvaluation(results);

  // ── Trend tracking ──
  appendTrendRow(results);
  generateTrendSummary();

  // ── Summary ──
  nightlyState.completedAt = new Date().toISOString();
  saveState(nightlyState);
  releaseLock();

  log('done', '\n═══ Nightly Cycle Complete ═══');
  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : `score: ${r.bestScore?.toFixed(3) || '?'}${r.saturated ? ' (saturated)' : ''}`;
    log('done', `  ${r.target}: ${status}`);
  }
  log('info', `Evaluation: .autoresearch/nightly/evaluations/`);
  log('info', `Trends: .autoresearch/nightly/trend-summary.md`);
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--budget-hours') flags.budgetHours = parseFloat(args[++i]);
    else if (args[i] === '--candidates') flags.candidates = parseInt(args[++i]);
    else if (args[i] === '--iterations') flags.iterations = parseInt(args[++i]);
    else if (args[i] === '--timeout') flags.timeout = parseInt(args[++i]);
    else if (args[i] === '--status') flags.status = true;
    else if (args[i] === '--dry-run') flags.dryRun = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printUsage() {
  console.log(`
Nightly Auto-Research — Protocol optimization orchestrator

Usage:
  node lib/autoresearch-nightly.js                     Run full nightly cycle
  node lib/autoresearch-nightly.js --status            Print trend summary
  node lib/autoresearch-nightly.js --dry-run           Show what would run

Flags:
  --budget-hours <h>     Total runtime budget (default: ${DEFAULT_BUDGET_HOURS})
  --candidates <n>       Candidates per iteration (default: ${DEFAULT_CANDIDATES})
  --iterations <n>       Max iterations per protocol (default: ${DEFAULT_ITERATIONS_PER_PROTOCOL})
  --timeout <min>        Per-benchmark timeout (default: ${DEFAULT_TIMEOUT_MIN})
  --status               Print trend summary and exit
  --dry-run              Show config and exit

Scheduling (launchd):
  # Install
  cp scheduling/com.agent-pipeline.autoresearch-nightly.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.agent-pipeline.autoresearch-nightly.plist

  # Uninstall
  launchctl unload ~/Library/LaunchAgents/com.agent-pipeline.autoresearch-nightly.plist
  rm ~/Library/LaunchAgents/com.agent-pipeline.autoresearch-nightly.plist

  # Test manually
  launchctl start com.agent-pipeline.autoresearch-nightly
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printUsage();
    return;
  }

  if (flags.status) {
    printTrendSummary();
    return;
  }

  await runNightlyCycle({
    budgetHours: flags.budgetHours || DEFAULT_BUDGET_HOURS,
    candidates: flags.candidates || DEFAULT_CANDIDATES,
    iterationsPerProtocol: flags.iterations || DEFAULT_ITERATIONS_PER_PROTOCOL,
    timeoutMin: flags.timeout || DEFAULT_TIMEOUT_MIN,
    dryRun: flags.dryRun || false,
  });
}

const isDirectRun = process.argv[1]?.endsWith('autoresearch-nightly.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

export { runNightlyCycle, discoverBenchmarks, allocateBudget, printTrendSummary };
