# Implementation Plan — Audit Fixes

All changes from audit2.md, organized into parallel phases.
Dependencies between items determine ordering. Independent items run in parallel.

---

## Phase 1: Crash Fixes (Critical — do first, blocks everything)

All independent of each other. Fix in parallel.

| Item | File | Change |
|------|------|--------|
| B1 | `bin/init.js` | Add `import crypto from 'node:crypto'` at top |
| B2 | `lib/ship.js` | Replace `iteration = maxAgents` with `shouldStop = true; break` in default switch case |
| B3 | `lib/validate-plan.js` | Import `getAllPhases` from `pipeline.js`, replace `goals.phases` with `getAllPhases(goals)` |

---

## Phase 2: Core Engine Fixes (High — blocks all pipeline runs)

Three parallel tracks. No dependencies between tracks.

### Track A: pipeline.js fixes

| Item | File | Change |
|------|------|--------|
| B4 | `lib/pipeline.js` | Guard `rollupPhaseStatus()`: `if (statuses.length === 0) return 'not-started'` |
| CT-1 | `lib/pipeline.js` | Remove `children: []` from `addAttempt()` |
| CT-2 | `lib/pipeline.js` | Add MajorPhase validation to `validateGoals()` — id, title, status enum, phases array, order |
| CT-3 | `lib/pipeline.js` | Add `VALID_AGENTS` enum to `setPipelineState()`, validate `lastAgent` |
| R3 | `lib/pipeline.js` | Guard `getStaleTasks()`: `if (!Array.isArray(task.attempts)) return` before `.sort()` |
| CT-8 | `lib/pipeline.js` | Add Phase.pipeline validation: check `state` against `VALID_PIPELINE_STATES` if present |

### Track B: ship.js state machine fixes

| Item | File | Change |
|------|------|--------|
| #11 | `lib/ship.js` | After exec RESTART: reset phase pipeline to `idle`, clear tasks to `not-started`, reset QA status.json |
| #12 | `lib/ship.js` | Track QA rounds at phase level (`phase.pipeline.qaRounds`) instead of counting task attempts. Increment on each QA dispatch, never reset on task replacement. |
| R1 | `lib/ship.js` | Add `const MAX_ITERATIONS = 50` and guard: `if (iteration >= MAX_ITERATIONS) { shouldStop = true; break }` |
| #2 | `lib/ship.js` | Raise quality gate concern threshold back to `>= 3` |
| #5 | `lib/ship.js` | Raise visual drift threshold to `>= 2` |

### Track C: plan-to-tasks + playwright-gate fixes

| Item | File | Change |
|------|------|--------|
| B5 | `lib/plan-to-tasks.js` | Pass parsed `dependsOn` to `pipeline-cli add-task` call |
| B6 | `lib/playwright-gate.js` | Add `\|\| 0` fallbacks: `(stats?.expected \|\| 0) + (stats?.unexpected \|\| 0) + (stats?.skipped \|\| 0)` |

---

## Phase 3: Wiring Fixes (Medium — parallel tracks)

All tracks independent of each other. Depend on Phase 2 being complete.

### Track D: pipeline-cli.js new commands

| Item | File | Change |
|------|------|--------|
| Wiring #2 | `lib/pipeline-cli.js` | Add `update-task <taskId> --title --desc --files --status` command |
| Wiring #2 | `lib/pipeline-cli.js` | Add `update-phase <phaseId> --title --desc --planFile --produces --consumes` command |

### Track E: ship.js dispatch wiring

| Item | File | Change |
|------|------|--------|
| #3 | `lib/ship.js` | Add `runDistiller('exec')` before interactive exec spawn |
| #6 | `lib/ship.js` | Add `runDistiller('resolve')` before the 3 resolve dispatches in final review |
| #7 | `lib/ship.js` | Create feature branch before dispatching builder: `git checkout -b build/<phase-slug>` |
| #1 | `lib/ship.js` | Add `startDevServer()` / `stopDevServer()` lifecycle management. Start before first visual step, keep alive, kill on exit. |

### Track F: distill-briefing.js fixes

| Item | File | Change |
|------|------|--------|
| Wiring #1 | `lib/distill-briefing.js` | Remove `mp.summary` reads (dead field), or generate summary in `rollup-major` |
| Wiring #4 | `lib/distill-briefing.js` | Add `'walkthrough'` to valid agent types, create `buildWalkthroughBriefing()` |
| #8 | `lib/distill-briefing.js` or `lib/ship.js` | Don't push `--next` for PM/exec modes in `runDistiller` |
| #15 | `lib/distill-briefing.js` | Build distiller: also consider `completed` tasks as valid, or generate phase-level briefing |
| #14 | `lib/ship.js` | Change `getFailedTasks` to return `{ id, title }` objects, pass `task.id` to distiller |
| #16 | `lib/ship.js` + `lib/distill-briefing.js` | Write per-phase briefings: `.ship/briefing-${phase.id}.md` for parallel builds |

### Track G: integration-check.js + pipeline-sync.js

| Item | File | Change |
|------|------|--------|
| Wiring #14 | `lib/integration-check.js` | Also check `goals.majorPhases[]` interfaceContract, not just sub-phases |
| R8 | `lib/pipeline-sync.js` | Remove duplicated `getAllPhases()`, import from `pipeline.js` |

### Track H: research slug fix

| Item | File | Change |
|------|------|--------|
| #4 | `lib/ship.js` | `runResearch` scans `.pm/research/` for any `.md` file modified in last 30 min, skips if found |

---

## Phase 4: Protocol & Prompt Updates (Medium — parallel, no code deps)

All documentation. Independent of each other and of code changes (but should reflect Phase 2-3 changes).

### Track I: agent-protocol.md schema alignment

| Item | File | Change |
|------|------|--------|
| CT-4 | `template/.claude/agent-protocol.md` | Add `interfaceContract` and `dependsOn` as optional on MajorPhase schema |
| CT-5 | `template/.claude/agent-protocol.md` | Mark `planFile` optional on Phase and Task |
| CT-6 | `template/.claude/agent-protocol.md` | Add `exec` and `design` to `Pipeline.lastAgent` valid values |
| CT-7 | `template/.claude/agent-protocol.md` | Mark `Project.description` and `Project.vision` as optional |
| CT-9 | `template/.claude/agent-protocol.md` | Add Task to Illustration entity list |
| C1 | `template/.claude/agent-protocol.md` | Add PM memory schema section |
| C4 | `template/.claude/agent-protocol.md` | Add QA diagnosis note format specification for Resolver |

### Track J: agent prompt fixes

| Item | File | Change |
|------|------|--------|
| C3 | `template/.claude/commands/build.md` | Add `.qa/memory/regressions.md` to startup reads |
| C5 | `template/.claude/commands/diagram.md` | Document entry/exit node convention |
| C4 | `template/.claude/commands/resolve.md` | Add instruction to read ralph-loop.md for QA diagnosis format |
| C6 | `template/.claude/commands/pm:handoff.md` + `pm:review.md` | Document as manual-only (not dispatched by ship.js) |

---

## Phase 5: Memory Hygiene (Medium — standalone)

Single track. Depends on Phase 2 Track A (pipeline.js fixes) for validation.

| Item | File | Change |
|------|------|--------|
| Wiring #18 (1) | `lib/memory-hygiene.js` | `regressions.md` — retire entries with 5+ consecutive passes |
| Wiring #18 (2) | `lib/memory-hygiene.js` | `regressions.md` — archive entries older than 60 days |
| Wiring #18 (3) | `lib/memory-hygiene.js` | `patterns.md` — merge duplicate entries (same root cause) |
| Wiring #18 (4) | `lib/memory-hygiene.js` | `.qa/memory/status.json` trajectory — cap at 20 entries |
| Wiring #18 (5) | `lib/memory-hygiene.js` | `.design/memory/status.json` trajectory — cap at 20 entries |
| Wiring #18 (6) | `lib/memory-hygiene.js` | `.design/memory/findings.md` — keep last 20 phase entries |
| Wiring #18 (7) | `lib/memory-hygiene.js` | `.design/memory/visual-drift.md` — archive resolved items > 60 days |
| Wiring #18 (8) | `lib/memory-hygiene.js` | `regressions.md` staleness audit — check if referenced code exists |
| Wiring #18 (9) | `lib/memory-hygiene.js` | `concerns.md` — archive RESOLVED entries > 30 days |
| #13 | `lib/memory-hygiene.js` | Fix `archiveEntries` header preservation — detect and keep `# Title` header |

---

## Phase 6: Cleanup & Polish (Low — last)

All independent. Do after everything else.

### Track K: code smells

| Item | File | Change |
|------|------|--------|
| S1 | `lib/ship.js` | Declare `result` before switch statement |
| S2 | `lib/ship.js` | Rename `planRef2` or restructure switch |
| S6 | `lib/merge.js` | Remove dead `if (tagName` block |
| R4 | `lib/agent-runner.js` | Capture stderr to `.ship/agent-stderr.log` |
| R6 | `lib/cost-tracker.js` | Review cumulative cost calculation |

### Track L: docs

| Item | File | Change |
|------|------|--------|
| D1-D7 | `docs/agent-loop.mmd` | Add parallel builds, building state, final review, Playwright gate |
| D4-D5 | `docs/scaffolding.mmd` | Add missing lib files and commands |
| D6 | `README.md` | Document /exec, /walkthrough, /design-review, final review, escalation |

### Track M: init.js scaffolding

| Item | File | Change |
|------|------|--------|
| #10 | `bin/init.js` | Add `checkpoint-fixes.md` to `.exec/memory/` scaffolding |
| Wiring #3 | `template/.claude/commands/exec.md` | Remove writes to `.exec/memory/final-review.md` or add reader |
| R5 | `lib/pipeline.js` | Align default status between `rollupPhaseStatus` and `rollupMajorPhaseStatus` |
| CT-10 | `lib/pipeline.js` | Add basic DiagramNode validation (id + position) |

---

## Execution Summary

```
Phase 1 ──────────────────── (3 fixes, parallel)
  │
Phase 2 ──────────────────── (3 tracks × 2-6 fixes each, parallel within)
  │
Phase 3 ──────────────────── (5 tracks × 1-6 fixes each, all parallel)
  │         ┌─ Track D: CLI commands
  │         ├─ Track E: ship.js dispatch
  │         ├─ Track F: distill-briefing
  │         ├─ Track G: integration + sync
  │         └─ Track H: research slug
  │
Phase 4 ──────────────────── (2 tracks, parallel with Phase 3)
  │         ├─ Track I: protocol schema
  │         └─ Track J: prompt fixes
  │
Phase 5 ──────────────────── (10 fixes, single file)
  │
Phase 6 ──────────────────── (3 tracks, all parallel)
            ├─ Track K: code smells
            ├─ Track L: docs
            └─ Track M: scaffolding
```

**Total: 62 changes across 6 phases, 13 parallel tracks.**
**Phases 3 and 4 can run in parallel with each other.**
**Phase 5 can start as soon as Phase 2 Track A is done.**
