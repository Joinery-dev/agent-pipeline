# Pipeline Wiring Audit

**Date:** 2026-03-22
**Scope:** Every connection between components — verify both sides are wired.

---

## BROKEN (needs fixing)

### 1. MajorPhase `summary` field is a dead read
`distill-briefing.js` reads `mp.summary` in PM, QA, design, and build briefings. But no CLI command, no agent, and no script ever sets it. Every briefing that tries to include a major phase summary gets `undefined`.

**Fix:** Either add a `rollup-major` step that populates `summary`, or remove the reads from distill-briefing.js.

### 2. No `update-task` or `update-phase` CLI command
`pm:plan.md` tells agents to update task `files[]` via pipeline-cli after creation, but the command doesn't exist. Tasks and phases can't be modified after creation through the CLI — violating the "all mutations through pipeline-cli" guardrail.

**Fix:** Add `update-task` and `update-phase` commands to pipeline-cli.js.

---

## DANGLING (works but one side is missing)

### 3. `.exec/memory/final-review.md` — write-only orphan
Exec writes to it during competitive-check, but nothing reads it. Dead-end write.

### 4. `walkthrough` agent type unsupported by distill-briefing.js
Ship.js dispatches `/walkthrough` twice (checkpoint + final), but distill-briefing.js doesn't handle the `walkthrough` type. The walkthrough gets whatever stale briefing was generated for the previous agent.

### 5. Three `/resolve` dispatches lack briefings
Checkpoint test failures (line ~1280), final test failures (line ~1944), and production build failures (line ~1983) dispatch the Resolver without calling `runDistiller` first.

### 6. `.pm/memory/reviews.md` — self-read only
Written by pm:review. Only read by pm:review itself (previous review items check). No other agent reads it.

### 7. `.qa/memory/learnings.txt` — self-read only
Written and read only by QA itself (ralph-loop). No other agent reads it.

---

## NOT ENFORCED (guardrails that are honor-system only)

### 8. Feature branch requirement
Builder says "always work on a feature branch, not main" but nothing in ship.js or QA checks whether the builder actually created a branch.

### 9. "All mutations through pipeline-cli"
Stated in agent-protocol.md, never verified. Agents can write .goals.json directly and bypass schema validation.

### 10. Resolver scope limits
"Only touch files QA mentioned" — never checked by ship.js or QA recheck. Resolver could modify anything.

### 11. Plan reading before coding
Builder says "must read plan before coding" — never verified by any external component.

### 12. Diagram and illustration creation
pm:plan.md says "always create a diagram" and "always create illustrations for UI phases" but no gate checks whether they were actually created.

---

## DIAGRAM GAPS (ship.js features not in docs/agent-loop.mmd)

### 13. Missing from diagram
These features are implemented in ship.js but not represented in docs/agent-loop.mmd:
- Parallel builds (findParallelBuildable, runParallelBuilds)
- Quality gate checks (runQualityGate at each iteration)
- Stale task detection (detectAndResetStaleTasks)
- Zero-progress escalation (3 consecutive no-progress → exec)
- PM plan failure escalation (→ exec)
- `building` resume state
- Plan-to-tasks deterministic extraction (before PM fallback)
- Playwright test gate (Builder-first fix routing in qa-failed)

---

---

## DATA FORMAT & SCHEMA AUDIT (checks 14-21)

### 14. Produces/Consumes Contract Validation
**Status: Mostly wired**

Phase-level `interfaceContract` (produces/consumes) correctly validated by `integration-check.js`. Field names match between `agent-protocol.md` schema and checker. 4 checks implemented: unmet dependencies, unused producers, missing contracts, phantom producers.

**Gap:** MajorPhase-level contracts NOT checked. `exec.md` encourages `--produces`/`--consumes` on major phases, `pipeline-cli.js` supports them, but `integration-check.js` only inspects sub-phase contracts via `getAllPhases()`.

**Fix:** Extend `integration-check.js` to also iterate `goals.majorPhases[]` and validate their `interfaceContract` fields.

### 15. Template Files Exist
**Status: Clean**

Every file that `init.js` copies from `template/` verified to exist. All 13 command files, 4 protocol files, 20 lib files, 5 visualization files, config files, and 12 benchmark directories confirmed present.

### 16. Imports Match Exports
**Status: Clean**

All local imports in `lib/*.js` verified. `pipeline-cli.js` → 18 functions from `pipeline.js`, `distill-briefing.js` → 4 functions, `ship.js` → `spawnAgent` from `agent-runner.js`, etc. All exist and export correctly.

### 17. Pipeline-CLI Argument Formats in Prompts
**Status: Clean**

Every `pipeline-cli.js` invocation across all agent prompts (build.md, qa.md, resolve.md, pm:plan.md, exec.md, diagram.md, agent-protocol.md) matches the actual CLI parser. No flag name mismatches or missing required arguments.

### 18. Memory Hygiene Rules vs Implementation
**Status: 9 of 13 rules NOT implemented**

**Implemented (3):**
- `decisions.md` — keep last 20, archive → `archiveEntries(..., 20)`
- `reviews.md` — keep last 15, archive → `archiveEntries(..., 15)`
- `learnings.txt` — keep last 30, archive → `archiveEntries(..., 30)`

**Partial (1):**
- `concerns.md` RESOLVED archival — detects stale OPEN concerns (>3 days) but does NOT archive RESOLVED concerns older than 30 days

**NOT implemented (9):**
- `regressions.md` — retire after 5 consecutive passes (ralph-loop.md)
- `regressions.md` — archive after 60 days (ralph-loop.md)
- `patterns.md` — merge duplicates (ralph-loop.md)
- `status.json` trajectory — keep last 20 entries, QA (ralph-loop.md)
- `status.json` trajectory — keep last 20 entries, design (design-loop.md)
- `findings.md` — keep last 20 phase entries, archive older (design-loop.md)
- `visual-drift.md` — resolve when fixed, archive after 60 days (design-loop.md)
- Staleness audit for regressions — check if code still exists (ralph-loop.md)
- `concerns.md` RESOLVED archival — 30 day rule (pm-reference.md)

**Impact:** Memory files grow unbounded on long projects.

**Fix:** Implement the 9 missing rules in `lib/memory-hygiene.js`.

### 19. Skip Conditionals
**Status: Clean**

Every "skip this step if X" conditional in agent prompts has a matching positive path that runs when the condition IS met. Checked across build.md, pm:plan.md, exec.md, qa.md, resolve.md, walkthrough.md. All correctly paired.

### 20. Diagram/Illustration Schema Agreement
**Status: Mostly wired**

**Diagrams — all 4 layers agree:**
- `agent-protocol.md` schema (id, title, nodes[], edges[], createdAt, updatedAt)
- `pipeline-cli.js` add-diagram (creates matching fields, validates node ids + edge refs)
- `/api/diagrams/route.js` (reads .goals.json, passes through all fields)
- `app/visualize/page.js` (reads nodes/edges, supports title/label fallbacks)

Fully consistent.

**Illustrations — storage wired, no viewer:**
- Schema, CLI, and API all agree on fields
- **No illustration viewer** in `app/visualize/page.js`
- Agents read PNGs directly via Read tool (works for agents, not for humans)

**Fix:** Add illustration viewer component to visualize page, or document as agent-facing only.

### 21. Briefing Agent Type Coverage
**Status: Minor gap**

| Agent | Reads briefing | distill-briefing.js support | Relevant? |
|-------|---------------|----------------------------|-----------|
| build | Yes | `buildTaskBriefing()` | Yes |
| qa | Yes | `buildQaBriefing()` | Yes |
| resolve | Yes | `buildTaskBriefing()` (shared) | Yes |
| pm / pm:plan | Yes | `buildPmBriefing()` | Yes |
| pm:research | Yes | `buildPmBriefing()` (shared) | Partial — no research-specific content |
| exec | Yes | `buildExecBriefing()` | Yes |
| design-review | Yes | `buildDesignBriefing()` | Yes |
| walkthrough | Yes | **Not supported** | Missing |

**Gap:** `walkthrough` reads `.ship/briefing.md` but distill-briefing.js doesn't accept `--agent walkthrough`. Works without it (reads "if exists") but could benefit from one.

**Fix:** Add `walkthrough` to valid agent types and create `buildWalkthroughBriefing()`.

---

## COMPETITIVE GAPS (from landscape research 2026-03-22)

### 22. No persistent Playwright test generation
QA checks criteria from scratch each round. It should write reusable Playwright spec tests that accumulate across phases — a growing regression suite that catches cross-phase breakage automatically. QA Wolf and similar tools generate production-grade Playwright code from natural language; our QA agent could do the same, writing specs to `tests/qa/` and `tests/design/` (directories already scaffolded).

**What to build:** QA and Design Review agents write `.spec.js` files when they verify criteria. These persist across phases and run via `npx playwright test` in the test gate. Each round adds specs, building a comprehensive acceptance test suite over the project lifecycle.

**Reference:** QA Wolf generates Playwright/Appium code from natural language. Percy and Applitools do AI-driven visual diffing with baseline management. Our agents could write both functional and visual regression specs.

### 23. No interactive UI testing in walkthroughs
The walkthrough agent screenshots pages but cannot interact — it can't click buttons, fill forms, test dropdowns, or navigate via JavaScript-driven UI. Real user testing requires clicking through flows, not just viewing static screenshots. Devin 2.0 and Mabl both interact with live UIs.

**What to build:** Extend the walkthrough agent to use Playwright for interaction — click nav links, submit forms, trigger modals, test keyboard navigation. The agent already has access to Playwright via the dev server. Add interaction steps to the walkthrough command: "click the contact button, fill the form, submit it, verify the success message."

**Reference:** Devin 2.0 processes UI mockups and interacts with live UIs. Mabl uses computer vision + ML to create self-healing interactive tests. QA Wolf agents map workflows and generate executable interaction code.

### 24. No model escalation for cost optimization
Every agent dispatch uses the same model regardless of task complexity. The 35-agent swarm runs Sonnet for initial attempts and upgrades to Opus after two consecutive failures — cutting costs significantly on simple tasks. Simple resolver fixes and straightforward builds don't need Opus-level reasoning.

**What to build:** Add model selection to `spawnAgent` / `runAgent`. Default to a faster/cheaper model (Sonnet) for build and resolve dispatches. Escalate to Opus after failure. Use Opus by default for exec, PM planning, and QA (where reasoning quality matters most). Track cost per agent type via `cost-tracker.js`.

**Reference:** The 35-agent swarm saved significant cost with model escalation. Claude Code supports `--model` flag. Anthropic's pricing makes Sonnet 5-10x cheaper than Opus for equivalent output.

---

## CONTRACT SMOKE TEST (protocol ↔ validator ↔ CLI)

Cross-referenced agent-protocol.md schema, pipeline.js validateGoals(), and pipeline-cli.js commands. 15 discrepancies found.

### High priority (could cause logical bugs)

**#4 — Attempt.children contradicts protocol.** Protocol explicitly says "Attempt (flat — NO children/nesting)" but `addAttempt()` in pipeline.js adds `children: []` to every attempt. Validator doesn't check for or reject it. The field's presence invites nesting that violates the flat-attempt invariant.

**Fix:** Remove `children: []` from `addAttempt()`.

**#8 — MajorPhase fields not validated at all.** Validator skips the entire MajorPhase entity. No checks on id, title, description, status, phases, or order. A MajorPhase with `status: "banana"` or missing fields passes validation silently.

**Fix:** Add MajorPhase validation to `validateGoals()` — check id, title, status enum, phases array.

**#5 — Pipeline.lastAgent not validated.** `setPipelineState()` accepts any string for `--agent`. Protocol says it must be `pm | build | qa | resolve | null`. An invalid value like `--agent banana` gets persisted. Code branching on agent type could take wrong paths.

**Fix:** Add agent enum validation to `setPipelineState()`.

### Medium priority (contract drift)

**#1, #2 — MajorPhase has interfaceContract and dependsOn but protocol doesn't define them.** CLI's `add-major-phase` and `update-major-phase` set these fields on MajorPhase, and exec.md tells agents to use them, but the protocol schema only defines them on Phase. Agents reading the protocol won't know they exist on MajorPhase.

**Fix:** Update the MajorPhase schema in agent-protocol.md to include `interfaceContract` and `dependsOn` as optional fields.

**#3 — planFile listed as required but never enforced.** Protocol shows `planFile` as required on both Phase and Task (no optional marker). Validator doesn't check it. CLI only sets it when `--planFile` flag is provided.

**Fix:** Either mark planFile as optional in the protocol (it effectively is), or add validation.

**#13 — MajorPhase status not validated on update.** `update-major-phase --status` passes raw value with no enum check. Validator never checks MajorPhase status.

**Fix:** Covered by #8 fix (add MajorPhase validation).

### Low priority (unlikely to bite)

**#6, #7 — Project description and vision not validated.** Listed as required in protocol, not checked by validator. Always set by CLI when flags provided. Only a problem for hand-edited JSON.

**#9, #10, #11 — Phase.description, Task.description, Attempt.notes not validated.** Required per schema, not checked. CLI defaults them to empty strings. Functionally harmless.

**#12 — Phase.pipeline sub-object not validated.** A phase with `pipeline: { state: "banana" }` passes validation. CLI always produces valid values.

**#14 — Illustration on Task not defined in protocol.** Protocol says "optional on Project, MajorPhase, Phase" — Task not listed. But `findEntityById` resolves tasks, so CLI allows adding illustrations to tasks.

**#15 — DiagramNode/DiagramEdge internal fields not validated.** Validator checks arrays exist but not node.type, position, data fields. CLI validates id uniqueness and edge references but not node contents.

---

## BUGS (will cause incorrect behavior)

### B1. Missing crypto import in init.js
**File:** `bin/init.js` line 135
Uses `crypto.randomUUID()` but never imports `crypto`. Init will crash with ReferenceError.

### B2. Undefined `maxAgents` in ship.js
**File:** `lib/ship.js` line ~2119
Default switch case sets `iteration = maxAgents` — a variable that doesn't exist. If an unknown pipeline state is hit, this crashes instead of stopping the loop. Should be `shouldStop = true`.

### B3. validate-plan.js bypasses majorPhases schema
**File:** `lib/validate-plan.js` lines 45, 55
Uses `goals.phases` instead of `getAllPhases()`. Completely bypasses validation for projects using the majorPhases schema (the current standard). The validator silently does nothing on modern projects.

### B4. Empty phase marked completed
**File:** `lib/pipeline.js` lines 397-403
`rollupPhaseStatus()` uses `statuses.every(s => s === 'completed')` which returns true for `[]`. A phase with zero tasks gets marked completed, causing dependent phases to unblock prematurely.

### B5. Task dependencies silently dropped
**File:** `lib/plan-to-tasks.js` lines 112-121
Parses `dependsOn` from plan files (lines 87-100) but never passes it to `pipeline-cli add-task`. Dependencies are extracted then discarded.

### B6. Operator precedence bug in playwright-gate.js
**File:** `lib/playwright-gate.js` line 97
`report.stats?.expected + report.stats?.unexpected + report.stats?.skipped` — optional chaining with arithmetic can produce `NaN` when any stat is undefined. Needs `|| 0` fallbacks.

---

## RISKS (could cause problems under certain conditions)

### R1. Main loop has no iteration cap
**File:** `lib/ship.js` lines ~1501-2122
The `while (!shouldStop)` loop has no maximum iteration guard. If all code paths continue without triggering progress checks or `shouldStop`, it loops forever.

### R2. Parallel build briefing race
**File:** `lib/ship.js` lines ~1055-1066
Each parallel builder calls `runDistiller` (sync) then `runAgent` (async). Later iterations overwrite `.ship/briefing.md` before earlier agents read it.

### R3. getStaleTasks crashes on undefined attempts
**File:** `lib/pipeline.js` lines 479-485
Calls `.sort()` on `task.attempts` without checking it's an array first. Schema violation crashes the entire stale-task check.

### R4. Stderr discarded in agent-runner.js
**File:** `lib/agent-runner.js` lines 136-140
`proc.stderr.on('data')` updates the heartbeat timer but throws away content. Agent diagnostic messages and error details are lost.

### R5. Major phase vs phase rollup logic diverges
**File:** `lib/pipeline.js` lines 453-477
`rollupPhaseStatus` defaults to `in-progress`; `rollupMajorPhaseStatus` defaults to `not-started`. Can cause status mismatches between hierarchy levels.

### R6. Cumulative cost calculation ambiguous
**File:** `lib/cost-tracker.js` line 104
Cumulative cost calculation may produce incorrect running totals.

### R7. No schema validation on .goals.json read
**File:** `lib/ship.js` lines ~116-124
`readGoals()` checks if it's valid JSON but doesn't verify required fields. Malformed files cause mysterious downstream crashes.

### R8. Duplicated getAllPhases in pipeline-sync.js
**File:** `lib/pipeline-sync.js` lines 14-24
Re-implements `getAllPhases()` instead of importing from `pipeline.js`. Schema changes in one won't propagate.

---

## COMMAND/PROTOCOL ISSUES (cross-agent consistency)

### C1. No PM memory schema defined
`agent-protocol.md` defines schemas for `.exec/memory/` and `.design/memory/` but not `.pm/memory/`. Yet 6+ agents reference PM memory files.

### C2. QA references .pm/memory/status.md without PM knowing
`qa.md` and `ralph-loop.md` reference `.pm/memory/status.md` which is never defined in PM's documented outputs.

### C3. build.md ownership/startup mismatch
Ownership claims it reads `.qa/memory/regressions.md` but startup steps don't list it. Startup only reads `patterns.md`.

### C4. No specification of QA diagnosis format for Resolver
`resolve.md` assumes QA notes contain specific structure but the format is only defined in `ralph-loop.md`, which Resolver is never told to read.

### C5. Entry/exit node convention undocumented in diagram.md
PM creates diagrams with entry/exit nodes per `pm:plan.md` spec, but `diagram.md` has no mention of this convention.

### C6. Orphan commands not documented as manual-only
`pm:handoff.md` and `pm:review.md` exist in template but are never dispatched by ship.js. Not documented as manual-only.

---

## DOCUMENTATION GAPS (diagrams vs code)

### D1. Missing `building` state in diagram
Code has distinct `building` state for resuming in-progress builds. Diagram skips it.

### D2. No parallel builds shown in diagram
Code implements `findParallelBuildable()` and `runParallelBuilds()`. Absent from diagrams.

### D3. Final review not shown in diagram
Code has entire final review cycle (~lines 1934-2112) with walkthroughs, competitive analysis, and human interaction. Diagram ends at complete.

### D4. scaffolding.mmd missing 9+ lib files
Doesn't list link-check.js, screenshot-grid.js, playwright-gate.js, visual-check.js, render-mockup.js, agent-runner.js, integration-check.js, autoresearch.js, autoresearch-nightly.js.

### D5. scaffolding.mmd missing 3 commands
Doesn't list /exec, /walkthrough, /design-review.

### D6. README.md missing commands and workflows
Doesn't document /exec, /walkthrough, /design-review. No mention of final review, checkpoints, escalation, autoresearch, or parallel builds.

### D7. Playwright gate undocumented
`lib/playwright-gate.js` called at 3 points in ship.js but appears in no diagram.

---

## SMELLS (code quality issues)

### S1. Variable hoisting in ship.js
Variable `result` declared after first use in parallel build path. Works due to hoisting but confusing.

### S2. planRef2 naming
Renamed to avoid block-scoped collision instead of restructuring switch cases.

### S3. Dead `children` field on attempts
`children: []` always created on attempts, never validated, never used.

### S4. Undocumented status regression
`in-progress → not-started` transition allowed without documentation. Tasks can silently regress.

### S5. Dual flags accepted without validation
Both `--desc` and `--description` accepted everywhere with no validation that only one is used.

### S6. Dead code in merge.js
Empty `if (tagName` block — dead code.

---

## PRIORITY SUMMARY

| Priority | Issue | Source |
|----------|-------|--------|
| **Critical** | Missing crypto import — init.js crashes | B1 |
| **Critical** | Undefined maxAgents — ship.js crashes on unknown state | B2 |
| **Critical** | validate-plan.js silently skips all modern projects | B3 |
| **High** | Empty phase marked completed — premature unblocking | B4 |
| **High** | Task dependencies silently dropped by plan-to-tasks | B5 |
| **High** | Playwright-gate operator precedence → NaN | B6 |
| **High** | `update-task` / `update-phase` CLI commands missing | Wiring #2 |
| **High** | Memory hygiene: 9 of 13 rules unimplemented | Wiring #18 |
| **High** | MajorPhase `summary` field is dead read | Wiring #1 |
| **High** | No persistent Playwright test generation | Competitive #22 |
| **High** | Attempt.children contradicts flat-attempt protocol | Contract #4 |
| **High** | MajorPhase fields not validated at all | Contract #8 |
| **High** | Pipeline.lastAgent not validated (accepts any string) | Contract #5 |
| **High** | Main loop has no iteration cap | R1 |
| **Medium** | Parallel build briefing race | R2 |
| **Medium** | getStaleTasks crashes on undefined attempts | R3 |
| **Medium** | No schema validation on .goals.json read | R7 |
| **Medium** | Duplicated getAllPhases in pipeline-sync.js | R8 |
| **Medium** | integration-check.js: major phase contracts not validated | Wiring #14 |
| **Medium** | 3 `/resolve` dispatches lack briefings | Wiring #5 |
| **Medium** | Feature branch requirement not enforced | Wiring #8 |
| **Medium** | No interactive UI testing in walkthroughs | Competitive #23 |
| **Medium** | No model escalation for cost optimization | Competitive #24 |
| **Medium** | MajorPhase interfaceContract/dependsOn not in protocol schema | Contract #1, #2 |
| **Medium** | planFile required in protocol but never enforced | Contract #3 |
| **Medium** | No PM memory schema in agent-protocol.md | C1 |
| **Medium** | QA diagnosis format unspecified for Resolver | C4 |
| **Low** | Stderr discarded in agent-runner.js | R4 |
| **Low** | Rollup logic diverges between phase and major phase | R5 |
| **Low** | No illustration web viewer | Wiring #20 |
| **Low** | Walkthrough briefing not supported | Wiring #4, #21 |
| **Low** | `final-review.md` write-only orphan | Wiring #3 |
| **Low** | `reviews.md` and `learnings.txt` self-read only | Wiring #6, #7 |
| **Low** | Code smells (S1-S6) | S1-S6 |
| **Low** | Diagram gaps (D1-D7) | D1-D7 |

## FULLY CONNECTED

- All agent command files dispatch correctly from ship.js
- All 20+ pipeline-cli commands referenced in protocols exist and work
- All memory files referenced in agent startups are created by init.js or at runtime
- All escalation paths implemented: QA exhaustion → PM → exec, design exhaustion → PM → exec, zero-progress → exec, quality gate → exec
- All lib/ scripts referenced in agent protocols exist
- distill-briefing.js covers all 6 main agent types (build, qa, pm, resolve, exec, design) with tailored briefings before dispatch
- Playwright gate infrastructure wired into ship.js and agent protocols
- Autoresearch system (12 benchmarks, 16+ targets) fully scaffolded by init.js
- All imports/exports match across lib/*.js
- All CLI argument formats in prompts match parser
- All skip conditionals correctly paired
- Diagram schema consistent across protocol, CLI, API, and viewer
