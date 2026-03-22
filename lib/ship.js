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
 *   --skip-canary            — skip the canary test on startup
 *   --no-research            — skip external research before planning
 *   --stale-timeout <min>    — minutes before in-progress tasks are reset (default: 30)
 *   --verbose                — full stream-json output from agents
 *   --quiet                  — only log state transitions and errors
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync } from 'fs';
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

  // Use explicit pipeline state if set
  if (phase.pipeline?.state) {
    const stateMap = {
      'idle': 'needs-build',
      'building': 'building',
      'awaiting-qa': 'awaiting-qa',
      'qa-failed': 'qa-failed',
      'complete': 'complete',
    };
    const mapped = stateMap[phase.pipeline.state];

    const statuses = phase.tasks.map(t => t.status);
    if (statuses.every(s => s === 'completed')) return 'complete';
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
    a.type === 'qa' || a.type === 'qa-recheck' ||
    a.description?.startsWith('QA validation')
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
    .map(t => t.title);
}

// ── Duration Tracking ────────────────────────────────────────────────────

function logDurationSummary(startTime) {
  const durationMs = Date.now() - startTime;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  log('ship', `Duration: ${minutes}m ${seconds}s`);
}

// ── Pre-dispatch Infrastructure ─────────────────────────────────────────

function runDistiller(agentType, taskId) {
  const distillerPath = resolve('lib/distill-briefing.js');
  if (!existsSync(distillerPath)) return;

  try {
    const args = ['--agent', agentType];
    if (taskId) args.push('--task', taskId);
    else if (!['pm', 'exec', 'walkthrough'].includes(agentType)) args.push('--next');

    execFileSync('node', [distillerPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    log('ship', 'Briefing generated: .ship/briefing.md');
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
async function runResearch(topic, { force = false } = {}) {
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
  const result = await runAgent(
    `/pm:research ${topic}`,
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
      // Update pipeline state if all tasks are now completed
      const allDone = phase.tasks.every(t => t.status === 'completed');
      if (allDone) {
        phase.pipeline = { state: 'complete', lastAgent: 'qa', lastTimestamp: new Date().toISOString() };
        phase.status = 'completed';
        log('ship', `All ${phase.tasks.length} tasks QA-verified — phase complete`);
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
          id: `reconcile-${Date.now()}-${updated}`,
          type: 'build',
          round: 1,
          description: 'Auto-reconciled: builder wrote code but did not update status',
          outcome: 'success',
          notes: `Files matched: ${taskFiles.join(', ') || '(keyword match)'}`,
          children: [],
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
            attempt.notes = (attempt.notes || '') + ' Stale — agent did not complete';
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

async function runAgent(command, description) {
  const agentType = command.startsWith('/exec') ? 'exec'
    : command.startsWith('/pm') ? 'pm'
    : command.startsWith('/build') ? 'build'
    : command.startsWith('/resolve') ? 'build'
    : command.startsWith('/design') ? 'design'
    : 'qa';
  log(agentType, description);

  agentDispatches++;

  const beforeSnapshot = snapshotGoals();
  let lastProgressSnapshot = getProgressSnapshot();
  let checksWithoutProgress = 0;

  const result = await spawnAgent(command, {
    cwd: process.cwd(),
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

    progressCheckMs: PROGRESS_CHECK_INTERVAL_MS,

    onProgress: ({ elapsedMs, silenceMs }) => {
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

    shouldKill: () => {
      return checksWithoutProgress >= MAX_CHECKS_WITHOUT_PROGRESS;
    },
  });

  // ── Post-run: goals diff, exec history, result interpretation ──

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

async function runParallelBuilds(phases) {
  log('ship', `Parallel build: ${phases.length} independent phases`);
  logDecision(`Running ${phases.length} builders in parallel: ${phases.map(p => p.title).join(', ')}`);

  const promises = phases.map(async (phase) => {
    const planRef = phase.planFile || phase.title;
    runDistiller('build', null);
    const result = await runAgent(
      `/build ${planRef}`,
      `[Parallel] Building: ${phase.title}`
    );
    reconcileTaskStatuses(phase.id);
    runVisualCheck('baseline', phase.id);
    return { phase, result };
  });

  const results = await Promise.all(promises);

  let anyProgress = false;
  for (const { phase, result } of results) {
    if (result?.success || result?.madeProgress) {
      anyProgress = true;
      const testResult = runTestGate(1);
      if (!testResult.passed) {
        log('ship', `Tests failed after parallel build of "${phase.title}"`);
      }
    }
  }

  return { success: anyProgress, madeProgress: anyProgress };
}

// ── Design Review ────────────────────────────────────────────────────────

async function runDesignReview(phase) {
  // Only run if the project has UI pages
  const appDir = resolve('app');
  if (!existsSync(appDir)) return { hasShipBlockers: false };

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

  const result = await runAgent(
    `/design-review ${phase.title}`,
    `Design review: ${phase.title}`
  );

  if (!result?.success) {
    log('ship', 'Design review did not complete — continuing');
    return { hasShipBlockers: false, round: designStatus.round };
  }

  // Check if SHIP-BLOCKER findings exist in the output
  const hasShipBlockers = result.output?.includes('SHIP-BLOCKER') || false;

  if (hasShipBlockers) {
    log('ship', `Design review found SHIP-BLOCKER issues (round ${designStatus.round})`);
  } else {
    log('ship', 'Design review passed — no SHIP-BLOCKER issues');
    // Reset round counter on success
    designStatus.round = 0;
    designStatus.overallGrade = 'pass';
    try { writeFileSync(statusPath, JSON.stringify(designStatus, null, 2)); } catch {}
  }

  return { hasShipBlockers, round: designStatus.round };
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
  if (context.failedTasks) parts.push(`Failed tasks: ${context.failedTasks.join(', ')}`);
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

let execEscalationCount = 0;

async function runExecEscalation(trigger, context) {
  execEscalationCount++;
  if (execEscalationCount > MAX_EXEC_RESTARTS) {
    log('error', `Exec has restarted ${execEscalationCount - 1} times — true human intervention needed`);
    return 'CONTINUE'; // force stop path
  }

  saveExecHistory(trigger, context);
  runDistiller('exec', null);

  const briefing = buildExecBriefing(trigger, context);
  log('exec', `Escalation #${execEscalationCount}: ${trigger}`);

  const result = await runAgent(
    `/exec --escalation "${briefing}"`,
    `Executive escalation: ${trigger}`
  );

  // Parse exec's binary decision from output
  const decision = result.output?.includes('DECISION: RESTART') ? 'RESTART' : 'CONTINUE';
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
        '*.log', '.ship/previous.log',
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
  const { resume, planName, dryRun, skipCanary, skipResearch, staleTimeoutMs } = options;

  const pipelineStartTime = Date.now();
  initLogFile();

  log('ship', `Starting: ${topic || planName || 'resume from .goals.json'}`);
  log('ship', `Stale timeout: ${Math.round(staleTimeoutMs / 60000)}min`);

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
    runLifecycleHooks('iteration-start', { iteration });

    const goals = readGoals();

    // ── Step 1: Do we need strategic structure? ──

    const needsExecPlanning = !goals
      || (goals && (!goals.majorPhases || goals.majorPhases.length === 0) && !goals.vision);

    if (needsExecPlanning && !resume) {
      if (dryRun) { log('ship', 'DRY RUN: would run /exec'); break; }

      log('exec', 'No strategic structure — running executive planning');
      runDistiller('exec', null);
      const result = await runAgent(
        `/exec ${topic}`,
        `Executive planning: ${topic}`
      );
      if (!result.success) {
        log('error', 'Executive planning failed');
        break;
      }
      continue;
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

    let handledByParallel = false;
    if (state === 'needs-build') {
      const parallelPhases = findParallelBuildable(goals);
      if (parallelPhases && parallelPhases.length > 1) {
        result = await runParallelBuilds(parallelPhases);
        handledByParallel = true;
      }
    }

    // ── Step 3: Dispatch based on state (skip if parallel handled it) ──

    let result;

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
        // Track cumulative QA rounds at phase level (#12)
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

        runDistiller('qa', null);
        const qaRef = phase.planFile
          ? phase.planFile.replace('plans/', '').replace('.md', '')
          : phase.title;
        result = await runAgent(
          `/qa ${qaRef}`,
          `Validating phase: ${phase.title}`
        );
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
        } else if (!visualResult.skipped) {
          // Visual check passed — run design review for UI projects
          const designResult = await runDesignReview(phase);

          if (designResult.hasShipBlockers) {
            if (designResult.round > MAX_DESIGN_ROUNDS) {
              log('exec', `Design review failed ${designResult.round} times on "${phase.title}" — escalating to executive`);
              const execResult = await runExecEscalation('design-exhaustion', { phase, round: designResult.round });
              if (execResult === 'RESTART') { clearPhaseForReplan(phase); forceResearch = true; }
              if (execResult !== 'RESTART') {
                logDecision(`Design failed ${designResult.round}x on "${phase.title}". Exec could not resolve.`);
                shouldStop = true;
              }
            } else {
              log('ship', `Design SHIP-BLOCKERs found (round ${designResult.round}/${MAX_DESIGN_ROUNDS}) — sending phase back through pipeline`);
              logDecision(`Design review found SHIP-BLOCKERs on "${phase.title}" (round ${designResult.round}). Looping back through build → QA → design.`);
              // Set pipeline state back to qa-failed to trigger the fix cycle
              if (existsSync(PIPELINE_CLI)) {
                try {
                  execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'qa-failed', '--agent', 'design'], {
                    encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
                  });
                } catch {}
              }
            }
          }
        }
        break;
      }

      case 'qa-failed': {
        const qaRounds = phase.pipeline?.qaRoundsCumulative || countQARounds(phase);
        const failedTasks = getFailedTasks(phase);

        log('ship', `QA has failed ${qaRounds} time(s). Failed tasks: ${failedTasks.join(', ')}`);

        if (qaRounds > MAX_QA_ROUNDS) {
          if (replanCount >= MAX_PM_REPLANS) {
            log('exec', `PM has re-planned ${replanCount} times — escalating to executive`);
            const execResult = await runExecEscalation('qa-exhaustion', { phase, failedTasks, qaRounds, replanCount });
            if (execResult === 'RESTART') { clearPhaseForReplan(phase); replanCount = 0; forceResearch = true; break; }
            log('error', 'Exec could not resolve — stopping');
            shouldStop = true;
            break;
          }

          replanCount++;
          log('pm', `QA failed ${qaRounds}x — escalating to PM for re-analysis (replan ${replanCount}/${MAX_PM_REPLANS})`);
          logDecision(`QA failed ${qaRounds}x on "${phase.title}". Escalating to PM for re-analysis (replan ${replanCount}).`);
          runDistiller('pm', null);
          result = await runAgent(
            `/pm QA has failed ${qaRounds} times on phase "${phase.title}". Failed tasks: ${failedTasks.join(', ')}. Please analyze the failures in .goals.json attempt notes, read .qa/memory/status.json for details, and either revise the plan or update the tasks. The current approach isn't working.`,
            `PM re-analyzing failures in: ${phase.title}`
          );
        } else {
          for (const taskTitle of failedTasks) {
            // Dispatch /resolve (targeted fix) instead of /build (full rebuild)
            runDistiller('resolve', null);
            log('build', `Resolving failed task: ${taskTitle}`);
            result = await runAgent(
              `/resolve ${taskTitle}`,
              `Resolving: ${taskTitle}`
            );

            // If resolver failed, check if we should escalate
            if (result && !result.success) {
              log('ship', `Resolver failed on "${taskTitle}" — will escalate to PM next round`);
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

        // Roll up all statuses (sub-phases → major phases)
        runRollupAll();
        runLifecycleHooks('phase-complete', { phaseId: phase.id });

        // Integration check — verify interface contracts
        runIntegrationCheck(null);

        // Log decision to PM memory
        logDecision(`Phase "${phase.title}" completed. QA passed. Moving to next phase.`);

        // Attempt merge to main
        try {
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
          if (currentBranch !== 'main') {
            runMerge(currentBranch, phase.title.toLowerCase().replace(/\s+/g, '-'));
          }
        } catch { /* merge is best-effort */ }

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
  --skip-canary            Skip the canary test on startup
  --no-research            Skip external research before planning
  --stale-timeout <min>    Minutes before in-progress tasks are reset (default: 30)
  --verbose                Full stream-json output from agents
  --quiet                  Only log state transitions and errors

Examples:
  node lib/ship.js "extract formatCurrency to shared util"
  node lib/ship.js --plan format-currency
  node lib/ship.js --resume --quiet
  node lib/ship.js --no-research "internal refactor"
`);
  process.exit(0);
}

async function main() {
  await run(opts.topic, {
    resume: opts.resume,
    planName: opts.planName,
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
