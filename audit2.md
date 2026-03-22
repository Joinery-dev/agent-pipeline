# Dry Run Audit — Issues Found

**Date:** 2026-03-22
**Scenario:** `node lib/ship.js "a landing page with 3 sections"` on a fresh scaffolded Next.js project.

---

## CRITICAL

### 1. Dev server lifecycle management — the entire visual pipeline is silently skipped

Every visual step depends on a running dev server: visual-check baseline, visual-check compare, design review, screenshot grid, link check, walkthroughs. Ship.js never starts one. It relies on either the builder having started it (but builder sessions end), the user running it in another terminal, or each agent starting it themselves (not instructed to).

When the dev server isn't running:
- `runVisualCheck` returns `{ skipped: true }`
- `!visualResult.skipped` is false → **design review never runs**
- Screenshot grid skips
- Link check skips
- Walkthrough agent can't take screenshots
- The entire design quality loop is bypassed

**Where it breaks:** ship.js lines 1743-1753 (visual compare), 1753 (design review gate), checkpoint lines 1283-1318, final review lines 1989-2030.

**Fix:** Ship.js should manage a dev server process:
- Start `npm run dev` (or detected equivalent) before the first visual step
- Keep the process alive across iterations
- Kill it on pipeline exit
- Pass the port to visual-check.js, screenshot-grid.js, link-check.js
- Add a `startDevServer()` / `stopDevServer()` helper pair
- Alternatively, have visual-check.js start/stop its own server (it already has port detection)

---

## HIGH

### 2. Quality gate threshold too aggressive — blocks on first concern

`runQualityGate()` at line 1393 triggers when `openConcernMatches.length >= 1`. A single OPEN concern in `.pm/memory/concerns.md` — which PM routinely creates during planning — would cause the quality gate to fail on iteration 2, escalating to exec.

The original threshold was `>= 3`. It was changed to `>= 1` at some point, making the pipeline unable to proceed past a single logged concern.

**Where it breaks:** ship.js line 1393. On iteration 2, if PM wrote any concern during planning, quality gate fails → exec escalation → likely CONTINUE → `shouldStop = true` → pipeline halts after one build.

**Fix:** Raise threshold back to `>= 3`, or add an age/session check so fresh concerns don't trigger the gate.

### 3. No briefing generated for initial exec planning

`runDistiller` is never called before the interactive exec dispatch at line 1544. Every other agent gets a briefing — exec's initial planning session does not.

Exec's startup says "Read .ship/briefing.md if it exists" — the "if it exists" prevents a crash, but exec misses the distilled project context. On a fresh project this is mostly empty anyway, but on a `--resume` or improvement cycle it would matter.

**Where it breaks:** ship.js line 1544 — `spawnAgent('/exec ...')` with no prior `runDistiller('exec')`.

**Fix:** Add `runDistiller('exec')` before the interactive exec spawn. Even on a fresh project, it provides the skeleton `.goals.json` context.

### 4. Research slug mismatch between exec and runResearch

Exec writes research to `.pm/research/{project-slug}.md` (e.g., `landing-page-coffee-shop.md`). But `runResearch` at line 333 generates slug from the topic string: `topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')`. For topic `"a landing page with 3 sections"` this produces `a-landing-page-with-3-sections.md`.

The slugs don't match. Research runs a second time unnecessarily. The exec's brief is orphaned — PM may or may not find it depending on whether it scans the directory.

**Where it breaks:** ship.js line 1585 — `runResearch(planTopic)` doesn't find exec's brief, runs `/pm:research` again.

**Fix options:**
- `runResearch` should scan `.pm/research/` for any recently created `.md` file (within last 30 min) and skip if found
- Or exec should use the same slug logic as `runResearch`
- Or `runResearch` should check all files in `.pm/research/`, not just exact slug match

---

## MEDIUM

### 5. Visual drift threshold too aggressive

`runQualityGate()` at line 1419 triggers on `driftingCount >= 1`. A single DRIFTING entry in `.design/memory/visual-drift.md` — which design review routinely creates — would fail the quality gate. Combined with issue #2, even minor design notes could halt the pipeline.

**Fix:** Raise to `>= 2` (matching the original) or `>= 3`.

### 6. Resolve dispatches in final review lack briefings

Three `/resolve` dispatches in the final review cycle have no `runDistiller` call:
- Final test suite failures (line 1943)
- Production build failures (line 1982)

The resolver gets a stale briefing from the previous agent's dispatch instead of one targeted at the resolve task.

**Where it breaks:** ship.js lines 1943, 1982.

**Fix:** Add `runDistiller('resolve')` before each resolve dispatch. Or call it with the specific failure context.

### 7. Builder may not create feature branch

Builder is instructed "if on main, create build/<name> branch" but nothing enforces this. In the dry run, builder likely stays on main. The merge step at line 1903 checks `currentBranch !== 'main'` and skips if on main — so no merge happens, no branch history, no rollback points.

**Where it breaks:** ship.js line 1903-1906 — merge skips because builder stayed on main.

**Fix options:**
- Ship.js creates the branch before dispatching builder: `git checkout -b build/<phase-slug>`
- Or ship.js checks after build and warns if still on main
- Or add a pre-build gate that verifies branch was created

### 8. `runDistiller('pm')` passes `--next` which finds a task, not project-wide context

When PM is dispatched for project-wide work (replan, status), `runDistiller('pm')` is called with no options. The function pushes `--next`, which in distill-briefing.js tries to find the next actionable task. For PM mode, the code skips the task requirement (`!['pm', 'exec'].includes(agentType)`), so `--next` is ignored. But the `--next` flag is misleading and could cause issues if the PM code path changes.

**Where it breaks:** Not currently broken — PM mode ignores the flag. But fragile.

**Fix:** `runDistiller` should not push `--next` for PM/exec modes. Add: `if (!['pm', 'exec'].includes(agentType)) args.push('--next');`

---

## LOW

### 9. Walkthrough agent journey planning output parsing is fragile

At line 2043-2046, ship.js parses the journey planning agent's output by splitting on newlines and filtering by length. The agent's output is stream-json format, so `result.output` contains JSON event lines, not plain text. The filter `!l.startsWith('{') && !l.startsWith('[')` tries to exclude JSON, but the actual journey text may be embedded inside JSON event objects.

**Where it breaks:** Lines 2043-2046 — parsing may fail to extract journeys, falling back to defaults.

**Fix:** The journey planning agent should write journeys to a file (`.ship/journeys.txt`) instead of relying on stdout parsing. Ship.js reads the file.

### 10. `checkpoint-fixes.md` not created by init.js

Ship.js checks `existsSync('.exec/memory/checkpoint-fixes.md')` at line 1361. This file is only created by exec during checkpoints — it's not scaffolded by init.js. Not a break (existsSync returns false, skips), but inconsistent with other memory files that are pre-created.

**Fix:** Either add to init.js scaffolding, or leave as-is (current behavior is correct).

---

## ERROR PATH TRACE (ship.js failure scenarios)

### 11. RESTART never actually clears phase state — just buys 2 more PM replans

**Severity:** HIGH

When exec returns `RESTART` from any escalation (qa-exhaustion, design-exhaustion, quality-gate, zero-progress), the code resets `replanCount = 0` and sets `forceResearch = true`, but **nothing clears the phase's pipeline state, task statuses, or QA round history**.

**Trace (qa-exhaustion at line 1834):**
1. `qaRounds > MAX_QA_ROUNDS` (e.g. 4 > 3) and `replanCount >= MAX_PM_REPLANS` (2 >= 2) → exec escalated
2. Exec returns `RESTART` → `replanCount = 0`, `forceResearch = true`, `break` out of switch
3. Next iteration: same phase, same state `qa-failed`, same `qaRounds` (still 4 > 3)
4. `replanCount` is 0 < MAX_PM_REPLANS → PM replans (replanCount → 1)
5. QA fails again → PM replans again (replanCount → 2)
6. `replanCount >= MAX_PM_REPLANS` → exec re-escalated
7. If exec says RESTART again, cycle repeats until `execEscalationCount > MAX_EXEC_RESTARTS` (3) at line 1213, which forces `CONTINUE` → `shouldStop = true`

RESTART effectively means "2 more PM replans then ask exec again", not "wipe the slate and start over." The phase retains all QA attempt history, blocked task statuses, and failed pipeline state.

**Where it breaks:** ship.js lines 1834 (qa-exhaustion), 1763 (design-exhaustion), 1516 (quality-gate), 2136 (zero-progress). All RESTART paths share the same non-clearing behavior.

**Fix:** After exec RESTART, ship.js should:
1. Reset the phase pipeline state to `needs-plan`: `execFileSync('node', [PIPELINE_CLI, 'set-pipeline', phase.id, 'idle', '--agent', 'exec'])`
2. Reset all task statuses in the phase to `not-started` or remove them entirely
3. Clear QA memory files for the phase (`.qa/memory/status.json`)
4. Then PM gets a truly clean slate for replanning

### 12. PM task replacement resets qaRounds counter — potential infinite loop

**Severity:** HIGH

`countQARounds(phase)` at line 199 counts QA attempts across the phase's current tasks. If PM's replan replaces tasks (creates new task IDs via `pipeline-cli add-task` + removes old ones), the new tasks have zero attempts. `qaRounds` returns 0 → the `qaRounds > MAX_QA_ROUNDS` guard at line 1830 is never true → resolver is dispatched instead of escalating to PM/exec.

**Trace:**
1. QA fails 4 times → `qaRounds` = 4 > MAX_QA_ROUNDS (3)
2. PM replans, deletes old tasks, creates new tasks with fresh IDs
3. Next iteration: `countQARounds` scans new tasks → 0 QA attempts → `qaRounds` = 0
4. 0 ≤ 3 → enters resolver path (line 1851), not PM/exec escalation
5. QA fails again, `qaRounds` slowly climbs 1, 2, 3...
6. After 4 more failures → PM replans again → tasks replaced again → counter resets to 0
7. **Infinite cycle**: QA(4) → PM(replan+replace) → QA(4) → PM(replan+replace) → ...

The `replanCount` variable is never incremented in this path because `qaRounds` never exceeds `MAX_QA_ROUNDS` after the reset. Exec escalation is unreachable.

**Where it breaks:** ship.js lines 1830-1873. The escalation ladder assumes QA round counts survive PM replans.

**Fix options:**
- Track QA rounds at the **phase** level (e.g., `phase.pipeline.qaRounds`) instead of counting task attempts
- Or track cumulative replan count independently of `qaRounds`: increment `replanCount` whenever PM is dispatched for failure, regardless of which code path triggered it
- Or `countQARounds` should also check archived/removed tasks

### 13. `archiveEntries` destroys file headers — no-op ternary on line 66

**Severity:** LOW

In `memory-hygiene.js` line 66:
```js
writeFileSync(filePath, toKeep.map((e, i) => (i === 0 && !e.startsWith('## ') ? e : e)).join('\n## '));
```

Both branches of the ternary return `e` — it's a no-op. The original intent was likely to preserve the file's `# Title` header (e.g., `# Architectural Decisions`). After the first archive pass:
1. Content is split on `/\n(?=## )/` — the header `# Architectural Decisions\n\n` becomes `entries[0]`
2. Entries are sliced: `toKeep = entries.slice(entries.length - 20)`
3. The header is in `toArchive` (it's the first entry), not in `toKeep`
4. File is rewritten without the header

After the first archive, `decisions.md` starts with a `## ` entry instead of `# Architectural Decisions`. Subsequent splits still work (they split on `## `), but the file loses its structural header permanently.

**Where it breaks:** memory-hygiene.js line 50-68, affecting `.pm/memory/decisions.md`, `.pm/memory/reviews.md`, `.qa/memory/learnings.txt`.

**Fix:** Detect and preserve the header line before splitting:
```js
const headerMatch = content.match(/^# .+\n/);
const header = headerMatch ? headerMatch[0] : '';
// ... archive logic ...
writeFileSync(filePath, header + toKeep.join('\n## '));
```

### 14. Resolve agent distiller receives task title instead of task ID

**Severity:** LOW

At ship.js line 1854:
```js
runDistiller('resolve', { taskId: taskTitle });
```

`taskTitle` comes from `getFailedTasks(phase)` (line 1799) which returns `task.title` strings, not `task.id` values. Inside `distill-briefing.js`, `findTask(goals, taskQuery)` at line 59 receives this title string. Whether this works depends on `findTask`'s implementation in `pipeline.js` — if it matches by substring against both `id` and `title`, it works. If it requires exact ID match, the distiller exits(1) and the resolve agent runs without a briefing.

**Where it breaks:** ship.js line 1854 → distill-briefing.js line 59.

**Fix:** Either:
- Change `getFailedTasks` to return `{ id, title }` objects, and pass `task.id` to `runDistiller`
- Or confirm `findTask` supports title-based lookup (and document this dependency)

### 15. Build agent distiller fails when all tasks are completed

**Severity:** LOW

When `runDistiller('build', { phaseId })` is called and all tasks in the phase have status `completed`, `distill-briefing.js` line 67-69 finds no actionable task:
```js
targetTask = targetPhase.tasks.find(t => t.status === 'not-started')
  || targetPhase.tasks.find(t => t.status === 'in-progress');
if (!targetTask) { console.error(...); process.exit(1); }
```

This happens in the `building` state (line 1714) after reconciliation has already marked all tasks as in-progress/completed. The distiller exits(1), caught by `runDistiller`'s try/catch — the builder runs without a briefing.

**Where it breaks:** ship.js lines 1688, 1714 → distill-briefing.js lines 66-69.

**Fix:** In the build agent path of `distill-briefing.js`, also consider `completed` tasks as valid targets (they may still need work in a re-build scenario), or skip the exit and generate a phase-level briefing without a target task.

### 16. Parallel builders share `.ship/briefing.md` — race condition

**Severity:** LOW

At ship.js line 1064, parallel builders each call `runDistiller('build', { phaseId: phase.id })` synchronously before their async `runAgent`. Because `runDistiller` is sync and writes to the same `.ship/briefing.md`, later iterations overwrite earlier briefings before agents read them. Acknowledged in the comment at line 1059-1063 but still a functional defect.

**Where it breaks:** ship.js lines 1064-1074.

**Fix:** Write per-phase briefings: `.ship/briefing-${phase.id}.md`. Pass the path to the agent via the prompt or an env var.

---

## PRIORITY SUMMARY

| Priority | Issue | # |
|----------|-------|---|
| **Critical** | Dev server lifecycle — entire visual pipeline silently skipped | 1 |
| **High** | Quality gate threshold too aggressive (>= 1 concern) | 2 |
| **High** | No briefing for initial exec | 3 |
| **High** | Research slug mismatch between exec and runResearch | 4 |
| **High** | RESTART never clears phase state — just buys 2 more PM replans | 11 |
| **High** | PM task replacement resets qaRounds — potential infinite loop | 12 |
| **Medium** | Visual drift threshold too aggressive | 5 |
| **Medium** | Final review resolve dispatches lack briefings | 6 |
| **Medium** | Builder may not create feature branch | 7 |
| **Medium** | runDistiller passes --next for PM/exec modes | 8 |
| **Low** | Journey planning output parsing fragile | 9 |
| **Low** | checkpoint-fixes.md not scaffolded | 10 |
| **Low** | archiveEntries destroys file headers (no-op ternary) | 13 |
| **Low** | Resolve distiller receives task title, not task ID | 14 |
| **Low** | Build distiller fails when all tasks completed | 15 |
| **Low** | Parallel builders share briefing.md — race condition | 16 |

---

## CONTRACT SMOKE TEST — Required Changes

Cross-referenced agent-protocol.md schema ↔ pipeline.js validateGoals() ↔ pipeline-cli.js.

### High (logical bugs)

- [ ] **CT-1.** `lib/pipeline.js` `addAttempt()` — Remove `children: []` from attempt creation. Protocol says "flat — NO children/nesting." Field invites nesting that violates invariant.
- [ ] **CT-2.** `lib/pipeline.js` `validateGoals()` — Add MajorPhase validation: check `id` (string), `title` (string), `status` (against VALID_STATUSES enum), `phases` (array), `order` (number). Currently the entire MajorPhase entity escapes validation.
- [ ] **CT-3.** `lib/pipeline.js` `setPipelineState()` — Add `lastAgent` enum validation. Accept only `pm`, `build`, `qa`, `resolve`, `design`, `exec`, or `null`. Currently accepts any string.

### Medium (contract drift)

- [ ] **CT-4.** `template/.claude/agent-protocol.md` MajorPhase schema — Add `interfaceContract: { produces: string[], consumes: string[] }` and `dependsOn: string[]` as optional fields. CLI and exec.md already use them but the schema doesn't document them.
- [ ] **CT-5.** `template/.claude/agent-protocol.md` Phase + Task schema — Mark `planFile` as optional (add `(optional)` marker). It's effectively optional: CLI doesn't require it, validator doesn't check it. Protocol currently shows it as required.
- [ ] **CT-6.** `template/.claude/agent-protocol.md` — Add `Pipeline.lastAgent` valid values to include `exec` and `design` (currently only lists `pm | build | qa | resolve | null`).

### Low (cosmetic)

- [ ] **CT-7.** `template/.claude/agent-protocol.md` — Add `(optional)` to `Project.description` and `Project.vision`. Validator doesn't check them; CLI only sets them when flags provided.
- [ ] **CT-8.** `lib/pipeline.js` `validateGoals()` — Add Phase.pipeline sub-object validation (check `state` against VALID_PIPELINE_STATES if present).
- [ ] **CT-9.** `template/.claude/agent-protocol.md` Illustration schema — Either add Task to the list of entities that can hold illustrations ("optional on Project, MajorPhase, Phase, Task") or block task-level illustrations in `findEntityById`.
- [ ] **CT-10.** `lib/pipeline-cli.js` / `lib/pipeline.js` — Add basic DiagramNode validation: check `id` (string) and `position` (object with x, y numbers) exist on each node. Currently only checks array existence.

