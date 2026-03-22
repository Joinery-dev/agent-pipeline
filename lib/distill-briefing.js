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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
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

if (!agentType || !['build', 'qa', 'pm', 'resolve', 'exec', 'design', 'walkthrough'].includes(agentType)) {
  console.error('Usage: distill-briefing.js --agent build|qa|pm|resolve|exec|design|walkthrough --task <id> | --phase <id> | --next');
  process.exit(1);
}

// PM and exec modes don't need a task/phase target
if (!['pm', 'exec', 'walkthrough'].includes(agentType) && !taskQuery && !phaseQuery && !useNext) {
  console.error('Must specify one of: --task <id>, --phase <id>, --next');
  process.exit(1);
}

// ── Load Goals ───────────────────────────────────────────────────────────

const goals = readGoals();
const allPhases = getAllPhases(goals);

// ── Resolve Target (for task-scoped agents) ──────────────────────────────

let targetTask = null;
let targetPhase = null;

if (!['pm', 'exec', 'walkthrough'].includes(agentType)) {
  if (taskQuery) {
    targetTask = findTask(goals, taskQuery);
    if (!targetTask) { console.error(`Task not found: ${taskQuery}`); process.exit(1); }
    targetPhase = findPhaseForTask(goals, targetTask.id);
  } else if (phaseQuery) {
    targetPhase = allPhases.find(p => p.id === phaseQuery || p.title === phaseQuery);
    if (!targetPhase) { console.error(`Phase not found: ${phaseQuery}`); process.exit(1); }
    // Design and QA are phase-scoped — don't need a target task
    if (!['design', 'qa'].includes(agentType)) {
      targetTask = targetPhase.tasks.find(t => t.status === 'not-started')
        || targetPhase.tasks.find(t => t.status === 'in-progress')
        || targetPhase.tasks.find(t => t.status === 'completed');
      // If still no task, generate a phase-level briefing (targetTask stays null)
    }
  } else if (useNext) {
    const eligible = allPhases
      .filter(p => p.status === 'in-progress' || p.status === 'not-started')
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const phase of eligible) {
      const task = phase.tasks.find(t => t.status === 'not-started')
        || phase.tasks.find(t => t.status === 'in-progress');
      if (task) { targetTask = task; targetPhase = phase; break; }
    }
    // Fallback: try completed tasks in eligible phases
    if (!targetTask) {
      for (const phase of eligible) {
        const task = phase.tasks.find(t => t.status === 'completed');
        if (task) { targetTask = task; targetPhase = phase; break; }
      }
    }
    // Fallback: use first eligible phase without a target task (phase-level briefing)
    if (!targetTask && eligible.length > 0) {
      targetPhase = eligible[0];
    }
    if (!targetPhase) { console.error('No eligible phase found'); process.exit(1); }
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
  if (agentType === 'exec') return buildExecBriefing();
  if (agentType === 'pm') return buildPmBriefing();
  if (agentType === 'qa') return buildQaBriefing();
  if (agentType === 'design') return buildDesignBriefing();
  if (agentType === 'walkthrough') return buildWalkthroughBriefing();
  return buildTaskBriefing(); // build, resolve
}

// ── Exec Briefing (strategic overview for escalation handling) ────────────

function buildExecBriefing() {
  const parts = [];

  parts.push(`<briefing agent="exec" generated="${new Date().toISOString()}">`);

  // Vision + completion
  if (goals.vision) {
    const totalPhases = allPhases.length;
    const completedPhases = allPhases.filter(p => p.status === 'completed').length;
    parts.push(`<project vision="${esc(goals.vision)}" completion="${completedPhases}/${totalPhases}" />`);
  }

  // Major phase statuses (1-line each)
  parts.push('<phases>');
  for (const mp of goals.majorPhases || []) {
    const subCount = mp.phases?.length || 0;
    const subDone = (mp.phases || []).filter(p => p.status === 'completed').length;
    const produces = mp.interfaceContract?.produces?.join(', ') || '';
    const consumes = mp.interfaceContract?.consumes?.join(', ') || '';
    parts.push(`  <major-phase title="${esc(mp.title)}" status="${mp.status}" sub-phases="${subDone}/${subCount}"${produces ? ` produces="${esc(produces)}"` : ''}${consumes ? ` consumes="${esc(consumes)}"` : ''} />`);

    // Show detail for failing/blocked sub-phases
    for (const phase of mp.phases || []) {
      if (phase.status === 'blocked' || phase.pipeline?.state === 'qa-failed') {
        const failedTasks = (phase.tasks || []).filter(t => t.status === 'blocked');
        parts.push(`    <failing-phase title="${esc(phase.title)}" pipeline="${phase.pipeline?.state || 'unknown'}" failed-tasks="${failedTasks.length}">`);
        for (const task of failedTasks) {
          const lastAttempt = task.attempts?.[task.attempts.length - 1];
          const notes = lastAttempt?.notes ? esc(lastAttempt.notes.slice(0, 500)) : '';
          parts.push(`      <task title="${esc(task.title)}" last-outcome="${lastAttempt?.outcome || 'none'}">${notes}</task>`);
        }
        parts.push('    </failing-phase>');
      }
    }
  }
  parts.push('</phases>');

  // Exec decision history
  const decisions = safeRead('.exec/memory/decisions.md');
  if (decisions && !decisions.includes('(none yet)')) {
    const sections = decisions.split(/^## /m).slice(1).slice(-3);
    if (sections.length > 0) {
      parts.push('<exec-decisions>');
      for (const s of sections) {
        parts.push(`  <decision>${esc(s.trim().slice(0, 300))}</decision>`);
      }
      parts.push('</exec-decisions>');
    }
  }

  // QA patterns and regressions
  const patterns = safeRead('.qa/memory/patterns.md');
  if (patterns && !patterns.includes('(none yet)')) {
    parts.push(`<qa-patterns>\n${esc(patterns.slice(0, 1000))}\n</qa-patterns>`);
  }

  const regressions = safeRead('.qa/memory/regressions.md');
  if (regressions && !regressions.includes('(none yet)')) {
    parts.push(`<qa-regressions>\n${esc(regressions.slice(0, 500))}\n</qa-regressions>`);
  }

  // Open concerns
  const concerns = safeRead('.pm/memory/concerns.md');
  const openConcerns = filterOpenConcerns(concerns);
  if (openConcerns) parts.push(`<open-concerns>\n${openConcerns}\n</open-concerns>`);

  // Design state
  const designStatus = safeJsonRead('.design/memory/status.json');
  if (designStatus?.overallGrade) {
    parts.push(`<design-state grade="${designStatus.overallGrade}" findings="${designStatus.findings?.shipBlockers || 0} blockers, ${designStatus.findings?.quality || 0} quality" />`);
  }

  // QA state
  const qaStatus = safeJsonRead('.qa/memory/status.json');
  if (qaStatus?.verdict) {
    parts.push(`<qa-state verdict="${qaStatus.verdict}" round="${qaStatus.round}" passing="${qaStatus.checksPassing}/${qaStatus.checksTotal}" />`);
  }

  parts.push('</briefing>');
  return parts.join('\n');
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
    const mpCompletedCount = (mp.phases || []).filter(p => p.status === 'completed').length;
    const mpTotalCount = (mp.phases || []).length;
    parts.push(`<major-phase title="${esc(mp.title)}" order="${mp.order}" status="${mp.status}" progress="${mpCompletedCount}/${mpTotalCount} phases done">`);

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

  // Project context — target phase + dependsOn get full detail; others get one-line summary
  const relevantPhaseIds = new Set([targetPhase.id, ...(targetPhase.dependsOn || [])]);
  parts.push('<project-context>');
  for (const m of goals.majorPhases || []) {
    const mCompletedCount = (m.phases || []).filter(p => p.status === 'completed').length;
    const mTotalCount = (m.phases || []).length;
    const hasRelevant = (m.phases || []).some(p => relevantPhaseIds.has(p.id));
    if (hasRelevant) {
      parts.push(`  <major-phase title="${esc(m.title)}" status="${m.status}" progress="${mCompletedCount}/${mTotalCount} phases done">`);
      for (const phase of m.phases || []) {
        if (relevantPhaseIds.has(phase.id)) {
          // Full detail for target phase and its dependencies
          parts.push(`    <phase title="${esc(phase.title)}" status="${phase.status}" pipeline="${phase.pipeline?.state || 'idle'}">`);
          for (const task of phase.tasks || []) {
            parts.push(`      <task id="${task.id}" title="${esc(task.title)}" status="${task.status}">`);
            for (const a of (task.attempts || []).slice(-2)) {
              parts.push(`        <attempt type="${a.type}" round="${a.round}" outcome="${a.outcome}" description="${esc(a.description)}">${a.notes ? esc(a.notes.slice(0, 500)) : ''}</attempt>`);
            }
            parts.push('      </task>');
          }
          parts.push('    </phase>');
        } else {
          // One-line summary for siblings
          parts.push(`    <phase title="${esc(phase.title)}" status="${phase.status}" />`);
        }
      }
      parts.push('  </major-phase>');
    } else {
      // One-line summary for unrelated major phases
      parts.push(`  <major-phase title="${esc(m.title)}" status="${m.status}">${mCompletedCount}/${mTotalCount} phases done</major-phase>`);
    }
  }
  parts.push('</project-context>');

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

// ── Design Review Briefing (phase-scoped visual context) ──────────────────

function buildDesignBriefing() {
  const parts = [];

  parts.push(`<briefing agent="design" generated="${new Date().toISOString()}">`);

  // Vision
  if (goals.vision) parts.push(`<vision>\n${goals.vision}\n</vision>`);

  // Visual language (the constitution — primary reference)
  const vlang = safeRead('.claude/visual-language.md');
  if (vlang) parts.push(`<visual-language>\n${vlang}\n</visual-language>`);

  // Current phase + plan's visual spec
  parts.push(`<current-phase title="${esc(targetPhase.title)}" status="${targetPhase.status}" pipeline="${targetPhase.pipeline?.state || 'idle'}">`);
  if (targetPhase.planFile) parts.push(`  <plan-file>${targetPhase.planFile}</plan-file>`);

  // Extract visual specification from plan
  const planContent = targetPhase.planFile ? safeRead(targetPhase.planFile) : null;
  if (planContent) {
    const vsMatch = planContent.match(/## Visual Specification[\s\S]*?(?=\n## [^#]|\n# |$)/);
    if (vsMatch) parts.push(`  <visual-spec>\n${esc(vsMatch[0])}\n  </visual-spec>`);
  }

  // Illustrations (mockup references)
  if (targetPhase.illustrations?.length) {
    parts.push('  <illustrations>');
    for (const ill of targetPhase.illustrations) {
      parts.push(`    <illustration title="${esc(ill.title)}" image="${ill.imagePath}" viewport="${ill.viewport || '1280x800'}" />`);
    }
    parts.push('  </illustrations>');
  }

  // Task summary (what was built)
  for (const task of targetPhase.tasks || []) {
    const files = task.files?.join(', ') || '';
    parts.push(`  <task title="${esc(task.title)}" status="${task.status}"${files ? ` files="${esc(files)}"` : ''} />`);
  }
  parts.push('</current-phase>');

  // All pages across project (for cross-phase consistency check)
  const otherPhases = allPhases.filter(p => p.id !== targetPhase.id && p.status === 'completed');
  if (otherPhases.length > 0) {
    parts.push('<completed-phases>');
    for (const p of otherPhases) {
      const produces = p.interfaceContract?.produces?.join(', ') || '';
      parts.push(`  <phase title="${esc(p.title)}"${produces ? ` produces="${esc(produces)}"` : ''} />`);
    }
    parts.push('</completed-phases>');
  }

  // Design memory (previous findings, grades, drift)
  const designStatus = safeJsonRead('.design/memory/status.json');
  if (designStatus?.overallGrade) {
    parts.push(`<design-state grade="${designStatus.overallGrade}" round="${designStatus.round}" trajectory="${designStatus.trajectory?.slice(-3).map(t => t.grade).join(' → ') || ''}" />`);
  }

  const findings = safeRead('.design/memory/findings.md');
  if (findings && !findings.includes('(none yet)')) {
    parts.push(`<previous-findings>\n${esc(findings.slice(0, 2000))}\n</previous-findings>`);
  }

  const pageGrades = safeJsonRead('.design/memory/page-grades.json');
  if (pageGrades && Object.keys(pageGrades).length > 0) {
    parts.push('<page-grades>');
    for (const [route, data] of Object.entries(pageGrades)) {
      const latest = data.grades?.[data.grades.length - 1];
      if (latest) parts.push(`  <page route="${esc(route)}" grade="${latest.grade}" phase="${esc(latest.phase)}" />`);
    }
    parts.push('</page-grades>');
  }

  const drift = safeRead('.design/memory/visual-drift.md');
  if (drift && !drift.includes('(none yet)')) {
    parts.push(`<visual-drift>\n${esc(drift.slice(0, 1500))}\n</visual-drift>`);
  }

  // Open concerns from PM
  const openConcerns = filterOpenConcerns(safeRead('.pm/memory/concerns.md'));
  if (openConcerns) parts.push(`<concerns>\n${openConcerns}\n</concerns>`);

  // QA patterns (visual patterns to check)
  const qaPatterns = safeRead('.qa/memory/patterns.md');
  if (qaPatterns && !qaPatterns.includes('(none yet)')) {
    parts.push(`<qa-patterns>\n${esc(qaPatterns.slice(0, 1000))}\n</qa-patterns>`);
  }

  parts.push('</briefing>');
  return parts.join('\n');
}

// ── Walkthrough Briefing (full project review, all pages/routes) ──────────

function buildWalkthroughBriefing() {
  const parts = [];

  parts.push(`<briefing agent="walkthrough" generated="${new Date().toISOString()}">`);

  // Project vision
  if (goals.vision) parts.push(`<vision>\n${goals.vision}\n</vision>`);

  // All pages/routes in the project (from phases and their files)
  parts.push('<pages-and-routes>');
  for (const mp of goals.majorPhases || []) {
    for (const phase of mp.phases || []) {
      const phaseFiles = [];
      for (const task of phase.tasks || []) {
        if (task.files?.length) phaseFiles.push(...task.files);
      }
      if (phaseFiles.length > 0 || phase.interfaceContract?.produces?.length) {
        parts.push(`  <phase title="${esc(phase.title)}" status="${phase.status}">`);
        if (phase.interfaceContract?.produces?.length) {
          parts.push(`    <produces>${phase.interfaceContract.produces.join(', ')}</produces>`);
        }
        if (phaseFiles.length > 0) {
          parts.push(`    <files>${phaseFiles.join(', ')}</files>`);
        }
        parts.push('  </phase>');
      }
    }
  }
  parts.push('</pages-and-routes>');

  // Visual language summary
  const vlang = safeRead('.claude/visual-language.md');
  if (vlang && !vlang.includes('Not yet established')) {
    parts.push(`<visual-language>\n${vlang}\n</visual-language>`);
  }

  // Recent QA status
  const qaStatus = safeJsonRead('.qa/memory/status.json');
  if (qaStatus?.verdict) {
    parts.push(`<qa-state verdict="${qaStatus.verdict}" round="${qaStatus.round}" passing="${qaStatus.checksPassing}/${qaStatus.checksTotal}" />`);
  }

  // Design review status
  const designStatus = safeJsonRead('.design/memory/status.json');
  if (designStatus?.overallGrade) {
    parts.push(`<design-state grade="${designStatus.overallGrade}" round="${designStatus.round}" />`);
  }

  const pageGrades = safeJsonRead('.design/memory/page-grades.json');
  if (pageGrades && Object.keys(pageGrades).length > 0) {
    parts.push('<page-grades>');
    for (const [route, data] of Object.entries(pageGrades)) {
      const latest = data.grades?.[data.grades.length - 1];
      if (latest) parts.push(`  <page route="${esc(route)}" grade="${latest.grade}" />`);
    }
    parts.push('</page-grades>');
  }

  // Open concerns from PM
  const openConcerns = filterOpenConcerns(safeRead('.pm/memory/concerns.md'));
  if (openConcerns) parts.push(`<open-concerns>\n${openConcerns}\n</open-concerns>`);

  // Overall project completion
  const totalPhases = allPhases.length;
  const completedPhases = allPhases.filter(p => p.status === 'completed').length;
  parts.push(`<project-completion total="${totalPhases}" completed="${completedPhases}" />`);

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

  // MajorPhase context — target phase + dependsOn only; others get one-line summary
  const relevantPhaseIds = new Set([targetPhase.id, ...(targetPhase.dependsOn || [])]);
  for (const m of goals.majorPhases || []) {
    const hasRelevant = (m.phases || []).some(p => relevantPhaseIds.has(p.id));
    const mCompletedCount = (m.phases || []).filter(p => p.status === 'completed').length;
    const mTotalCount = (m.phases || []).length;
    if (hasRelevant) {
      parts.push(`<major-phase title="${esc(m.title)}" status="${m.status}" progress="${mCompletedCount}/${mTotalCount} phases done">`);
      for (const phase of m.phases || []) {
        if (relevantPhaseIds.has(phase.id)) {
          // Full detail for target phase and its dependencies
          parts.push(`  <phase title="${esc(phase.title)}" status="${phase.status}" pipeline="${phase.pipeline?.state || 'idle'}">`);
          for (const task of phase.tasks || []) {
            const lastAttempt = task.attempts?.[task.attempts.length - 1];
            parts.push(`    <task title="${esc(task.title)}" status="${task.status}"${lastAttempt ? ` last-attempt="${lastAttempt.outcome}"` : ''} />`);
          }
          parts.push('  </phase>');
        } else {
          // One-line summary for siblings
          parts.push(`  <phase title="${esc(phase.title)}" status="${phase.status}" />`);
        }
      }
      parts.push('</major-phase>');
    } else {
      // One-line summary for unrelated major phases
      parts.push(`<major-phase title="${esc(m.title)}" status="${m.status}">${mCompletedCount}/${mTotalCount} phases done</major-phase>`);
    }
  }

  // Target task (or phase-level fallback if all tasks completed)
  if (targetTask) {
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
  } else {
    // Phase-level briefing fallback (no actionable task found)
    parts.push(`<target>`);
    parts.push(`  <phase title="${esc(targetPhase.title)}" status="${targetPhase.status}" pipeline="${targetPhase.pipeline?.state || 'idle'}">`);
    if (targetPhase.description) parts.push(`    <description>${esc(targetPhase.description)}</description>`);
    for (const t of targetPhase.tasks || []) {
      parts.push(`    <task title="${esc(t.title)}" status="${t.status}" />`);
    }
    parts.push('  </phase>');
    if (targetPhase.planFile) {
      parts.push(`  <plan-file>${targetPhase.planFile}</plan-file>`);
    }
    parts.push('  <note>All tasks in this phase are completed. Review phase-level status.</note>');
    parts.push('</target>');
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
  const planPath = (targetTask?.planFile) || targetPhase.planFile;
  const planContent = planPath ? safeRead(planPath) : null;
  const criteria = extractSuccessCriteria(planContent, targetTask?.title);
  if (criteria) parts.push(`<success-criteria>\n${criteria}\n</success-criteria>`);

  // Concerns
  const openConcerns = filterOpenConcerns(safeRead('.pm/memory/concerns.md'));
  if (openConcerns) parts.push(`<concerns>\n${openConcerns}\n</concerns>`);

  // Patterns relevant to task files
  const patterns = safeRead('.qa/memory/patterns.md');
  if (patterns && targetTask?.files?.length) {
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
