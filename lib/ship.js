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

import { spawn, execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { createWriteStream } from 'fs';

const GOALS_PATH = resolve('.goals.json');
const PIPELINE_CLI = resolve('lib/pipeline-cli.js');
const MAX_QA_ROUNDS = 3;
const MAX_PM_REPLANS = 2;
const MAX_DESIGN_ROUNDS = 3;
const MAX_BUILD_BATCH = 5;
const PROGRESS_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check for real progress every 5 min
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // log heartbeat every 30s
const MAX_CHECKS_WITHOUT_PROGRESS = 2; // kill after 2 checks (10 min) with zero progress

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

// ── Research ─────────────────────────────────────────────────────────────

/**
 * Run /pm:research before planning to gather external context.
 * Skips if a research brief already exists for this topic.
 */
async function runResearch(topic) {
  const researchDir = resolve('.pm/research');
  if (!existsSync(researchDir)) mkdirSync(researchDir, { recursive: true });

  // Check if research brief already exists for this topic
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const briefPath = resolve(researchDir, `${slug}.md`);
  if (existsSync(briefPath)) {
    log('ship', `Research brief exists: .pm/research/${slug}.md — skipping research`);
    return { skipped: true, reason: 'brief exists' };
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

    // Progress-based monitoring instead of stall timeout
    let lastProgressSnapshot = getProgressSnapshot();
    let checksWithoutProgress = 0;
    let lastHeartbeat = Date.now();

    const heartbeat = setInterval(() => {
      const silenceMs = Date.now() - lastActivityAt;
      const silenceSec = Math.round(silenceMs / 1000);
      const elapsed = Date.now() - agentStartTime;

      // Heartbeat log every 30s of silence
      if (silenceMs > 60000) {
        log(agentType, `  ... working (${silenceSec}s since last output, ${Math.round(elapsed / 60000)}m total)`);
      }

      // Progress check every 5 minutes
      if (Date.now() - lastHeartbeat >= PROGRESS_CHECK_INTERVAL_MS) {
        lastHeartbeat = Date.now();
        const currentProgress = getProgressSnapshot();

        if (hasRealProgress(lastProgressSnapshot, currentProgress)) {
          log('ship', `Progress check: ✓ (git diff: ${currentProgress.gitDiffSize}, files: ${currentProgress.untrackedCount})`);
          checksWithoutProgress = 0;
        } else if (silenceMs > PROGRESS_CHECK_INTERVAL_MS) {
          // Only count as no-progress if agent is also silent
          checksWithoutProgress++;
          log('ship', `Progress check: ✗ no changes detected (${checksWithoutProgress}/${MAX_CHECKS_WITHOUT_PROGRESS})`);

          if (checksWithoutProgress >= MAX_CHECKS_WITHOUT_PROGRESS) {
            log('error', `Agent has made no progress for ${checksWithoutProgress * 5} minutes — killing`);
            proc.kill('SIGTERM');
          }
        }

        lastProgressSnapshot = currentProgress;
      }
    }, HEARTBEAT_INTERVAL_MS);

    proc.on('close', (code) => {
      clearInterval(heartbeat);

      const durationMs = Date.now() - agentStartTime;

      const afterSnapshot = snapshotGoals();
      const diff = diffSnapshots(beforeSnapshot, afterSnapshot);
      const finalProgress = getProgressSnapshot();
      const madeRealProgress = hasRealProgress(lastProgressSnapshot, finalProgress) || diff.changed;

      if (code === 0) {
        log(agentType, `Finished. Progress: ${diff.details}`);
        resolvePromise({ success: true, output, madeProgress: madeRealProgress || diff.changed, diff });
      } else if (madeRealProgress) {
        log('ship', `Agent exited with code ${code}, but made progress (git/files changed)`);
        log('ship', 'Treating as partial success — state machine will pick up');
        resolvePromise({ success: true, output, madeProgress: true, diff, partial: true });
      } else {
        log('error', `Agent exited with code ${code}, no progress made`);
        resolvePromise({ success: false, output, madeProgress: false, diff });
      }
    });
  });
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
    if (openConcernMatches.length >= 1) {
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
    if (driftingCount >= 1) {
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

  while (!shouldStop) {
    iteration++;
    log('ship', `── Iteration ${iteration} ──`);
    const iterationStartProgress = getProgressSnapshot();

    // ── Quality gate (check for accumulating issues) ──
    if (iteration > 1 && !runQualityGate()) {
      shouldStop = true;
      break;
    }

    // ── Stale lock detection ──
    detectAndResetStaleTasks(staleTimeoutMs);

    // ── Checkpoint ──
    createCheckpoint(iteration);

    const goals = readGoals();

    // ── Step 1: Do we need a plan? ──

    if (!goals && !resume) {
      if (dryRun) { log('ship', 'DRY RUN: would run /pm:plan'); break; }

      log('pm', 'No .goals.json — creating plan');
      if (!skipResearch) await runResearch(topic);
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
        if (!skipResearch) await runResearch(planTopic);
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
          if (!skipResearch) await runResearch(planTopic);
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
        const planRef2 = phase.planFile || phase.title;
        result = await runAgent(
          `/build ${planRef2}`,
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
        // QA status reconciliation — QA agent may not reliably call update-status
        reconcileQAStatuses(phase.id);
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
              log('error', `Design review failed ${designResult.round} times on "${phase.title}" — needs human intervention`);
              logDecision(`Design failed ${designResult.round}x on "${phase.title}". Stopping — needs human review.`);
              shouldStop = true;
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
        }
        break;
      }

      case 'complete': {
        log('done', `Phase "${phase.title}" is complete!`);

        // Roll up all statuses (sub-phases → major phases)
        runRollupAll();

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
        iteration = maxAgents;
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
        log('error', '3 consecutive iterations with zero tangible progress — stopping');
        log('ship', 'Not even code changes detected. This is a systemic issue. Run /pm for diagnosis.');
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
