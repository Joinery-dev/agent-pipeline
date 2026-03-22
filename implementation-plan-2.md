# Implementation Plan 2 — Audit 4 Fixes

All changes from audit4.md: resume recovery, context budget, prompt correctness, and format compatibility.

---

## Phase 1: Critical Data Loss & Crashes (do first, blocks everything)

All independent. Fix in parallel.

### Track A: ship.js critical fixes

| Item | Change |
|------|--------|
| FC-1 | `runDesignReview()`: stop overwriting design status.json on success. Remove the write at line ~1110 or reload from disk after the agent runs. |
| R1 | `--resume` false complete: after the `needsExecPlanning && !resume` guard, add a check for `needsExecPlanning && resume` that logs an error and breaks instead of falling through to "All phases complete!" |
| FC-9 | Exec DECISION parsing: add case-insensitive matching and log warning when neither RESTART nor CONTINUE found in output |

### Track B: memory-hygiene.js critical fixes

| Item | Change |
|------|--------|
| FC-2 | `runRegressionRetirement()`: change `t.verdict` → derive from `t.passing === t.total`, change `t.checksPassing` → `t.passing`, change `t.checksTotal` → `t.total` |
| FC-3 | Learnings archiver: change delimiter from `/\n(?=---)/` to `/\n(?=## )/` to match ralph-loop.md heading format |

---

## Phase 2: Ship.js State Machine Fixes (High)

Single track — all ship.js.

| Item | Change |
|------|--------|
| R2 | QA round counter: move `qaRoundsCumulative` increment to AFTER `runAgent` returns, not before dispatch |
| R3 | Persist `execEscalationCount`: read from `.exec/memory/escalation-count.json` on startup, write back on each escalation. Reset to 0 when a new phase starts successfully. |
| R4 | Merge skip: move `runRollupAll()` to AFTER `runMerge()` in the `case 'complete'` block, so phase isn't marked completed until merge succeeds |
| FC-4 | Human decision regex: change to case-insensitive `/\*{0,2}human decision:?\*{0,2}\s*(SHIP|IMPROVE)/gi` |
| FC-8 | `countQAAttempts`: remove the dead `a.description?.startsWith('QA validation')` fallback |
| P5 | Add `buildFailureSummary(phase)`: extract latest QA failure notes from task attempts, return formatted string for PM replan prompt |
| P6 | Pass failure context to `runResearch()` on RESTART: `runResearch(planTopic, { force: true, failureContext: buildFailureSummary(phase) })` |

---

## Phase 3: Feature Wiring (Critical — ship.js dispatch gaps)

These are features that exist (commands, lib tools, diagrams) but ship.js doesn't dispatch them.

### Track C: ship.js dispatch wiring

| Item | Change |
|------|--------|
| P1 | Add exec checkpoint dispatch in `case 'complete'` when a major phase just completed. Before merge, dispatch `/exec --checkpoint` with the major phase context. |
| P2 | Add final review cycle after all phases complete. Before `pipelineSuccess = true`, run: full test suite → production build → link check → screenshot grid → walkthrough → project-level QA → project-level design review → interactive exec final review. |
| P3 | Use `spawnAgent` with `interactive: true` for initial exec dispatch and final review exec, so exec can ask the human questions. Keep automated escalation dispatches as non-interactive. |
| P4 | After exec checkpoint runs, read `.exec/memory/checkpoint-fixes.md` and route fixes to the appropriate agent (builder for code fixes, PM for plan revisions). |

### Track D: reconciler fixes (ship.js)

| Item | Change |
|------|--------|
| FC-10 | `reconcileTaskStatuses`: use `crypto.randomUUID()` instead of `reconcile-${Date.now()}` for attempt IDs |
| FC-11 | `reconcileTaskStatuses`: use `addAttempt()` from pipeline.js instead of hand-building the attempt object (gets correct round auto-calculation) |

---

## Phase 4: Context Budget (High — parallel tracks)

### Track E: command template updates (all prompts)

| Item | File | Change |
|------|------|--------|
| CB1 | `build.md` | Replace "Read .goals.json" with "Read .ship/briefing.md for project context. Use `pipeline-cli get-task <id>` for specific lookups. Do not read .goals.json directly." |
| CB1 | `qa.md` | Same — replace "Read .goals.json — ALL phases" with briefing + CLI lookups |
| CB1 | `exec.md` | Same — briefing + CLI. Exec reads .goals.json only during escalation when it needs full state. |
| CB1 | `pm.md` | Same |
| CB1 | `pm:plan.md` | Same |
| CB1 | `design-review.md` | Same |
| CB1 | `resolve.md` | Same |

### Track F: pipeline.js attempt archival

| Item | File | Change |
|------|------|--------|
| CB2 | `lib/pipeline.js` | Add `archiveAttempts(goals)`: for completed tasks, move all but the final QA-success attempt to `.ship/attempt-archive/${taskId}.json`. Call from `updateTaskStatus` when status changes to `completed`. |

### Track G: exec.md split

| Item | File | Change |
|------|------|--------|
| CB3 | `template/.claude/commands/exec.md` | Split into `exec.md` (initial planning + checkpoint + final review modes) and `exec:escalation.md` (escalation handling mode only) |
| CB3 | `lib/ship.js` | `runExecEscalation` dispatches `/exec:escalation` instead of `/exec --escalation` |

### Track H: distill-briefing.js scoping

| Item | File | Change |
|------|------|--------|
| CB4 | `lib/distill-briefing.js` | Build/QA/resolve briefings: only include target phase + dependsOn phases. PM briefings: target major phase detail + one-line summaries of others. Exec briefings: only failing/blocked phases with detail. |
| FC-6 | `lib/distill-briefing.js` | QA briefing: include `a.description` alongside `a.notes` in attempt XML |

### Track I: ship.js context pre-flight

| Item | File | Change |
|------|------|--------|
| CB5 | `lib/ship.js` | Add `estimateContextTokens(agentType)` function. Before each `runAgent()`, estimate total. Warn at >120K tokens, refuse dispatch at >160K and escalate to exec. |
| CB6 | `lib/pipeline-cli.js` | Add `get-phase-full <phaseId>` command returning the phase with tasks/attempts but without sibling phases |

---

## Phase 5: Format Compatibility Fixes (High — parallel tracks)

### Track J: memory-hygiene.js format fixes

| Item | Change |
|------|--------|
| FC-5 | `runConcernsResolvedArchival()`: match both `**Resolved:**` and `**Resolution:**` field names |

### Track K: prompt + protocol fixes

| Item | File | Change |
|------|------|--------|
| FC-7 | `template/.claude/ralph-loop.md` | Add instruction: for QA rounds > 1, use `--type qa-recheck` instead of `--type qa` |
| FC-14 | `template/.claude/design-loop.md` | Document the schema for design-sourced patterns.md entries: must include `**Seen in:**` and `**Root cause:**` fields to be recognized by quality gate and hygiene |
| P7 | `template/.claude/commands/design-review.md` | Restructure ownership section into OWNS / CROSS-WRITES / READS |
| P8 | `template/.claude/commands/pm.md` | Add explicit ownership section listing `.pm/memory/` files |
| FC-12 | `template/.claude/design-loop.md` | Clarify that design agent should write letter grades (A-F), document that ship.js should NOT overwrite them (cross-ref to FC-1 fix) |

---

## Phase 6: Low Priority Cleanup

### Track L: small fixes (all parallel)

| Item | File | Change |
|------|------|--------|
| FC-13 | `lib/distill-briefing.js` | `filterOpenConcerns()`: change `s.includes('OPEN')` to `s.includes('**Status:** OPEN')` |
| FC-15 | `lib/ship.js` | Stale task handler: change `' Stale —'` to `'\nStale —'` (newline instead of leading space) |
| CB1 (scaffold) | `bin/init.js` | Add `.exec/memory/escalation-count.json` to scaffolding (for R3 fix) |

---

## Execution Summary

```
Phase 1 ──────────────── Critical data loss (2 parallel tracks)
  │
Phase 2 ──────────────── Ship.js state machine (7 fixes, single track)
  │
Phase 3 ──────────────── Feature wiring (2 parallel tracks)
  │   ├── Track C: dispatch gaps (P1-P4)
  │   └── Track D: reconciler fixes (FC-10, FC-11)
  │
Phase 4 ──────────────── Context budget (5 parallel tracks)
  │   ├── Track E: command templates (CB1 × 7 files)
  │   ├── Track F: attempt archival (CB2)
  │   ├── Track G: exec.md split (CB3)
  │   ├── Track H: briefing scoping (CB4 + FC-6)
  │   └── Track I: pre-flight check (CB5 + CB6)
  │
Phase 5 ──────────────── Format compatibility (2 parallel tracks)
  │   ├── Track J: memory-hygiene format fixes
  │   └── Track K: prompt/protocol fixes
  │
Phase 6 ──────────────── Low priority cleanup (3 fixes, parallel)
```

**Total: 48 changes across 6 phases, 12 tracks.**
**Phases 4 and 5 can run in parallel with each other.**
**Phase 3 Track D can run in parallel with Phase 3 Track C.**
