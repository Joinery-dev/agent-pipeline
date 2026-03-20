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
 *   --stale-timeout <min>    — minutes before in-progress tasks are reset (default: 30)
 *   --verbose                — full stream-json output from agents
 *   --quiet                  — only log state transitions and errors
 */

import { spawn, execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { createWriteStream } from 'fs';
import { createTracker, parseTokenUsage as parseTokens } from './cost-tracker.js';

const GOALS_PATH = resolve('.goals.json');
const PIPELINE_CLI = resolve('lib/pipeline-cli.js');
const MAX_QA_ROUNDS = 2;
const MAX_PM_REPLANS = 2;
const MAX_BUILD_BATCH = 5;
const STALL_TIMEOUT_MS = 3 * 60 * 1000;  // 3 min no output = stalled
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // check every 30s

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
  const icons = { ship: '🚢', pm: '📋', build: '🔨', qa: '🔍', done: '✅', error: '❌' };
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
  const icons = { ship: '🚢', pm: '📋', build: '🔨', qa: '🔍', done: '✅', error: '❌' };
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

function getFailedTasks(phase) {
  return phase.tasks
    .filter(t => t.status === 'blocked')
    .map(t => t.title);
}

// ── Cost Tracking (via lib/cost-tracker.js) ─────────────────────────────

let costTracker = null; // initialized in run() with budget

function initCostTracker(budget) {
  costTracker = createTracker(budget);
}

function recordAgentCost(agent, taskId, output, durationMs) {
  const tokens = parseTokens(output);
  const entry = costTracker.recordDispatch({
    agent,
    taskId: taskId || 'unknown',
    ...tokens,
  });
  log('ship', `Cost: $${entry.cost.toFixed(2)} this agent, $${entry.cumulative.toFixed(2)} cumulative`);
}

function logCostSummary(startTime) {
  const durationMs = Date.now() - startTime;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);

  log('ship', '── Cost Summary ──');
  log('ship', `  ${costTracker.summary()}`);
  log('ship', `  Duration: ${minutes}m ${seconds}s`);
}

// ── Pre-dispatch Infrastructure ─────────────────────────────────────────

function runDistiller(agentType, taskId) {
  const distillerPath = resolve('lib/distill-briefing.js');
  if (!existsSync(distillerPath)) return;

  try {
    const args = ['--agent', agentType];
    if (taskId) args.push('--task', taskId);
    else args.push('--next');

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

// ── Progress Diffing ─────────────────────────────────────────────────────

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

// ── Agent Runner (streaming with heartbeat + cost tracking) ──────────────

let agentDispatches = 0;

function runAgent(command, description) {
  const agentType = command.startsWith('/pm') ? 'pm' : command.startsWith('/build') ? 'build' : 'qa';
  log(agentType, description);

  agentDispatches++;
  const agentStartTime = Date.now();

  const beforeSnapshot = snapshotGoals();

  return new Promise((resolvePromise) => {
    const proc = spawn('claude', [
      '-p', command,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--max-turns', '50',
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lastActivityAt = Date.now();
    let output = '';
    let lastLoggedLine = '';

    proc.stdout.on('data', (chunk) => {
      lastActivityAt = Date.now();
      const text = chunk.toString();
      output += text;

      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);

          // Verbose mode: log full events
          if (verbosity === 'verbose') {
            logVerbose(agentType, JSON.stringify(event));
          }

          // Log tool use events as heartbeats
          if (event.type === 'assistant' && event.tool) {
            const toolMsg = `  ⚙ ${event.tool.name || 'working'}...`;
            if (toolMsg !== lastLoggedLine) {
              if (verbosity !== 'quiet') {
                log(agentType, toolMsg);
              } else {
                logVerbose(agentType, toolMsg);
              }
              lastLoggedLine = toolMsg;
            }
          }
        } catch {
          // Not valid JSON
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      lastActivityAt = Date.now();
    });

    const heartbeat = setInterval(() => {
      const silenceMs = Date.now() - lastActivityAt;
      const silenceSec = Math.round(silenceMs / 1000);

      if (silenceMs > STALL_TIMEOUT_MS) {
        const afterSnapshot = snapshotGoals();
        const diff = diffSnapshots(beforeSnapshot, afterSnapshot);

        if (diff.changed) {
          log('ship', `Agent silent for ${silenceSec}s but made progress: ${diff.details}`);
          log('ship', 'Giving it more time...');
          lastActivityAt = Date.now();
        } else {
          log('error', `Agent stalled — ${silenceSec}s silence, no .goals.json changes`);
          log('ship', 'Killing stalled agent');
          proc.kill('SIGTERM');
        }
      } else if (silenceMs > 60000) {
        log(agentType, `  ... working (${silenceSec}s since last output)`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    proc.on('close', (code) => {
      clearInterval(heartbeat);

      const durationMs = Date.now() - agentStartTime;

      // Record cost via cost-tracker
      recordAgentCost(agentType, null, output, durationMs);

      const afterSnapshot = snapshotGoals();
      const diff = diffSnapshots(beforeSnapshot, afterSnapshot);

      if (code === 0) {
        log(agentType, `Finished. Progress: ${diff.details}`);
        resolvePromise({ success: true, output, madeProgress: diff.changed, diff });
      } else if (diff.changed) {
        log('ship', `Agent exited with code ${code}, but made progress: ${diff.details}`);
        log('ship', 'Treating as partial success — state machine will pick up from .goals.json');
        resolvePromise({ success: true, output, madeProgress: true, diff, partial: true });
      } else {
        log('error', `Agent exited with code ${code}, no progress made`);
        resolvePromise({ success: false, output, madeProgress: false, diff });
      }
    });
  });
}


// ── State Machine ────────────────────────────────────────────────────────

async function run(topic, options = {}) {
  const { resume, planName, dryRun, skipCanary, staleTimeoutMs } = options;

  const pipelineStartTime = Date.now();
  initLogFile();

  initCostTracker(Infinity);

  log('ship', `Starting: ${topic || planName || 'resume from .goals.json'}`);
  log('ship', `Stale timeout: ${Math.round(staleTimeoutMs / 60000)}min`);

  // ── Memory hygiene (pre-run) ──
  runMemoryHygiene();

  // ── Canary test ──
  if (!skipCanary && !dryRun) {
    const canaryPassed = await runCanary();
    if (!canaryPassed) {
      log('error', 'Canary test failed — aborting pipeline');
      logCostSummary(pipelineStartTime);
      if (logStream) logStream.end();
      return;
    }
  }

  let replanCount = 0;
  let iteration = 0;
  let consecutiveNoProgress = 0;
  let pipelineSuccess = false;
  let shouldStop = false;

  while (!shouldStop) {
    iteration++;
    log('ship', `── Iteration ${iteration} ──`);

    // ── Stale lock detection ──
    detectAndResetStaleTasks(staleTimeoutMs);

    // ── Checkpoint ──
    createCheckpoint(iteration);

    const goals = readGoals();

    // ── Step 1: Do we need a plan? ──

    if (!goals && !resume) {
      if (dryRun) { log('ship', 'DRY RUN: would run /pm:plan'); break; }

      log('pm', 'No .goals.json — creating plan');
      runDistiller('pm', null);
      const result = await runAgent(
        `/pm:plan ${topic}`,
        `Creating plan for: ${topic}`
      );
      if (!result.success) {
        log('error', 'PM failed to create plan');
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
        runDistiller('pm', null);
        const result = await runAgent(
          `/pm:plan ${planTopic}`,
          `Planning major phase: ${emptyMajor.title}`
        );
        if (!result.success) {
          log('error', `PM failed to plan "${emptyMajor.title}"`);
          shouldStop = true;
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

    // ── Step 3: Dispatch based on state ──

    let result;

    switch (state) {
      case 'needs-plan': {
        log('pm', 'Phase has no tasks — asking PM to plan');
        runDistiller('pm', null);
        result = await runAgent(
          `/pm:plan ${topic}`,
          `Planning: ${topic}`
        );
        break;
      }

      case 'needs-build': {
        // Validate plan before dispatching builder
        if (!runPlanValidator(phase.id)) {
          log('ship', `Skipping phase "${phase.title}" — plan validation failed`);
          topic = null; // move to next phase
          break;
        }
        runDistiller('build', null);
        const planRef = phase.planFile || phase.title;
        result = await runAgent(
          `/build ${planRef}`,
          `Building phase: ${phase.title}`
        );
        // Test gate after build
        if (result?.success) {
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
        if (result?.success) {
          const testResult = runTestGate(1);
          if (!testResult.passed) {
            log('ship', `Tests failed after build — will dispatch resolver next`);
          }
        }
        break;
      }

      case 'awaiting-qa': {
        runDistiller('qa', null);
        const planRef = phase.planFile
          ? phase.planFile.replace('plans/', '').replace('.md', '')
          : phase.title;
        result = await runAgent(
          `/qa ${planRef}`,
          `Validating phase: ${phase.title}`
        );
        break;
      }

      case 'qa-failed': {
        const qaRounds = countQARounds(phase);
        const failedTasks = getFailedTasks(phase);

        log('ship', `QA has failed ${qaRounds} time(s). Failed tasks: ${failedTasks.join(', ')}`);

        if (qaRounds > MAX_QA_ROUNDS) {
          if (replanCount >= MAX_PM_REPLANS) {
            log('error', `PM has re-planned ${replanCount} times. Stopping — needs human intervention.`);
            log('ship', 'Failed tasks:');
            failedTasks.forEach(t => log('ship', `  - ${t}`));
            shouldStop = true;
            break;
          }

          replanCount++;
          log('pm', `QA failed ${qaRounds}x — escalating to PM for re-analysis (replan ${replanCount}/${MAX_PM_REPLANS})`);
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
        }
        break;
      }

      case 'complete': {
        log('done', `Phase "${phase.title}" is complete!`);

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
        } else {
          log('done', 'All phases complete! Project milestone reached.');
          pipelineSuccess = true;
          shouldStop = true;
        }
        break;
      }

      default: {
        log('error', `Unknown state: ${state}`);
        iteration = maxAgents;
        break;
      }
    }

    // ── Step 4: Progress check ──

    if (result && !result.madeProgress) {
      consecutiveNoProgress++;
      log('ship', `No progress detected (${consecutiveNoProgress} consecutive)`);

      if (consecutiveNoProgress >= 3) {
        log('error', '3 consecutive iterations with no progress — stopping');
        log('ship', 'The agents are running but not advancing .goals.json state.');
        log('ship', 'This likely means a systemic issue. Run /pm for diagnosis.');
        break;
      }
    } else {
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
  logCostSummary(pipelineStartTime);

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
  --stale-timeout <min>    Minutes before in-progress tasks are reset (default: 30)
  --verbose                Full stream-json output from agents
  --quiet                  Only log state transitions and errors

Examples:
  node lib/ship.js "extract formatCurrency to shared util"
  node lib/ship.js --plan format-currency
  node lib/ship.js --resume --quiet
`);
  process.exit(0);
}

async function main() {
  await run(opts.topic, {
    resume: opts.resume,
    planName: opts.planName,
    dryRun: opts.dryRun,
    skipCanary: opts.skipCanary,
    staleTimeoutMs: opts.staleTimeoutMs,
  });
}

main().catch(err => {
  log('error', `Unhandled: ${err.message}`);
  process.exit(1);
});
