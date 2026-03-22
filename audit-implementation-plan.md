# Audit Implementation Plan

All fixes from audit.md organized into parallel phases. Items within a phase have no dependencies on each other and can be worked on simultaneously.

---

## Phase 1: Critical Bugs (do first — these crash the system)

All independent. Fix in parallel.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| B1 | Missing crypto import | `bin/init.js:135` | Add `import crypto from 'crypto'` or use `import { randomUUID } from 'crypto'` |
| B2 | Undefined `maxAgents` | `lib/ship.js:~2119` | Replace `iteration = maxAgents` with `shouldStop = true` |
| B3 | validate-plan.js bypasses majorPhases | `lib/validate-plan.js:45,55` | Import `getAllPhases` from pipeline.js, replace `goals.phases` usage |
| B6 | Playwright-gate NaN | `lib/playwright-gate.js:97` | Add `\|\| 0` fallbacks: `(report.stats?.expected \|\| 0) + (report.stats?.unexpected \|\| 0)` |

---

## Phase 2: High-Priority Schema & Pipeline Fixes

All independent. Fix in parallel.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| B4 | Empty phase marked completed | `lib/pipeline.js:397-403` | Add `if (statuses.length === 0) return phase.status;` guard |
| B5 | Task dependencies dropped | `lib/plan-to-tasks.js:112-121` | Pass parsed `dependsOn` to pipeline-cli add-task command |
| R1 | No iteration cap on main loop | `lib/ship.js` | Add `MAX_ITERATIONS = 50` constant, check in while condition |
| R3 | getStaleTasks crashes | `lib/pipeline.js:479-485` | Add `if (!Array.isArray(task.attempts)) continue;` guard |
| R7 | No schema validation on read | `lib/ship.js:116-124` | Call `validateGoals()` after JSON.parse, log warnings (don't block) |
| R8 | Duplicated getAllPhases | `lib/pipeline-sync.js:14-24` | Delete local impl, import `{ getAllPhases }` from `./pipeline.js` |
| #4 | Attempt.children violates protocol | `lib/pipeline.js:297` | Remove `children: []` from `addAttempt()` |

---

## Phase 3: CLI & Validation Gaps

Can run in parallel with Phase 2 since they touch different files.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| #2 | No update-task/update-phase | `lib/pipeline-cli.js`, `lib/pipeline.js` | Add `update-task <id> --title/--desc/--files/--status` and `update-phase <id> --title/--desc/--planFile` commands |
| #8 | MajorPhase fields not validated | `lib/pipeline.js` | Add MajorPhase validation block in `validateGoals()`: check id, title, status enum, phases is array |
| #5 | Pipeline.lastAgent not validated | `lib/pipeline.js:351-364` | Add agent enum validation: `['pm', 'build', 'qa', 'resolve', 'design', 'exec', null]` |
| #1 | MajorPhase summary is dead read | `lib/distill-briefing.js` | Either: (a) add summary generation to `rollupMajorPhaseStatus` in pipeline.js, or (b) remove `mp.summary` reads from briefing code |
| #14 | Major phase contracts not validated | `lib/integration-check.js` | Add iteration over `goals.majorPhases[]` to validate their `interfaceContract` fields |

---

## Phase 4: Protocol & Documentation Fixes

All independent markdown/doc changes. Fix in parallel.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| C1 | No PM memory schema | `template/.claude/agent-protocol.md` | Add `.pm/memory/` schema section documenting status.md, decisions.md, concerns.md, reviews.md, handoff.md formats |
| C3 | build.md startup/ownership mismatch | `template/.claude/commands/build.md` | Add `regressions.md` to startup step 9 (or remove from ownership) |
| C4 | QA diagnosis format unspecified | `template/.claude/commands/resolve.md` | Add note: "QA attempt notes follow the format defined in ralph-loop.md Step 3: DIAGNOSE" |
| C5 | Entry/exit nodes not in diagram.md | `template/.claude/commands/diagram.md` | Add entry/exit node convention section |
| C6 | Orphan commands undocumented | `template/.claude/commands/pm:handoff.md`, `pm:review.md` | Add header note: "Manual command — not dispatched by ship.js" |
| #1,#2 | MajorPhase contract/dependsOn not in schema | `template/.claude/agent-protocol.md` | Add `interfaceContract` and `dependsOn` to MajorPhase schema definition |
| #3 | planFile required but not enforced | `template/.claude/agent-protocol.md` | Mark planFile as optional in schema |

---

## Phase 5: Memory Hygiene Implementation

Single file, multiple rules. Sequential within this phase.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| #18 | 9 missing hygiene rules | `lib/memory-hygiene.js` | Implement all: regressions retire (5 passes), regressions archive (60d), patterns merge dupes, status.json trajectory cap (20), design trajectory cap (20), findings.md cap (20 phases), visual-drift resolve+archive, regression staleness audit, concerns RESOLVED 30d archival |

---

## Phase 6: Ship.js Wiring & Quality

Dependencies: Phase 2 must complete first (for schema validation fixes).

| ID | Issue | File | Fix |
|----|-------|------|-----|
| #5 | 3 resolve dispatches lack briefings | `lib/ship.js` | Add `runDistiller('resolve', null)` before the 3 non-briefed `/resolve` dispatches (~lines 1280, 1944, 1983) |
| #4,21 | Walkthrough briefing unsupported | `lib/distill-briefing.js` | Add `walkthrough` to valid agent types, create `buildWalkthroughBriefing()` |
| R2 | Parallel build briefing race | `lib/ship.js` | Generate per-agent briefing files (`.ship/briefing-build-{phaseId}.md`) instead of overwriting single file |
| R4 | Stderr discarded | `lib/agent-runner.js` | Capture stderr content and include in return object: `{ ..., stderr }` |
| R5 | Rollup logic diverges | `lib/pipeline.js` | Align defaults: both should return `not-started` when empty, `in-progress` as fallback |
| S1 | Variable hoisting | `lib/ship.js` | Move `let result;` declaration before the switch statement |
| S3 | Dead children field | `lib/pipeline.js` | Remove `children: []` from addAttempt (same as Contract #4) |
| S4 | Undocumented status regression | `lib/pipeline.js` | Add comment explaining why `in-progress → not-started` is allowed (stale task reset) |

---

## Phase 7: Diagrams & Documentation

No code dependencies. Can start anytime after Phase 1.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| D1 | Missing building state | `docs/agent-loop.mmd` | Add `building` state node with resume path |
| D2 | No parallel builds | `docs/agent-loop.mmd` | Add parallel build fork/join |
| D3 | Final review missing | `docs/agent-loop.mmd` | Add final review cycle (walkthroughs, competitive analysis, ship decision) |
| D4 | scaffolding.mmd missing files | `docs/scaffolding.mmd` | Add all 9 missing lib files |
| D5 | scaffolding.mmd missing commands | `docs/scaffolding.mmd` | Add /exec, /walkthrough, /design-review |
| D6 | README.md incomplete | `README.md` | Add /exec, /walkthrough, /design-review, final review, checkpoints, escalation, autoresearch, parallel builds |
| D7 | Playwright gate undocumented | `docs/agent-loop.mmd` | Add playwright gate nodes at 3 ship.js call points |

---

## Phase 8: Code Smells (lowest priority)

All independent. Fix when convenient.

| ID | Issue | File | Fix |
|----|-------|------|-----|
| S2 | planRef2 naming | `lib/ship.js` | Restructure switch cases to use block scoping |
| S5 | Dual flags | `lib/pipeline-cli.js` | Normalize: accept both but warn if both provided |
| S6 | Dead code in merge.js | `lib/merge.js:281-283` | Remove empty `if` block |

---

## Parallelization Map

```
Phase 1 (Critical Bugs)     ─┐
                              ├──→ Phase 2 (Schema/Pipeline) ──→ Phase 6 (Ship.js Wiring)
Phase 3 (CLI/Validation)    ─┤
Phase 4 (Protocol/Docs)     ─┤
Phase 7 (Diagrams)          ─┘
                                   Phase 5 (Memory Hygiene) ──→ standalone
                                   Phase 8 (Smells) ──→ standalone, anytime
```

Phases 1, 3, 4, 7 have zero interdependencies — start all simultaneously.
Phase 2 can start in parallel with 3, 4, 7 since it touches different files.
Phase 5 is standalone (only touches memory-hygiene.js).
Phase 6 depends on Phase 2 (schema fixes must land before ship.js wiring).
Phase 8 is lowest priority, do anytime.

**Estimated scope:** ~45 individual fixes across 8 phases. Phases 1-4 are the most impactful and can all run in parallel.
