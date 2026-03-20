#!/usr/bin/env node

/**
 * distill-briefing.js — Generates focused briefing documents for agent dispatches.
 *
 * Usage:
 *   node lib/distill-briefing.js --agent build --task <taskId>
 *   node lib/distill-briefing.js --agent qa --phase <phaseId>
 *   node lib/distill-briefing.js --agent pm --next
 *   node lib/distill-briefing.js --agent resolve --task <taskId>
 *
 * Produces .ship/briefing.md with XML-structured, focused context per agent type.
 * Framework-agnostic — works with any project using .goals.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { readGoals, findTask, findPhaseForTask, getAllPhases } from './pipeline.js';

// ── CLI ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  if (name === 'next') return true;
  return args[idx + 1];
}

const agentType = getArg('agent');
const taskQuery = getArg('task');
const phaseQuery = getArg('phase');
const useNext = args.includes('--next');

if (!agentType || !['build', 'qa', 'pm', 'resolve'].includes(agentType)) {
  console.error('Usage: distill-briefing.js --agent build|qa|pm|resolve --task <id> | --phase <id> | --next');
  process.exit(1);
}

// PM mode doesn't need a task/phase target
if (agentType !== 'pm' && !taskQuery && !phaseQuery && !useNext) {
  console.error('Must specify one of: --task <id>, --phase <id>, --next');
  process.exit(1);
}

// ── Load Goals ───────────────────────────────────────────────────────────

const goals = readGoals();
const allPhases = getAllPhases(goals);

// ── Resolve Target (for non-PM agents) ───────────────────────────────────

let targetTask = null;
let targetPhase = null;

if (agentType !== 'pm') {
  if (taskQuery) {
    targetTask = findTask(goals, taskQuery);
    if (!targetTask) { console.error(`Task not found: ${taskQuery}`); process.exit(1); }
    targetPhase = findPhaseForTask(goals, targetTask.id);
  } else if (phaseQuery) {
    targetPhase = allPhases.find(p => p.id === phaseQuery || p.title === phaseQuery);
    if (!targetPhase) { console.error(`Phase not found: ${phaseQuery}`); process.exit(1); }
    targetTask = targetPhase.tasks.find(t => t.status === 'not-started')
      || targetPhase.tasks.find(t => t.status === 'in-progress');
    if (!targetTask) { console.error(`No actionable tasks in phase: ${targetPhase.title}`); process.exit(1); }
  } else if (useNext) {
    const eligible = allPhases
      .filter(p => p.status === 'in-progress' || p.status === 'not-started')
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const phase of eligible) {
      const task = phase.tasks.find(t => t.status === 'not-started');
      if (task) { targetTask = task; targetPhase = phase; break; }
    }
    if (!targetTask) { console.error('No next task found'); process.exit(1); }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeRead(filePath) {
  try { return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null; }
  catch { return null; }
}

function safeJsonRead(filePath) {
  const raw = safeRead(filePath);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function findMajorPhaseFor(phase) {
  if (!goals.majorPhases) return null;
  return goals.majorPhases.find(mp => mp.phases?.some(p => p.id === phase.id));
}

function getSiblingInterfaces(phase) {
  const mp = findMajorPhaseFor(phase);
  if (!mp) return [];

  const interfaces = [];
  for (const sibling of mp.phases) {
    if (sibling.id === phase.id) continue;
    if (sibling.status === 'completed' && sibling.interfaceContract?.produces?.length) {
      interfaces.push({ title: sibling.title, produces: sibling.interfaceContract.produces });
    }
  }

  // Also include interfaces from dependsOn phases (may be in other majorPhases)
  if (Array.isArray(phase.dependsOn)) {
    for (const depId of phase.dependsOn) {
      const dep = allPhases.find(p => p.id === depId);
      if (dep && dep.interfaceContract?.produces?.length) {
        if (!interfaces.some(i => i.title === dep.title)) {
          interfaces.push({ title: dep.title, produces: dep.interfaceContract.produces });
        }
      }
    }
  }

  return interfaces;
}

function filterOpenConcerns(content) {
  if (!content) return null;
  const sections = content.split(/^## /m).slice(1);
  const open = sections.filter(s => s.includes('OPEN') || s.includes('ESCALATED'));
  return open.length > 0 ? open.map(s => '## ' + s.trim()).join('\n\n') : null;
}

function extractSuccessCriteria(planContent, taskTitle) {
  if (!planContent || !taskTitle) return null;
  const lines = planContent.split('\n');
  let inTask = false;
  const criteria = [];
  const titleLower = taskTitle.toLowerCase();

  for (const line of lines) {
    if (/^#{1,4}\s/.test(line) && line.toLowerCase().includes(titleLower)) { inTask = true; continue; }
    if (inTask && /^#{1,2}\s/.test(line) && !line.toLowerCase().includes(titleLower)) break;
    if (inTask && line.match(/^[-*]\s+/)) criteria.push(line.trim());
  }
  return criteria.length > 0 ? criteria.join('\n') : null;
}

// ── Build Briefing by Agent Type ─────────────────────────────────────────

function buildBriefing() {
  if (agentType === 'pm') return buildPmBriefing();
  if (agentType === 'qa') return buildQaBriefing();
  return buildTaskBriefing(); // build, resolve
}

// ── PM Briefing (project-wide, no target task) ───────────────────────────

function buildPmBriefing() {
  const parts = [];

  parts.push(`<briefing agent="pm" generated="${new Date().toISOString()}">`);

  // Vision
  if (goals.vision) {
    parts.push(`<vision>\n${goals.vision}\n</vision>`);
  }

  // MajorPhase summaries
  parts.push('<major-phases>');
  for (const mp of goals.majorPhases || []) {
    parts.push(`<major-phase title="${esc(mp.title)}" order="${mp.order}" status="${mp.status}">`);
    if (mp.summary) parts.push(`  <summary>${esc(mp.summary)}</summary>`);

    for (const phase of mp.phases || []) {
      if (phase.status === 'completed') {
        // Completed: summary only
        const produces = phase.interfaceContract?.produces?.join(', ') || '';
        parts.push(`  <phase title="${esc(phase.title)}" status="completed"${produces ? ` produces="${esc(produces)}"` : ''} />`);
      } else if (phase.status === 'in-progress' || phase.status === 'blocked') {
        // Active: full detail
        parts.push(`  <phase title="${esc(phase.title)}" status="${phase.status}" pipeline="${phase.pipeline?.state || 'idle'}">`);
        for (const task of phase.tasks || []) {
          const lastAttempt = task.attempts?.[task.attempts.length - 1];
          parts.push(`    <task title="${esc(task.title)}" status="${task.status}"${lastAttempt ? ` last-attempt="${lastAttempt.outcome}"` : ''} />`);
        }
        parts.push('  </phase>');
      } else {
        // Not-started: title + description + deps
        const deps = phase.dependsOn?.length ? ` depends-on="${phase.dependsOn.join(',')}"` : '';
        parts.push(`  <phase title="${esc(phase.title)}" status="not-started"${deps}>${phase.description ? ' ' + esc(phase.description) : ''}</phase>`);
      }
    }
    parts.push('</major-phase>');
  }
  parts.push('</major-phases>');

  // PM memory
  const status = safeRead('.pm/memory/status.md');
  const concerns = safeRead('.pm/memory/concerns.md');
  const openConcerns = filterOpenConcerns(concerns);

  if (status) parts.push(`<pm-status>\n${status}\n</pm-status>`);
  if (openConcerns) parts.push(`<open-concerns>\n${openConcerns}\n</open-concerns>`);

  // QA state
  const qaStatus = safeJsonRead('.qa/memory/status.json');
  if (qaStatus?.verdict) {
    parts.push(`<qa-state verdict="${qaStatus.verdict}" round="${qaStatus.round}" passing="${qaStatus.checksPassing}/${qaStatus.checksTotal}" />`);
    if (qaStatus.forestWarnings?.length) {
      parts.push('<forest-warnings>');
      for (const w of qaStatus.forestWarnings) {
        parts.push(`  <warning risk="${w.risk}">${esc(w.description)}</warning>`);
      }
      parts.push('</forest-warnings>');
    }
  }

  parts.push('</briefing>');
  return parts.join('\n');
}

// ── QA Briefing (broad project context + focused phase) ──────────────────

function buildQaBriefing() {
  const parts = [];
  const mp = findMajorPhaseFor(targetPhase);

  parts.push(`<briefing agent="qa" generated="${new Date().toISOString()}">`);

  // Vision
  if (goals.vision) parts.push(`<vision>\n${goals.vision}\n</vision>`);

  // All majorPhase summaries (forest context)
  parts.push('<project-context>');
  for (const m of goals.majorPhases || []) {
    if (m.summary) {
      parts.push(`  <major-phase title="${esc(m.title)}" status="${m.status}">${esc(m.summary)}</major-phase>`);
    }
  }
  parts.push('</project-context>');

  // Current phase full detail
  parts.push(`<current-phase title="${esc(targetPhase.title)}" status="${targetPhase.status}" pipeline="${targetPhase.pipeline?.state || 'idle'}">`);
  if (targetPhase.planFile) parts.push(`  <plan-file>${targetPhase.planFile}</plan-file>`);
  for (const task of targetPhase.tasks || []) {
    parts.push(`  <task id="${task.id}" title="${esc(task.title)}" status="${task.status}">`);
    for (const a of (task.attempts || []).slice(-2)) {
      parts.push(`    <attempt type="${a.type}" round="${a.round}" outcome="${a.outcome}">${a.notes ? esc(a.notes.slice(0, 500)) : ''}</attempt>`);
    }
    parts.push('  </task>');
  }
  parts.push('</current-phase>');

  // Interface contracts (for forest check)
  const interfaces = getSiblingInterfaces(targetPhase);
  if (interfaces.length > 0) {
    parts.push('<available-interfaces>');
    for (const i of interfaces) {
      parts.push(`  <phase title="${esc(i.title)}">${i.produces.join(', ')}</phase>`);
    }
    parts.push('</available-interfaces>');
  }

  // Concerns and conventions
  const openConcerns = filterOpenConcerns(safeRead('.pm/memory/concerns.md'));
  if (openConcerns) parts.push(`<concerns>\n${openConcerns}\n</concerns>`);

  const conventions = safeRead('.claude/project-conventions.md');
  if (conventions && !conventions.includes('(none yet')) {
    parts.push(`<conventions>\n${conventions}\n</conventions>`);
  }

  parts.push('</briefing>');
  return parts.join('\n');
}

// ── Builder/Resolver Briefing (focused on single task) ───────────────────

function buildTaskBriefing() {
  const parts = [];
  const mp = findMajorPhaseFor(targetPhase);

  parts.push(`<briefing agent="${agentType}" generated="${new Date().toISOString()}">`);

  // Vision (always — short)
  if (goals.vision) parts.push(`<vision>\n${goals.vision}\n</vision>`);

  // MajorPhase context (summary only)
  if (mp?.summary) {
    parts.push(`<major-phase title="${esc(mp.title)}">${esc(mp.summary)}</major-phase>`);
  }

  // Target task
  parts.push(`<target>`);
  parts.push(`  <task id="${targetTask.id}" title="${esc(targetTask.title)}" status="${targetTask.status}">`);
  parts.push(`    <description>${esc(targetTask.description || '')}</description>`);
  if (targetTask.files?.length) parts.push(`    <files>${targetTask.files.join(', ')}</files>`);
  parts.push('  </task>');
  parts.push(`  <phase title="${esc(targetPhase.title)}" status="${targetPhase.status}" pipeline="${targetPhase.pipeline?.state || 'idle'}" />`);
  if (targetTask.planFile || targetPhase.planFile) {
    parts.push(`  <plan-file>${targetTask.planFile || targetPhase.planFile}</plan-file>`);
  }
  parts.push('</target>');

  // Previous attempts (last 3)
  const recent = (targetTask.attempts || []).slice(-3);
  if (recent.length > 0) {
    parts.push('<previous-attempts>');
    for (const a of recent) {
      parts.push(`  <attempt type="${a.type}" round="${a.round}" outcome="${a.outcome}">`);
      if (a.description) parts.push(`    <description>${esc(a.description)}</description>`);
      if (a.notes) parts.push(`    <notes>${esc(a.notes)}</notes>`);
      parts.push('  </attempt>');
    }
    parts.push('</previous-attempts>');
  }

  // QA findings (for resolve agent or qa-failed state)
  const pipeState = targetPhase.pipeline?.state;
  if (agentType === 'resolve' || pipeState === 'qa-failed') {
    const qaStatus = safeJsonRead('.qa/memory/status.json');
    if (qaStatus?.criteria) {
      const failing = qaStatus.criteria.filter(c => !c.passes);
      if (failing.length > 0) {
        parts.push('<qa-failures>');
        for (const c of failing) {
          parts.push(`  <criterion severity="${c.severity}">${esc(c.description)}${c.notes ? ' — ' + esc(c.notes) : ''}</criterion>`);
        }
        parts.push('</qa-failures>');
      }
    }
  }

  // Sibling interfaces
  const interfaces = getSiblingInterfaces(targetPhase);
  if (interfaces.length > 0) {
    parts.push('<available-interfaces>');
    for (const i of interfaces) {
      parts.push(`  <phase title="${esc(i.title)}">${i.produces.join(', ')}</phase>`);
    }
    parts.push('</available-interfaces>');
  }

  // Success criteria from plan
  const planPath = targetTask.planFile || targetPhase.planFile;
  const planContent = planPath ? safeRead(planPath) : null;
  const criteria = extractSuccessCriteria(planContent, targetTask.title);
  if (criteria) parts.push(`<success-criteria>\n${criteria}\n</success-criteria>`);

  // Concerns
  const openConcerns = filterOpenConcerns(safeRead('.pm/memory/concerns.md'));
  if (openConcerns) parts.push(`<concerns>\n${openConcerns}\n</concerns>`);

  // Patterns relevant to task files
  const patterns = safeRead('.qa/memory/patterns.md');
  if (patterns && targetTask.files?.length) {
    const relevant = targetTask.files.some(f => patterns.includes(f));
    if (relevant) parts.push(`<relevant-patterns>\n${patterns}\n</relevant-patterns>`);
  }

  // Conventions
  const conventions = safeRead('.claude/project-conventions.md');
  if (conventions && !conventions.includes('(none yet')) {
    parts.push(`<conventions>\n${conventions}\n</conventions>`);
  }

  parts.push('</briefing>');
  return parts.join('\n');
}

// ── Escape XML ───────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Write ────────────────────────────────────────────────────────────────

const briefing = buildBriefing();
const outDir = '.ship';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'briefing.md'), briefing);
console.log(resolve(outDir, 'briefing.md'));
