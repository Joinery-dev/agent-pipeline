#!/usr/bin/env node

/**
 * autoresearch.js — Karpathy-style overnight optimization loop for agent protocols.
 *
 * Applies the autoresearch pattern to agent-pipeline protocol files:
 * one modifiable file, one locked evaluation, one metric, keep/revert via git.
 *
 * The three-file mapping:
 *   train.py  (Karpathy)  →  template/.claude/commands/<agent>.md  (protocol to optimize)
 *   program.md (Karpathy)  →  .autoresearch/program.md              (human constraints)
 *   prepare.py (Karpathy)  →  .autoresearch/benchmarks/<name>/eval.js (locked evaluation)
 *
 * Usage:
 *   node lib/autoresearch.js --target build.md --benchmark build-basic
 *   node lib/autoresearch.js --target build.md --benchmark build-basic --iterations 50 --budget-hours 8
 *   node lib/autoresearch.js --resume
 *   node lib/autoresearch.js --results
 *
 * Flags:
 *   --target <file>        Protocol file to optimize (relative to template/.claude/commands/)
 *   --benchmark <name>     Benchmark name in .autoresearch/benchmarks/
 *   --iterations <n>       Max iterations (default: 50)
 *   --timeout <min>        Per-benchmark timeout in minutes (default: 5)
 *   --budget-hours <h>     Total runtime budget in hours (default: 8)
 *   --resume               Resume from experiment.json state
 *   --results              Print results summary and exit
 *   --verbose              Full agent output
 *   --quiet                Minimal output
 *   --dry-run              Show config and exit
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, appendFileSync, readdirSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { createWriteStream } from 'fs';
import { spawnAgent } from './agent-runner.js';

// ── Constants ─────────────────────────────────────────────────────────────

const AUTORESEARCH_DIR = resolve('.autoresearch');
const BENCHMARKS_DIR = resolve(AUTORESEARCH_DIR, 'benchmarks');
const STATE_PATH = resolve(AUTORESEARCH_DIR, 'experiment.json');
const RESULTS_PATH = resolve(AUTORESEARCH_DIR, 'results.tsv');
const PROGRAM_PATH = resolve(AUTORESEARCH_DIR, 'program.md');
const HISTORY_DIR = resolve(AUTORESEARCH_DIR, 'history');
const LOG_PATH = resolve(AUTORESEARCH_DIR, 'latest.log');
const FIELD_REPORTS_DIR = resolve(AUTORESEARCH_DIR, 'field-reports');

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_TIMEOUT_MIN = 5;
const DEFAULT_BUDGET_HOURS = 8;
const DEFAULT_CANDIDATES = 3;
const MAX_CONSECUTIVE_ERRORS = 3;
const CONVERGENCE_THRESHOLD = 5;  // consecutive <1% improvement = saturated
const SIMILAR_REVERT_THRESHOLD = 3; // force strategy switch after 3 similar reverts

// ── Mutation Operators ───────────────────────────────────────────────────

const MUTATION_OPERATORS = [
  { id: 'add-constraint', description: 'Add a specific rule, check, or requirement' },
  { id: 'remove-bloat', description: 'Remove vague, generic, or redundant instructions' },
  { id: 'add-example', description: 'Add a concrete example showing the desired behavior' },
  { id: 'restructure', description: 'Reorder steps for better flow and clarity' },
  { id: 'tighten-language', description: 'Make existing instructions more precise and specific' },
  { id: 'add-counterexample', description: 'Add an example showing what NOT to do' },
];

const TSV_HEADER = 'iteration\ttimestamp\thypothesis\tscore\tbest_score\tdelta\tdecision\tduration_ms\teval_details';

// ── Logging ───────────────────────────────────────────────────────────────

let verbosity = 'normal';
let logStream = null;

function initLog() {
  if (!existsSync(AUTORESEARCH_DIR)) mkdirSync(AUTORESEARCH_DIR, { recursive: true });
  logStream = createWriteStream(LOG_PATH, { flags: 'w' });
}

function log(level, msg) {
  const icons = { research: '🔬', keep: '✅', revert: '↩️', error: '❌', info: 'ℹ️' };
  const ts = new Date().toLocaleTimeString();
  const line = `${ts}  ${icons[level] || '  '} [${level.toUpperCase()}]  ${msg}`;

  if (logStream) logStream.write(line + '\n');

  if (verbosity === 'quiet') {
    if (['keep', 'revert', 'error', 'info'].includes(level)) console.log(line);
  } else {
    console.log(line);
  }
}

// ── State Management ──────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function createState(targetFile, benchmarkName) {
  return {
    targetFile,
    benchmark: benchmarkName,
    iteration: 0,
    bestScore: 0,
    keptVersions: 0,
    baseline: null,
    startedAt: new Date().toISOString(),
    branch: null,
    history: [],
  };
}

// ── Benchmark Loading ─────────────────────────────────────────────────────

function loadBenchmark(name) {
  const dir = resolve(BENCHMARKS_DIR, name);
  if (!existsSync(dir)) {
    throw new Error(`Benchmark not found: ${dir}`);
  }

  const metaPath = resolve(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error(`Benchmark missing meta.json: ${metaPath}`);
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  const taskPath = resolve(dir, 'task.md');
  const evalPath = resolve(dir, 'eval.js');
  const scaffoldDir = resolve(dir, 'scaffold');

  if (!existsSync(taskPath)) throw new Error(`Benchmark missing task.md: ${taskPath}`);
  if (!existsSync(evalPath)) throw new Error(`Benchmark missing eval.js: ${evalPath}`);
  if (!existsSync(scaffoldDir)) throw new Error(`Benchmark missing scaffold/: ${scaffoldDir}`);

  return {
    dir,
    meta,
    task: readFileSync(taskPath, 'utf-8'),
    evalPath,
    scaffoldDir,
  };
}

// ── Results TSV ───────────────────────────────────────────────────────────

function ensureResultsFile() {
  if (!existsSync(RESULTS_PATH)) {
    writeFileSync(RESULTS_PATH, TSV_HEADER + '\n');
  }
}

function appendResult(iteration, hypothesis, score, bestScore, delta, decision, durationMs, details) {
  ensureResultsFile();
  const ts = new Date().toISOString();
  const detailsJson = JSON.stringify(details).replace(/\t/g, ' ');
  const hyp = hypothesis.replace(/\t/g, ' ').replace(/\n/g, ' ');
  const line = `${iteration}\t${ts}\t${hyp}\t${score}\t${bestScore}\t${delta}\t${decision}\t${durationMs}\t${detailsJson}`;
  appendFileSync(RESULTS_PATH, line + '\n');
}

function readLastNResults(n, resultsPath = RESULTS_PATH) {
  if (!existsSync(resultsPath)) return '';
  const lines = readFileSync(resultsPath, 'utf-8').trim().split('\n');
  // Include header + last N data lines
  const header = lines[0];
  const data = lines.slice(1).slice(-n);
  return [header, ...data].join('\n');
}

/**
 * OPRO pattern: return last N results sorted worst-first (ascending by score).
 * LLM recency bias means it focuses more on fixing the worst failures.
 */
function readLastNResultsSorted(n, resultsPath = RESULTS_PATH) {
  if (!existsSync(resultsPath)) return '';
  const lines = readFileSync(resultsPath, 'utf-8').trim().split('\n');
  const header = lines[0];
  const data = lines.slice(1).slice(-Math.max(n * 2, 20)); // read a larger window
  // Sort by score ascending (worst first) and take N
  const sorted = data
    .map(line => ({ line, score: parseFloat(line.split('\t')[3]) || 0 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map(r => r.line);
  return [header, ...sorted].join('\n');
}

function printResultsSummary() {
  if (!existsSync(RESULTS_PATH)) {
    console.log('No results yet. Run autoresearch first.');
    return;
  }

  const lines = readFileSync(RESULTS_PATH, 'utf-8').trim().split('\n');
  if (lines.length < 2) {
    console.log('No experiment results yet.');
    return;
  }

  const data = lines.slice(1).map(line => {
    const parts = line.split('\t');
    return {
      iteration: parts[0],
      hypothesis: parts[2],
      score: parseFloat(parts[3]),
      decision: parts[6],
    };
  });

  const baseline = data.find(d => d.decision === 'baseline');
  const keeps = data.filter(d => d.decision === 'keep');
  const reverts = data.filter(d => d.decision === 'revert');
  const errors = data.filter(d => d.decision === 'error' || d.decision === 'eval-error');
  const best = data.reduce((max, d) => d.score > max.score ? d : max, { score: 0 });

  console.log('\n=== Autoresearch Results ===\n');
  console.log(`Total iterations:  ${data.length}`);
  console.log(`Baseline score:    ${baseline?.score?.toFixed(3) ?? 'N/A'}`);
  console.log(`Best score:        ${best.score.toFixed(3)}`);
  console.log(`Kept:              ${keeps.length}`);
  console.log(`Reverted:          ${reverts.length}`);
  console.log(`Errors:            ${errors.length}`);

  if (baseline && best.score > baseline.score) {
    const improvement = ((best.score - baseline.score) / baseline.score * 100).toFixed(1);
    console.log(`Improvement:       +${improvement}%`);
  }

  if (keeps.length > 0) {
    console.log('\nKept experiments:');
    for (const k of keeps) {
      console.log(`  #${k.iteration}: ${k.score.toFixed(3)} — ${k.hypothesis.slice(0, 80)}`);
    }
  }

  console.log('');
}

// ── Git Operations ────────────────────────────────────────────────────────

function ensureGitBranch(branchName) {
  try {
    const current = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    if (current !== branchName) {
      execSync(`git checkout -b ${branchName}`, { stdio: 'pipe' });
      log('info', `Created branch: ${branchName}`);
    }
  } catch {
    // Already on the branch or git issue — continue
  }
  return branchName;
}

function gitCommit(message) {
  try {
    execSync('git add -A', { stdio: 'pipe' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}" --allow-empty`, { stdio: 'pipe' });
  } catch {
    // Nothing to commit — that's fine
  }
}

function gitRevertFile(filePath) {
  try {
    // Revert to the last committed version
    execSync(`git checkout HEAD~1 -- "${filePath}"`, { stdio: 'pipe' });
  } catch {
    log('error', `Failed to revert ${filePath}`);
  }
}

function gitTag(tagName) {
  try {
    execSync(`git tag -f "${tagName}"`, { stdio: 'pipe' });
  } catch {
    // Tag creation failed — non-fatal
  }
}

// ── Protocol Snapshots ────────────────────────────────────────────────────

function saveProtocolSnapshot(iteration, content, decision) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `iter-${String(iteration).padStart(3, '0')}-${decision}.md`;
  writeFileSync(resolve(HISTORY_DIR, filename), content);
}

// ── Proposer Agent ────────────────────────────────────────────────────────

function selectMutationOperator(state) {
  // If forced by revert tracking, use that
  if (state.forcedOperator) {
    const op = MUTATION_OPERATORS.find(o => o.id === state.forcedOperator);
    if (op) return op;
  }
  // Cycle through operators, but skip recently-failed ones
  const recentReverts = (state.revertTracking || []).slice(-SIMILAR_REVERT_THRESHOLD);
  const recentOps = new Set(recentReverts.map(r => r.operator));

  // Try the natural cycle position first
  let idx = (state.iteration || 0) % MUTATION_OPERATORS.length;
  for (let attempts = 0; attempts < MUTATION_OPERATORS.length; attempts++) {
    const candidate = MUTATION_OPERATORS[(idx + attempts) % MUTATION_OPERATORS.length];
    if (!recentOps.has(candidate.id)) return candidate;
  }
  // All operators recently reverted — use the cycle position anyway
  return MUTATION_OPERATORS[idx];
}

function readFieldReportSignal() {
  if (!existsSync(FIELD_REPORTS_DIR)) return '';

  let reports;
  try {
    reports = readdirSync(FIELD_REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(resolve(FIELD_REPORTS_DIR, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(r => r && r.summary);
  } catch { return ''; }

  if (reports.length === 0) return '';

  // Aggregate failure categories
  const catCounts = {};
  const catProjects = {};
  for (const r of reports) {
    for (const cat of r.failureAnalysis?.topCategories || []) {
      catCounts[cat.category] = (catCounts[cat.category] || 0) + cat.count;
      if (!catProjects[cat.category]) catProjects[cat.category] = new Set();
      catProjects[cat.category].add(r.projectHash);
    }
  }

  const topFailures = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => `- ${cat}: ${count} occurrences across ${catProjects[cat]?.size || 0} projects`)
    .join('\n');

  if (!topFailures) return '';

  return `\n## Real-World Failure Signal
In production pipelines (${reports.length} projects, ${reports.reduce((s, r) => s + (r.summary?.totalTasks || 0), 0)} tasks), the top failure categories are:
${topFailures}

Your hypothesis should address one of these real-world failure modes when possible.
Benchmark scores matter, but real-world impact matters more.\n`;
}

function buildProposerPrompt(program, currentProtocol, state, benchmarkTask, options = {}) {
  // OPRO pattern: worst-first sorting for recency bias exploitation
  const resultsPath = options.resultsPath || RESULTS_PATH;
  const resultsHistory = readLastNResultsSorted(10, resultsPath);
  const recentHistory = state.history.slice(-5)
    .map(h => `- Iter ${h.iteration}: [${h.operator || '?'}] "${h.hypothesis}" → ${h.decision} (score: ${h.score})`)
    .join('\n') || '(no prior experiments)';

  const operator = options.operator || selectMutationOperator(state);
  const fieldSignal = readFieldReportSignal();

  return `You are an AI researcher optimizing a protocol file for an agent pipeline.
Your goal: modify the protocol to maximize the benchmark score.

## Your Constraints (DO NOT VIOLATE)
${program}

## Current Protocol File
\`\`\`markdown
${currentProtocol}
\`\`\`

## Benchmark Task (what the agent must do with this protocol)
${benchmarkTask}

## Experiment History (sorted worst-first — focus on fixing these failures)
\`\`\`
${resultsHistory}
\`\`\`

## Recent Hypotheses and Outcomes
${recentHistory}

## Current Best Score: ${state.bestScore.toFixed(3)}

## Your Mutation Strategy: ${operator.id}
${operator.description}
Apply ONLY this type of change. Do not mix strategies.
${fieldSignal}
## Instructions

IMPORTANT: Your changes must generalize to any task the agent might face,
not just this specific benchmark scenario. Avoid changes that would only
help with this exact task but hurt other tasks.

1. Read the WORST result in the history above
2. CRITIQUE: What specific behavior in the current protocol caused that low score?
3. Using your mutation strategy (${operator.id}), form ONE specific hypothesis about what change would fix it
4. Output your critique, hypothesis, then the COMPLETE modified protocol file

Your output MUST follow this exact format:

CRITIQUE: <what specifically went wrong and why>
HYPOTHESIS: <one sentence describing your targeted ${operator.id} change>
---PROTOCOL---
<the complete protocol file content — every line, modified where needed>

Do NOT include anything after the protocol content. Output the FULL file.`;
}

function parseProposerOutput(output) {
  // Extract the last text content from stream-json output
  let textContent = '';

  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && event.message) {
        textContent += event.message;
      }
      // Handle content blocks
      if (event.type === 'content_block_delta' && event.delta?.text) {
        textContent += event.delta.text;
      }
      // Handle result messages
      if (event.type === 'result' && event.result) {
        textContent = event.result;
      }
    } catch {
      // Not JSON — might be raw text
      if (!line.startsWith('{')) {
        textContent += line + '\n';
      }
    }
  }

  if (!textContent) {
    return { success: false, hypothesis: 'No output from proposer', newProtocol: null };
  }

  // Parse critique (APO pattern)
  const critiqueMatch = textContent.match(/CRITIQUE:\s*(.+?)(?:\n|$)/);
  const critique = critiqueMatch ? critiqueMatch[1].trim() : '';

  // Parse hypothesis
  const hypMatch = textContent.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/);
  const hypothesis = hypMatch ? hypMatch[1].trim() : 'Unknown hypothesis';

  // Parse protocol — everything after ---PROTOCOL---
  const protocolMarker = '---PROTOCOL---';
  const markerIdx = textContent.indexOf(protocolMarker);

  if (markerIdx === -1) {
    // Try to find protocol content in code blocks
    const codeBlockMatch = textContent.match(/```(?:markdown)?\n([\s\S]+?)```/);
    if (codeBlockMatch) {
      return { success: true, hypothesis, newProtocol: codeBlockMatch[1].trim() };
    }
    return { success: false, hypothesis, newProtocol: null };
  }

  let newProtocol = textContent.slice(markerIdx + protocolMarker.length).trim();

  // Strip trailing code fence if present
  if (newProtocol.endsWith('```')) {
    newProtocol = newProtocol.slice(0, newProtocol.lastIndexOf('```')).trim();
  }

  // Strip leading code fence if present
  if (newProtocol.startsWith('```')) {
    newProtocol = newProtocol.replace(/^```(?:markdown)?\n/, '').trim();
  }

  if (!newProtocol || newProtocol.length < 50) {
    return { success: false, hypothesis, newProtocol: null };
  }

  return { success: true, hypothesis, critique, newProtocol };
}

async function runProposer(program, currentProtocol, state, benchmarkTask, options = {}) {
  const prompt = buildProposerPrompt(program, currentProtocol, state, benchmarkTask, options);

  log('research', 'Proposer: analyzing history and forming hypothesis...');

  const result = await spawnAgent(prompt, {
    timeoutMs: 3 * 60 * 1000, // 3 min for proposer
    onToolUse: (name) => {
      if (verbosity === 'verbose') log('research', `  Proposer tool: ${name}`);
    },
  });

  if (!result.success && !result.output) {
    return { success: false, hypothesis: 'Proposer agent crashed', newProtocol: null };
  }

  return parseProposerOutput(result.output);
}

// ── Benchmark Runner ──────────────────────────────────────────────────────

function createTempWorkspace(scaffoldDir) {
  const tmpDir = resolve('/tmp', `autoresearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(scaffoldDir, tmpDir, { recursive: true });
  return tmpDir;
}

async function runBenchmark(benchmark, targetFile, fullTargetPath, timeoutMs) {
  // Create isolated workspace from scaffold
  const workDir = createTempWorkspace(benchmark.scaffoldDir);

  // Copy all template protocols into workspace (frozen evaluation baselines)
  const templateClaude = resolve('template', '.claude');
  const workClaude = resolve(workDir, '.claude');
  if (existsSync(templateClaude)) {
    cpSync(templateClaude, workClaude, { recursive: true });
  }

  // Copy all lib/ infrastructure into workspace
  const templateLib = resolve('template', 'lib');
  const workLib = resolve(workDir, 'lib');
  // Don't overwrite scaffold's lib/ files, just fill in missing ones
  if (existsSync(templateLib)) {
    // Note: scaffold already has pipeline.js/pipeline-cli.js from setup
  }

  // Overwrite just the target file with the experimental version
  // Compute relative path from repo root to place in workspace
  const repoRoot = process.cwd();
  const relTargetPath = fullTargetPath.startsWith(repoRoot)
    ? fullTargetPath.slice(repoRoot.length + 1)
    : targetFile;
  // Strip template/ prefix — workspace IS the template
  const workspacePath = relTargetPath.replace(/^template\//, '');
  const targetInWorkspace = resolve(workDir, workspacePath);
  const targetParent = dirname(targetInWorkspace);
  if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true });
  if (existsSync(fullTargetPath)) {
    cpSync(fullTargetPath, targetInWorkspace);
  }

  // Run the benchmark agent
  log('research', 'Benchmark: running agent with modified protocol...');
  const taskPrompt = benchmark.task;

  const agentResult = await spawnAgent(taskPrompt, {
    cwd: workDir,
    timeoutMs,
    onToolUse: (name) => {
      if (verbosity !== 'quiet') log('research', `  Benchmark agent: ${name}`);
    },
    onHeartbeat: ({ silenceMs, elapsedMs }) => {
      if (silenceMs > 60000 && verbosity === 'verbose') {
        log('research', `  Benchmark: ${Math.round(elapsedMs / 1000)}s elapsed`);
      }
    },
  });

  // Run deterministic evaluation
  log('research', 'Evaluating benchmark result...');
  let evalResult = { score: 0, details: {} };
  try {
    const evalOutput = execSync(`node "${benchmark.evalPath}" "${workDir}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    evalResult = JSON.parse(evalOutput);
  } catch (err) {
    const output = err.stdout || '';
    try {
      evalResult = JSON.parse(output);
    } catch {
      log('error', `Eval script failed: ${err.message}`);
    }
  }

  // Cleanup
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Cleanup failure is non-fatal
  }

  return {
    score: evalResult.score,
    details: evalResult.details || {},
    agentSuccess: agentResult.success,
    durationMs: agentResult.durationMs,
  };
}

// ── Main Loop ─────────────────────────────────────────────────────────────

let shouldStop = false;
let shutdownRegistered = false;

function setupGracefulShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.on('SIGINT', () => {
    if (shouldStop) {
      console.log('\nForce quit.');
      process.exit(1);
    }
    console.log('\nGraceful shutdown requested — finishing current iteration...');
    shouldStop = true;
  });
}

async function run(targetFile, benchmarkName, options = {}) {
  const {
    maxIterations = DEFAULT_MAX_ITERATIONS,
    timeoutMs = DEFAULT_TIMEOUT_MIN * 60 * 1000,
    budgetHours = DEFAULT_BUDGET_HOURS,
    candidates = DEFAULT_CANDIDATES,
    dryRun = false,
    resume = false,
    stateDir = AUTORESEARCH_DIR,
    branchPrefix = 'autoresearch',
  } = options;

  // Use custom state paths if stateDir is overridden
  const statePath = resolve(stateDir, 'experiment.json');
  const resultsPath = resolve(stateDir, 'results.tsv');
  const historyDir = resolve(stateDir, 'history');
  const logPath = resolve(stateDir, 'latest.log');

  // Initialize with custom paths
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  logStream = createWriteStream(logPath, { flags: 'w' });
  setupGracefulShutdown();

  if (!existsSync(PROGRAM_PATH)) {
    log('error', `program.md not found at ${PROGRAM_PATH}`);
    log('info', 'Run: npx agent-pipeline init to scaffold .autoresearch/');
    return { saturated: false, bestScore: 0 };
  }

  const program = readFileSync(PROGRAM_PATH, 'utf-8');
  const benchmark = loadBenchmark(benchmarkName);

  // Resolve target: accept full relative paths OR shorthand command names
  let fullTargetPath;
  if (existsSync(resolve(targetFile))) {
    fullTargetPath = resolve(targetFile);
  } else if (existsSync(resolve('.claude', 'commands', targetFile))) {
    fullTargetPath = resolve('.claude', 'commands', targetFile);
  } else if (existsSync(resolve('.claude', targetFile))) {
    fullTargetPath = resolve('.claude', targetFile);
  } else if (existsSync(resolve('template', '.claude', 'commands', targetFile))) {
    fullTargetPath = resolve('template', '.claude', 'commands', targetFile);
  } else if (existsSync(resolve('template', '.claude', targetFile))) {
    fullTargetPath = resolve('template', '.claude', targetFile);
  } else {
    log('error', `Target not found: ${targetFile}`);
    return { saturated: false, bestScore: 0 };
  }

  // Local state management (parameterized paths)
  const loadLocalState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : null;
  const saveLocalState = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
  const ensureLocalResults = () => { if (!existsSync(resultsPath)) writeFileSync(resultsPath, TSV_HEADER + '\n'); };
  const appendLocalResult = (iteration, hypothesis, score, bestScore, delta, decision, durationMs, details) => {
    ensureLocalResults();
    const ts = new Date().toISOString();
    const detailsJson = JSON.stringify(details).replace(/\t/g, ' ');
    const hyp = hypothesis.replace(/\t/g, ' ').replace(/\n/g, ' ');
    appendFileSync(resultsPath, `${iteration}\t${ts}\t${hyp}\t${score}\t${bestScore}\t${delta}\t${decision}\t${durationMs}\t${detailsJson}\n`);
  };
  const saveLocalSnapshot = (iteration, content, decision) => {
    if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
    writeFileSync(resolve(historyDir, `iter-${String(iteration).padStart(3, '0')}-${decision}.md`), content);
  };

  log('info', `Target: ${targetFile} → ${fullTargetPath}`);
  log('info', `Benchmark: ${benchmarkName} (${benchmark.meta.description})`);
  log('info', `Max iterations: ${maxIterations}, Candidates/iter: ${candidates}`);
  log('info', `Timeout per run: ${Math.round(timeoutMs / 60000)}min, Budget: ${budgetHours}h`);
  log('info', `State dir: ${stateDir}`);

  if (dryRun) {
    log('info', 'DRY RUN — would start optimization loop. Exiting.');
    return { saturated: false, bestScore: 0, dryRun: true };
  }

  // Load or create state
  let state;
  if (resume) {
    state = loadLocalState();
    if (!state) {
      log('error', 'No experiment.json found — cannot resume');
      return { saturated: false, bestScore: 0 };
    }
    if (!state.revertTracking) state.revertTracking = [];
    if (state.consecutiveLowImprovement === undefined) state.consecutiveLowImprovement = 0;
    log('info', `Resuming from iteration ${state.iteration}, best score: ${state.bestScore.toFixed(3)}`);
  } else {
    state = createState(fullTargetPath, benchmarkName);
    state.revertTracking = [];
    state.consecutiveLowImprovement = 0;
    state.saturated = false;
  }

  // Create git branch
  const branchSlug = basename(targetFile, '.md').replace(/[^a-z0-9]/gi, '-');
  const branchName = `${branchPrefix}/${branchSlug}-${Date.now()}`;
  if (!resume) {
    state.branch = ensureGitBranch(branchName);
  }

  // ── Baseline measurement ──

  if (!state.baseline) {
    log('research', '── Measuring baseline (unmodified protocol) ──');
    const baselineResult = await runBenchmark(benchmark, targetFile, fullTargetPath, timeoutMs);
    state.baseline = baselineResult;
    state.bestScore = baselineResult.score;
    appendLocalResult(0, 'baseline', baselineResult.score, baselineResult.score, '-', 'baseline', baselineResult.durationMs, baselineResult.details);
    state.iteration = 1;
    saveLocalState(state);
    log('info', `Baseline score: ${baselineResult.score.toFixed(3)}`);
  }

  // ── Main loop ──

  const deadline = Date.now() + (budgetHours * 3600000);
  let consecutiveErrors = 0;

  while (state.iteration <= maxIterations && Date.now() < deadline && !shouldStop) {
    // ── Convergence detection ──
    if (state.consecutiveLowImprovement >= CONVERGENCE_THRESHOLD) {
      log('info', `Protocol saturated after ${state.iteration - 1} iterations (${CONVERGENCE_THRESHOLD} consecutive <1% improvement) — moving on`);
      state.saturated = true;
      saveLocalState(state);
      break;
    }

    log('research', `\n── Iteration ${state.iteration}/${maxIterations} ──`);
    const iterStart = Date.now();
    const currentProtocol = readFileSync(fullTargetPath, 'utf-8');

    // ── Step 1: Generate batch candidates ──
    const operator = selectMutationOperator(state);
    log('research', `Mutation operator: ${operator.id} — ${operator.description}`);

    const candidateResults = [];

    for (let c = 0; c < candidates; c++) {
      // Vary the operator for each candidate in the batch
      const candidateOperator = candidates > 1
        ? MUTATION_OPERATORS[(state.iteration + c) % MUTATION_OPERATORS.length]
        : operator;

      if (candidates > 1) log('research', `  Candidate ${c + 1}/${candidates} using ${candidateOperator.id}`);

      const proposal = await runProposer(program, currentProtocol, state, benchmark.task, {
        operator: candidateOperator,
        resultsPath,
      });

      if (!proposal.success || !proposal.newProtocol) {
        consecutiveErrors++;
        log('error', `Proposer failed (candidate ${c + 1}): ${proposal.hypothesis}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        continue;
      }
      consecutiveErrors = 0;

      // Apply, benchmark, collect result
      writeFileSync(fullTargetPath, proposal.newProtocol);
      gitCommit(`${branchPrefix} iter ${state.iteration} candidate ${c + 1}: ${proposal.hypothesis}`);

      const benchResult = await runBenchmark(benchmark, targetFile, fullTargetPath, timeoutMs);

      candidateResults.push({
        proposal,
        benchResult,
        operator: candidateOperator,
      });

      // Revert for next candidate
      gitRevertFile(fullTargetPath);
      gitCommit(`${branchPrefix} revert candidate ${c + 1}`);
    }

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log('error', `${MAX_CONSECUTIVE_ERRORS} consecutive errors — stopping`);
      appendLocalResult(state.iteration, 'consecutive-errors', -1, state.bestScore, '-', 'error', Date.now() - iterStart, {});
      break;
    }

    if (candidateResults.length === 0) {
      state.iteration++;
      saveLocalState(state);
      continue;
    }

    // ── Step 2: Pick the best candidate ──
    const best = candidateResults.reduce((a, b) => b.benchResult.score > a.benchResult.score ? b : a);
    const delta = best.benchResult.score - state.bestScore;
    const deltaPercent = state.bestScore > 0 ? Math.abs(delta / state.bestScore) : 0;

    // ── Step 3: Keep or revert ──
    let decision;

    if (best.benchResult.score > state.bestScore) {
      decision = 'keep';
      // Apply the winning candidate
      writeFileSync(fullTargetPath, best.proposal.newProtocol);
      gitCommit(`${branchPrefix} iter ${state.iteration}: ${best.proposal.hypothesis}`);
      state.bestScore = best.benchResult.score;
      state.keptVersions++;
      gitTag(`${branchPrefix}/${branchSlug}/v${state.keptVersions}`);
      saveLocalSnapshot(state.iteration, best.proposal.newProtocol, 'keep');
      log('keep', `KEEP: ${best.benchResult.score.toFixed(3)} (+${delta.toFixed(3)}) [${best.operator.id}] — "${best.proposal.hypothesis}"`);

      // Track convergence
      if (deltaPercent < 0.01) {
        state.consecutiveLowImprovement++;
      } else {
        state.consecutiveLowImprovement = 0;
      }
      // Clear forced operator on success
      state.forcedOperator = null;
    } else {
      decision = 'revert';
      saveLocalSnapshot(state.iteration, best.proposal.newProtocol, 'revert');
      log('revert', `REVERT: ${best.benchResult.score.toFixed(3)} (${delta >= 0 ? '+' : ''}${delta.toFixed(3)}) [${best.operator.id}] — "${best.proposal.hypothesis}"`);

      // Track convergence
      state.consecutiveLowImprovement++;

      // ── Structured revert tracking + forced strategy switch ──
      state.revertTracking.push({
        iteration: state.iteration,
        operator: best.operator.id,
        hypothesis: best.proposal.hypothesis,
      });
      // Check for similar reverts
      const recentReverts = state.revertTracking.slice(-SIMILAR_REVERT_THRESHOLD);
      if (recentReverts.length >= SIMILAR_REVERT_THRESHOLD) {
        const sameOp = recentReverts.every(r => r.operator === recentReverts[0].operator);
        if (sameOp) {
          const usedOps = new Set(recentReverts.map(r => r.operator));
          const nextOp = MUTATION_OPERATORS.find(o => !usedOps.has(o.id));
          if (nextOp) {
            state.forcedOperator = nextOp.id;
            log('info', `Forcing strategy switch to ${nextOp.id} — ${SIMILAR_REVERT_THRESHOLD} similar reverts with ${recentReverts[0].operator}`);
          }
        }
      }
    }

    // ── Step 4: Log ──
    const totalDuration = Date.now() - iterStart;
    appendLocalResult(state.iteration, best.proposal.hypothesis, best.benchResult.score, state.bestScore, delta.toFixed(3), decision, totalDuration, best.benchResult.details);

    state.history.push({
      iteration: state.iteration,
      hypothesis: best.proposal.hypothesis,
      critique: best.proposal.critique,
      operator: best.operator.id,
      score: best.benchResult.score,
      decision,
      candidatesEvaluated: candidateResults.length,
    });

    state.iteration++;
    saveLocalState(state);
  }

  // ── Summary ──

  const totalIterations = state.iteration - 1;
  const keeps = state.history.filter(h => h.decision === 'keep').length;
  const reverts = state.history.filter(h => h.decision === 'revert').length;

  log('info', '\n═══════════════════════════════════════');
  log('info', '         AUTORESEARCH COMPLETE');
  log('info', '═══════════════════════════════════════');
  log('info', `Iterations:     ${totalIterations}`);
  log('info', `Baseline:       ${state.baseline.score.toFixed(3)}`);
  log('info', `Best score:     ${state.bestScore.toFixed(3)}`);
  if (state.baseline.score > 0) {
    const improvement = ((state.bestScore - state.baseline.score) / state.baseline.score * 100).toFixed(1);
    log('info', `Improvement:    +${improvement}%`);
  }
  log('info', `Kept:           ${keeps}`);
  log('info', `Reverted:       ${reverts}`);
  log('info', `Saturated:      ${state.saturated ? 'yes' : 'no'}`);
  log('info', `Protocol vers:  ${state.keptVersions}`);
  log('info', `Results:        ${resultsPath}`);
  log('info', `Git tags:       ${branchPrefix}/${branchSlug}/v1..v${state.keptVersions}`);

  if (shouldStop) {
    log('info', 'Stopped gracefully. Resume with: node lib/autoresearch.js --resume');
  }

  if (logStream) logStream.end();

  return {
    saturated: state.saturated,
    bestScore: state.bestScore,
    baseline: state.baseline?.score,
    iterations: totalIterations,
    keeps,
    reverts,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') flags.target = args[++i];
    else if (args[i] === '--benchmark') flags.benchmark = args[++i];
    else if (args[i] === '--iterations') flags.iterations = parseInt(args[++i]);
    else if (args[i] === '--timeout') flags.timeout = parseInt(args[++i]);
    else if (args[i] === '--budget-hours') flags.budgetHours = parseFloat(args[++i]);
    else if (args[i] === '--candidates') flags.candidates = parseInt(args[++i]);
    else if (args[i] === '--resume') flags.resume = true;
    else if (args[i] === '--results') flags.results = true;
    else if (args[i] === '--verbose') flags.verbose = true;
    else if (args[i] === '--quiet') flags.quiet = true;
    else if (args[i] === '--dry-run') flags.dryRun = true;
  }
  return flags;
}

function printUsage() {
  console.log(`
Usage:
  node lib/autoresearch.js --target build.md --benchmark build-basic
  node lib/autoresearch.js --resume
  node lib/autoresearch.js --results

Flags:
  --target <file>        Protocol file to optimize (e.g., build.md, qa.md, exec.md)
  --benchmark <name>     Benchmark in .autoresearch/benchmarks/
  --iterations <n>       Max iterations (default: ${DEFAULT_MAX_ITERATIONS})
  --candidates <n>       Candidates per iteration (default: ${DEFAULT_CANDIDATES})
  --timeout <min>        Per-benchmark timeout in minutes (default: ${DEFAULT_TIMEOUT_MIN})
  --budget-hours <h>     Total runtime budget (default: ${DEFAULT_BUDGET_HOURS})
  --resume               Resume from experiment.json
  --results              Print results summary
  --verbose              Full agent output
  --quiet                Minimal output
  --dry-run              Show config and exit

Examples:
  node lib/autoresearch.js --target build.md --benchmark build-basic --budget-hours 8
  node lib/autoresearch.js --target exec.md --benchmark exec-decompose --iterations 30
  node lib/autoresearch.js --resume --quiet
`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.verbose) verbosity = 'verbose';
  if (flags.quiet) verbosity = 'quiet';

  if (flags.results) {
    printResultsSummary();
    return;
  }

  if (flags.resume) {
    const state = loadState();
    if (!state) {
      console.error('No experiment.json found — cannot resume.');
      process.exit(1);
    }
    await run(basename(state.targetFile), state.benchmark, {
      maxIterations: flags.iterations || DEFAULT_MAX_ITERATIONS,
      candidates: flags.candidates || DEFAULT_CANDIDATES,
      timeoutMs: (flags.timeout || DEFAULT_TIMEOUT_MIN) * 60 * 1000,
      budgetHours: flags.budgetHours || DEFAULT_BUDGET_HOURS,
      resume: true,
    });
    return;
  }

  if (!flags.target || !flags.benchmark) {
    printUsage();
    process.exit(1);
  }

  await run(flags.target, flags.benchmark, {
    maxIterations: flags.iterations || DEFAULT_MAX_ITERATIONS,
    candidates: flags.candidates || DEFAULT_CANDIDATES,
    timeoutMs: (flags.timeout || DEFAULT_TIMEOUT_MIN) * 60 * 1000,
    budgetHours: flags.budgetHours || DEFAULT_BUDGET_HOURS,
    dryRun: flags.dryRun || false,
  });
}

// ── Exports (for testing) ─────────────────────────────────────────────────

export { run, parseProposerOutput, appendResult, readLastNResults, readLastNResultsSorted, loadBenchmark, loadState, saveState, createState, MUTATION_OPERATORS };

// ── Entry point ──────────────────────────────────────────────────────────

const isDirectRun = process.argv[1]?.endsWith('autoresearch.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
