# Audit 4 — Resume Recovery, Context Budget, and Prompt Correctness

**Date:** 2026-03-22
**Scope:** Can ship.js recover from every possible mid-iteration crash via `--resume`?

---

## BUGS

### R1. False "all complete" with empty majorPhases
**Severity:** Critical
**File:** `lib/ship.js` lines 1382, 1447-1449

If exec crashes after writing `majorPhases: []` but before populating it, `--resume` declares "All phases complete!" with nothing built. The `!resume` guard on line 1382 prevents re-dispatching exec, and the empty array means no phases are found as incomplete.

**Trace:**
1. readGoals() returns `{ majorPhases: [], vision: undefined }`
2. `needsExecPlanning` is true (empty majorPhases + no vision)
3. `!resume` is false → guard skipped, exec NOT dispatched
4. `!goals` is false → doesn't abort
5. `getAllPhases(goals)` returns `[]` → no phase found
6. Empty major phase check: `majorPhases` is `[]` → no match
7. Line 1447: "All phases complete!" → pipeline exits

**Fix:** Add a `--resume` path for empty strategic structure. After the `!resume` guard, add:
```javascript
if (needsExecPlanning && resume) {
  log('error', 'No strategic structure found. Run without --resume to create project structure.');
  break;
}
```
Or better: allow exec re-dispatch on `--resume` when `majorPhases` is empty — remove `!resume` from the guard for this specific case.

---

### R2. QA round counter inflated on crash
**Severity:** Medium
**File:** `lib/ship.js` line 1591

`qaRoundsCumulative` is incremented BEFORE QA is dispatched. Each `--resume` during a QA crash counts as a QA round even though QA never ran. After 3 crash-resumes during QA, the pipeline prematurely escalates to PM replan.

**Trace:**
1. Phase is `awaiting-qa`, user runs `--resume`
2. Line 1591: `phase.pipeline.qaRoundsCumulative` incremented, written to .goals.json
3. QA agent spawned, ship.js crashes mid-QA
4. User runs `--resume` again → counter incremented again
5. After MAX_QA_ROUNDS resumes → premature escalation

**Fix:** Increment the counter AFTER QA completes, not before dispatch. Move the increment to after `runAgent` returns, or only increment when QA actually produces a verdict.

---

### R3. Exec escalation counter resets on each --resume
**Severity:** Medium
**File:** `lib/ship.js` line 1187

`execEscalationCount` is a process-local variable (let, not persisted). Each `--resume` invocation resets it to 0. The `MAX_EXEC_RESTARTS` safeguard (line 1191) never fires across sessions.

**Trace:**
1. Pipeline stalls → exec escalated → exec fails or crashes
2. `execEscalationCount` was 1 in the process
3. Ship.js crashes or user kills it
4. User runs `--resume` → `execEscalationCount` starts at 0
5. Same failure → escalate again → counter is 1, not 2
6. Cycle repeats unbounded

**Fix:** Persist `execEscalationCount` to `.exec/memory/` or `.goals.json`. Read on startup, increment on escalation, write back. Reset to 0 only when exec succeeds or a new phase starts.

---

### R4. Merge permanently skipped after rollup
**Severity:** Medium
**File:** `lib/ship.js` lines 1703-1715

If `runRollupAll()` marks a phase `completed` (line 1703) but ship.js crashes before `runMerge()` (line 1715), `--resume` skips the phase entirely because `p.status !== 'completed'` filter on line 1413 excludes it. The feature branch code is never merged to main.

**Trace:**
1. Phase enters `case 'complete'`
2. Line 1703: `runRollupAll()` sets `phase.status = 'completed'`
3. Crash before line 1715 (`runMerge`)
4. `--resume`: line 1413 skips all `completed` phases
5. Merge never retried

**Fix:** Before finding the next phase, check if any `completed` phase is on a non-main branch with un-merged commits. Or: move the rollup to AFTER the merge so the phase isn't marked completed until the merge succeeds.

---

## SAFE RECOVERIES

| Scenario | Recovery | Notes |
|----------|----------|-------|
| Exec crash, no .goals.json | Stops cleanly | User re-runs without --resume |
| Exec crash, majorPhases with entries | Recovers | Finds empty major phase, dispatches PM |
| PM crash, no sub-phases yet | Recovers | PM re-dispatched for empty major phase |
| PM crash, partial sub-phases | Mostly recovers | Missing sub-phases PM didn't create are lost |
| Build crash | Recovers | Stale detection resets tasks, builder re-dispatched |
| QA crash, partial results | Recovers | Completed tasks kept, QA re-runs for rest |
| Resolve crash | Recovers | Blocked task stays blocked, resolver re-dispatched |
| Post-clearPhaseForReplan crash | Recovers | Builder re-dispatched (forceResearch flag lost — minor) |

## MINOR ISSUES

### Pipeline state label mismatch after stale reset
After stale detection resets tasks to `not-started`, `phase.pipeline.state` may still say `'building'`. `getPipelineState` returns `'building'` from the explicit state, even though all tasks are `not-started`. Functionally correct (builder is dispatched either way) but misleading in logs.

### forceResearch flag lost on crash
`forceResearch` is process-local. After a RESTART + crash, `--resume` won't force fresh research. PM may reuse stale research. Minor — PM reads exec's lessons from `.exec/memory/decisions.md` regardless.

### Partial PM planning data loss
If PM crashes after creating some sub-phases but before creating others, the missing sub-phases are never created. The pipeline builds what exists and declares victory. This is inherent to the no-transactional-writes design.

---

## CONTEXT BUDGET ANALYSIS

**Date:** 2026-03-22
**Method:** Measured every file loaded into agent context windows. Scaffolded projects at multiple scales (1–500 tasks) with realistic attempt data (4 attempts/task with QA notes). Mapped full read chains from every command template.

### The problem

`.goals.json` grows quadratically — each task adds ~180 tokens empty, ~715 tokens with a typical build→QA→fix→recheck cycle. Every agent is instructed to "Read .goals.json" in its command template, loading the entire file into context regardless of how much is relevant.

### Measured .goals.json sizes

| Project size | Tasks | Empty (tokens) | With 4 attempts/task |
|---|---|---|---|
| 1mp × 1sp × 1t | 1 | ~400 | ~1,200 |
| 1mp × 2sp × 3t | 6 | ~1,200 | ~5,900 |
| 2mp × 3sp × 5t | 30 | ~4,700 | ~23,000 |
| 3mp × 5sp × 5t | 75 | ~11,500 | **~56,000** |
| 5mp × 5sp × 10t | 250 | ~34,000 | **~166,000** |
| 10mp × 5sp × 10t | 500 | ~68,000 | **~332,000** |

### Measured static overhead per agent

| File | Tokens | Loaded by |
|------|--------|-----------|
| CLAUDE.md | 280 | All |
| agent-protocol.md | 3,253 | All |
| project-conventions.md | 113 | PM, Build, QA |
| visual-language.md | 1,500–2,500 | PM, Build, Design |
| ralph-loop.md | 2,165 | QA only |
| design-loop.md | 1,858 | Design only |

Command files vary 17x:

| Agent | Command file | Tokens |
|---|---|---|
| QA | qa.md | 626 |
| Resolver | resolve.md | 722 |
| Builder | build.md | 979 |
| PM:Plan | pm:plan.md | 3,830 |
| **Exec** | **exec.md** | **10,152** |

### Briefing sizes (measured from distill-briefing.js output, 27-task project)

| Agent | Briefing tokens |
|---|---|
| Exec | 122 |
| Design | 122 |
| PM | 245 |
| Build | 345 |
| QA | 457 |

The briefing system works — it distills project state into 122–457 tokens. But agents read `.goals.json` anyway because their command templates say to, making the briefing redundant overhead rather than a replacement.

### Full context load by agent type

**Builder** (lightest):
- Fixed overhead: ~7K tokens (CLAUDE.md + protocol + build.md + visual-language + conventions)
- Briefing: ~345 tokens
- .goals.json: **variable** (full file per build.md line 20)
- Plan file: ~2K–5K
- Memory files (read-only): ~2K–5K
- Source code: ~5K–15K
- **Total: ~16K–32K + .goals.json**

**QA** (broadest reader — qa.md line 14 says "Read .goals.json — ALL phases"):
- Fixed overhead: ~9K tokens (includes ralph-loop.md)
- .goals.json: **full file**
- Plan + memory: ~6K–18K
- **Total: ~15K–27K + .goals.json**

**Exec** (heaviest — 10K command + full state + research):
- Fixed overhead: ~14K tokens (exec.md alone is 10K)
- .goals.json: **full file**
- All memory directories: ~9K–40K
- WebSearch + codebase reads: ~15K–45K
- **Total: ~38K–99K + .goals.json**

### Blowup thresholds (200K context window)

| Tasks | .goals.json | Builder headroom | QA headroom | Exec headroom |
|---|---|---|---|---|
| 30 | ~23K | 145K | 150K | 80–140K |
| 75 | ~56K | 112K | 117K | **47–100K** |
| 150 | ~112K | 56K | 61K | **~0** |
| **250** | **~166K** | **2K** | **7K** | **BLOWN** |

**Exec blows the context window around 150 tasks.** The agent cannot reason — its entire context is consumed by startup reads.

**Builder and QA blow around 250 tasks**, but degrade well before that — an agent with 2K free tokens cannot read source code or write solutions.

Even at 75 tasks (a medium project — 3 major phases × 5 sub-phases × 5 tasks), `.goals.json` with attempt history consumes 56K tokens, or 28% of the context window, before the agent starts working.

---

## CONTEXT BUDGET FIXES

### CB1. Stop telling agents to read full .goals.json
**Severity:** High
**Files:** `template/.claude/commands/build.md:20`, `qa.md:14`, `exec.md`, `pm.md:12`, `pm:plan.md:13`, `walkthrough.md:21`, `design-review.md`

Every command template instructs "Read .goals.json." The briefing system was built to replace this — `distill-briefing.js` extracts exactly what each agent needs into 122–457 tokens. But agents read both, making the briefing additive rather than a substitute.

**Fix:** Change all command templates to: "Read .ship/briefing.md for your project context. Use `node lib/pipeline-cli.js get-task <id>` or `get-phase <id>` for specific lookups. Do NOT read .goals.json directly — it may exceed your context window on large projects."

Builder needs one task. QA needs one phase. Neither needs 250 tasks of history from 10 major phases.

### CB2. Truncate attempt history in .goals.json
**Severity:** High
**File:** `lib/pipeline.js`

Each attempt adds ~715 bytes (~179 tokens). A task with 4 attempts (build → QA fail → fix → QA pass) costs 716 tokens in attempt data alone. At 250 tasks, that's 179K tokens of attempt history — most of it irrelevant (only the latest 1–2 attempts matter to any agent).

**Fix:** Add `archiveAttempts()` to pipeline.js. After a task reaches `completed`, move all but the final QA-success attempt to `.ship/attempt-archive/${taskId}.json`. Keep `.goals.json` lean. The distiller can read the archive when building QA/resolve briefings that need history.

### CB3. Split exec.md (10,152 tokens → two files of ~5K each)
**Severity:** Medium
**File:** `template/.claude/commands/exec.md` (854 lines, 40.6KB)

exec.md is 12x larger than build.md. It covers two completely different modes:
1. Interactive initial planning (vision, phases, research — used once at project start)
2. Automated escalation handling (diagnose, RESTART/CONTINUE — used during failures)

Every exec dispatch loads both, but only uses one.

**Fix:** Split into `exec.md` (initial planning, ~400 lines) and `exec:escalation.md` (failure handling, ~400 lines). ship.js already knows which mode it's dispatching — use the right command.

### CB4. Cap briefing scope to relevant phases only
**Severity:** Medium
**File:** `lib/distill-briefing.js`

PM and exec briefings iterate ALL major phases with task detail. On a 10-major-phase project, the briefing includes completed phases from weeks ago that are irrelevant to current work.

**Fix:** For build/QA/resolve briefings: include only the target phase + phases it `dependsOn`. For PM briefings: include only the target major phase + one-line summaries of others. For exec briefings: include only failing/blocked phases with detail, completed phases as one-line status only.

### CB5. Add context budget pre-flight check to ship.js
**Severity:** Medium
**File:** `lib/ship.js`

No guard exists against dispatching an agent into a blown context window. The agent silently degrades — it reads what it can, forgets early instructions, and produces confused output that wastes a full QA cycle to detect.

**Fix:** Before each `runAgent()` call, estimate context consumption:
```javascript
function estimateContextTokens(agentType, phaseId) {
  const commandSize = fs.statSync(`template/.claude/commands/${agentType}.md`).size / 4;
  const goalsSize = fs.statSync('.goals.json').size / 4;
  const briefingSize = fs.existsSync('.ship/briefing.md')
    ? fs.statSync('.ship/briefing.md').size / 4 : 0;
  const protocolSize = 3253 + 280; // agent-protocol + CLAUDE.md
  const total = commandSize + goalsSize + briefingSize + protocolSize;
  return total;
}
```
If estimated total > 120K tokens (60% of 200K window), log a warning. If > 160K (80%), refuse to dispatch and escalate to exec with context: "Project too large for single-agent context. Consider archiving completed phase attempts or splitting the project."

### CB6. Add --phase flag to pipeline-cli.js for scoped reads
**Severity:** Low
**File:** `lib/pipeline-cli.js`

When agents do need .goals.json data, they currently must read the entire file. A `get-phase --full <phaseId>` command that returns only one phase's data (with tasks and attempts) would let agents get what they need without loading 250 tasks.

**Fix:** Add `get-phase-full <phaseId>` that returns the phase object with its parent major phase context but without sibling phases or other major phases. Agents use this instead of reading the raw file.

---

## PROMPT CORRECTNESS AUDIT

**Date:** 2026-03-22
**Method:** 61 automated tests (prompt-audit.test.js) checking CLI command existence, file references, cross-agent format contracts, contradictions, ownership conflicts, distiller output tags.
**Results:** 56 pass, 5 fail.

### CRITICAL — Features exist in commands but ship.js doesn't dispatch them

Ship.js was externally rewritten during this session. Several features have agent commands, lib tools, and diagrams — but ship.js no longer dispatches them.

### P1. Exec checkpoint never dispatched

exec.md Mode 3 (Phase Checkpoint) exists with 6 steps, `--checkpoint` argument support, and guardrails. Ship.js has no `runExecCheckpoint()` function. The `case 'complete'` goes directly from rollup to next phase with no checkpoint between major phases.

Affected files: exec.md checkpoint mode, exec-checkpoint.mmd diagram, checkpoint guardrails.

### P2. Final review cycle never runs

exec.md Mode 4 (Final Review) exists with 7 steps, `--final-review` argument support. `walkthrough.md`, `lib/screenshot-grid.js`, `lib/link-check.js` all exist. Ship.js `case 'complete'` when all phases are done just sets `pipelineSuccess = true` and stops. None of the 10-step final review runs.

Affected files: exec.md final review mode, walkthrough.md, screenshot-grid.js, link-check.js, final-review.mmd diagram.

### P3. Interactive exec mode never used

`agent-runner.js` has `interactive: true` with `stdio: 'inherit'`. exec.md discover step uses AskUserQuestion. Ship.js dispatches exec with standard `runAgent()` using `-p` mode — exec cannot ask the human questions.

Affected files: agent-runner.js interactive option, exec.md discover step.

### P4. Checkpoint-fixes wiring disconnected

exec.md write-fixes step writes to `.exec/memory/checkpoint-fixes.md`. Ship.js never reads this file. Even if the checkpoint ran (it doesn't per P1), the fix review would be written but never acted on.

### P5. buildFailureSummary not implemented

The concept of synthesizing failure notes from task attempts for PM replan prompts was designed but no `buildFailureSummary()` function exists in ship.js. PM replan prompts use the generic message without specific failure details.

### P6. restartFailureContext not implemented

`runResearch()` accepts a `failureContext` parameter, but no code passes it. After exec RESTART, research runs fresh without knowing what failed. `forceResearch` IS present and working — only the context is missing.

---

### HIGH — Prompt contract issues

### P7. Design review ownership section is structurally ambiguous

Ownership says "READS AND WRITES .pm/memory/concerns.md" and "READS plan files, .goals.json (never modifies)." The cross-writes to PM concerns and QA patterns are correct and documented, but the section structure makes it easy to misread the scope. Test flagged it.

**Fix:** Restructure into explicit "OWNS (read+write)", "CROSS-WRITES (shared)", "READS (read-only)" sections.

### P8. PM ownership declaration not in pm.md

`pm.md` says "You own the structure" but doesn't explicitly declare `.pm/memory/` ownership. That's in `pm-reference.md` line 110. If PM doesn't read pm-reference.md (only reads it "when you need to write to .pm/memory/ files"), the ownership context may be missing.

**Fix:** Add ownership section to pm.md itself.

---

### CONFIRMED WORKING (from prompt audit tests)

**Cross-agent format contracts — all 7 tests pass:**
- QA diagnosis format (root cause, files, criteria) → Resolver reads it correctly
- Builder attempt notes → QA reads via .goals.json
- PM plan success criteria → Builder reads via planFile
- PM Visual Specification (Layout/Hierarchy/Mood) → QA checks against it
- PM Visual Specification → Design Review checks against it
- Exec decisions.md lessons → PM:plan reads on restart
- Exec checkpoint-fixes format is defined (but not wired — see P4)

**No contradictions — all 6 tests pass:**
- Builder: creates branch, doesn't stay on main
- Resolver: ONLY QA diagnosis scope, no exploring
- QA: tree blocking / forest advisory — consistent throughout
- PM:plan: WHAT and WHY, never HOW — no code in templates
- Exec: guardrails prevent creating plans or tasks
- Design: evaluates against spec, not personal taste

**Ownership — 3 of 5 tests pass:**
- .design/memory/ exclusively owned by design-review
- .exec/memory/ owned by exec
- PM concerns.md shared write documented
- (2 minor issues: P7 and P8 above)

**Distiller output — all 4 tests pass:**
- Builder gets vision, target, success-criteria, previous-attempts, visual-language, illustrations
- QA gets visual-language, visual-spec, illustrations, design-state, page-grades
- Design gets previous-findings, page-grades, visual-drift
- Exec gets failing-phase details

**CLI commands — all valid:**
- All pipeline-cli commands referenced in 13 agent prompts exist in the CLI
- 2 false positives from regex (flag values parsed as commands)

---

## COMBINED PRIORITY SUMMARY (all audits)

| Source | Finding | Priority |
|--------|---------|----------|
| audit4 P1 | Exec checkpoint not dispatched | Critical |
| audit4 P2 | Final review not dispatched | Critical |
| audit4 P3 | Interactive exec not used | Critical |
| audit4 P4 | Checkpoint-fixes not wired | Critical |
| audit4 P5 | buildFailureSummary missing | High |
| audit4 P6 | restartFailureContext missing | High |
| audit4 R1 | --resume false "all complete" with empty majorPhases | Critical |
| audit4 R2 | QA round counter inflated on crash | Medium |
| audit4 R3 | Exec escalation counter resets on --resume | Medium |
| audit4 R4 | Merge permanently skipped after rollup | Medium |
| audit4 CB1 | Agents read full .goals.json (context blowup) | High |
| audit4 CB2 | Attempt history unbounded (context blowup) | High |
| audit4 CB3 | exec.md 10K tokens — should split | Medium |
| audit4 CB4 | Briefings include all phases, not just relevant | Medium |
| audit4 CB5 | No context budget pre-flight check | Medium |
| audit4 P7 | Design ownership ambiguous | Low |
| audit4 P8 | PM ownership not in pm.md | Low |
