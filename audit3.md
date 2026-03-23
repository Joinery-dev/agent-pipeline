# Audit 3 — Confirmed Bugs and Required Fixes

**Date:** 2026-03-22
**Source:** Dry run simulation, stress tests (80/80 passing), code trace, audit.md, audit2.md

---

## CRITICAL — Pipeline produces half-checked output

### 1. Dev server never starts — entire visual pipeline silently skipped

Ship.js never starts a dev server. Every tool that needs one (visual-check, screenshot-grid, link-check, design review, walkthroughs) checks common ports, finds nothing, and returns `{ skipped: true }`. Because `runVisualCheck` returns skipped, the `!visualResult.skipped` guard at line 1753 is false and **design review never runs**.

**Impact:** On a real project, the product ships without visual QA, design review, screenshot comparison, link checking, walkthrough testing, or mockup comparison. The entire quality pipeline we built is bypassed.

**Where:** ship.js lines 1698 (baseline), 1743 (compare), 1753 (design review gate), checkpoint lines 1283-1318, final review lines 1989-2030.

**Fix:** Add `startDevServer()` / `stopDevServer()` helpers to ship.js. Start before first visual step, keep alive across iterations, kill on pipeline exit. Pass the port to downstream tools.

### 2. Quality gate blocks on first concern (threshold >= 1)

`runQualityGate()` at line 1393 fails when `openConcernMatches.length >= 1`. PM routinely creates OPEN concerns during planning. A single concern halts the pipeline on iteration 2, escalates to exec, exec says CONTINUE, `shouldStop = true`.

**Impact:** Pipeline cannot proceed past one build iteration on any project where PM logs a design concern.

**Where:** ship.js line 1393. Was originally `>= 3`, changed to `>= 1`.

**Fix:** Raise back to `>= 3`, or add age/session filtering.

### 3. Visual drift threshold also too aggressive (>= 1)

`runQualityGate()` at line 1419 fails on `driftingCount >= 1`. Design review routinely logs DRIFTING entries. Combined with #2, even minor design notes halt the pipeline.

**Where:** ship.js line 1419. Was originally `>= 2`.

**Fix:** Raise back to `>= 2` or `>= 3`.

---

## HIGH — Infinite loops and state corruption

### 4. RESTART never clears phase state — just buys 2 more PM replans

When exec returns RESTART, ship.js resets `replanCount = 0` and `forceResearch = true` but nothing clears the phase's pipeline state, task statuses, or QA round history. The phase still has `qaRounds > MAX_QA_ROUNDS`, so on the next iteration PM gets 2 more replans before exec is re-escalated. RESTART means "2 more PM replans then ask exec again", not "wipe the slate."

After `MAX_EXEC_RESTARTS` (3), exec forces CONTINUE → `shouldStop = true`. Total wasted work: 3 × 2 = 6 PM replans, each followed by QA rounds, all on a fundamentally broken phase.

**Where:** ship.js lines 1834, 1763, 1516, 2136. All RESTART paths share this.

**Fix:** After RESTART, reset the phase: `set-pipeline idle`, reset task statuses to `not-started`, clear QA attempts on the phase's tasks.

### 5. PM task replacement resets QA round counter — potential infinite loop

`countQARounds(phase)` counts QA attempts across current tasks. If PM replans and creates new task IDs (replacing old tasks), the new tasks have zero attempts. `qaRounds` returns 0, the `> MAX_QA_ROUNDS` guard never fires, resolver is dispatched instead of escalating. PM replans again, creates new tasks, counter resets again.

Cycle: QA(4) → PM(replan+replace) → QA(4) → PM(replan+replace) → ∞

The `replanCount` variable is never incremented in this path because `qaRounds` never exceeds the threshold after reset.

**Where:** ship.js lines 1830-1873.

**Fix:** Track QA rounds at the phase level (`phase.pipeline.qaRounds`) instead of counting task attempts. Or increment `replanCount` whenever PM is dispatched for any failure.

### 6. No briefing for initial exec planning

`runDistiller` is never called before the interactive exec dispatch at line 1544. Every other agent gets a briefing. On a fresh project this is mostly empty, but on `--resume` or improvement cycles the exec misses accumulated context.

**Where:** ship.js line 1544.

**Fix:** Call `runDistiller('exec')` before the interactive exec spawn.

### 7. Research slug mismatch between exec and runResearch

Exec writes research to `.pm/research/{project-slug}.md`. `runResearch` at line 333 generates slug from the topic string. The slugs differ. Research runs a second time unnecessarily. Exec's brief is orphaned.

**Where:** ship.js line 1585 vs exec.md research step.

**Fix:** `runResearch` should scan `.pm/research/` for any recently created file, not just exact slug match.

---

## MEDIUM — Schema holes confirmed by tests

### 8. pipeline.lastAgent accepts any string (test-confirmed)

`set-pipeline` accepts `--agent banana`. No enum validation. Code that branches on agent type could take wrong paths.

**Test:** `Schema validation gaps > accepts invalid pipeline.lastAgent values` — PASSES, confirming the bug.

**Where:** pipeline-cli.js `set-pipeline` command, pipeline.js `setPipelineState()`.

**Fix:** Validate agent against `['pm', 'build', 'qa', 'resolve', 'design', 'exec', null]`.

### 9. MajorPhase fields not validated at all (test-confirmed)

A MajorPhase with `status: "banana"` passes `validate`. No checks on id, title, status, phases array. The entire entity is skipped by the validator.

Additionally, `validate-plan.js` iterates `goals.phases` directly (line 45), but projects using `majorPhases` have `goals.phases === undefined` → `TypeError` crash. Ship.js catches this at line 274 (`catch { return true; }`) — crashing validator = plan declared valid, all validation silently bypassed.

**Test:** `Schema validation gaps > MajorPhase with invalid status passes validation` — PASSES, confirming the bug.

**Where:** pipeline.js `validateGoals()`, validate-plan.js line 45.

**Fix:** Add MajorPhase validation — check id, title, status enum, phases array. Fix validate-plan.js to use `getAllPhases()` instead of `goals.phases`.

### 10. Attempt.children contradicts flat protocol (test-confirmed)

Every attempt gets `children: []`. Protocol explicitly says "Attempt (flat — NO children/nesting)". The field invites nesting that violates the invariant.

**Test:** `Schema validation gaps > attempt with children array contradicts protocol` — PASSES, confirming the bug.

**Where:** pipeline.js `addAttempt()`.

**Fix:** Remove `children: []` from `addAttempt()`.

### 11. MajorPhase interfaceContract and dependsOn not in protocol schema

CLI and exec.md use these fields on MajorPhase, but agent-protocol.md only defines them on Phase. Agents reading the protocol won't know they exist on MajorPhase.

**Where:** agent-protocol.md MajorPhase schema.

**Fix:** Add `interfaceContract` and `dependsOn` as optional fields on MajorPhase in the protocol.

### 12. planFile required in protocol but never enforced

Protocol shows `planFile` as required on Phase and Task. Validator doesn't check it. CLI only sets it when `--planFile` flag is provided.

**Where:** agent-protocol.md schema vs pipeline.js validator.

**Fix:** Mark as optional in protocol (it effectively is).

### 13. Resolve dispatches in final review lack briefings

Three `/resolve` dispatches have no `runDistiller` call:
- Final test suite failures (line 1943)
- Production build failures (line 1982)
- Checkpoint test failures (line ~1280)

Resolver gets a stale briefing from the previous agent.

**Where:** ship.js lines 1943, 1982, ~1280.

**Fix:** Add `runDistiller('resolve')` before each resolve dispatch.

### 14. Resolve distiller receives task title, not task ID

`runDistiller('resolve', { taskId: taskTitle })` at line 1854 passes a title string where an ID is expected. Works only if `findTask` in pipeline.js supports title-based lookup.

**Where:** ship.js line 1854.

**Fix:** Change `getFailedTasks` to return `{ id, title }` objects, pass `task.id`.

### 15. Feature branch never created or enforced

Builder is told "if on main, create build/<name> branch" but nothing checks. Builder likely stays on main. Merge step at line 1903 skips because `currentBranch === 'main'`. No branch history, no rollback points.

**Where:** ship.js line 1903-1906, build.md startup.

**Fix:** Ship.js creates branch before builder dispatch, or checks after build.

---

## LOW — Won't crash but should fix

### 16. MajorPhase `summary` field is dead read

`distill-briefing.js` reads `mp.summary` in PM, QA, design, and build briefings. No CLI command or agent ever sets it. Every briefing gets `undefined`.

**Where:** distill-briefing.js PM/QA/build briefings.

**Fix:** Add summary population to `rollup-major`, or remove reads.

### 17. Memory hygiene: 9 of 13 rules not implemented

Only 3 archival rules work (decisions 20, reviews 15, learnings 30). 9 rules from ralph-loop.md and design-loop.md are not implemented: regression retirement, pattern merging, trajectory caps, drift archival, staleness audits, concerns archival.

**Where:** lib/memory-hygiene.js.

**Fix:** Implement the 9 missing rules.

### 18. `update-task` and `update-phase` CLI commands missing

pm:plan.md tells agents to update task `files[]` after creation, but the command doesn't exist. Tasks and phases can't be modified after creation through the CLI.

**Where:** pipeline-cli.js.

**Fix:** Add `update-task` and `update-phase` commands.

### 19. archiveEntries destroys file headers AND doubles `## ` markers

In memory-hygiene.js line 66, both branches of the ternary return `e` — it's a no-op. After first archive pass, `decisions.md` loses its `# Architectural Decisions` header.

Additionally, entries split on `/\n(?=## )/` retain `## ` at the start. `.join('\n## ')` inserts another `## ` between them. After one archive: `## ## Decision title`. After two: `## ## ## Decision title`. Markdown structure is permanently corrupted with each hygiene run.

**Where:** memory-hygiene.js lines 50-68.

**Fix:** Detect and preserve the header line before splitting. Use `.join('\n')` instead of `.join('\n## ')` since entries already start with `## `.

### 20. Build distiller fails when all tasks completed

When `runDistiller('build', { phaseId })` is called and all tasks are completed, distill-briefing.js finds no actionable task, exits(1). Builder runs without briefing.

**Where:** distill-briefing.js lines 66-69.

**Fix:** Accept completed tasks as valid targets, or generate phase-level briefing.

### 21. Parallel builders share .ship/briefing.md — race condition

Parallel builders each call `runDistiller` synchronously but write to the same file. Later iterations overwrite earlier briefings before agents read them.

**Where:** ship.js lines 1064-1074.

**Fix:** Write per-phase briefings: `.ship/briefing-${phase.id}.md`.

### 22. Journey planning output parsing fragile

Ship.js parses journey planning agent output by splitting on newlines. Output is stream-json format with JSON event lines. Filter tries to exclude JSON but may fail.

**Where:** ship.js lines 2043-2046.

**Fix:** Agent writes journeys to `.ship/journeys.txt`, ship.js reads the file.

### 23. Walkthrough agent type not supported by distill-briefing.js

Ship.js dispatches `/walkthrough` but distiller doesn't handle `walkthrough` type. Gets stale briefing.

**Where:** distill-briefing.js valid agent types.

**Fix:** Add `walkthrough` type with `buildWalkthroughBriefing()`.

### 24. `.exec/memory/final-review.md` — write-only orphan

Exec writes to it during competitive-check, nothing reads it.

**Where:** exec.md final review competitive-check step.

**Fix:** Have the final review read-reports step include it, or remove the write.

### 25. `runDistiller` passes `--next` for PM/exec modes

Harmless currently (PM mode ignores the flag), but fragile if PM code path changes.

**Where:** ship.js `runDistiller` function.

**Fix:** Don't push `--next` for PM/exec modes.

### 26. checkpoint-fixes.md not scaffolded by init.js

Ship.js checks `existsSync('.exec/memory/checkpoint-fixes.md')`. File only created by exec during checkpoints, not by init.js. Not a break but inconsistent.

**Where:** ship.js line 1361.

**Fix:** Add to init.js or leave as-is (current behavior works).

### 27. `.pm/memory/reviews.md` — self-read only

Written and read only by pm:review. No other agent consumes it.

### 28. `.qa/memory/learnings.txt` — self-read only

Written and read only by QA. No other agent consumes it.

### 29. No illustration web viewer

Illustrations stored in .goals.json but no viewer component in `app/visualize/page.js`. Agents read PNGs directly (works for agents, not humans).

### 30. integration-check.js skips MajorPhase contracts

Only validates sub-phase contracts via `getAllPhases()`. MajorPhase-level `interfaceContract` is never checked.

**Fix:** Extend to iterate `goals.majorPhases[]` and validate their contracts.

---

## COMPETITIVE GAPS (from landscape research)

### 31. No persistent Playwright test generation

QA checks from scratch each round instead of accumulating a test suite. `tests/qa/` and `tests/design/` directories are scaffolded but nothing writes specs to them.

### 32. No interactive UI testing in walkthroughs

Walkthrough agent screenshots pages but can't click buttons, fill forms, or navigate JS-driven UI.

### 33. No model escalation for cost optimization

Every dispatch uses the same model. Simple resolver fixes don't need Opus-level reasoning.

---

## ATTACK TEST FINDINGS (pipeline-attack.test.js — 26 tests)

### 34. add-attempt crashes on task with missing attempts array (test-confirmed)

`pipeline-cli.js add-attempt` throws `Cannot read properties of undefined (reading 'filter')` when targeting a task where the `attempts` field is missing (undefined). This happens when `.goals.json` is hand-edited, corrupted, or created by an older version of the pipeline.

**Test:** `Corrupt and partial state > handles task with attempts: undefined` — CRASHES with unhandled TypeError.

**Where:** pipeline.js `addAttempt()` — reads `task.attempts.filter(...)` without checking if `attempts` exists.

**Fix:** Guard with `if (!Array.isArray(task.attempts)) task.attempts = [];` before accessing.

### 35. Pipeline state transitions not validated + `completed` is terminal (test-confirmed)

`set-pipeline` accepts any state transition. `building → complete`, `idle → qa-failed`, any jump is allowed. Task status has strict transition validation (`not-started → in-progress → completed`), but pipeline state has none.

Additionally, `STATUS_TRANSITIONS['completed'] = []` — no transitions allowed for tasks. If QA later finds a regression in a completed task, there is no API path to reopen it. Requires direct JSON editing, bypassing all validation.

**Test:** `Status transition attacks > pipeline state can be set to any value regardless of current state` — PASSES, confirming no transition validation exists.

**Where:** pipeline-cli.js `set-pipeline` command, pipeline.js line 23.

**Fix:** Add pipeline state transition validation: `idle → building → awaiting-qa → complete` and `* → qa-failed → building`. Add a `completed → in-progress` escape hatch for regression handling.

### 36. Unknown fields in .goals.json are silently preserved

When an external process or corrupt agent adds unknown fields to `.goals.json` (e.g., `_externalHack: true`), the pipeline preserves them through all subsequent read-modify-write cycles. No schema enforcement on read.

**Test:** `Concurrent write safety > external modification between reads is not detected` — PASSES, unknown field preserved.

**Impact:** Low — doesn't break anything, but means the file can accumulate garbage over a long project.

### Confirmed working (good news from attack tests):

- **Command injection safe:** Shell metacharacters (`$(whoami)`, backticks, semicolons, pipes) stored literally as strings, never executed. 4/4 injection tests pass.
- **Large project scales:** 10 major phases, 50 tasks, 20 rapid-fire attempts — all handled correctly. `.goals.json` stays valid JSON. 4/4 stress tests pass.
- **Duplicate IDs caught:** Validator correctly detects and rejects duplicate task IDs in `.goals.json`.
- **Backward transitions blocked:** `completed → in-progress` correctly rejected. `not-started → blocked` correctly rejected. Task status enforcement works.
- **Corrupt state handled gracefully:** Missing majorPhases array, null fields, tasks: null, deeply nested phases, trailing garbage — all handled without unhandled exceptions. 5/6 corruption tests pass (1 real bug found above).
- **Concurrent writes safe:** 10 rapid sequential CLI writes produce valid JSON. Read-modify-write doesn't corrupt the file.
- **Plan file edge cases handled:** Missing plan files and empty plan files don't crash validate-plan or plan-to-tasks.

---

## ADVERSARIAL AUDIT — Codebase Break Attempt (findings #37–#95)

**Date:** 2026-03-22
**Method:** 5 parallel agents attacked every component: pipeline-cli/pipeline.js state machine, ship.js orchestration, agent-runner/distiller/memory-hygiene, init/command templates, and visual/test infrastructure. Deduplicated against #1–#36 above.

---

### CRITICAL — Will crash or corrupt on real code paths

#### 37. `result` ReferenceError crashes parallel builds (ship.js:1621)

Line 1621 assigns `result = await runParallelBuilds(parallelPhases)`, but `result` is declared with `let` on line 1628. In ESM strict mode, `let` is hoisted to the block scope but sits in the temporal dead zone until the declaration. Line 1621 hits the TDZ and throws `ReferenceError`.

**Trigger:** Any run where `findParallelBuildable()` returns 2+ independent phases. Guaranteed crash — parallel builds are completely broken.

#### 38. `maxAgents` undefined — crash in safety-net default case (ship.js:2119)

```js
default: {
  log('error', `Unknown state: ${state}`);
  iteration = maxAgents;  // ← never declared
  break;
}
```

`maxAgents` does not exist anywhere in the file. Throws `ReferenceError`. The safety net for unknown states is itself broken.

#### 39. `plan-to-tasks.js` stdout contamination — deterministic path always fails (plan-to-tasks.js:133+145)

The script writes progress lines to stdout (`console.log('Created: ...')`) before writing the final JSON object. Ship.js at line 1648 does `JSON.parse(taskResult)` on the entire stdout, which contains mixed text+JSON. Parse always fails. Ship.js falls back to the LLM agent every single time. The "fast deterministic" path never works.

#### 40. `visual-check.js` dev server process leak — `server.pid` never set (visual-check.js:551)

Cleanup code checks `if (server.started && server.pid)` but `ensureDevServer()` returns `{ started, running, proc }` — sets `proc`, not `pid`. Condition is always falsy, cleanup **never runs**. Every invocation that starts a dev server leaks it permanently.

Additionally, line 551 tries `process.kill(-server.pid)` (negative PID = process group kill), but line 121 sets `detached: false`. If `pid` were fixed without fixing `detached`, this would kill the calling process's own group.

#### 41. Non-atomic `.goals.json` writes — crash-corruption risk (pipeline.js:68-69)

`writeFileSync` overwrites in place. If the process is killed mid-write (SIGKILL, OOM, power loss), the file contains a mix of new and old bytes — unparseable JSON. Correct pattern: write-to-temp-then-rename.

#### 42. No file locking on `.goals.json` read-modify-write (pipeline.js:58-74)

Multiple agents can concurrently read → mutate → write. Last writer wins, silently overwriting the other's changes. No advisory lock, no optimistic concurrency, no CAS.

**Trigger:** Parallel builds (line 1064-1076) — each builder + its `reconcileTaskStatuses` call races on the same file.

#### 43. `agent-runner.js` — no `proc.on('error')` handler (agent-runner.js:70, 93)

If `claude` is not on PATH, `spawn()` emits an `error` event (ENOENT). No handler exists. Node.js throws an uncaught exception. The promise never resolves — the pipeline crashes.

#### 44. `agent-runner.js` — no SIGKILL escalation after SIGTERM (agent-runner.js:147)

If the spawned process traps/ignores SIGTERM, the `close` event never fires. The promise never resolves. Ship.js hangs permanently. The timeout fires once and is consumed. No SIGKILL follow-up.

#### 45. Interactive mode still passes `-p` flag — breaks multi-turn chat (agent-runner.js:71)

`-p` is "print" (single-prompt) mode — runs the prompt and exits. Combined with `stdio: 'inherit'`, the user sees output but cannot converse. The entire interactive exec planning and final review feature is broken — the agent produces one response and exits.

#### 46. Shell injection via branch/tag names in `merge.js` (merge.js:250, 287)

`run()` uses `execSync(cmd)` with string interpolation. Branch names come from `.goals.json` (agent-written). A title like `Fix "auth"; rm -rf /; echo "` would be executed.

#### 47. Shell injection in `integration-check.js` (integration-check.js:155)

```js
execSync(`grep -rl "${nameMatch[1]}" app/ lib/ 2>/dev/null`, ...)
```

`nameMatch[1]` comes from `interfaceContract.produces[]` in `.goals.json` — arbitrary content.

---

### HIGH — Incorrect behavior on plausible paths

#### 48. Phase completion infinite loop when `rollupAll` fails silently (ship.js:1877-1887)

The `complete` case runs `runRollupAll()` to set `phase.status = 'completed'`. If rollup fails silently (line 531), `phase.status` stays non-completed. Next iteration finds the same phase, `getPipelineState` returns `'complete'` (all tasks done), the `complete` case runs again — repeated merge, exec checkpoint, walkthroughs. Infinite loop.

#### 49. Failed final review still declares success (ship.js:2085-2112)

If `finalResult.success` is false (timeout, Ctrl+C, agent crash), the `if` block is skipped, execution falls through to `"Project complete! Final review passed."` Pipeline reports success and removes rollback checkpoint tags.

#### 50. `runPlaywrightTestGate` returns `passed: true` on infrastructure failure (ship.js:318-320)

If playwright-gate.js crashes and stdout is not valid JSON: `catch { return { passed: true, skipped: true }; }`. Any Playwright infrastructure failure is silently treated as "all tests pass."

#### 51. Integration check failures treated as "skipped" (ship.js:511 + integration-check.js:186)

integration-check.js exits with code 1 on HIGH severity issues. ship.js catches the thrown error and returns `{ skipped: true }`. Real integration failures invisible.

#### 52. Zero-task phase rolls up to `completed` via vacuous truth (pipeline.js:397-416)

`[].every(s => s === 'completed')` returns `true`. A phase with `tasks: []` is immediately marked `completed`, triggering major phase rollup and exec checkpoints for work never done.

#### 53. `replanCount` leaks across phases (ship.js:1500)

Initialized once, only reset after exec RESTART. Phase A uses 1 replan → Phase B inherits `replanCount = 1`, gets `MAX_PM_REPLANS - 1` replans. Later phases get progressively fewer chances.

#### 54. `findPhaseByPlan` substring match returns wrong phase (ship.js:138-159)

`p.title?.toLowerCase().includes(planName.toLowerCase())` — topic "auth" matches "Authentication Flow" and "Author Bio Page". Returns first array-order match. Can dispatch agents against wrong phase.

#### 55. `break` vs `continue` after RESTART in qa-failed path (ship.js:1834)

All other RESTART handlers use `continue` (restart while loop). qa-exhaustion uses `break` (exits switch only). Falls through to progress check, may trigger a second exec escalation in same iteration.

#### 56. Browser process leaks in `link-check.js` on timeout/signal (link-check.js:75-134)

Two browser instances launched. No `process.on('SIGTERM')` or `finally` cleanup. Ship.js 120s timeout kills the process, leaving Chromium orphaned.

#### 57. `link-check.js` — no `process.exit()` at end (link-check.js:231)

No explicit exit. Playwright's open handles can keep Node alive indefinitely. Ship.js 120s timeout is the only exit mechanism.

#### 58. `/exec` references `AskUserQuestion` — not a Claude Code tool (exec.md:51, 744, 790)

Exec template instructs using `AskUserQuestion` in multiple modes. Not a built-in Claude Code tool. In non-interactive escalation mode, cannot work at all. Combined with #45, interactive features are doubly broken.

#### 59. QA told "max 5 rounds" but ship.js escalates after 3 (qa.md:49 vs ship.js:40)

`qa.md` says "Max 5 rounds per plan". `ship-config.json` defaults `maxQARounds: 3`. QA agent plans for 5 rounds but never sees round 4 or 5 — ship.js escalates first.

#### 60. `reconcileTaskStatuses` and `reconcileQAStatuses` bypass pipeline-cli.js (ship.js:440-477, 626-705)

Both read `.goals.json`, mutate tasks directly, write back with `writeFileSync`. Bypasses pipeline-cli.js transition rules, QA gates, schema validation. Protocol says "All .goals.json mutations through lib/pipeline-cli.js" — violated in ≥3 places.

#### 61. `memory-hygiene.js` exit code 1 silently discards all results (memory-hygiene.js:217 vs ship.js:328-340)

memory-hygiene exits code 1 when warnings exist (common). `execFileSync` throws. Ship.js catch discards error. JSON output on `err.stdout`, never parsed. Ship.js never logs hygiene actions.

---

### MEDIUM — Incorrect under edge conditions

#### 62. `goalsJsonHash` uses file length, not content hash (ship.js:873)

If `.goals.json` changes but new content has same byte length (`"in-progress"` → `"not-started"` — both 11 chars), `hasRealProgress` reports no change. False no-progress detection.

#### 63. `hasRealProgress` is one-directional — misses reverts (ship.js:876-883)

Only checks for *increases* in `gitDiffSize` and `untrackedCount`. Reverting bad code or deleting malformed files is counted as "no progress."

#### 64. Final review decision parsing reads accumulated `decisions.md` (ship.js:2093-2101)

Regex scans entire file, takes last match. File accumulates across runs. Old `IMPROVE` could restart pipeline; old `SHIP` could skip current `IMPROVE`.

#### 65. Exec escalation context has shell-escaping issues (ship.js:1225, 1347)

`/exec --escalation "${briefing}"` — if `briefing` contains double quotes (from phase titles like `Build "About" Page`), the string breaks.

#### 66. `topic` mutation corrupts research and phase lookup (ship.js:1685, 1922, 1929)

`topic` reassigned in multiple switch branches. After phase completion, `topic` set to next phase's title. Research may target stale topic.

#### 67. `parseFlags` treats empty string as boolean `true` (pipeline-cli.js:34)

`--name ""` → `"" || true` → `true`. Project name becomes boolean `true`. Passes validation. Serializes as `"name": true`.

#### 68. `parseInt("abc")` for `--order` produces NaN → poisons file (pipeline-cli.js:293)

`parseInt("abc")` → `NaN`. Passes validation. `JSON.stringify(NaN)` → `null`. Next read: `order: null` fails validation. File un-writable until manually fixed.

#### 69. `addAttempt` doesn't auto-update task status (pipeline.js:276-303)

Adding `in-progress` attempt to `not-started` task leaves status as `not-started`. Rollup, stale detection, QA pre-checks all see wrong state.

#### 70. `add-task` to completed phase leaves status inconsistent (pipeline-cli.js:350-371)

Adding `not-started` task to `completed` phase doesn't reset phase status. Phase claims `completed` while containing incomplete work.

#### 71. `getStaleTasks` mutates attempts array in-place via `.sort()` (pipeline.js:487-488)

`.sort()` mutates the original. If `getStaleTasks` is called followed by `writeGoals`, reordered attempts persist. Ordering becomes nondeterministic.

#### 72. `extractSuccessCriteria` matches wrong section on substring titles (distill-briefing.js:142-144)

Title "Authentication" matches `## Authentication` and `## Authentication Overview`. Break condition doesn't fire because both contain the title. Criteria from wrong section collected.

#### 73. `/resolve` doesn't read `.qa/memory/patterns.md` or `regressions.md` (resolve.md:18-26)

Resolver has no context about recurring patterns or known regressions. May apply fixes that have already failed or reintroduce known regressions.

#### 74. `/build` sets `awaiting-qa` even with incomplete tasks (build.md:128-130)

Build template instructs `set-pipeline awaiting-qa` after batch. If builder only completed 3 of 5 tasks, QA runs against incomplete phase.

#### 75. `WebSearch`/`WebFetch` referenced in commands but require MCP config (exec.md, pm:research.md)

Require MCP server configuration that `init.js` does not set up. Agents fail to research and may hallucinate findings.

#### 76. `rollup-all` skips zero-task phases — inconsistent with direct `rollup` (pipeline-cli.js:151-155)

`rollup-all` only rolls up phases where `phase.tasks?.length > 0`. Direct `rollup` on zero-task phase marks it `completed`. Two code paths, different results.

#### 77. Error swallowing across ship.js critical paths

Silent catches: `loadShipConfig` (line 53 — bad config ignored), `runPlanValidator` (line 274 — crash = "plan valid"), `runMemoryHygiene` (line 338 — invisible), `logDecision` (line 548 — decisions lost), `saveExecHistory` (line 1010 — history lost), `cleanupCheckpoints` (line 730 — orphaned tags).

#### 78. `test-runner.js` crashes if `tests/` directory missing (test-runner.js:52, 82, 89)

Three functions call `readdirSync('tests')` without `existsSync` guard. Throws ENOENT.

#### 79. `link-check.js` content regex `\{.*\}` false-positives (link-check.js:173)

Matches any curly braces — flags CSS rules, JSON displays, code snippets as "placeholder text."

#### 80. `init.js` assumes Next.js project structure (bin/init.js:362-376)

Unconditionally copies `app/visualize/page.js`, `app/api/diagrams/route.js`, `app/api/illustrations/route.js` — Next.js App Router files. Causes build errors on non-Next.js projects.

#### 81. `init.js` never updates existing files — no upgrade path (bin/init.js:44-53)

`copyIfMissing` skips existing files. Running init after package upgrade never updates templates. Bugfixes unreachable. No `--force` or `--update` flag.

---

### LOW — Edge cases, cosmetic, minor degradation

#### 82. Chunk-split JSON in stream-json monitoring (agent-runner.js:115-117)

If a stdout chunk splits a JSON line, both halves fail `JSON.parse` silently. `onToolUse` never fired for that event. Monitoring unreliable near chunk boundaries.

#### 83. Timeout/exit race can report successful run as killed (agent-runner.js:144-148, 182)

If process exits naturally at the exact moment timeout fires, `killed` set to `true` before close handler. Reports `killed: true` for successful run.

#### 84. No size cap on PM/exec briefings (distill-briefing.js:246-308)

PM and exec briefings iterate ALL major phases with full task detail. No truncation. Large projects produce briefings that waste context window.

#### 85. `esc()` doesn't strip XML-illegal control characters (distill-briefing.js:651-654)

Null bytes (0x00) and control chars (0x01-0x1F minus allowed) are illegal in XML 1.0. Malformed briefing if `.goals.json` contains them.

#### 86. Major phase `dependsOn` never validated (pipeline.js:164-174)

`validateGoals` checks phase-level `dependsOn` but not `majorPhase.dependsOn`. References to nonexistent IDs pass validation.

#### 87. Diagram/illustration IDs not checked for global uniqueness (pipeline.js:100-131)

`checkId` called for phases and tasks but not diagrams or illustrations. ID collisions possible.

#### 88. `lsof` is macOS/Linux only (link-check.js:52, screenshot-grid.js:82)

Windows users silently fail to detect running dev servers.

#### 89. `screenshot-grid.js` `file://` URLs break on paths with spaces (screenshot-grid.js:133)

Path not URL-encoded. Spaces, `#`, `?`, `%` produce malformed URLs.

#### 90. `playwright-gate.js` operator precedence in `total` calc (playwright-gate.js:97, 124)

`report.stats?.expected + report.stats?.unexpected + report.stats?.skipped || 0` — if any stat undefined, sum is NaN, `NaN || 0` → `0`. Total count wrong but pass/fail unaffected.

#### 91. `plan-to-tasks.js` operator precedence in file filter (plan-to-tasks.js:83)

`f && f.includes('.') || f.includes('/')` — evaluates as `(f && f.includes('.')) || f.includes('/')`. Directory names with `/` but no `.` treated as files.

#### 92. `/pm:plan` and `/pm:research` have duplicate step numbering (pm:plan.md:13-14, pm:research.md:13-15)

Step 5 appears twice in pm:plan. Step 4 appears twice in pm:research. Could confuse LLM agents.

#### 93. `writeGoals` verification races with concurrent writers (pipeline.js:70-74)

Read-back verification after `writeFileSync` can fail spuriously if another process writes between the two calls. Compounds #42.

#### 94. Ship.js main loop has no hard iteration cap (ship.js:1508-2146)

No maximum iteration guard. Bounded only by `consecutiveNoProgress` → exec escalation → `MAX_EXEC_RESTARTS`. But if reconciliation creates git changes that count as "progress" without advancing pipeline state, counters reset and loop runs indefinitely.

#### 95. `add-attempt` crashes on task with missing attempts array (pipeline.js addAttempt)

`task.attempts.filter(...)` without checking if `attempts` exists. Throws TypeError when `.goals.json` hand-edited or corrupted.

*Note: #95 is a restatement of existing audit3 #34 for completeness in this section's numbering.*

---

## SUMMARY

| Priority | Count | Issues |
|----------|-------|--------|
| **Critical** | 3+11 | Original: Dev server (#1), quality gate (#2), drift gate (#3). Adversarial: parallel build crash (#37), maxAgents crash (#38), plan-to-tasks stdout (#39), visual-check leak (#40), non-atomic writes (#41), no file locking (#42), no proc.on error (#43), no SIGKILL (#44), -p flag breaks interactive (#45), shell injection merge.js (#46), shell injection integration-check (#47) |
| **High** | 4+14 | Original: RESTART doesn't clear (#4), infinite replan (#5), no exec briefing (#6), slug mismatch (#7). Adversarial: completion infinite loop (#48), failed review ships (#49), Playwright crash=pass (#50), integration=skipped (#51), vacuous rollup (#52), replanCount leak (#53), wrong phase match (#54), break/continue confusion (#55), browser leak (#56), link-check hang (#57), AskUserQuestion (#58), QA rounds mismatch (#59), reconcile bypasses CLI (#60), hygiene exit code (#61) |
| **Medium** | 9+20 | Original: #8-12, #13-15, #35. Adversarial: #62-81 |
| **Low** | 16+14 | Original: #16-30, #34, #36. Adversarial: #82-94 |
| **Breaker** | 3 | 1MB CLI crash (#96), circular deps deadlock (#97), parallel write race (#98) |
| **Competitive** | 3 | Playwright tests (#31), UI interaction (#32), model escalation (#33) |
| **Total** | **98** | |

---

## BREAKER TEST FINDINGS (pipeline-breaker.test.js — 75 tests, 2026-03-22)

**Method:** 75 adversarial tests across 23 suites targeting every pipeline subsystem. Tests designed to break the system by exercising edge cases, boundary conditions, data corruption, race conditions, lifecycle abuse, and adversarial inputs.

### New Bugs Confirmed

#### 96. CRASH: 1MB CLI arguments cause stack overflow

**File:** `lib/pipeline-cli.js` (any command with large `--notes` values)
**Severity:** HIGH — will crash in real agent runs

When an agent produces verbose output (detailed QA notes, build logs, error traces) and passes it via `--notes` on the CLI, Node.js hits `RangeError: Maximum call stack size exceeded`. The 1MB arg passes through `execFileSync` which internally hits stack limits.

**Impact:** QA agents reviewing large codebases or builders with verbose output will crash the pipeline. This is a realistic scenario — QA notes often contain full file diffs, test output, and diagnostic traces.

**Fix:** Add `--notes-file <path>` flag to `pipeline-cli.js update-attempt` that reads notes from a temp file instead of CLI args. Agents should write long output to a temp file first.

#### 97. Circular dependencies create unbreakable deadlock — no cycle detection

**File:** `lib/pipeline.js:checkDependencies()`, `lib/pipeline.js:validateGoals()`
**Severity:** MEDIUM — will hang the orchestrator

If Phase A depends on Phase B and Phase B depends on Phase A, both report `ready: false` permanently. `validateGoals()` does not detect cycles — only self-references. The orchestrator will loop forever trying to find buildable work, burning tokens until max iterations or human intervention.

**Fix:** Add cycle detection (topological sort or DFS-based) to `validateGoals()`. Flag cycles as validation errors.

#### 98. Parallel CLI writes cause lost updates — no file locking

**File:** `lib/pipeline.js:writeGoals()`
**Severity:** MEDIUM — silent data loss under parallel builds

Test confirmed: launching 3 parallel `update-status` CLI invocations results in only 1 of 3 updates surviving. Each CLI does read → modify → write on `.goals.json` without locking. Last writer wins, silently overwriting others' changes.

**Impact:** In `MAX_BUILD_BATCH=5` parallel build mode, builder status updates will be silently dropped. The reconciliation fallback partially compensates but only for tasks with explicit `files[]` entries.

### Bugs Confirmed as Fixed

#### Bug B5: Agent name validation — FIXED
`set-pipeline --agent evil-agent` now correctly rejects invalid agent names with error: `Invalid agent type: evil-agent. Valid: pm, build, qa, resolve, design, exec`. All 6 valid agent types tested and confirmed working.

#### Bug B4: Empty phase rollup — FIXED
Phases with zero tasks correctly remain `not-started` after rollup. The `Array.every()` on empty array edge case is handled. Major phase cascade also correct — empty sub-phases don't mark major phase as completed.

### Verified Working (75/75 tests pass)

| Area | Tests | Verdict |
|------|-------|---------|
| **Status transitions** | 8 | All illegal transitions rejected. QA gate enforced. |
| **Attempt immutability** | 3 | Finalized attempts can't be modified. Invalid types/outcomes rejected. |
| **Dependencies** | 3 | Self-reference caught. Ghost deps caught. Circular deps create deadlock (bug #97). |
| **Rollup logic** | 4 | Mixed statuses cascade correctly. 500-task project rolls up in ~36s. |
| **Schema validation** | 7 | Corrupt statuses, missing arrays, duplicate IDs caught. MajorPhase status gap confirmed (bug #9). |
| **Pipeline state** | 3 | Invalid states rejected. Agent name validated (B5 fixed). |
| **Concurrent writes** | 3 | Sequential writes safe. Parallel writes lose updates (bug #98). |
| **Stale detection** | 3 | No-attempt tasks flagged. Future dates handled. Completed tasks never stale. |
| **Distiller resilience** | 5 | Large projects, empty state, special chars, missing memory, 100 failed attempts all handled. |
| **Reconciliation** | 2 | Empty attempts handled. qa-recheck counts as QA pass. |
| **Size limits** | 2 | 100KB descriptions work. 1MB notes crash (bug #96). |
| **Plan validator** | 2 | Missing and empty plan files handled gracefully. |
| **Entity lookup** | 5 | Ambiguous, exact, UUID lookups correct. Missing entities fail cleanly. |
| **Diagrams/illustrations** | 4 | Invalid edges, duplicate nodes, missing files, bad regions all rejected. |
| **Round calculation** | 2 | build/build-fix share counting. qa/qa-recheck share counting. |
| **Lifecycle cycling** | 3 | Completed is terminal. blocked/in-progress cycle works. Reset cycle works. |
| **CLI robustness** | 6 | Unknown commands, missing args, empty strings, 100K args, null bytes, path traversal handled. |
| **Idempotency** | 2 | rollup-all and validate are idempotent and non-destructive. |
| **Full lifecycle** | 2 | End-to-end PM→Build→QA→Complete with cross-phase dependencies works. |
| **writeGoals integrity** | 1 | Invalid data blocked at write time. |
| **Memory hygiene** | 2 | Binary data and missing directories handled. |
| **Chaos (50 random ops)** | 1 | Random valid operations don't corrupt state. Schema preserved after chaos. |

### Priority Fixes from Breaker Tests

1. **#96 — 1MB CLI crash** (HIGH): Add `--notes-file` flag. Blocks real agent runs with verbose output.
2. **#97 — Circular dependency deadlock** (MEDIUM): Add cycle detection to `validateGoals()`. Silent hang.
3. **#98 — Parallel write race** (MEDIUM): Add file locking to `writeGoals()`. Data loss under parallel builds.

