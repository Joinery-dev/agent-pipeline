#!/usr/bin/env node

/**
 * ship.js — Autonomous orchestrator for the agent pipeline.
 *
 * Watches .goals.json and dispatches PM, Builder, and QA agents as
 * separate Claude Code sessions. Each agent gets a fresh context window.
 * .goals.json is the message bus between them.
 *
 * Usage:
 *   node ship.js <topic>           — PM plans it, Builder builds it, QA validates
 *   node ship.js --resume          — resume from current .goals.json state
 *   node ship.js --plan <name>     — build an existing plan
 *   node ship.js --dry-run <topic> — show what would happen without running
 *
 * Flags:
 *   --phase <name>           — stop after the named phase (or major phase) completes
 *   --skip-canary            — skip the canary test on startup
 *   --no-research            — skip external research before planning
 *   --stale-timeout <min>    — minutes before in-progress tasks are reset (default: 30)
 *   --verbose                — full stream-json output from agents
 *   --quiet                  — only log state transitions and errors
 */

import { execSync, execFileSync } from 'child_process';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync, symlinkSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { createWriteStream } from 'fs';
import { spawnAgent } from './agent-runner.js';

const GOALS_PATH = resolve('.goals.json');
const PIPELINE_CLI = resolve('lib/pipeline-cli.js');

// ── Tunable orchestration parameters ────────────────────────────────────
// Loaded from ship-config.json if it exists, otherwise uses defaults.
// Autoresearch can optimize these values via the ship-config benchmark.

function loadShipConfig() {
  const configPath = resolve('ship-config.json');
  const defaults = {
    maxQARounds: 3,
    maxPMReplans: 2,
    maxDesignRounds: 3,
    maxBuildBatch: 5,
    maxExecRestarts: 3,
    maxParallelQA: 3,
    progressCheckIntervalMs: 5 * 60 * 1000,
    heartbeatIntervalMs: 30 * 1000,
    maxChecksWithoutProgress: 2,
    hooks: {},
  };
  if (existsSync(configPath)) {
    try {
      const loaded = JSON.parse(readFileSync(configPath, 'utf-8'));
      return { ...defaults, ...loaded };
    } catch { return defaults; }
  }
  return defaults;
}

const CONFIG = loadShipConfig();
const MAX_QA_ROUNDS = CONFIG.maxQARounds;
const MAX_PM_REPLANS = CONFIG.maxPMReplans;
const MAX_DESIGN_ROUNDS = CONFIG.maxDesignRounds;
const MAX_BUILD_BATCH = CONFIG.maxBuildBatch;
const MAX_EXEC_RESTARTS = CONFIG.maxExecRestarts;
const MAX_PARALLEL_QA = CONFIG.maxParallelQA;
const MAX_ITERATIONS = 50;
const PROGRESS_CHECK_INTERVAL_MS = CONFIG.progressCheckIntervalMs;
const HEARTBEAT_INTERVAL_MS = CONFIG.heartbeatIntervalMs;
const MAX_CHECKS_WITHOUT_PROGRESS = CONFIG.maxChecksWithoutProgress;

// ── Lifecycle Hooks ───────────────────────────────────────────────────────
// Generic extension point. Runs external scripts listed in ship-config.json
// at defined lifecycle events. Hook failures never break the pipeline.

function runLifecycleHooks(event, context = {}) {
  const hooks = CONFIG.hooks?.[event] || [];
  for (const hook of hooks) {
    try {
      const script = typeof hook === 'string' ? hook : hook.script;
      const args = (typeof hook === 'object' && hook.args) || [];
      const timeout = (typeof hook === 'object' && hook.timeout) || 5000;
      if (!script || !existsSync(resolve(script))) continue;
      const env = { ...process.env, SHIP_EVENT: event, SHIP_CONTEXT: JSON.stringify(context) };
      execFileSync('node', [resolve(script), ...args], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
        env,
      });
    } catch {
      // Hook failure is silently swallowed — hooks must never break the pipeline
    }
  }
}

// ── Verbosity ─────────────────────────────────────────────────────────────

let verbosity = 'normal'; // 'quiet' | 'normal' | 'verbose'
let logStream = null;

function initLogFile() {
  const shipDir = resolve('.ship');
  if (!existsSync(shipDir)) mkdirSync(shipDir);

  const latestLog = resolve('.ship/latest.log');
  const previousLog = resolve('.ship/previous.log');

  if (existsSync(latestLog)) {
    renameSync(latestLog, previousLog);
  }

  logStream = createWriteStream(latestLog, { flags: 'w' });
}

function log(agent, msg) {
  const icons = { ship: '🚢', pm: '📋', build: '🔨', qa: '🔍', exec: '🧠', done: '✅', error: '❌' };
  const ts = new Date().toLocaleTimeString();
  const line = `${ts}  ${icons[agent] || '  '} [${agent.toUpperCase()}]  ${msg}`;

  // Always write to log file
  if (logStream) logStream.write(line + '\n');

  // Console output respects verbosity
  if (verbosity === 'quiet') {
    if (['ship', 'error', 'done'].includes(agent)) {
      console.log(line);
    }
  } else {
    console.log(line);
  }
}

function logVerbose(agent, msg) {
  const icons = { ship: '🚢', pm: '📋', build: '🔨', qa: '🔍', exec: '🧠', done: '✅', error: '❌' };
  const ts = new Date().toLocaleTimeString();
  const line = `${ts}  ${icons[agent] || '  '} [${agent.toUpperCase()}]  ${msg}`;

  if (logStream) logStream.write(line + '\n');
  if (verbosity === 'verbose') console.log(line);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readGoals() {
  if (!existsSync(GOALS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
  } catch {
    log('error', '.goals.json is malformed — cannot proceed');
    process.exit(1);
  }
}

function getAllPhases(goals) {
  if (Array.isArray(goals?.majorPhases)) {
    const phases = [];
    for (const mp of goals.majorPhases) {
      if (Array.isArray(mp.phases)) phases.push(...mp.phases);
    }
    return phases;
  }
  if (Array.isArray(goals?.phases)) return goals.phases;
  return [];
}

function shouldStopAtPhase(phaseStopName, completedPhase, goals) {
  if (!phaseStopName) return false;
  const needle = phaseStopName.toLowerCase();

  // Check if the just-completed sub-phase matches
  if (completedPhase.title?.toLowerCase().includes(needle)) {
    return { matchedTitle: completedPhase.title, type: 'sub-phase' };
  }

  // Check if a major phase just completed that matches
  if (Array.isArray(goals?.majorPhases)) {
    const matchedMajor = goals.majorPhases.find(mp =>
      mp.title?.toLowerCase().includes(needle) &&
      mp.status === 'completed'
    );
    if (matchedMajor) {
      return { matchedTitle: matchedMajor.title, type: 'major-phase' };
    }
  }

  return false;
}

function findPhaseByPlan(goals, planName) {
  // Search sub-phases first
  const phases = getAllPhases(goals);
  const subMatch = phases.find(p =>
    p.planFile?.includes(planName) ||
    p.title?.toLowerCase().includes(planName.toLowerCase())
  );
  if (subMatch) return subMatch;

  // Search major phases too
  if (Array.isArray(goals.majorPhases)) {
    const majorMatch = goals.majorPhases.find(mp =>
      mp.title?.toLowerCase().includes(planName.toLowerCase())
    );
    // If major phase has sub-phases, return the first incomplete one
    if (majorMatch?.phases?.length > 0) {
      return majorMatch.phases.find(p => p.status !== 'completed') || majorMatch.phases[0];
    }
  }

  return null;
}

function getPipelineState(phase) {
  if (!phase) return 'needs-plan';
  if (!phase.tasks || phase.tasks.length === 0) return 'needs-plan';

  // Use explicit pipeline state if set — trust it over task-status inference
  if (phase.pipeline?.state) {
    const stateMap = {
      'idle': 'needs-build',
      'building': 'building',
      'awaiting-qa': 'awaiting-qa',
      'qa-failed': 'qa-failed',
      'awaiting-design': 'awaiting-design',
      'design-failed': 'design-failed',
      'complete': 'complete',
    };
    const mapped = stateMap[phase.pipeline.state];
    if (mapped) return mapped;
  }

  // Fallback: infer from task statuses
  const statuses = phase.tasks.map(t => t.status);

  if (statuses.every(s => s === 'completed')) return 'complete';
  if (statuses.some(s => s === 'blocked')) return 'qa-failed';

  const allBuilt = phase.tasks.every(t => {
    if (t.status === 'completed') return true;
    return t.attempts?.some(a => a.outcome === 'success');
  });

  if (allBuilt && statuses.some(s => s !== 'completed')) return 'awaiting-qa';
  if (statuses.some(s => s === 'in-progress')) return 'building';
  if (statuses.some(s => s === 'not-started')) return 'needs-build';

  return 'needs-build';
}

function countQARounds(phase) {
  let maxRound = 0;
  for (const task of phase.tasks) {
    const qaAttempts = countQAAttempts(task.attempts || []);
    if (qaAttempts > maxRound) maxRound = qaAttempts;
  }
  return maxRound;
}

function countQAAttempts(attempts) {
  return attempts.filter(a =>
    a.type === 'qa' || a.type === 'qa-recheck'
  ).length;
}

function clearPhaseForReplan(phase) {
  try {
    execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'idle', '--agent', 'exec'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Reset all tasks in the phase to not-started
    const restartGoals = readGoals();
    const restartPhase = getAllPhases(restartGoals).find(p => p.id === phase.id);
    if (restartPhase?.tasks) {
      for (const task of restartPhase.tasks) {
        if (task.status !== 'completed') {
          task.status = 'not-started';
        }
      }
      writeFileSync(GOALS_PATH, JSON.stringify(restartGoals, null, 2));
    }
    log('exec', `Phase "${phase.title}" cleared for replan`);
  } catch (err) {
    log('exec', `Phase clear failed: ${err.message}`);
  }
}

function getFailedTasks(phase) {
  return phase.tasks
    .filter(t => t.status === 'blocked')
    .map(t => ({ id: t.id, title: t.title }));
}

function buildFailureSummary(phase) {
  const lines = [];
  for (const task of (phase.tasks || [])) {
    if (task.status !== 'blocked') continue;
    const attempts = task.attempts || [];
    const lastFail = [...attempts].reverse().find(a => a.outcome === 'failure' || a.outcome === 'partial');
    if (lastFail) {
      lines.push(`Task "${task.title}": ${lastFail.notes || lastFail.description || 'no details'}`);
    } else {
      lines.push(`Task "${task.title}": blocked (no failure details)`);
    }
  }
  return lines.join('\n\n');
}

// ── Duration Tracking ────────────────────────────────────────────────────

function logDurationSummary(startTime) {
  const durationMs = Date.now() - startTime;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  log('ship', `Duration: ${minutes}m ${seconds}s`);
}

// ── Context Budget Pre-flight (CB5) ──────────────────────────────────────

function estimateContextTokens(agentType) {
  let totalChars = 0;

  // Briefing
  const briefing = resolve('.ship/briefing.md');
  if (existsSync(briefing)) totalChars += readFileSync(briefing, 'utf-8').length;

  // Agent command template
  const cmdPath = resolve(`.claude/commands/${agentType === 'build' ? 'build' : agentType === 'qa' ? 'qa' : agentType === 'resolve' ? 'resolve' : agentType}.md`);
  if (existsSync(cmdPath)) totalChars += readFileSync(cmdPath, 'utf-8').length;

  // Goals file (builders/QA read parts of it)
  if (existsSync(GOALS_PATH)) totalChars += readFileSync(GOALS_PATH, 'utf-8').length;

  // Memory files
  const memDirs = ['.pm/memory', '.qa/memory', '.design/memory', '.exec/memory'];
  for (const dir of memDirs) {
    const fullDir = resolve(dir);
    if (existsSync(fullDir)) {
      try {
        const files = readdirSync(fullDir);
        for (const f of files) {
          try { totalChars += readFileSync(resolve(fullDir, f), 'utf-8').length; } catch {}
        }
      } catch {}
    }
  }

  // Rough estimate: ~4 chars per token
  return Math.round(totalChars / 4);
}

// ── Pre-dispatch Infrastructure ─────────────────────────────────────────

function runDistiller(agentType, taskId, { phaseId, outputPath } = {}) {
  const distillerPath = resolve('lib/distill-briefing.js');
  if (!existsSync(distillerPath)) return;

  try {
    const args = ['--agent', agentType];
    if (taskId) args.push('--task', taskId);
    else if (phaseId) args.push('--phase', phaseId);
    else if (!['pm', 'exec', 'walkthrough'].includes(agentType)) args.push('--next');

    execFileSync('node', [distillerPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    // Move briefing to a custom path (used by parallel dispatch to avoid contention)
    if (outputPath) {
      const src = resolve('.ship/briefing.md');
      if (existsSync(src)) renameSync(src, resolve(outputPath));
    }

    log('ship', `Briefing generated: ${outputPath || '.ship/briefing.md'}`);
  } catch (err) {
    logVerbose('ship', `Distiller skipped: ${err.message}`);
  }
}

function runPlanValidator(phaseId) {
  const validatorPath = resolve('lib/validate-plan.js');
  if (!existsSync(validatorPath)) return true;

  try {
    const result = execFileSync('node', [validatorPath, '--phase', phaseId], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const parsed = JSON.parse(result);
    if (parsed.errors?.length > 0) {
      log('error', `Plan validation failed: ${parsed.errors.join('; ')}`);
      return false;
    }
    if (parsed.warnings?.length > 0) {
      log('ship', `Plan warnings: ${parsed.warnings.join('; ')}`);
    }
    return true;
  } catch {
    return true; // don't block on validator failure
  }
}

function runTestGate(tier = 1) {
  const runnerPath = resolve('lib/test-runner.js');
  if (!existsSync(runnerPath)) return { passed: true };

  try {
    const result = execFileSync('node', [runnerPath, '--tier', String(tier)], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
    });
    const parsed = JSON.parse(result);
    return { passed: parsed.failed === 0, result: parsed };
  } catch (err) {
    const output = err.stdout || '';
    try {
      const parsed = JSON.parse(output);
      return { passed: false, result: parsed };
    } catch {
      return { passed: false, result: { failed: 1, message: err.message } };
    }
  }
}

function runMemoryHygiene() {
  const hygienePath = resolve('lib/memory-hygiene.js');
  if (!existsSync(hygienePath)) return;

  try {
    const result = execFileSync('node', [hygienePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const parsed = JSON.parse(result);
    if (parsed.actions_taken > 0) {
      log('ship', `Memory hygiene: ${parsed.actions_taken} actions (${parsed.empty_warnings.length} warnings)`);
    }
  } catch {
    // Non-fatal
  }
}

// ── Research ─────────────────────────────────────────────────────────────

/**
 * Run /pm:research before planning to gather external context.
 * Skips if a research brief already exists for this topic (unless force=true).
 *
 * @param {string} topic - topic to research
 * @param {object} opts
 * @param {boolean} opts.force - run even if a brief already exists (used after exec RESTART)
 */
async function runResearch(topic, { force = false, failureContext = null } = {}) {
  const researchDir = resolve('.pm/research');
  if (!existsSync(researchDir)) mkdirSync(researchDir, { recursive: true });

  // Check if research brief already exists — by exact slug OR any recent brief
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const briefPath = resolve(researchDir, `${slug}.md`);
  if (existsSync(briefPath) && !force) {
    log('ship', `Research brief exists: .pm/research/${slug}.md — skipping research`);
    return { skipped: true, reason: 'brief exists' };
  }
  // Also check for any brief written in the last 30 minutes (exec may use a different slug)
  if (!force) {
    try {
      const files = readdirSync(researchDir).filter(f => f.endsWith('.md'));
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
      for (const f of files) {
        const stat = statSync(resolve(researchDir, f));
        if (stat.mtimeMs > thirtyMinAgo) {
          log('ship', `Recent research brief found: .pm/research/${f} — skipping research`);
          return { skipped: true, reason: 'recent brief exists' };
        }
      }
    } catch { /* scan failure is non-fatal */ }
  }

  if (force && existsSync(briefPath)) {
    log('ship', `Force research: removing stale brief .pm/research/${slug}.md`);
    unlinkSync(briefPath);
  }

  log('pm', `Researching: ${topic}`);
  const researchPrompt = failureContext
    ? `/pm:research ${topic} — Previous attempt failed. Failure context:\n${failureContext}`
    : `/pm:research ${topic}`;
  const result = await runAgent(
    researchPrompt,
    `Researching best practices: ${topic}`
  );

  if (result?.success) {
    log('ship', 'Research complete — brief written to .pm/research/');
  } else {
    log('ship', 'Research did not complete — continuing without research brief');
  }

  return result;
}

function runMerge(branch, phaseTitle) {
  const mergePath = resolve('lib/merge.js');
  if (!existsSync(mergePath)) return false;

  try {
    const result = execFileSync('node', [mergePath, branch, '--tag', `release/${phaseTitle}`, '--no-push'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000,
    });
    const parsed = JSON.parse(result);
    log('done', `Merged ${branch} to main, tagged release/${phaseTitle}`);
    return parsed.merged;
  } catch (err) {
    log('ship', `Merge skipped: ${err.message}`);
    return false;
  }
}

// ── QA Status Reconciliation ─────────────────────────────────────────────

/**
 * After QA runs, check if QA success attempts exist on tasks that are
 * still in-progress. If so, mark them completed. Same pattern as
 * reconcileTaskStatuses but for the QA → completed transition.
 */
function reconcileQAStatuses(phaseId) {
  try {
    const goals = readGoals();
    const phase = getAllPhases(goals).find(p => p.id === phaseId);
    if (!phase || !phase.tasks) return;

    let updated = 0;

    for (const task of phase.tasks) {
      if (task.status === 'completed') continue;

      const hasQASuccess = (task.attempts || []).some(a =>
        (a.type === 'qa' || a.type === 'qa-recheck') && a.outcome === 'success'
      );

      if (hasQASuccess) {
        task.status = 'completed';
        updated++;
        log('ship', `QA reconciled: "${task.title}" → completed (QA success attempt exists)`);
      }
    }

    if (updated > 0) {
      const allDone = phase.tasks.every(t => t.status === 'completed');
      if (allDone) {
        log('ship', `All ${phase.tasks.length} tasks QA-verified — awaiting final checks before phase completion`);
      }

      writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
      log('ship', `QA reconciled ${updated} task statuses`);
    }
  } catch (err) {
    logVerbose('ship', `QA reconciliation error: ${err.message}`);
  }
}

// ── Rollup & PM Memory ──────────────────────────────────────────────────

function runIntegrationCheck(majorPhaseTitle) {
  const checkPath = resolve('lib/integration-check.js');
  if (!existsSync(checkPath)) return { skipped: true };

  try {
    const args = majorPhaseTitle ? ['--major', majorPhaseTitle] : [];
    const result = execFileSync('node', [checkPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    const parsed = JSON.parse(result);

    if (parsed.issues?.length > 0) {
      const highIssues = parsed.issues.filter(i => i.severity === 'HIGH');
      if (highIssues.length > 0) {
        log('error', `Integration check: ${highIssues.length} HIGH severity issues`);
        for (const issue of highIssues) {
          log('error', `  ${issue.message}`);
        }
      }
      const medIssues = parsed.issues.filter(i => i.severity === 'MEDIUM');
      if (medIssues.length > 0) {
        log('ship', `Integration check: ${medIssues.length} MEDIUM issues`);
      }
    } else {
      log('ship', `Integration check passed (${parsed.phasesChecked} phases, ${parsed.contractsFound} contracts)`);
    }

    return parsed;
  } catch (err) {
    logVerbose('ship', `Integration check error: ${err.message}`);
    return { skipped: true };
  }
}

function runRollupAll() {
  if (!existsSync(PIPELINE_CLI)) return;
  try {
    const result = execFileSync('node', [PIPELINE_CLI, 'rollup-all'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    const parsed = JSON.parse(result);
    const changes = parsed.filter(r => r.type === 'majorPhase');
    for (const c of changes) {
      log('ship', `Major phase "${c.title}" → ${c.status}`);
    }
  } catch (err) {
    logVerbose('ship', `Rollup-all failed: ${err.message}`);
  }
}

function logDecision(message) {
  const memDir = resolve('.pm/memory');
  const decFile = resolve('.pm/memory/decisions.md');
  try {
    if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const entry = `\n## ${date} — ship.js\n${message}\n`;
    if (existsSync(decFile)) {
      const content = readFileSync(decFile, 'utf-8');
      writeFileSync(decFile, content + entry);
    } else {
      writeFileSync(decFile, `# Architectural Decisions\n${entry}`);
    }
  } catch {
    // Non-fatal
  }
}

// ── Visual Verification ──────────────────────────────────────────────────

function runVisualCheck(mode, phaseId) {
  const checkPath = resolve('lib/visual-check.js');
  if (!existsSync(checkPath)) return { skipped: true, reason: 'visual-check.js not found' };

  const args = [];
  if (mode === 'baseline') args.push('--baseline');
  if (mode === 'compare') args.push('--compare');
  if (mode === 'both') { args.push('--baseline', '--compare'); }
  if (phaseId) args.push('--phase', phaseId);

  try {
    const result = execFileSync('node', [checkPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000, // 2 min — server startup + screenshots
    });
    const parsed = JSON.parse(result);

    if (parsed.skipped) {
      logVerbose('ship', `Visual check skipped: ${parsed.reason}`);
      return parsed;
    }

    if (parsed.screenshotDir) {
      log('ship', `Screenshots saved: ${parsed.screenshotDir} (${parsed.pages} pages)`);
    }

    if (parsed.issues?.length > 0) {
      log('ship', `Visual issues found: ${parsed.issues.length}`);
      for (const issue of parsed.issues.slice(0, 5)) {
        log('ship', `  ⚠ ${issue}`);
      }
    }

    if (parsed.regressions?.length > 0) {
      log('error', `Visual regressions: ${parsed.regressions.length}`);
      for (const reg of parsed.regressions) {
        log('error', `  ${reg.severity}: ${reg.route} — ${reg.message}`);
      }
    }

    return parsed;
  } catch (err) {
    const output = err.stdout?.trim();
    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed.issues?.length > 0 || parsed.regressions?.length > 0) {
          log('ship', `Visual check found issues (${parsed.issues?.length || 0} issues, ${parsed.regressions?.length || 0} regressions)`);
          return parsed;
        }
      } catch {}
    }
    logVerbose('ship', `Visual check error: ${err.message}`);
    return { skipped: true, reason: err.message };
  }
}

// ── Post-Build Status Reconciliation ─────────────────────────────────────

/**
 * After a builder finishes, check what actually happened and update
 * .goals.json accordingly. The builder often writes code successfully
 * but fails to run pipeline-cli.js to update task statuses.
 *
 * Strategy:
 * 1. Get list of files changed since last checkpoint (git diff)
 * 2. For each not-started task in the phase, check if its files[] were touched
 * 3. If files were touched, mark the task in-progress with a build attempt
 * 4. If ALL tasks have files touched, set pipeline to awaiting-qa
 */
function reconcileTaskStatuses(phaseId) {
  try {
    // Get changed files
    let changedFiles;
    try {
      changedFiles = execSync('git diff --name-only HEAD 2>/dev/null || git diff --name-only', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);
    } catch {
      changedFiles = [];
    }

    // Also check untracked files
    try {
      const untracked = execSync('git ls-files --others --exclude-standard', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);
      changedFiles.push(...untracked);
    } catch {}

    if (changedFiles.length === 0) return;

    const goals = readGoals();
    const phase = getAllPhases(goals).find(p => p.id === phaseId);
    if (!phase || !phase.tasks) return;

    let updated = 0;
    const now = new Date().toISOString();

    for (const task of phase.tasks) {
      if (task.status !== 'not-started') continue;

      // Check if any of the task's files were touched
      const taskFiles = task.files || [];
      let touched = false;

      if (taskFiles.length > 0) {
        // Match by explicit files[] hint — reliable
        touched = taskFiles.some(tf =>
          changedFiles.some(cf => cf.includes(tf) || tf.includes(cf))
        );
      }
      // No keyword fallback — too unreliable in parallel builds.
      // Tasks without files[] need explicit status updates from agents.

      if (touched) {
        task.status = 'in-progress';
        if (!Array.isArray(task.attempts)) task.attempts = [];
        task.attempts.push({
          id: crypto.randomUUID(),
          type: 'build',
          round: task.attempts.filter(a => a.type === 'build' || a.type === 'build-fix').length + 1,
          description: 'Auto-reconciled: builder wrote code but did not update status',
          outcome: 'success',
          notes: `Files matched: ${taskFiles.join(', ') || '(keyword match)'}`,
          createdAt: now,
        });
        updated++;
        log('ship', `Reconciled: "${task.title}" → in-progress (files touched)`);
      }
    }

    if (updated > 0) {
      // Set pipeline to awaiting-qa if all tasks are now in-progress or better
      const allTouched = phase.tasks.every(t => t.status !== 'not-started');
      if (allTouched) {
        phase.pipeline = { state: 'awaiting-qa', lastAgent: 'build', lastTimestamp: now };
        log('ship', `All ${phase.tasks.length} tasks reconciled — pipeline set to awaiting-qa`);
      }

      writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
      log('ship', `Reconciled ${updated} task statuses from git diff`);
    }
  } catch (err) {
    log('ship', `Reconciliation skipped: ${err.message}`);
  }
}

// ── Checkpoint Tags ──────────────────────────────────────────────────────

function createCheckpoint(iteration) {
  try {
    execSync(`git tag -f ship/iter-${iteration}`, { stdio: 'pipe' });
    log('ship', `Checkpoint: ship/iter-${iteration}`);
  } catch (err) {
    log('error', `Failed to create checkpoint tag: ${err.message}`);
  }
}

function logCheckpoints(maxIteration) {
  if (maxIteration < 1) return;
  log('ship', `Checkpoints: ship/iter-1 through ship/iter-${maxIteration}`);
  log('ship', 'To rollback: git checkout ship/iter-N -- .goals.json .pm/memory/ .qa/memory/');
}

function cleanupCheckpoints(maxIteration) {
  const tags = [];
  for (let i = 1; i <= maxIteration; i++) tags.push(`ship/iter-${i}`);
  try {
    execSync(`git tag -d ${tags.join(' ')}`, { stdio: 'pipe' });
    log('ship', 'Cleaned up checkpoint tags');
  } catch {
    // Some tags may not exist
  }
}

// ── Canary Test ──────────────────────────────────────────────────────────

async function runCanary() {
  log('ship', 'Running canary test...');
  const canaryPath = resolve('.canary-test.json');
  const startTime = Date.now();

  writeFileSync(canaryPath, JSON.stringify({ test: true, timestamp: Date.now() }, null, 2));

  try {
    await runAgent(
      'Read .canary-test.json, add a field "verified": true, write it back. Then verify the file contains "verified". Report success or failure.',
      'Canary: verifying Claude can read/write JSON'
    );

    if (!existsSync(canaryPath)) {
      log('error', 'Canary failed — .canary-test.json was deleted');
      return false;
    }

    try {
      const content = JSON.parse(readFileSync(canaryPath, 'utf-8'));
      if (content.verified === true) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log('ship', `Canary passed — Claude can read/write JSON files (${elapsed}s)`);
        return true;
      } else {
        log('error', 'Canary failed — "verified" field not set to true');
        return false;
      }
    } catch {
      log('error', 'Canary failed — .canary-test.json is not valid JSON');
      return false;
    }
  } finally {
    try { unlinkSync(canaryPath); } catch {}
  }
}

// ── Stale Lock Detection ─────────────────────────────────────────────────

function detectAndResetStaleTasks(staleTimeoutMs) {
  const staleMinutes = Math.round(staleTimeoutMs / 60000);

  // Try pipeline-cli.js first (validates schema on write)
  if (existsSync(PIPELINE_CLI)) {
    try {
      const result = execFileSync('node', [PIPELINE_CLI, 'stale-tasks', '--minutes', String(staleMinutes)], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const staleTasks = JSON.parse(result);
      for (const task of staleTasks) {
        log('ship', `Stale task detected: "${task.title}" (${task.staleMinutes} min, no updates)`);

        // Reset via pipeline-cli.js (enforces transition rules + validates)
        execFileSync('node', [PIPELINE_CLI, 'update-status', task.id, 'not-started'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        log('ship', `Reset to not-started: "${task.title}"`);
      }
      return;
    } catch {
      // Fall through to manual detection
    }
  }

  // Fallback: direct manipulation (no schema validation)
  const goals = readGoals();
  const allPhases = getAllPhases(goals);
  if (allPhases.length === 0) return;

  const now = Date.now();
  let changed = false;

  for (const phase of allPhases) {
    for (const task of phase.tasks || []) {
      if (task.status !== 'in-progress') continue;

      const attempts = task.attempts || [];
      if (attempts.length === 0) continue;

      // Skip tasks where the build already succeeded — not actually stale
      const hasSuccessfulBuild = attempts.some(a =>
        (a.type === 'build' || a.type === 'build-fix') && a.outcome === 'success'
      );
      if (hasSuccessfulBuild) continue;

      const latest = attempts[attempts.length - 1];
      const createdAt = latest.createdAt ? new Date(latest.createdAt).getTime() : 0;
      const ageMs = now - createdAt;

      if (ageMs > staleTimeoutMs) {
        const ageMin = Math.round(ageMs / 60000);
        log('ship', `Stale task detected: "${task.title}" (${ageMin} min, no updates)`);
        log('ship', 'Resetting to not-started');

        task.status = 'not-started';
        for (const attempt of attempts) {
          if (attempt.outcome === 'in-progress' || !attempt.outcome) {
            attempt.outcome = 'failure';
            attempt.notes = (attempt.notes || '') + '\n\nStale — agent did not complete';
          }
        }
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
  }
}

// ── Real Progress Detection ──────────────────────────────────────────────

/**
 * Check for tangible progress: git changes, new files, .goals.json updates.
 * Returns a snapshot that can be compared against a previous snapshot.
 */
function getProgressSnapshot() {
  let gitDiffSize = 0;
  let untrackedCount = 0;
  let goalsJson = '';

  try {
    const diff = execSync('git diff --stat 2>/dev/null', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    gitDiffSize = diff.length;
  } catch {}

  try {
    const untracked = execSync('git ls-files --others --exclude-standard 2>/dev/null', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    untrackedCount = untracked ? untracked.split('\n').length : 0;
  } catch {}

  try {
    goalsJson = readFileSync(GOALS_PATH, 'utf-8');
  } catch {}

  return { gitDiffSize, untrackedCount, goalsJsonHash: goalsJson.length };
}

function hasRealProgress(before, after) {
  if (!before || !after) return true; // first check, assume progress
  return (
    after.gitDiffSize > before.gitDiffSize ||     // more code changed
    after.untrackedCount > before.untrackedCount || // new files created
    after.goalsJsonHash !== before.goalsJsonHash     // .goals.json updated
  );
}

// ── Progress Diffing (goals-only, for agent result reporting) ────────────

function snapshotGoals() {
  const goals = readGoals();
  if (!goals) return null;
  const snapshot = {};
  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks || []) {
      snapshot[task.id] = {
        status: task.status,
        attempts: countAllAttempts(task.attempts || []),
      };
    }
  }
  return snapshot;
}

function countAllAttempts(attempts) {
  return attempts.length;
}

function diffSnapshots(before, after) {
  if (!before || !after) return { changed: true, details: 'no baseline' };

  const changes = [];
  for (const [id, afterState] of Object.entries(after)) {
    const beforeState = before[id];
    if (!beforeState) {
      changes.push(`new task ${id}`);
    } else {
      if (beforeState.status !== afterState.status)
        changes.push(`task status: ${beforeState.status} → ${afterState.status}`);
      if (beforeState.attempts !== afterState.attempts)
        changes.push(`attempts: ${beforeState.attempts} → ${afterState.attempts}`);
    }
  }

  return {
    changed: changes.length > 0,
    details: changes.length > 0 ? changes.join(', ') : 'no changes to .goals.json',
  };
}

// ── Agent Runner (wraps shared spawnAgent with ship.js monitoring) ────────

let agentDispatches = 0;

async function runAgent(command, description, { cwd: agentCwd } = {}) {
  const agentType = command.startsWith('/exec') ? 'exec'
    : command.startsWith('/pm') ? 'pm'
    : command.startsWith('/build') ? 'build'
    : command.startsWith('/resolve') ? 'build'
    : command.startsWith('/design') ? 'design'
    : 'qa';

  // CB5: Context budget pre-flight check
  const estimatedTokens = estimateContextTokens(agentType);
  if (estimatedTokens > 160000) {
    log('error', `Context budget exceeded (~${Math.round(estimatedTokens / 1000)}K tokens) — refusing dispatch, escalating to exec`);
    return { success: false, output: '', madeProgress: false, contextOverflow: true };
  } else if (estimatedTokens > 120000) {
    log('ship', `⚠ Context budget warning: ~${Math.round(estimatedTokens / 1000)}K tokens for ${agentType} agent`);
  }

  log(agentType, description);

  agentDispatches++;

  const isWorktree = !!agentCwd;
  const beforeSnapshot = isWorktree ? null : snapshotGoals();
  let lastProgressSnapshot = isWorktree ? null : getProgressSnapshot();
  let checksWithoutProgress = 0;

  const result = await spawnAgent(command, {
    cwd: agentCwd || process.cwd(),
    timeoutMs: 30 * 60 * 1000, // 30 min hard timeout for pipeline agents
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
    verbose: verbosity === 'verbose',

    onToolUse: (toolName) => {
      const toolMsg = `  ⚙ ${toolName}...`;
      if (verbosity !== 'quiet') {
        log(agentType, toolMsg);
      } else {
        logVerbose(agentType, toolMsg);
      }
    },

    onHeartbeat: ({ silenceMs, elapsedMs }) => {
      if (silenceMs > 60000) {
        const silenceSec = Math.round(silenceMs / 1000);
        log(agentType, `  ... working (${silenceSec}s since last output, ${Math.round(elapsedMs / 60000)}m total)`);
      }
    },

    onVerbose: (eventJson) => {
      logVerbose(agentType, eventJson);
    },

    // Disable git-based progress monitoring for worktree agents (runs in different dir)
    progressCheckMs: isWorktree ? 0 : PROGRESS_CHECK_INTERVAL_MS,

    onProgress: isWorktree ? null : ({ elapsedMs, silenceMs }) => {
      const currentProgress = getProgressSnapshot();

      if (hasRealProgress(lastProgressSnapshot, currentProgress)) {
        log('ship', `Progress check: ✓ (git diff: ${currentProgress.gitDiffSize}, files: ${currentProgress.untrackedCount})`);
        checksWithoutProgress = 0;
      } else if (silenceMs > PROGRESS_CHECK_INTERVAL_MS) {
        checksWithoutProgress++;
        log('ship', `Progress check: ✗ no changes detected (${checksWithoutProgress}/${MAX_CHECKS_WITHOUT_PROGRESS})`);
      }

      lastProgressSnapshot = currentProgress;
    },

    shouldKill: isWorktree ? null : () => {
      return checksWithoutProgress >= MAX_CHECKS_WITHOUT_PROGRESS;
    },
  });

  // ── Post-run: goals diff, exec history, result interpretation ──

  if (isWorktree) {
    // Worktree agents: skip goals diffing (goals live in worktree, not main dir)
    log(agentType, `Finished (worktree). Exit code: ${result.exitCode}`);
    return { success: result.success, output: result.output, madeProgress: result.success, worktree: true };
  }

  const afterSnapshot = snapshotGoals();
  const diff = diffSnapshots(beforeSnapshot, afterSnapshot);
  const finalProgress = getProgressSnapshot();
  const madeRealProgress = hasRealProgress(lastProgressSnapshot, finalProgress) || diff.changed;

  // Save history for exec recovery (non-blocking)
  try {
    saveExecHistory(`dispatch-${agentType}`, {
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      progress: diff.details,
      madeProgress: madeRealProgress,
    });
  } catch { /* history saving is best-effort */ }

  if (result.success) {
    log(agentType, `Finished. Progress: ${diff.details}`);
    return { success: true, output: result.output, madeProgress: madeRealProgress || diff.changed, diff };
  } else if (madeRealProgress) {
    log('ship', `Agent exited with code ${result.exitCode}, but made progress (git/files changed)`);
    log('ship', 'Treating as partial success — state machine will pick up');
    return { success: true, output: result.output, madeProgress: true, diff, partial: true };
  } else {
    log('error', `Agent exited with code ${result.exitCode}, no progress made`);
    return { success: false, output: result.output, madeProgress: false, diff };
  }
}


// ── Parallel Build Detection ─────────────────────────────────────────────

/**
 * Find phases that can be built in parallel — they share no dependencies
 * and don't overlap in files[].
 */
function findParallelBuildable(goals) {
  const phases = getAllPhases(goals).filter(p => {
    const state = getPipelineState(p);
    return state === 'needs-build';
  });

  if (phases.length < 2) return null;

  // Check for dependency conflicts
  const independent = [];
  for (const phase of phases) {
    const deps = phase.dependsOn || [];
    const hasUnmetDep = deps.some(depId => {
      const dep = getAllPhases(goals).find(p => p.id === depId);
      return dep && dep.status !== 'completed';
    });
    if (!hasUnmetDep) independent.push(phase);
  }

  if (independent.length < 2) return null;
  return independent;
}

function findParallelQAPhases(goals) {
  const phases = getAllPhases(goals).filter(p => {
    const state = getPipelineState(p);
    return state === 'awaiting-qa';
  });

  if (phases.length < 2) return null;

  // Exclude phases with unmet dependencies
  const independent = [];
  for (const phase of phases) {
    const deps = phase.dependsOn || [];
    const hasUnmetDep = deps.some(depId => {
      const dep = getAllPhases(goals).find(p => p.id === depId);
      return dep && dep.status !== 'completed';
    });
    if (!hasUnmetDep) independent.push(phase);
  }

  if (independent.length < 2) return null;
  return independent.slice(0, MAX_PARALLEL_QA);
}

// ── Worktree Helpers ──────────────────────────────────────────────────────

function createWorktree(phase, prefix = 'build') {
  const slug = phase.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const worktreePath = resolve(`.worktrees/${prefix}-${slug}`);
  const branchName = `parallel-${prefix}/${slug}-${Date.now()}`;

  // Clean up stale worktree at this path if it exists
  try { execSync(`git worktree remove "${worktreePath}" --force 2>/dev/null`, { stdio: 'pipe' }); } catch {}

  mkdirSync(resolve('.worktrees'), { recursive: true });
  execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, { stdio: 'pipe' });

  // Symlink node_modules so builders don't need to reinstall
  const nodeModules = resolve('node_modules');
  const worktreeNodeModules = resolve(worktreePath, 'node_modules');
  if (existsSync(nodeModules) && !existsSync(worktreeNodeModules)) {
    symlinkSync(nodeModules, worktreeNodeModules);
  }

  // Ensure .ship/ exists in worktree
  mkdirSync(resolve(worktreePath, '.ship'), { recursive: true });

  log('ship', `Worktree created: ${worktreePath} (branch: ${branchName})`);
  return { path: worktreePath, branch: branchName, slug };
}

/**
 * Capture builder output in a worktree after the agent exits.
 *
 * Problem: Claude Code may resolve the project root via .git (which in a
 * worktree points back to the main repo), causing it to write files to the
 * MAIN directory instead of the worktree. This function handles both cases:
 *
 * 1. Builder wrote to worktree (normal case) — commit the changes there
 * 2. Builder wrote to main dir (worktree .git resolution) — migrate files
 *    to the worktree branch, then reset main dir
 */
function commitWorktreeChanges(worktreePath, phaseTitle) {
  // ── Check worktree for changes ──
  try {
    const wtBranch = execSync('git branch --show-current', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    const wtStatus = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const wtLog = execSync('git log --oneline -3', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    log('ship', `Worktree "${phaseTitle}" post-build state: branch=${wtBranch}, uncommitted=${wtStatus ? wtStatus.split('\n').length + ' files' : 'none'}`);
    logVerbose('ship', `Worktree recent commits: ${wtLog}`);

    if (wtStatus) {
      // Changes in worktree — commit them
      const fileCount = wtStatus.split('\n').length;
      log('ship', `Worktree "${phaseTitle}": committing ${fileCount} files`);
      execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
      execSync(`git commit -m "parallel build: ${phaseTitle}"`, { cwd: worktreePath, stdio: 'pipe' });
      const committed = execSync('git diff --stat HEAD~1..HEAD', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
      log('ship', `Worktree commit verified: ${committed.split('\n').pop()}`);
      return true;
    }

    // Check if builder committed directly in the worktree
    // (branch would be ahead of main's HEAD)
    const mainHead = execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const wtHead = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (wtHead !== mainHead) {
      log('ship', `Worktree "${phaseTitle}": builder committed directly (worktree HEAD differs from main HEAD)`);
      return false; // changes are committed, merge will pick them up
    }

    log('ship', `Worktree "${phaseTitle}": no changes found in worktree — checking main directory`);
  } catch (err) {
    log('error', `Worktree check failed for "${phaseTitle}": ${err.message}`);
  }

  // ── Fallback: check if builder wrote to main directory instead ──
  // Claude Code may resolve its project root via the .git file in the worktree
  // (which points back to the main repo), causing Write/Edit tools to target
  // the main directory. Pipeline-cli commands still use cwd (the worktree), so
  // .goals.json gets updated there — but code files land in main.
  //
  // Recovery: copy code files from main dir to worktree, commit there, then
  // reset those files in main. Uses file-copy (not cherry-pick) because other
  // builders may be concurrently writing to main dir.
  try {
    // Find changed + untracked files in main dir, excluding pipeline infrastructure
    const infraPatterns = ['.goals.json', '.ship/', '.worktrees/', '.pm/', '.qa/', '.design/', '.exec/', '.git', 'node_modules/'];
    let mainChanged = [];
    try {
      const diff = execSync('git diff --name-only', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      mainChanged = [...new Set([
        ...diff.split('\n').filter(Boolean),
        ...untracked.split('\n').filter(Boolean),
      ])].filter(f => !infraPatterns.some(p => f.startsWith(p)));
    } catch {}

    if (mainChanged.length === 0) {
      log('ship', `Worktree "${phaseTitle}": no code changes in main dir either — builder may not have written files`);
      return false;
    }

    log('ship', `Worktree "${phaseTitle}": found ${mainChanged.length} code files in MAIN directory — migrating to worktree`);

    // Copy each file from main dir to worktree
    let copied = 0;
    for (const file of mainChanged) {
      try {
        const src = resolve(file);
        const dst = resolve(worktreePath, file);
        if (!existsSync(src)) continue;
        mkdirSync(resolve(worktreePath, file, '..'), { recursive: true });
        copyFileSync(src, dst);
        copied++;
      } catch {}
    }

    if (copied === 0) {
      log('ship', `Worktree "${phaseTitle}": no files could be copied`);
      return false;
    }

    // Commit in worktree
    execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
    execSync(`git commit -m "parallel build: ${phaseTitle}"`, { cwd: worktreePath, stdio: 'pipe' });
    const committed = execSync('git diff --stat HEAD~1..HEAD', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' }).trim();
    log('ship', `Migrated ${copied} files to worktree: ${committed.split('\n').pop()}`);

    // Reset migrated files in main dir so they don't interfere with other merges
    for (const file of mainChanged) {
      try {
        execSync(`git checkout -- "${file}"`, { stdio: 'pipe' });
      } catch {
        // Untracked file — remove it
        try { unlinkSync(resolve(file)); } catch {}
      }
    }

    return true;
  } catch (err) {
    log('error', `Main-to-worktree migration failed for "${phaseTitle}": ${err.message}`);
    return false;
  }
}

/**
 * Merge a worktree branch into the current branch.
 *
 * Strategy: checkpoint-commit local changes instead of stashing.
 * Stash is fragile — the progress sync dirties .goals.json every 30s,
 * causing stash pop conflicts and silent data loss. A checkpoint commit
 * is idempotent and the reconciliation step writes the definitive state.
 */
function mergeWorktreeBranch(branchName, phaseTitle) {
  // Step 1: Verify the branch exists and has commits to merge
  let commitsAhead;
  try {
    commitsAhead = parseInt(
      execSync(`git rev-list HEAD.."${branchName}" --count`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(),
      10
    );
  } catch (err) {
    log('error', `Cannot find branch "${branchName}": ${err.stderr?.toString() || err.message}`);
    return false;
  }

  if (!commitsAhead || commitsAhead === 0) {
    log('ship', `Branch "${branchName}" has 0 commits ahead of HEAD — nothing to merge`);
    return false;
  }

  log('ship', `Merging "${branchName}" (${commitsAhead} commits) for "${phaseTitle}"...`);

  // Step 2: Ensure transient dirs are gitignored (prevents untracked file conflicts)
  ensureGitignoreEntries(['.ship/', '.worktrees/']);

  // Step 3: Checkpoint-commit any dirty local state.
  // The progress sync writes .goals.json every 30s. Rather than stashing
  // (fragile — pop conflicts, silent data loss), commit it. The reconciliation
  // step after merge writes the definitive .goals.json.
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (status) {
      log('ship', `Checkpoint-committing ${status.split('\n').length} dirty files before merge`);
      execSync('git add -A', { stdio: 'pipe' });
      execSync('git commit -m "ship.js: pre-merge checkpoint"', { stdio: 'pipe' });
    }
  } catch (err) {
    // If commit fails (e.g., nothing to commit after add), that's fine — proceed
    logVerbose('ship', `Pre-merge checkpoint: ${err.message}`);
  }

  // Step 4: Merge
  try {
    execSync(`git merge --no-ff "${branchName}" -m "merge parallel build: ${phaseTitle}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    log('error', `Merge failed for "${branchName}": ${stderr.slice(0, 500)}`);
    try { execSync('git merge --abort', { stdio: 'pipe' }); } catch {}
    return false;
  }

  log('ship', `Merged "${branchName}" successfully (${commitsAhead} commits)`);
  return true;
}

function cleanupWorktree(worktreePath, branchName) {
  try { execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' }); } catch {}
  try { execSync(`git branch -D "${branchName}"`, { stdio: 'pipe' }); } catch {}
}

function reconcileParallelGoals(worktrees) {
  const mainGoals = readGoals();
  if (!mainGoals) return;

  for (const { path: wtPath, phaseId } of worktrees) {
    try {
      const wtGoalsPath = resolve(wtPath, '.goals.json');
      if (!existsSync(wtGoalsPath)) continue;
      const wtGoals = JSON.parse(readFileSync(wtGoalsPath, 'utf-8'));

      // Find the phase in both goals and copy task statuses from worktree
      const wtPhases = getAllPhases(wtGoals);
      const mainPhases = getAllPhases(mainGoals);

      for (const wtPhase of wtPhases) {
        if (wtPhase.id !== phaseId) continue;
        const mainPhase = mainPhases.find(p => p.id === phaseId);
        if (!mainPhase) continue;

        // Copy task statuses and attempts
        for (const wtTask of (wtPhase.tasks || [])) {
          const mainTask = (mainPhase.tasks || []).find(t => t.id === wtTask.id);
          if (!mainTask) continue;
          if (wtTask.status !== mainTask.status || (wtTask.attempts?.length || 0) > (mainTask.attempts?.length || 0)) {
            mainTask.status = wtTask.status;
            mainTask.attempts = wtTask.attempts;
          }
        }

        // Copy pipeline state if updated
        if (wtPhase.pipeline?.state && wtPhase.pipeline.state !== 'idle') {
          mainPhase.pipeline = wtPhase.pipeline;
        }
      }
    } catch (err) {
      log('ship', `Goals reconciliation skipped for ${wtPath}: ${err.message}`);
    }
  }

  writeFileSync(GOALS_PATH, JSON.stringify(mainGoals, null, 2));
  log('ship', 'Reconciled .goals.json from parallel worktrees');
}

// ── Worktree Progress Sync ────────────────────────────────────────────────
// Periodically merges .goals.json from active worktrees into the main copy
// so external tools (sidebar apps, dashboards) can track progress in real time.
// Safe because builders/QA agents only write to their worktree's .goals.json,
// never the main copy.

function startWorktreeProgressSync(worktrees, intervalMs = 30000) {
  const sync = () => {
    try {
      reconcileParallelGoals(worktrees);
    } catch {}
  };
  const timer = setInterval(sync, intervalMs);
  return { stop: () => clearInterval(timer) };
}

// ── Parallel Builds ──────────────────────────────────────────────────────

async function runParallelBuilds(phases) {
  log('ship', `Parallel build: ${phases.length} independent phases (worktree isolation)`);
  logDecision(`Running ${phases.length} builders in parallel: ${phases.map(p => p.title).join(', ')}`);

  // Phase 1: Prepare briefings and worktrees (sequential — fast)
  const worktrees = [];
  for (const phase of phases) {
    try {
      // Generate phase-scoped briefing
      runDistiller('build', null, { phaseId: phase.id });

      // Create isolated worktree
      const wt = createWorktree(phase, 'build');
      wt.phaseId = phase.id;
      wt.phase = phase;

      // Copy the briefing into the worktree
      const briefingSrc = resolve('.ship/briefing.md');
      if (existsSync(briefingSrc)) {
        copyFileSync(briefingSrc, resolve(wt.path, '.ship/briefing.md'));
      }

      worktrees.push(wt);
    } catch (err) {
      log('error', `Failed to prepare worktree for "${phase.title}": ${err.message}`);
    }
  }

  if (worktrees.length === 0) {
    log('error', 'No worktrees created — falling back to sequential build');
    return { success: false, madeProgress: false };
  }

  // Phase 2: Pipelined build → merge → QA
  // Each builder's completion chains directly into merge + QA dispatch for
  // that phase. Remaining builders continue in parallel with QA agents.
  const progressSync = startWorktreeProgressSync(worktrees);

  // Git merge must be serialized — only one merge at a time.
  let mergeLock = Promise.resolve();
  function withMergeLock(fn) {
    const next = mergeLock.then(fn, fn); // run even if previous errored
    mergeLock = next;
    return next;
  }

  const qaCleanups = []; // QA worktrees to clean up at the end
  let anyProgress = false;

  // Dependency tracking: each phase gets a promise that resolves when it's merged.
  // Before dispatching QA for a phase, we wait for all its dependsOn phases to merge.
  // This prevents QA from running against a worktree snapshot that's missing
  // code from dependency phases that haven't merged yet.
  const mergeSignals = new Map(); // phaseId → { promise, resolve }
  for (const wt of worktrees) {
    let resolveSignal;
    const promise = new Promise(r => { resolveSignal = r; });
    mergeSignals.set(wt.phaseId, { promise, resolve: resolveSignal });
  }

  const pipelines = worktrees.map(async (wt) => {
    // ── Build (concurrent with other builders) ──
    const planRef = wt.phase.planFile || wt.phase.title;
    const buildResult = await runAgent(
      `/build ${planRef}`,
      `[Parallel] Building: ${wt.phase.title}`,
      { cwd: wt.path }
    );

    if (!buildResult?.success && !buildResult?.madeProgress) {
      log('ship', `Builder for "${wt.phase.title}" made no progress — skipping merge`);
      mergeSignals.get(wt.phaseId).resolve(false); // unblock dependents
      return { wt, buildResult, qaResult: null };
    }

    // ── Merge (serialized — one at a time) ──
    let merged = false;
    await withMergeLock(async () => {
      // Commit any uncommitted changes in the worktree (builder may have
      // already committed, in which case this is a no-op)
      commitWorktreeChanges(wt.path, wt.phase.title);

      // Always attempt merge — mergeWorktreeBranch checks commits ahead
      // and handles all edge cases with logging
      merged = mergeWorktreeBranch(wt.branch, wt.phase.title);

      if (merged) {
        anyProgress = true;
        reconcileTaskStatuses(wt.phaseId);
        reconcileParallelGoals([wt]);
        runVisualCheck('baseline', wt.phaseId);
      }
    });

    // Signal dependents that this phase is merged (or failed)
    mergeSignals.get(wt.phaseId).resolve(merged);

    if (!merged) return { wt, buildResult, qaResult: null };

    // ── Wait for dependency phases to merge before QA ──
    // QA worktree is created from current HEAD, so dependency code must be
    // merged first or the QA agent would validate against incomplete code.
    const deps = wt.phase.dependsOn || [];
    for (const depId of deps) {
      const signal = mergeSignals.get(depId);
      if (signal) {
        const depMerged = await signal.promise;
        if (!depMerged) {
          log('ship', `Dependency "${depId}" failed to merge — skipping QA for "${wt.phase.title}"`);
          return { wt, buildResult, qaResult: null };
        }
      }
    }

    log('ship', `"${wt.phase.title}" built + merged — dispatching QA`);

    // ── QA (concurrent with remaining builds and other QAs) ──
    let qaResult = null;
    try {
      const briefingPath = `.ship/briefing-qa-${wt.phaseId}.md`;
      runDistiller('qa', null, { phaseId: wt.phaseId, outputPath: briefingPath });

      const qaWt = createWorktree(wt.phase, 'qa');
      qaWt.phaseId = wt.phaseId;
      qaWt.phase = wt.phase;
      qaCleanups.push(qaWt);

      const briefingSrc = resolve(briefingPath);
      if (existsSync(briefingSrc)) {
        copyFileSync(briefingSrc, resolve(qaWt.path, '.ship/briefing.md'));
        try { unlinkSync(briefingSrc); } catch {}
      }

      const qaRef = wt.phase.planFile
        ? wt.phase.planFile.replace('plans/', '').replace('.md', '')
        : wt.phase.title;
      qaResult = await runAgent(
        `/qa ${qaRef}`,
        `[Pipelined QA] Validating: ${wt.phase.title}`,
        { cwd: qaWt.path }
      );

      // Post-QA reconciliation (serialized — writes to .goals.json)
      await withMergeLock(async () => {
        reconcileParallelGoals([qaWt]);

        // QA round tracking
        try {
          const qaGoals = readGoals();
          const qaPhase = getAllPhases(qaGoals).find(p => p.id === wt.phaseId);
          if (qaPhase) {
            if (!qaPhase.pipeline) qaPhase.pipeline = {};
            qaPhase.pipeline.qaRoundsCumulative = (qaPhase.pipeline.qaRoundsCumulative || 0) + 1;
            writeFileSync(GOALS_PATH, JSON.stringify(qaGoals, null, 2));
          }
        } catch {}

        reconcileQAStatuses(wt.phaseId);
        runLifecycleHooks('post-qa', { phaseId: wt.phaseId });

        // Visual regression check
        const visualResult = runVisualCheck('compare', wt.phaseId);
        if (visualResult.regressions?.length > 0) {
          log('error', `Visual regressions on "${wt.phase.title}" — blocking completion`);
          if (existsSync(PIPELINE_CLI)) {
            try {
              execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'qa-failed', '--agent', 'qa'], {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              });
            } catch {}
          }
          return;
        }

        // Determine next state: awaiting-design or complete
        const refreshedGoals = readGoals();
        const refreshedPhase = getAllPhases(refreshedGoals).find(p => p.id === wt.phaseId);
        const allTasksDone = refreshedPhase?.tasks?.every(t => t.status === 'completed');

        if (allTasksDone) {
          const needsDesign = existsSync(resolve('app'));
          const phaseFiles = (wt.phase.tasks || []).flatMap(t => t.files || []);
          const visualFilePatterns = [/page\.(js|tsx?)$/, /layout\.(js|tsx?)$/, /\.tsx$/, /components?\//];
          const hasVisualFiles = phaseFiles.length === 0 || phaseFiles.some(f => visualFilePatterns.some(p => p.test(f)));

          if (needsDesign && hasVisualFiles) {
            if (existsSync(PIPELINE_CLI)) {
              try {
                execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'awaiting-design', '--agent', 'qa'], {
                  encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                });
              } catch {}
            }
            log('ship', `Phase "${wt.phase.title}" — QA passed → awaiting design review`);
          } else {
            if (existsSync(PIPELINE_CLI)) {
              try {
                execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'complete', '--agent', 'ship'], {
                  encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                });
              } catch {}
            }
            log('ship', `Phase "${wt.phase.title}" — QA passed, no design review needed → complete`);
          }
        }
      });
    } catch (err) {
      log('ship', `QA dispatch failed for "${wt.phase.title}": ${err.message}`);
    }

    return { wt, buildResult, qaResult };
  });

  await Promise.all(pipelines);
  progressSync.stop();

  // Run tests once after all builds + QA complete
  if (anyProgress) {
    const testResult = runTestGate(1);
    if (!testResult.passed) {
      log('ship', 'Tests failed after pipelined builds — resolver will handle');
    }
  }

  // Cleanup all worktrees (build + QA)
  for (const wt of worktrees) {
    cleanupWorktree(wt.path, wt.branch);
  }
  for (const wt of qaCleanups) {
    cleanupWorktree(wt.path, wt.branch);
  }

  return { success: anyProgress, madeProgress: anyProgress };
}

// ── Parallel QA ──────────────────────────────────────────────────────────

async function runParallelQA(phases) {
  log('ship', `Parallel QA: ${phases.length} independent phases`);
  logDecision(`Running ${phases.length} QA agents in parallel: ${phases.map(p => p.title).join(', ')}`);

  // Phase 1: Prepare briefings and worktrees (sequential — fast)
  const worktrees = [];
  for (const phase of phases) {
    try {
      // Generate phase-scoped briefing to a unique path
      const briefingPath = `.ship/briefing-qa-${phase.id}.md`;
      runDistiller('qa', null, { phaseId: phase.id, outputPath: briefingPath });

      // Create isolated worktree (QA is read-only for code, but needs its own .goals.json)
      const wt = createWorktree(phase, 'qa');
      wt.phaseId = phase.id;
      wt.phase = phase;

      // Copy the phase-specific briefing into the worktree
      const briefingSrc = resolve(briefingPath);
      if (existsSync(briefingSrc)) {
        copyFileSync(briefingSrc, resolve(wt.path, '.ship/briefing.md'));
        try { unlinkSync(briefingSrc); } catch {} // clean up temp briefing
      }

      worktrees.push(wt);
    } catch (err) {
      log('error', `Failed to prepare QA worktree for "${phase.title}": ${err.message}`);
    }
  }

  if (worktrees.length === 0) {
    log('error', 'No QA worktrees created — falling back to sequential QA');
    return { success: false, madeProgress: false };
  }

  // If only 1 worktree survived preparation, still run it (avoid falling back mid-setup)
  log('ship', `Dispatching ${worktrees.length} QA agents...`);

  // Phase 2: Dispatch QA agents in parallel
  const progressSync = startWorktreeProgressSync(worktrees);

  const promises = worktrees.map(async (wt) => {
    const qaRef = wt.phase.planFile
      ? wt.phase.planFile.replace('plans/', '').replace('.md', '')
      : wt.phase.title;
    const result = await runAgent(
      `/qa ${qaRef}`,
      `[Parallel QA] Validating: ${wt.phase.title}`,
      { cwd: wt.path }
    );
    return { wt, result };
  });

  const results = await Promise.all(promises);
  progressSync.stop();

  // Phase 3: Reconcile (sequential — all agents done, safe to write .goals.json)

  // 3a. Merge QA attempts from worktrees back to main .goals.json
  reconcileParallelGoals(worktrees);

  // 3b. Per-phase post-QA processing
  let anyProgress = false;

  // Batch QA round tracking into a single .goals.json write
  try {
    const qaGoals = readGoals();
    for (const { wt } of results) {
      const qaPhase = getAllPhases(qaGoals).find(p => p.id === wt.phaseId);
      if (qaPhase) {
        if (!qaPhase.pipeline) qaPhase.pipeline = {};
        qaPhase.pipeline.qaRoundsCumulative = (qaPhase.pipeline.qaRoundsCumulative || 0) + 1;
      }
    }
    writeFileSync(GOALS_PATH, JSON.stringify(qaGoals, null, 2));
  } catch (err) {
    logVerbose('ship', `QA round tracking failed: ${err.message}`);
  }

  // Reconcile QA statuses and run post-QA checks for each phase
  for (const { wt, result } of results) {
    if (result?.success || result?.madeProgress) anyProgress = true;

    reconcileQAStatuses(wt.phaseId);
    runLifecycleHooks('post-qa', { phaseId: wt.phaseId });

    // Visual regression check (sequential — shares dev server)
    const visualResult = runVisualCheck('compare', wt.phaseId);
    if (visualResult.regressions?.length > 0) {
      log('error', `Visual regressions on "${wt.phase.title}" — blocking completion`);
      if (existsSync(PIPELINE_CLI)) {
        try {
          execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'qa-failed', '--agent', 'qa'], {
            encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {}
      }
      continue;
    }

    // Determine next state: awaiting-design or complete
    const refreshedGoals = readGoals();
    const refreshedPhase = getAllPhases(refreshedGoals).find(p => p.id === wt.phaseId);
    const allTasksDone = refreshedPhase?.tasks?.every(t => t.status === 'completed');

    if (allTasksDone) {
      const needsDesign = existsSync(resolve('app'));
      const phaseFiles = (wt.phase.tasks || []).flatMap(t => t.files || []);
      const visualFilePatterns = [/page\.(js|tsx?)$/, /layout\.(js|tsx?)$/, /\.tsx$/, /components?\//];
      const hasVisualFiles = phaseFiles.length === 0 || phaseFiles.some(f => visualFilePatterns.some(p => p.test(f)));

      if (needsDesign && hasVisualFiles) {
        if (existsSync(PIPELINE_CLI)) {
          try {
            execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'awaiting-design', '--agent', 'qa'], {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
        log('ship', `Phase "${wt.phase.title}" — QA passed → awaiting design review`);
      } else {
        if (existsSync(PIPELINE_CLI)) {
          try {
            execFileSync('node', [PIPELINE_CLI, 'set-pipeline', wt.phaseId, 'complete', '--agent', 'ship'], {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
        log('ship', `Phase "${wt.phase.title}" — QA passed, no design review needed → complete`);
      }
    }
  }

  // Phase 4: Cleanup all worktrees (QA didn't modify code, no merge needed)
  for (const wt of worktrees) {
    cleanupWorktree(wt.path, wt.branch);
  }

  log('ship', `Parallel QA complete: ${worktrees.length} phases processed`);
  return { success: anyProgress, madeProgress: anyProgress };
}

// ── Design Review ────────────────────────────────────────────────────────

async function runDesignReview(phase) {
  // Only run if the project has UI pages
  const appDir = resolve('app');
  if (!existsSync(appDir)) return { hasShipBlockers: false };

  // Skip design review for non-visual phases (e.g. project setup, config,
  // CSS tokens). A phase needs at least one task whose files touch a route
  // or component to be worth reviewing visually.
  const visualFilePatterns = [/page\.(js|tsx?)$/, /layout\.(js|tsx?)$/, /\.tsx$/, /components?\//];
  const phaseFiles = (phase.tasks || []).flatMap(t => t.files || []);
  const hasVisualFiles = phaseFiles.some(f => visualFilePatterns.some(p => p.test(f)));
  if (phaseFiles.length > 0 && !hasVisualFiles) {
    log('ship', `Skipping design review for "${phase.title}" — no visual files in task list`);
    return { hasShipBlockers: false };
  }

  // Track design rounds in .design/memory/status.json
  const statusPath = resolve('.design/memory/status.json');
  let designStatus = { round: 0 };
  try { designStatus = JSON.parse(readFileSync(statusPath, 'utf-8')); } catch {}
  designStatus.round = (designStatus.round || 0) + 1;
  designStatus.phase = phase.title;
  designStatus.lastRun = new Date().toISOString();
  try {
    mkdirSync(resolve('.design/memory'), { recursive: true });
    writeFileSync(statusPath, JSON.stringify(designStatus, null, 2));
  } catch {}

  log('ship', `Running design review (round ${designStatus.round}/${MAX_DESIGN_ROUNDS})...`);
  runDistiller('design', phase.id);

  // Add design-review attempt to each task in the phase
  const attemptIds = {};
  if (existsSync(PIPELINE_CLI)) {
    for (const task of (phase.tasks || [])) {
      try {
        const out = execFileSync('node', [
          PIPELINE_CLI, 'add-attempt', task.id,
          '--type', 'design-review',
          '--desc', `Design review round ${designStatus.round}`,
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        const parsed = JSON.parse(out);
        if (parsed.attemptId) attemptIds[task.id] = parsed.attemptId;
      } catch (err) {
        logVerbose('ship', `Design attempt creation failed for ${task.id}: ${err.message}`);
      }
    }
  }

  const result = await runAgent(
    `/design-review ${phase.title}`,
    `Design review: ${phase.title}`
  );

  if (!result?.success) {
    log('ship', 'Design review did not complete — continuing');
    // Mark attempts as partial
    for (const [taskId, attemptId] of Object.entries(attemptIds)) {
      try {
        execFileSync('node', [
          PIPELINE_CLI, 'update-attempt', taskId, attemptId,
          '--outcome', 'partial',
          '--notes', 'Design review did not complete',
        ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {}
    }
    return { hasShipBlockers: false, round: designStatus.round };
  }

  // Check if SHIP-BLOCKER findings exist in the output
  const hasShipBlockers = result.output?.includes('SHIP-BLOCKER') || false;

  // Update all task attempts with outcome
  const outcome = hasShipBlockers ? 'failure' : 'success';
  const notes = hasShipBlockers ? 'SHIP-BLOCKER issues found' : 'Design review passed';
  for (const [taskId, attemptId] of Object.entries(attemptIds)) {
    try {
      execFileSync('node', [
        PIPELINE_CLI, 'update-attempt', taskId, attemptId,
        '--outcome', outcome,
        '--notes', notes,
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
  }

  if (hasShipBlockers) {
    log('ship', `Design review found SHIP-BLOCKER issues (round ${designStatus.round})`);
  } else {
    log('ship', 'Design review passed — no SHIP-BLOCKER issues');
    // Re-read status from disk to preserve what the design agent wrote during its run
    let freshStatus = { round: 0 };
    try { freshStatus = JSON.parse(readFileSync(statusPath, 'utf-8')); } catch {}
    freshStatus.round = 0;
    try { writeFileSync(statusPath, JSON.stringify(freshStatus, null, 2)); } catch {}
  }

  // Re-read round from disk to return the design agent's value
  let finalStatus = { round: 0 };
  try { finalStatus = JSON.parse(readFileSync(statusPath, 'utf-8')); } catch {}
  return { hasShipBlockers, round: finalStatus.round };
}

// ── Git Repo Enforcement ─────────────────────────────────────────────────

function ensureDesignMemory() {
  const memDir = resolve('.design/memory');
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(resolve(memDir, 'status.json'),
      JSON.stringify({ lastRun: null, phase: null, round: 0, overallGrade: null, specCompliance: { met: 0, total: 0 }, findings: { shipBlockers: 0, quality: 0, polish: 0 }, trajectory: [] }, null, 2));
    writeFileSync(resolve(memDir, 'findings.md'), '# Design Findings\n\n(none yet)\n');
    writeFileSync(resolve(memDir, 'visual-drift.md'), '# Visual Drift Log\n\n(none yet)\n');
    writeFileSync(resolve(memDir, 'page-grades.json'), '{}');
    log('ship', 'Initialized .design/memory/');
  }
}

function ensureExecMemory() {
  const memDir = resolve('.exec/memory');
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(resolve(memDir, 'decisions.md'), '# Executive Decisions\n\n(none yet)\n');
    writeFileSync(resolve(memDir, 'escalation-log.md'), '# Escalation Log\n\n(none yet)\n');
    log('ship', 'Initialized .exec/memory/');
  }
}

function saveExecHistory(trigger, context) {
  const histDir = resolve('.exec/history');
  if (!existsSync(histDir)) mkdirSync(histDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const entry = {
    timestamp: new Date().toISOString(),
    trigger,
    context,
    goalsSnapshot: readGoals(),
  };
  try {
    entry.gitLog = execSync('git log --oneline -10 2>/dev/null', {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { entry.gitLog = '(unavailable)'; }
  writeFileSync(resolve(histDir, `${ts}.json`), JSON.stringify(entry, null, 2));
  log('exec', `History saved: .exec/history/${ts}.json`);
}

function buildExecBriefing(trigger, context) {
  const parts = [`Trigger: ${trigger}`];

  // Add context details
  if (context.phase) parts.push(`Phase: "${context.phase.title || context.phase}"`);
  if (context.failedTasks) parts.push(`Failed tasks: ${Array.isArray(context.failedTasks) ? context.failedTasks.join(', ') : context.failedTasks}`);
  if (context.qaRounds) parts.push(`QA rounds: ${context.qaRounds}`);
  if (context.replanCount) parts.push(`PM replans: ${context.replanCount}`);
  if (context.consecutiveNoProgress) parts.push(`No-progress iterations: ${context.consecutiveNoProgress}`);
  if (context.majorPhase) parts.push(`Major phase: "${context.majorPhase.title}"`);
  if (Array.isArray(context)) parts.push(`Issues: ${context.join('; ')}`);

  // Add recent exec decisions
  const decFile = resolve('.exec/memory/decisions.md');
  if (existsSync(decFile)) {
    const content = readFileSync(decFile, 'utf-8');
    const sections = content.split(/^## /m).slice(1).slice(-3);
    if (sections.length > 0) {
      parts.push(`Recent exec decisions: ${sections.map(s => s.split('\n')[0].trim()).join(' | ')}`);
    }
  }

  return parts.join('. ');
}

function loadExecEscalationCount() {
  const countPath = resolve('.exec/memory/escalation-count.json');
  try {
    return JSON.parse(readFileSync(countPath, 'utf-8')).count || 0;
  } catch { return 0; }
}

function saveExecEscalationCount(count) {
  const countPath = resolve('.exec/memory/escalation-count.json');
  try {
    mkdirSync(resolve('.exec/memory'), { recursive: true });
    writeFileSync(countPath, JSON.stringify({ count, updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* best effort */ }
}

let execEscalationCount = 0;

async function runExecEscalation(trigger, context) {
  execEscalationCount++;
  saveExecEscalationCount(execEscalationCount);
  if (execEscalationCount > MAX_EXEC_RESTARTS) {
    log('error', `Exec has restarted ${execEscalationCount - 1} times — true human intervention needed`);
    return 'CONTINUE'; // force stop path
  }

  saveExecHistory(trigger, context);
  runDistiller('exec', null);

  const briefing = buildExecBriefing(trigger, context);
  log('exec', `Escalation #${execEscalationCount}: ${trigger}`);

  const result = await runAgent(
    `/exec:escalation ${briefing}`,
    `Executive escalation: ${trigger}`
  );

  // Parse exec's binary decision from output
  const hasRestart = /DECISION:\s*RESTART/i.test(result.output || '');
  const hasContinue = /DECISION:\s*CONTINUE/i.test(result.output || '');
  if (!hasRestart && !hasContinue) {
    log('exec', 'WARNING: Exec output did not contain DECISION: RESTART or DECISION: CONTINUE — defaulting to CONTINUE');
  }
  const decision = hasRestart ? 'RESTART' : 'CONTINUE';
  log('exec', `Decision: ${decision} (trigger: ${trigger})`);

  if (decision === 'RESTART') {
    logDecision(`Exec RESTART on "${trigger}". Escalation #${execEscalationCount}. Phase will be replanned by PM.`);
  }

  return decision;
}

function runQualityGate() {
  const concerns = resolve('.pm/memory/concerns.md');
  const patterns = resolve('.qa/memory/patterns.md');
  const drift = resolve('.design/memory/visual-drift.md');

  const issues = [];

  // Check for accumulating unresolved design concerns
  if (existsSync(concerns)) {
    const content = readFileSync(concerns, 'utf-8');
    const openDesignConcerns = (content.match(/## (HIGH|CRITICAL).*design|## (HIGH|CRITICAL).*visual|## (HIGH|CRITICAL).*Design/gi) || [])
      .length;
    const openConcernMatches = content.match(/\*\*Status:\*\* OPEN/g) || [];
    if (openConcernMatches.length >= 3) {
      issues.push(`${openConcernMatches.length} OPEN concern(s) in PM memory — quality is accumulating debt`);
    }
  }

  // Check for recurring visual patterns
  if (existsSync(patterns)) {
    const content = readFileSync(patterns, 'utf-8');
    // Count patterns with "Seen in:" that list 3+ rounds
    const sections = content.split(/^## /m).slice(1);
    for (const section of sections) {
      const seenLine = section.match(/\*\*Seen in:\*\*(.*)/);
      if (seenLine) {
        const rounds = (seenLine[1].match(/Round \d+/g) || []).length;
        if (rounds >= 3) {
          const title = section.split('\n')[0].trim();
          issues.push(`QA pattern "${title}" seen ${rounds} times without resolution`);
        }
      }
    }
  }

  // Check for visual drift
  if (existsSync(drift)) {
    const content = readFileSync(drift, 'utf-8');
    const driftingCount = (content.match(/STATUS: DRIFTING/g) || []).length;
    if (driftingCount >= 2) {
      issues.push(`${driftingCount} active visual drift item(s) — design language is fragmenting`);
    }
  }

  if (issues.length > 0) {
    log('error', '── Quality Gate FAILED ──');
    for (const issue of issues) {
      log('error', `  ${issue}`);
    }
    log('error', 'Quality is degrading across phases. Human review needed before continuing.');
    log('ship', 'Fix the accumulated concerns, then run with --resume.');
    return false;
  }

  return true;
}

function ensureGitignoreEntries(entries) {
  const gitignorePath = resolve('.gitignore');
  try {
    const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    const lines = content.split('\n');
    const missing = entries.filter(e => !lines.some(l => l.trim() === e));
    if (missing.length > 0) {
      const suffix = (content.endsWith('\n') || content === '') ? '' : '\n';
      writeFileSync(gitignorePath, content + suffix + missing.join('\n') + '\n');
      logVerbose('ship', `Added to .gitignore: ${missing.join(', ')}`);
    }
  } catch {}
}

function ensureGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
  } catch {
    log('ship', 'No git repo found — initializing');

    // Create .gitignore if missing to prevent adding node_modules, etc.
    if (!existsSync('.gitignore')) {
      writeFileSync('.gitignore', [
        'node_modules/', '.next/', '.nuxt/', 'dist/', 'build/', 'out/',
        '.env', '.env.local', '.env.*.local',
        '.DS_Store', 'Thumbs.db',
        '*.log', '.ship/', '.worktrees/',
      ].join('\n') + '\n');
      log('ship', 'Created .gitignore');
    }

    execSync('git init', { stdio: 'pipe' });
    execSync('git add -A', { stdio: 'pipe' });
    try {
      execSync('git commit -m "Initial commit (auto-created by ship.js)"', { stdio: 'pipe' });
    } catch {
      // git commit fails if nothing to commit — that's fine
    }
    log('ship', 'Git repo initialized with initial commit');
    logDecision('Auto-initialized git repo — project had no version control.');
  }
}

// ── State Machine ────────────────────────────────────────────────────────

async function run(topic, options = {}) {
  const { resume, planName, dryRun, skipCanary, skipResearch, staleTimeoutMs, phaseStopName } = options;

  const pipelineStartTime = Date.now();
  initLogFile();

  log('ship', `Starting: ${topic || planName || 'resume from .goals.json'}`);
  log('ship', `Stale timeout: ${Math.round(staleTimeoutMs / 60000)}min`);
  if (phaseStopName) {
    log('ship', `Phase stop target: "${phaseStopName}" (will stop after this phase completes)`);
  }

  // ── Git repo enforcement ──
  ensureGitRepo();

  // ── Design memory initialization ──
  ensureDesignMemory();

  // ── Exec memory initialization ──
  ensureExecMemory();

  // ── Memory hygiene (pre-run) ──
  runMemoryHygiene();

  // ── Canary test ──
  if (!skipCanary && !dryRun) {
    const canaryPassed = await runCanary();
    if (!canaryPassed) {
      log('error', 'Canary test failed — aborting pipeline');
      logDurationSummary(pipelineStartTime);
      if (logStream) logStream.end();
      return;
    }
  }

  let replanCount = 0;
  let iteration = 0;
  let consecutiveNoProgress = 0;
  let pipelineSuccess = false;
  let shouldStop = false;
  let forceResearch = false; // set true after exec RESTART to bypass brief-exists check

  // R3: Persist escalation count across sessions
  execEscalationCount = loadExecEscalationCount();

  while (!shouldStop) {
    iteration++;
    if (iteration > MAX_ITERATIONS) {
      log('error', 'Max iterations reached — stopping');
      shouldStop = true;
      break;
    }
    log('ship', `── Iteration ${iteration} ──`);
    const iterationStartProgress = getProgressSnapshot();

    // ── Quality gate (check for accumulating issues) ──
    if (iteration > 1 && !runQualityGate()) {
      const execResult = await runExecEscalation('quality-gate', { iteration });
      if (execResult === 'RESTART') {
        const restartGoalsQG = readGoals();
        const activePhaseQG = restartGoalsQG ? getAllPhases(restartGoalsQG).find(p => p.status !== 'completed') : null;
        if (activePhaseQG) clearPhaseForReplan(activePhaseQG);
        forceResearch = true;
        continue;
      }
      shouldStop = true;
      break;
    }

    // ── Stale lock detection ──
    detectAndResetStaleTasks(staleTimeoutMs);

    // ── Checkpoint ──
    createCheckpoint(iteration);

    const goals = readGoals();

    // ── Step 1: Do we need strategic structure? ──

    const needsExecPlanning = !goals
      || (goals && (!goals.majorPhases || goals.majorPhases.length === 0) && !goals.vision);

    if (needsExecPlanning && !resume) {
      if (dryRun) { log('ship', 'DRY RUN: would run /exec'); break; }

      log('exec', 'No strategic structure — running executive planning');
      runDistiller('exec', null);
      // P3: Interactive exec for initial planning so exec can ask human questions
      const result = await spawnAgent(`/exec ${topic}`, {
        cwd: process.cwd(),
        timeoutMs: 30 * 60 * 1000,
        interactive: true,
      });
      if (!result.success) {
        log('error', 'Executive planning failed');
        break;
      }
      continue;
    }

    if (needsExecPlanning && resume) {
      log('error', 'No strategic structure found. Re-run without --resume to create project structure.');
      break;
    }

    if (!goals) {
      log('error', 'No .goals.json found and --resume specified');
      break;
    }

    // ── Step 2: Find the relevant phase ──

    const searchTerm = planName || topic;
    let phase = null;

    if (searchTerm) {
      phase = findPhaseByPlan(goals, searchTerm);
    }

    if (!phase) {
      phase = getAllPhases(goals).find(p => p.status !== 'completed');
    }

    // If no sub-phases found, check for major phases with empty phases[]
    // These need planning before they can be built
    if (!phase && Array.isArray(goals.majorPhases)) {
      const emptyMajor = goals.majorPhases.find(mp =>
        mp.status !== 'completed' &&
        (!Array.isArray(mp.phases) || mp.phases.length === 0)
      );
      if (emptyMajor) {
        log('ship', `Major phase "${emptyMajor.title}" has no sub-phases — needs planning`);
        const planTopic = topic || emptyMajor.title;
        if (!skipResearch) { await runResearch(planTopic, { force: forceResearch }); forceResearch = false; }
        runDistiller('pm', null);
        const result = await runAgent(
          `/pm:plan ${planTopic}`,
          `Planning major phase: ${emptyMajor.title}`
        );
        if (!result.success) {
          log('error', `PM failed to plan "${emptyMajor.title}"`);
          const execResult = await runExecEscalation('pm-plan-failure', { majorPhase: emptyMajor });
          if (execResult === 'RESTART') {
            const restartGoalsPM = readGoals();
            const activePhasePM = restartGoalsPM ? getAllPhases(restartGoalsPM).find(p => p.status !== 'completed') : null;
            if (activePhasePM) clearPhaseForReplan(activePhasePM);
            forceResearch = true;
          }
          if (execResult !== 'RESTART') shouldStop = true;
        }
        continue;
      }
    }

    if (!phase) {
      log('done', 'All phases complete!');
      pipelineSuccess = true;
      break;
    }

    const state = getPipelineState(phase);
    log('ship', `Phase: "${phase.title}" — state: ${state}`);

    if (dryRun) {
      log('ship', `DRY RUN: next action would be: ${state}`);
      break;
    }

    // ── Step 2b: Check for parallel builds ──

    let result;
    let handledByParallel = false;
    if (state === 'needs-build') {
      const parallelPhases = findParallelBuildable(goals);
      if (parallelPhases && parallelPhases.length > 1) {
        result = await runParallelBuilds(parallelPhases);
        handledByParallel = true;
      }
    }

    // ── Step 2c: Check for parallel QA ──

    if (!handledByParallel && state === 'awaiting-qa') {
      const qaPhases = findParallelQAPhases(goals);
      if (qaPhases && qaPhases.length > 1) {
        result = await runParallelQA(qaPhases);
        handledByParallel = true;
      }
    }

    // ── Step 3: Dispatch based on state (skip if parallel handled it) ──

    if (!handledByParallel) switch (state) {
      case 'needs-plan': {
        const planTopic = topic || phase.title;

        // Check if plan file exists but tasks are missing
        const hasPlanFile = phase.planFile && existsSync(resolve(phase.planFile));

        if (hasPlanFile) {
          // Deterministic: parse plan file and create tasks without LLM
          log('ship', `Plan file exists (${phase.planFile}) but no tasks — extracting tasks deterministically`);
          const planToTasks = resolve('lib/plan-to-tasks.js');
          if (existsSync(planToTasks)) {
            try {
              const taskResult = execFileSync('node', [planToTasks, '--plan', phase.planFile, '--phase', phase.id], {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 15000,
              });
              const parsed = JSON.parse(taskResult);
              log('ship', `Created ${parsed.tasksCreated} tasks from plan file`);
              result = { success: parsed.tasksCreated > 0, madeProgress: parsed.tasksCreated > 0 };
            } catch (err) {
              log('error', `plan-to-tasks failed: ${err.stderr?.trim() || err.message}`);
              // Fall back to PM agent
              log('pm', 'Falling back to PM agent for task creation');
              runDistiller('pm', null);
              result = await runAgent(
                `/pm:plan ${planTopic} — The plan file ${phase.planFile} already exists. Read it and create the tasks in .goals.json using pipeline-cli.js add-task. Do NOT rewrite the plan file.`,
                `Populating tasks from existing plan: ${phase.planFile}`
              );
            }
          } else {
            // No plan-to-tasks script, use PM agent
            runDistiller('pm', null);
            result = await runAgent(
              `/pm:plan ${planTopic} — The plan file ${phase.planFile} already exists. Read it and create the tasks in .goals.json using pipeline-cli.js add-task. Do NOT rewrite the plan file.`,
              `Populating tasks from existing plan: ${phase.planFile}`
            );
          }
        } else {
          log('pm', `Phase "${planTopic}" has no tasks — asking PM to plan`);
          if (!skipResearch) { await runResearch(planTopic, { force: forceResearch }); forceResearch = false; }
          runDistiller('pm', null);
          result = await runAgent(
            `/pm:plan ${planTopic}`,
            `Planning: ${planTopic}`
          );
        }
        break;
      }

      case 'needs-build': {
        // Validate plan before dispatching builder
        if (!runPlanValidator(phase.id)) {
          log('ship', `Skipping phase "${phase.title}" — plan validation failed`);
          topic = null; // move to next phase
          break;
        }
        // Ensure we're on a feature branch before building
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
          if (branch === 'main') {
            const branchName = `build/${phase.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            execSync(`git checkout -b ${branchName}`, { stdio: 'pipe' });
            log('ship', `Created feature branch: ${branchName}`);
          }
        } catch (err) {
          logVerbose('ship', `Branch check skipped: ${err.message}`);
        }
        runDistiller('build', null);
        const planRef = phase.planFile || phase.title;
        result = await runAgent(
          `/build ${planRef}`,
          `Building phase: ${phase.title}`
        );
        // Post-build status reconciliation — builder often writes code but
        // fails to update .goals.json via pipeline-cli. Fix it deterministically.
        reconcileTaskStatuses(phase.id);
        // Visual baseline — save screenshots of current state
        runVisualCheck('baseline', phase.id);
        // Test gate after build
        if (result?.success || result?.madeProgress) {
          const testResult = runTestGate(1);
          if (!testResult.passed) {
            log('ship', `Tests failed after build — will dispatch resolver next`);
          }
        }
        break;
      }

      case 'building': {
        runDistiller('build', null);
        const planRef = phase.planFile || phase.title;
        result = await runAgent(
          `/build ${planRef}`,
          `Resuming build: ${phase.title}`
        );
        reconcileTaskStatuses(phase.id);
        runVisualCheck('baseline', phase.id);
        if (result?.success || result?.madeProgress) {
          const testResult = runTestGate(1);
          if (!testResult.passed) {
            log('ship', `Tests failed after build — will dispatch resolver next`);
          }
        }
        break;
      }

      case 'awaiting-qa': {
        runDistiller('qa', null);
        const qaRef = phase.planFile
          ? phase.planFile.replace('plans/', '').replace('.md', '')
          : phase.title;
        result = await runAgent(
          `/qa ${qaRef}`,
          `Validating phase: ${phase.title}`
        );

        // Track cumulative QA rounds at phase level AFTER agent returns (#12, R2)
        try {
          const qaGoals = readGoals();
          const qaPhase = getAllPhases(qaGoals).find(p => p.id === phase.id);
          if (qaPhase) {
            if (!qaPhase.pipeline) qaPhase.pipeline = {};
            qaPhase.pipeline.qaRoundsCumulative = (qaPhase.pipeline.qaRoundsCumulative || 0) + 1;
            writeFileSync(GOALS_PATH, JSON.stringify(qaGoals, null, 2));
          }
        } catch (err) {
          logVerbose('ship', `QA round tracking failed: ${err.message}`);
        }

        // QA status reconciliation — QA agent may not reliably call update-status
        reconcileQAStatuses(phase.id);
        runLifecycleHooks('post-qa', { phaseId: phase.id });
        // Visual regression check — compare against baseline
        const visualResult = runVisualCheck('compare', phase.id);
        if (visualResult.regressions?.length > 0) {
          log('error', 'Visual regressions detected — blocking completion');
          if (existsSync(PIPELINE_CLI)) {
            try {
              execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'qa-failed', '--agent', 'qa'], {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              });
            } catch {}
          }
        }

        // QA + visual passed — check if design review is needed
        {
          const refreshedGoals = readGoals();
          const refreshedPhase = getAllPhases(refreshedGoals).find(p => p.id === phase.id);
          const allTasksDone = refreshedPhase?.tasks?.every(t => t.status === 'completed');

          if (allTasksDone) {
            const needsDesign = existsSync(resolve('app'));
            const phaseFiles = (phase.tasks || []).flatMap(t => t.files || []);
            const visualFilePatterns = [/page\.(js|tsx?)$/, /layout\.(js|tsx?)$/, /\.tsx$/, /components?\//];
            const hasVisualFiles = phaseFiles.length === 0 || phaseFiles.some(f => visualFilePatterns.some(p => p.test(f)));

            if (needsDesign && hasVisualFiles) {
              // Transition to design review
              if (existsSync(PIPELINE_CLI)) {
                try {
                  execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'awaiting-design', '--agent', 'qa'], {
                    encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                  });
                } catch {}
              }
              log('ship', `Phase "${phase.title}" — QA passed → awaiting design review`);
            } else {
              // No design review needed — mark complete
              if (existsSync(PIPELINE_CLI)) {
                try {
                  execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'complete', '--agent', 'ship'], {
                    encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                  });
                } catch {}
              }
              log('ship', `Phase "${phase.title}" — QA passed, no design review needed → complete`);
            }
          }
        }
        break;
      }

      case 'awaiting-design': {
        // Track cumulative design rounds at phase level
        try {
          const dGoals = readGoals();
          const dPhase = getAllPhases(dGoals).find(p => p.id === phase.id);
          if (dPhase) {
            if (!dPhase.pipeline) dPhase.pipeline = {};
            dPhase.pipeline.designRoundsCumulative = (dPhase.pipeline.designRoundsCumulative || 0) + 1;
            writeFileSync(GOALS_PATH, JSON.stringify(dGoals, null, 2));
          }
        } catch (err) {
          logVerbose('ship', `Design round tracking failed: ${err.message}`);
        }

        const designResult = await runDesignReview(phase);

        if (designResult.hasShipBlockers) {
          const designRounds = phase.pipeline?.designRoundsCumulative || designResult.round || 1;

          if (designRounds > MAX_DESIGN_ROUNDS) {
            log('exec', `Design review failed ${designRounds} times on "${phase.title}" — escalating to executive`);
            const execResult = await runExecEscalation('design-exhaustion', { phase, round: designRounds });
            if (execResult === 'RESTART') { clearPhaseForReplan(phase); forceResearch = true; }
            if (execResult !== 'RESTART') {
              logDecision(`Design failed ${designRounds}x on "${phase.title}". Exec could not resolve.`);
              shouldStop = true;
            }
          } else {
            log('ship', `Design SHIP-BLOCKERs found (round ${designRounds}/${MAX_DESIGN_ROUNDS}) — sending back through build → QA → design`);
            logDecision(`Design review found SHIP-BLOCKERs on "${phase.title}" (round ${designRounds}). Looping back.`);
            if (existsSync(PIPELINE_CLI)) {
              try {
                execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'design-failed', '--agent', 'design'], {
                  encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                });
              } catch {}
            }
          }
        } else {
          // Design passed — mark phase complete
          if (existsSync(PIPELINE_CLI)) {
            try {
              execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'complete', '--agent', 'design'], {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              });
            } catch {}
          }
          log('ship', `Phase "${phase.title}" — design review passed → complete`);
        }
        break;
      }

      case 'design-failed': {
        // Design found issues — dispatch resolver to fix them, then loop back to QA
        const failedTasks = getFailedTasks(phase);

        if (failedTasks.length > 0) {
          for (const ft of failedTasks) {
            runDistiller('resolve', ft.id);
            log('build', `Resolving design issue: ${ft.title}`);
            result = await runAgent(
              `/resolve ${ft.title}`,
              `Resolving design issue: ${ft.title}`
            );
          }
          runLifecycleHooks('post-resolve', { phaseId: phase.id });
        } else {
          // No specific failed tasks — send back through build with design context
          runDistiller('build', null);
          const planRef = phase.planFile || phase.title;
          result = await runAgent(
            `/build ${planRef} — Design review found SHIP-BLOCKER issues. Read .design/memory/status.json for details. Fix only the design issues.`,
            `Fixing design issues: ${phase.title}`
          );
          reconcileTaskStatuses(phase.id);
        }

        // Send back to QA (which will flow to design again after passing)
        if (existsSync(PIPELINE_CLI)) {
          try {
            execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'awaiting-qa', '--agent', 'ship'], {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch {}
        }
        log('ship', `Phase "${phase.title}" — design fixes applied → back to QA`);
        break;
      }

      case 'qa-failed': {
        const qaRounds = phase.pipeline?.qaRoundsCumulative || countQARounds(phase);
        const failedTasks = getFailedTasks(phase);
        const failedNames = failedTasks.map(t => t.title);

        log('ship', `QA has failed ${qaRounds} time(s). Failed tasks: ${failedNames.join(', ')}`);

        if (qaRounds > MAX_QA_ROUNDS) {
          if (replanCount >= MAX_PM_REPLANS) {
            log('exec', `PM has re-planned ${replanCount} times — escalating to executive`);
            const execResult = await runExecEscalation('qa-exhaustion', { phase, failedTasks: failedNames, qaRounds, replanCount });
            if (execResult === 'RESTART') { clearPhaseForReplan(phase); replanCount = 0; forceResearch = true; break; }
            log('error', 'Exec could not resolve — stopping');
            shouldStop = true;
            break;
          }

          replanCount++;
          log('pm', `QA failed ${qaRounds}x — escalating to PM for re-analysis (replan ${replanCount}/${MAX_PM_REPLANS})`);
          logDecision(`QA failed ${qaRounds}x on "${phase.title}". Escalating to PM for re-analysis (replan ${replanCount}).`);
          // P6: Pass failure context to research on replan
          const failureContext = buildFailureSummary(phase);
          if (!skipResearch) { await runResearch(phase.title, { force: true, failureContext }); }
          runDistiller('pm', null);
          result = await runAgent(
            `/pm QA has failed ${qaRounds} times on phase "${phase.title}". Failed tasks: ${failedNames.join(', ')}. Please analyze the failures in .goals.json attempt notes, read .qa/memory/status.json for details, and either revise the plan or update the tasks. The current approach isn't working.`,
            `PM re-analyzing failures in: ${phase.title}`
          );
        } else {
          for (const ft of failedTasks) {
            // Dispatch /resolve (targeted fix) instead of /build (full rebuild)
            runDistiller('resolve', ft.id);
            log('build', `Resolving failed task: ${ft.title}`);
            result = await runAgent(
              `/resolve ${ft.title}`,
              `Resolving: ${ft.title}`
            );

            // If resolver failed, check if we should escalate
            if (result && !result.success) {
              log('ship', `Resolver failed on "${ft.title}" — will escalate to PM next round`);
            }

            const updated = readGoals();
            const updatedPhase = findPhaseByPlan(updated, phase.planFile || phase.title);
            if (updatedPhase && getFailedTasks(updatedPhase).length === 0) {
              log('ship', 'All failed tasks resolved — moving to QA');
              break;
            }
          }
          runLifecycleHooks('post-resolve', { phaseId: phase.id });
        }
        break;
      }

      case 'complete': {
        log('done', `Phase "${phase.title}" is complete!`);

        runLifecycleHooks('phase-complete', { phaseId: phase.id });

        // Integration check — verify interface contracts
        runIntegrationCheck(null);

        // Log decision to PM memory
        logDecision(`Phase "${phase.title}" completed. QA passed. Moving to next phase.`);

        // Attempt merge to main BEFORE rollup (R4) — phase isn't marked completed until merge succeeds
        try {
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
          if (currentBranch !== 'main') {
            runMerge(currentBranch, phase.title.toLowerCase().replace(/\s+/g, '-'));
          }
        } catch { /* merge is best-effort */ }

        // Roll up all statuses AFTER merge (sub-phases → major phases)
        runRollupAll();

        // R3: Reset escalation count on successful phase completion
        execEscalationCount = 0;
        saveExecEscalationCount(0);

        // P1: Exec checkpoint when a major phase just completed
        if (Array.isArray(goals.majorPhases)) {
          const refreshedGoals = readGoals();
          const completedMajor = refreshedGoals?.majorPhases?.find(mp =>
            mp.status === 'completed' &&
            mp.phases?.some(p => p.id === phase.id)
          );
          if (completedMajor) {
            log('exec', `Major phase "${completedMajor.title}" completed — running exec checkpoint`);
            runDistiller('exec', null);
            await runAgent(
              `/exec --checkpoint "${completedMajor.title}"`,
              `Exec checkpoint: ${completedMajor.title}`
            );
            // P4: Route checkpoint fixes if exec wrote any
            const fixesPath = resolve('.exec/memory/checkpoint-fixes.md');
            if (existsSync(fixesPath)) {
              const fixContent = readFileSync(fixesPath, 'utf-8');
              if (fixContent.includes('## Code Fix') || fixContent.includes('## code fix')) {
                log('ship', 'Exec checkpoint found code fixes — dispatching resolver');
                runDistiller('resolve', null);
                await runAgent('/resolve Exec checkpoint identified fixes needed — read .exec/memory/checkpoint-fixes.md for details', 'Resolving exec checkpoint fixes');
              }
              if (fixContent.includes('## Plan Revision') || fixContent.includes('## plan revision')) {
                log('ship', 'Exec checkpoint found plan revisions — dispatching PM');
                runDistiller('pm', null);
                await runAgent('/pm Exec checkpoint identified plan revisions — read .exec/memory/checkpoint-fixes.md for details', 'PM processing exec checkpoint revisions');
              }
              // Clean up the fixes file after routing
              try { unlinkSync(fixesPath); } catch {}
            }
          }
        }

        // --phase stop check
        if (phaseStopName) {
          const refreshedGoalsForStop = readGoals();
          const stopResult = shouldStopAtPhase(phaseStopName, phase, refreshedGoalsForStop);
          if (stopResult) {
            log('ship', `Phase "${stopResult.matchedTitle}" completed. Stopping (--phase mode).`);
            pipelineSuccess = true;
            shouldStop = true;
            break;
          }
        }

        const nextPhase = getAllPhases(goals).find(p =>
          p.status !== 'completed' && p.id !== phase.id
        );

        if (nextPhase) {
          log('ship', `Next phase: "${nextPhase.title}" — continuing...`);
          topic = nextPhase.title;
        } else if (Array.isArray(goals.majorPhases) && goals.majorPhases.some(mp =>
          mp.status !== 'completed' &&
          (!Array.isArray(mp.phases) || mp.phases.length === 0)
        )) {
          // There are empty major phases that need planning — loop will pick them up
          log('ship', 'Completed sub-phases exhausted — empty major phases remain, continuing...');
          topic = null;
        } else {
          log('done', 'All phases complete! Project milestone reached.');
          pipelineSuccess = true;
          shouldStop = true;
        }
        break;
      }

      default: {
        log('error', `Unknown state: ${state}`);
        shouldStop = true;
        log('error', 'Unknown pipeline state — stopping');
        break;
      }
    }

    // ── Step 4: Real progress check ──

    const iterationProgress = getProgressSnapshot();
    const iterationHadProgress = result?.madeProgress || hasRealProgress(iterationStartProgress, iterationProgress);

    if (!iterationHadProgress) {
      consecutiveNoProgress++;
      log('ship', `No real progress detected — git diff unchanged, no new files (${consecutiveNoProgress} consecutive)`);

      if (consecutiveNoProgress >= 3) {
        log('exec', '3 consecutive iterations with zero progress — escalating to executive');
        const execResult = await runExecEscalation('zero-progress', { consecutiveNoProgress, iteration });
        if (execResult === 'RESTART') { if (phase) clearPhaseForReplan(phase); consecutiveNoProgress = 0; forceResearch = true; continue; }
        log('error', 'Exec could not resolve zero-progress — stopping');
        break;
      }
    } else {
      if (consecutiveNoProgress > 0) {
        log('ship', 'Progress detected — resetting counter');
      }
      consecutiveNoProgress = 0;
    }
  }

  // P2: Final review cycle when all phases complete
  if (pipelineSuccess) {
    log('ship', '── Final Review ──');

    // Full test suite
    const finalTest = runTestGate(2);
    if (!finalTest.passed) {
      log('error', 'Final test suite failed');
    }

    // Screenshot grid + walkthrough
    runVisualCheck('both', null);

    // Project-level QA
    runDistiller('qa', null);
    await runAgent('/qa --project', 'Project-level QA validation');

    // Project-level design review (if UI project)
    const appDir = resolve('app');
    if (existsSync(appDir)) {
      runDistiller('design', null);
      await runAgent('/design-review --project', 'Project-level design review');
    }

    // P3: Interactive exec final review
    log('exec', 'Running executive final review');
    runDistiller('exec', null);
    await spawnAgent('/exec --final-review', {
      cwd: process.cwd(),
      timeoutMs: 30 * 60 * 1000,
      interactive: true,
    });
  }

  log('ship', 'Pipeline finished.');

  // ── Checkpoint summary ──
  logCheckpoints(iteration);
  if (pipelineSuccess) {
    cleanupCheckpoints(iteration);
  }

  // ── Memory hygiene (post-run) ──
  runMemoryHygiene();

  // ── Cost summary ──
  logDurationSummary(pipelineStartTime);

  // ── Final status ──
  const finalGoals = readGoals();
  if (finalGoals) {
    log('ship', '── Final State ──');
    for (const p of getAllPhases(finalGoals)) {
      const done = p.tasks?.filter(t => t.status === 'completed').length || 0;
      const total = p.tasks?.length || 0;
      const icon = p.status === 'completed' ? '✅' : p.status === 'blocked' ? '🚫' : '⏳';
      log('ship', `  ${icon} ${p.title}: ${done}/${total} tasks (${p.status})`);
    }
  }

  if (logStream) logStream.end();
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const raw = argv.slice(2);
  const opts = {
    resume: false,
    planName: null,
    phaseStopName: null,
    dryRun: false,
    topic: null,
    skipCanary: false,
    skipResearch: false,
    staleTimeoutMs: 30 * 60 * 1000,
  };

  const positional = [];
  let i = 0;

  while (i < raw.length) {
    const arg = raw[i];
    switch (arg) {
      case '--resume':
        opts.resume = true;
        break;
      case '--plan': {
        i++;
        const planParts = [];
        while (i < raw.length && !raw[i].startsWith('--')) {
          planParts.push(raw[i]);
          i++;
        }
        opts.planName = planParts.join(' ');
        i--; // outer loop increments
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--phase': {
        i++;
        const phaseParts = [];
        while (i < raw.length && !raw[i].startsWith('--')) {
          phaseParts.push(raw[i]);
          i++;
        }
        opts.phaseStopName = phaseParts.join(' ');
        i--; // outer loop increments
        break;
      }
      case '--skip-canary':
        opts.skipCanary = true;
        break;
      case '--no-research':
        opts.skipResearch = true;
        break;
      case '--stale-timeout':
        i++;
        opts.staleTimeoutMs = parseInt(raw[i], 10) * 60 * 1000;
        break;
      case '--verbose':
        verbosity = 'verbose';
        break;
      case '--quiet':
        verbosity = 'quiet';
        break;
      default:
        if (!arg.startsWith('--')) {
          positional.push(arg);
        }
        break;
    }
    i++;
  }

  if (positional.length > 0 && !opts.planName) {
    opts.topic = positional.join(' ');
  }

  return opts;
}

const opts = parseArgs(process.argv);

if (process.argv.length <= 2) {
  console.log(`
Usage:
  node ship.js <topic>             Plan, build, and validate a feature
  node ship.js --resume            Resume from current .goals.json state
  node ship.js --plan <name>       Build and validate an existing plan
  node ship.js --dry-run <topic>   Show what would happen without running

Flags:
  --phase <name>           Stop after the named phase completes
  --skip-canary            Skip the canary test on startup
  --no-research            Skip external research before planning
  --stale-timeout <min>    Minutes before in-progress tasks are reset (default: 30)
  --verbose                Full stream-json output from agents
  --quiet                  Only log state transitions and errors

Examples:
  node lib/ship.js "extract formatCurrency to shared util"
  node lib/ship.js --plan format-currency
  node lib/ship.js --resume --quiet
  node lib/ship.js --resume --phase "Foundation & Design System"
  node lib/ship.js --no-research "internal refactor"
`);
  process.exit(0);
}

async function main() {
  await run(opts.topic, {
    resume: opts.resume,
    planName: opts.planName,
    phaseStopName: opts.phaseStopName,
    dryRun: opts.dryRun,
    skipCanary: opts.skipCanary,
    skipResearch: opts.skipResearch,
    staleTimeoutMs: opts.staleTimeoutMs,
  });
}

main().catch(err => {
  log('error', `Unhandled: ${err.message}`);
  process.exit(1);
});
