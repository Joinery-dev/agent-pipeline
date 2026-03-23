/**
 * Pipeline Engine — Schema enforcement for .goals.json
 *
 * Replaces LLM-instruction-based JSON manipulation with deterministic
 * code that validates schema, manages attempts, and tracks pipeline state.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

// ── Enums ──────────────────────────────────────────────────────────────

const VALID_STATUSES = ['not-started', 'in-progress', 'completed', 'blocked'];
const VALID_OUTCOMES = ['in-progress', 'success', 'failure', 'partial'];
const VALID_ATTEMPT_TYPES = ['build', 'qa', 'build-fix', 'qa-recheck', 'design-review', 'design-fix'];
const VALID_PIPELINE_STATES = ['idle', 'building', 'awaiting-qa', 'qa-failed', 'awaiting-design', 'design-failed', 'complete'];

// Valid status transitions: from → [allowed targets]
const STATUS_TRANSITIONS = {
  'not-started': ['in-progress'],
  'in-progress': ['completed', 'blocked', 'not-started'],
  'blocked': ['in-progress'],
  'completed': [],
};

// ── Schema Helpers ────────────────────────────────────────────────────

/**
 * Extract all phases from goals, supporting both:
 *   - New: goals.majorPhases[].phases[]
 *   - Legacy: goals.phases[]
 */
export function getAllPhases(goals) {
  if (Array.isArray(goals.majorPhases)) {
    const phases = [];
    for (const mp of goals.majorPhases) {
      if (Array.isArray(mp.phases)) phases.push(...mp.phases);
    }
    return phases;
  }
  if (Array.isArray(goals.phases)) return goals.phases;
  return [];
}

/**
 * Find the majorPhase that contains a given phase ID.
 */
export function findMajorPhaseForPhase(goals, phaseId) {
  if (!Array.isArray(goals.majorPhases)) return null;
  for (const mp of goals.majorPhases) {
    if (mp.phases?.some(p => p.id === phaseId)) return mp;
  }
  return null;
}

// ── Core Operations (Task 1) ───────────────────────────────────────────

export function readGoals(path = '.goals.json') {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

export function writeGoals(goals, path = '.goals.json') {
  const validation = validateGoals(goals);
  if (!validation.valid) {
    throw new Error(`Schema validation failed:\n${validation.errors.join('\n')}`);
  }
  const json = JSON.stringify(goals, null, 2);
  writeFileSync(path, json);
  // Read back and verify
  const readBack = JSON.parse(readFileSync(path, 'utf-8'));
  if (JSON.stringify(readBack, null, 2) !== json) {
    throw new Error('Write verification failed — file content does not match');
  }
}

export function validateGoals(goals) {
  const errors = [];

  if (!goals || typeof goals !== 'object') {
    return { valid: false, errors: ['Goals must be an object'] };
  }

  if (!goals.id) errors.push('Project missing id');
  if (!goals.name) errors.push('Project missing name');

  const phases = getAllPhases(goals);
  if (phases.length === 0 && !goals.majorPhases && !goals.phases) {
    errors.push('Project missing majorPhases[] or phases[]');
    return { valid: false, errors };
  }

  const allIds = new Set();
  function checkId(id, context) {
    if (!id) { errors.push(`${context}: missing id`); return; }
    if (allIds.has(id)) errors.push(`Duplicate id: ${id} (${context})`);
    allIds.add(id);
  }

  function validateDiagrams(diagrams, context) {
    if (!Array.isArray(diagrams)) return;
    for (let di = 0; di < diagrams.length; di++) {
      const d = diagrams[di];
      const dc = `${context}.Diagram[${di}]`;
      if (!d.id) errors.push(`${dc}: missing id`);
      if (!d.title) errors.push(`${dc}: missing title`);
      if (!Array.isArray(d.nodes)) errors.push(`${dc}: missing nodes[]`);
      if (!Array.isArray(d.edges)) errors.push(`${dc}: missing edges[]`);
      if (!d.createdAt) errors.push(`${dc}: missing createdAt`);
      if (!d.updatedAt) errors.push(`${dc}: missing updatedAt`);
    }
  }

  function validateIllustrations(illustrations, context) {
    if (!Array.isArray(illustrations)) return;
    for (let ii = 0; ii < illustrations.length; ii++) {
      const ill = illustrations[ii];
      const ic = `${context}.Illustration[${ii}]`;
      if (!ill.id) errors.push(`${ic}: missing id`);
      if (!ill.title) errors.push(`${ic}: missing title`);
      if (!ill.imagePath) errors.push(`${ic}: missing imagePath`);
      if (!ill.createdAt) errors.push(`${ic}: missing createdAt`);
      if (!ill.updatedAt) errors.push(`${ic}: missing updatedAt`);
      if (ill.region) {
        if (typeof ill.region.x !== 'number' || typeof ill.region.y !== 'number' ||
            typeof ill.region.width !== 'number' || typeof ill.region.height !== 'number') {
          errors.push(`${ic}: region must have numeric x, y, width, height`);
        }
      }
    }
  }

  function validateScreenshots(screenshots, context) {
    if (!Array.isArray(screenshots)) return;
    for (let si = 0; si < screenshots.length; si++) {
      const ss = screenshots[si];
      const sc = `${context}.Screenshot[${si}]`;
      if (!ss.id) errors.push(`${sc}: missing id`);
      if (!ss.route) errors.push(`${sc}: missing route`);
      if (!ss.imagePath) errors.push(`${sc}: missing imagePath`);
      if (!ss.createdAt) errors.push(`${sc}: missing createdAt`);
    }
  }

  // Validate diagrams at project level
  if (goals.diagrams) validateDiagrams(goals.diagrams, 'Project');
  if (goals.illustrations) validateIllustrations(goals.illustrations, 'Project');

  // Validate diagrams at majorPhase level
  if (Array.isArray(goals.majorPhases)) {
    for (let mi = 0; mi < goals.majorPhases.length; mi++) {
      const mp = goals.majorPhases[mi];
      if (mp.diagrams) validateDiagrams(mp.diagrams, `MajorPhase[${mi}]`);
      if (mp.illustrations) validateIllustrations(mp.illustrations, `MajorPhase[${mi}]`);
    }
  }

  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi];
    const pc = `Phase[${pi}]`;

    checkId(phase.id, pc);
    if (!phase.title) errors.push(`${pc}: missing title`);
    if (!VALID_STATUSES.includes(phase.status)) {
      errors.push(`${pc}: invalid status "${phase.status}"`);
    }
    if (!Array.isArray(phase.tasks)) {
      errors.push(`${pc}: missing tasks[]`);
      continue;
    }
    if (phase.order === undefined || phase.order === null) {
      errors.push(`${pc}: missing order`);
    }

    // Validate optional dependsOn — each entry must reference an existing phase ID
    if (Array.isArray(phase.dependsOn)) {
      const phaseIds = new Set(phases.map(p => p.id));
      for (const depId of phase.dependsOn) {
        if (!phaseIds.has(depId)) {
          errors.push(`${pc}: dependsOn references unknown phase ID "${depId}"`);
        }
        if (depId === phase.id) {
          errors.push(`${pc}: dependsOn references itself`);
        }
      }
    }

    // Validate optional interfaceContract structure
    if (phase.interfaceContract) {
      if (phase.interfaceContract.produces && !Array.isArray(phase.interfaceContract.produces)) {
        errors.push(`${pc}: interfaceContract.produces must be an array`);
      }
      if (phase.interfaceContract.consumes && !Array.isArray(phase.interfaceContract.consumes)) {
        errors.push(`${pc}: interfaceContract.consumes must be an array`);
      }
    }

    if (phase.diagrams) validateDiagrams(phase.diagrams, pc);
    if (phase.illustrations) validateIllustrations(phase.illustrations, pc);
    if (phase.screenshots) validateScreenshots(phase.screenshots, pc);

    for (let ti = 0; ti < phase.tasks.length; ti++) {
      const task = phase.tasks[ti];
      const tc = `${pc}.Task[${ti}]`;

      checkId(task.id, tc);
      if (!task.title) errors.push(`${tc}: missing title`);
      if (!VALID_STATUSES.includes(task.status)) {
        errors.push(`${tc}: invalid status "${task.status}"`);
      }
      if (!Array.isArray(task.attempts)) {
        errors.push(`${tc}: missing attempts[]`);
        continue;
      }
      if (!task.createdAt) errors.push(`${tc}: missing createdAt`);

      if (task.diagrams) validateDiagrams(task.diagrams, tc);

      for (let ai = 0; ai < task.attempts.length; ai++) {
        const attempt = task.attempts[ai];
        const ac = `${tc}.Attempt[${ai}]`;

        checkId(attempt.id, ac);
        if (attempt.description === undefined) errors.push(`${ac}: missing description`);
        if (!VALID_OUTCOMES.includes(attempt.outcome)) {
          errors.push(`${ac}: invalid outcome "${attempt.outcome}"`);
        }
        if (!VALID_ATTEMPT_TYPES.includes(attempt.type)) {
          errors.push(`${ac}: invalid type "${attempt.type}"`);
        }
        if (attempt.round === undefined || attempt.round === null) {
          errors.push(`${ac}: missing round`);
        }
        if (!attempt.createdAt) errors.push(`${ac}: missing createdAt`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function newId() {
  return randomUUID();
}

export function findTask(goals, query) {
  const results = [];

  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks) {
      // Exact ID match
      if (task.id === query) return task;
      // Exact title match (case-insensitive)
      if (task.title.toLowerCase() === query.toLowerCase()) return task;
    }
  }

  // Substring match
  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks) {
      if (task.title.toLowerCase().includes(query.toLowerCase())) {
        results.push(task);
      }
    }
  }

  if (results.length === 1) return results[0];
  if (results.length > 1) {
    throw new Error(
      `Ambiguous query "${query}" — matches ${results.length} tasks:\n` +
      results.map(t => `  - ${t.title}`).join('\n')
    );
  }

  return null;
}

export function findPhaseForTask(goals, taskId) {
  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks) {
      if (task.id === taskId) return phase;
    }
  }
  return null;
}

// ── Attempt Management (Task 2) ────────────────────────────────────────

export function addAttempt(goals, taskId, { type, description }) {
  const task = findTaskById(goals, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!VALID_ATTEMPT_TYPES.includes(type)) {
    throw new Error(`Invalid attempt type: ${type}. Valid: ${VALID_ATTEMPT_TYPES.join(', ')}`);
  }

  // Auto-calculate round: count existing attempts with same base type + 1
  const baseType = type.replace('-fix', '').replace('-recheck', '');
  const sameTypeCount = task.attempts.filter(a => {
    const aBase = a.type.replace('-fix', '').replace('-recheck', '');
    return aBase === baseType;
  }).length;

  const attempt = {
    id: newId(),
    type,
    round: sameTypeCount + 1,
    description: description || '',
    outcome: 'in-progress',
    notes: '',
    children: [],
    createdAt: new Date().toISOString(),
  };

  task.attempts.push(attempt);
  return attempt.id;
}

export function updateAttempt(goals, taskId, attemptId, { outcome, notes }) {
  const task = findTaskById(goals, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const attempt = task.attempts.find(a => a.id === attemptId);
  if (!attempt) throw new Error(`Attempt not found: ${attemptId} on task ${taskId}`);

  if (attempt.outcome !== 'in-progress') {
    throw new Error(
      `Cannot update attempt ${attemptId} — outcome is "${attempt.outcome}" (only "in-progress" can be updated)`
    );
  }

  if (outcome !== undefined) {
    if (!VALID_OUTCOMES.includes(outcome)) {
      throw new Error(`Invalid outcome: ${outcome}. Valid: ${VALID_OUTCOMES.join(', ')}`);
    }
    attempt.outcome = outcome;
  }
  if (notes !== undefined) {
    attempt.notes = notes;
  }
}

export function getLatestAttempt(goals, taskId, type) {
  const task = findTaskById(goals, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const matching = task.attempts
    .filter(a => a.type === type)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return matching[0] || null;
}

export function getAttempts(goals, taskId) {
  const task = findTaskById(goals, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  return [...task.attempts].sort((a, b) =>
    new Date(a.createdAt) - new Date(b.createdAt)
  );
}

// ── Pipeline State Management (Task 3) ─────────────────────────────────

export function setPipelineState(goals, phaseId, state, agentType) {
  if (!VALID_PIPELINE_STATES.includes(state)) {
    throw new Error(`Invalid pipeline state: ${state}. Valid: ${VALID_PIPELINE_STATES.join(', ')}`);
  }

  const phase = getAllPhases(goals).find(p => p.id === phaseId);
  if (!phase) throw new Error(`Phase not found: ${phaseId}`);

  phase.pipeline = {
    state,
    lastAgent: agentType || null,
    lastTimestamp: new Date().toISOString(),
  };
}

export function getPipelineState(goals, phaseId) {
  const phase = getAllPhases(goals).find(p => p.id === phaseId);
  if (!phase) throw new Error(`Phase not found: ${phaseId}`);

  return phase.pipeline || { state: 'idle', lastAgent: null, lastTimestamp: null };
}

export function checkDependencies(goals, phaseId) {
  const phases = getAllPhases(goals);
  const phase = phases.find(p => p.id === phaseId);
  if (!phase) throw new Error(`Phase not found: ${phaseId}`);

  if (!Array.isArray(phase.dependsOn) || phase.dependsOn.length === 0) {
    return { ready: true, blocking: [] };
  }

  const blocking = [];
  for (const depId of phase.dependsOn) {
    const dep = phases.find(p => p.id === depId);
    if (!dep) {
      blocking.push({ phaseId: depId, title: '(unknown phase)', status: 'missing' });
      continue;
    }
    if (dep.status !== 'completed') {
      blocking.push({ phaseId: dep.id, title: dep.title, status: dep.status });
    }
  }

  return { ready: blocking.length === 0, blocking };
}

export function rollupPhaseStatus(goals, phaseId) {
  const phase = getAllPhases(goals).find(p => p.id === phaseId);
  if (!phase) throw new Error(`Phase not found: ${phaseId}`);

  const statuses = phase.tasks.map(t => t.status);

  if (statuses.every(s => s === 'completed')) {
    phase.status = 'completed';
  } else if (statuses.some(s => s === 'blocked')) {
    phase.status = 'blocked';
  } else if (statuses.some(s => s === 'in-progress')) {
    phase.status = 'in-progress';
  } else if (statuses.every(s => s === 'not-started')) {
    phase.status = 'not-started';
  } else {
    phase.status = 'in-progress';
  }

  return phase.status;
}

export function updateTaskStatus(goals, taskId, newStatus) {
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Valid: ${VALID_STATUSES.join(', ')}`);
  }

  const task = findTaskById(goals, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const allowed = STATUS_TRANSITIONS[task.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(
      `Invalid status transition: "${task.status}" → "${newStatus}". ` +
      `Allowed from "${task.status}": [${(allowed || []).join(', ')}]`
    );
  }

  // QA gate: tasks can only be completed if there's a QA attempt with outcome success
  if (newStatus === 'completed') {
    const hasQASuccess = (task.attempts || []).some(a =>
      (a.type === 'qa' || a.type === 'qa-recheck') && a.outcome === 'success'
    );
    if (!hasQASuccess) {
      throw new Error(
        `Cannot mark task "${task.title}" completed — no QA attempt with outcome "success". ` +
        `Only QA can mark tasks completed. Use /qa to validate first.`
      );
    }
  }

  task.status = newStatus;

  // CB2: Archive old attempts when task is completed
  if (newStatus === 'completed') {
    archiveAttempts(goals);
  }
}

/**
 * Roll up a major phase's status based on its sub-phases.
 */
export function rollupMajorPhaseStatus(goals, majorPhaseId) {
  if (!Array.isArray(goals.majorPhases)) throw new Error('No majorPhases in goals');
  const mp = goals.majorPhases.find(m => m.id === majorPhaseId);
  if (!mp) throw new Error(`MajorPhase not found: ${majorPhaseId}`);

  const phases = mp.phases || [];
  if (phases.length === 0) {
    mp.status = 'not-started';
    return mp.status;
  }

  const statuses = phases.map(p => p.status);

  if (statuses.every(s => s === 'completed')) {
    mp.status = 'completed';
  } else if (statuses.some(s => s === 'blocked')) {
    mp.status = 'blocked';
  } else if (statuses.some(s => s === 'in-progress' || s === 'completed')) {
    mp.status = 'in-progress';
  } else {
    mp.status = 'not-started';
  }

  return mp.status;
}

export function getStaleTasks(goals, staleMinutes = 30) {
  const threshold = Date.now() - staleMinutes * 60 * 1000;
  const stale = [];

  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks) {
      if (task.status !== 'in-progress') continue;

      const latestAttempt = task.attempts
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

      if (!latestAttempt) {
        stale.push({ task, phase, reason: 'in-progress with no attempts' });
        continue;
      }

      // Skip tasks where the build already succeeded — they're not stale,
      // the agent just didn't update the task status after finishing.
      const hasSuccessfulBuild = task.attempts.some(a =>
        (a.type === 'build' || a.type === 'build-fix') && a.outcome === 'success'
      );
      if (hasSuccessfulBuild) continue;

      if (new Date(latestAttempt.createdAt).getTime() < threshold) {
        stale.push({
          task,
          phase,
          reason: `latest attempt is ${Math.round((Date.now() - new Date(latestAttempt.createdAt).getTime()) / 60000)}min old`,
        });
      }
    }
  }

  return stale;
}

// ── Attempt History Archival (CB2) ─────────────────────────────────────

/**
 * Archive old attempts for completed tasks to keep .goals.json lean.
 *
 * For each completed task with more than 2 attempts:
 *   - Keeps the last 2 attempts on the task
 *   - Moves the rest to .ship/attempt-archive/${taskId}.json
 *
 * @param {object} goals - The goals object (will be mutated)
 * @param {string} goalsPath - Path to .goals.json (used to resolve archive dir)
 * @returns {{ archived: number, tasksProcessed: number }}
 */
export function archiveAttempts(goals, goalsPath = '.goals.json') {
  const archiveDir = join(dirname(goalsPath) || '.', '.ship', 'attempt-archive');
  let archived = 0;
  let tasksProcessed = 0;

  for (const phase of getAllPhases(goals)) {
    for (const task of phase.tasks) {
      if (task.status !== 'completed') continue;
      if (!Array.isArray(task.attempts) || task.attempts.length <= 2) continue;

      tasksProcessed++;

      // Sort by creation time so we keep the latest 2
      const sorted = [...task.attempts].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
      const toArchive = sorted.slice(0, sorted.length - 2);
      const toKeep = sorted.slice(sorted.length - 2);

      // Write archive file (append to existing if present)
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }

      const archivePath = join(archiveDir, `${task.id}.json`);
      let existing = [];
      if (existsSync(archivePath)) {
        try {
          existing = JSON.parse(readFileSync(archivePath, 'utf-8')).attempts || [];
        } catch {
          existing = [];
        }
      }

      const archiveData = {
        taskId: task.id,
        title: task.title,
        attempts: [...existing, ...toArchive],
      };
      writeFileSync(archivePath, JSON.stringify(archiveData, null, 2));

      archived += toArchive.length;
      task.attempts = toKeep;
    }
  }

  return { archived, tasksProcessed };
}

// ── Entity Lookup ─────────────────────────────────────────────────────

/**
 * Find any entity (project, majorPhase, phase, or task) by ID.
 * Returns the entity object or null.
 */
export function findEntityById(goals, id) {
  if (goals.id === id) return goals;

  if (Array.isArray(goals.majorPhases)) {
    for (const mp of goals.majorPhases) {
      if (mp.id === id) return mp;
      if (Array.isArray(mp.phases)) {
        for (const phase of mp.phases) {
          if (phase.id === id) return phase;
          if (Array.isArray(phase.tasks)) {
            for (const task of phase.tasks) {
              if (task.id === id) return task;
            }
          }
        }
      }
    }
  }

  if (Array.isArray(goals.phases)) {
    for (const phase of goals.phases) {
      if (phase.id === id) return phase;
      if (Array.isArray(phase.tasks)) {
        for (const task of phase.tasks) {
          if (task.id === id) return task;
        }
      }
    }
  }

  return null;
}

// ── Internal Helpers ───────────────────────────────────────────────────

function findTaskById(goals, taskId) {
  for (const phase of getAllPhases(goals)) {
    const task = phase.tasks.find(t => t.id === taskId);
    if (task) return task;
  }
  return null;
}
