# Audit 3 Implementation Plan

All fixes from audit3.md organized into parallel phases. Many items overlap with audit.md fixes already applied — those are marked as DONE.

---

## Phase 1: Critical Pipeline Blockers (do first — pipeline can't run real projects without these)

These are the showstoppers. Fix in parallel.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 1 | Dev server never starts — visual pipeline silently skipped | `lib/ship.js` | Add `startDevServer()` / `stopDevServer()` helpers. Start before first visual step, keep alive across iterations, kill on exit. Pass port to downstream tools. | NEW |
| 2 | Quality gate blocks on first concern (threshold >= 1) | `lib/ship.js:~1393` | Raise `openConcernMatches.length >= 1` back to `>= 3` | NEW |
| 3 | Visual drift threshold too aggressive (>= 1) | `lib/ship.js:~1419` | Raise `driftingCount >= 1` back to `>= 2` | NEW |

---

## Phase 2: Infinite Loop Prevention (critical for unattended runs)

Independent of Phase 1. Fix in parallel.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 4 | RESTART never clears phase state | `lib/ship.js` | After RESTART: `set-pipeline idle`, reset task statuses to `not-started`, clear QA attempts on phase tasks. Do this at all 4 RESTART paths (lines ~1834, 1763, 1516, 2136). | NEW |
| 5 | PM task replacement resets QA counter → infinite loop | `lib/ship.js` | Track QA rounds at phase level (`phase.pipeline.qaRounds`) instead of counting task attempts. Increment in ship.js when dispatching QA, check against MAX. Or: increment `replanCount` whenever PM is dispatched for any failure, regardless of qaRounds. | NEW |
| 34 | add-attempt crashes on missing attempts array | `lib/pipeline.js` | Guard: `if (!Array.isArray(task.attempts)) task.attempts = [];` at top of `addAttempt()` | NEW |

---

## Phase 3: Schema & Validation (already partially done from audit.md)

Check which are done, fix the rest.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 8 | pipeline.lastAgent accepts any string | `lib/pipeline.js` | Validate against agent enum in `setPipelineState()` | DONE (Phase 2+3) |
| 9 | MajorPhase fields not validated | `lib/pipeline.js` | Add MajorPhase validation block in `validateGoals()` | DONE (Phase 2+3) |
| 10 | Attempt.children contradicts protocol | `lib/pipeline.js` | Remove `children: []` from `addAttempt()` | DONE (Phase 2+3) |
| 11 | MajorPhase interfaceContract/dependsOn not in protocol | `template/.claude/agent-protocol.md` | Add as optional fields on MajorPhase schema | DONE (Phase 4) |
| 12 | planFile required but not enforced | `template/.claude/agent-protocol.md` | Mark as optional | DONE (Phase 4) |
| 35 | Pipeline state transitions not validated | `lib/pipeline.js` | Add pipeline state transition validation map (like task STATUS_TRANSITIONS). Add `completed → in-progress` escape hatch. | NEW |
| 36 | Unknown fields silently preserved | Decision | Document as acceptable (schema-on-write via `validateGoals()` already catches structural issues; unknown fields are harmless) | SKIP |

---

## Phase 4: Briefing & Distiller Fixes

Independent of Phases 1-2. Fix in parallel.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 6 | No briefing for initial exec planning | `lib/ship.js:~1544` | Add `runDistiller('exec')` before interactive exec spawn | NEW |
| 13 | 3 resolve dispatches lack briefings | `lib/ship.js` | Add `runDistiller('resolve')` before each | DONE (Phase 6) |
| 14 | Resolve distiller receives title not ID | `lib/ship.js:~1854` | Change `getFailedTasks` to return `{ id, title }` objects, pass `task.id` to distiller | NEW |
| 16 | MajorPhase summary is dead read | `lib/distill-briefing.js` | Add on-the-fly summary generation fallback | DONE (Phase 2+3) |
| 20 | Build distiller fails when all tasks completed | `lib/distill-briefing.js` | Accept completed tasks as valid targets, or generate phase-level briefing when no actionable task | NEW |
| 23 | Walkthrough agent type not supported | `lib/distill-briefing.js` | Add `walkthrough` type + `buildWalkthroughBriefing()` | DONE (Phase 6) |
| 25 | runDistiller passes --next for PM/exec modes | `lib/ship.js` | Don't push `--next` for PM/exec modes | NEW |

---

## Phase 5: Research & Slug Fixes

Small, independent.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 7 | Research slug mismatch exec vs runResearch | `lib/ship.js` | `runResearch` should scan `.pm/research/` for any recently created file (last 5 min), not just exact slug match. Or normalize slugging between exec and ship.js. | NEW |
| 22 | Journey planning output parsing fragile | `lib/ship.js` | Agent writes journeys to `.ship/journeys.txt`, ship.js reads the file instead of parsing stream-json output. | NEW |

---

## Phase 6: Memory & Hygiene Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 17 | Memory hygiene: 9 rules not implemented | `lib/memory-hygiene.js` | Implement all 9 | DONE (Phase 5) |
| 19 | archiveEntries destroys headers + doubles ## markers | `lib/memory-hygiene.js` | Preserve header before splitting. Use `.join('\n')` since entries already start with `## `. Fix the no-op ternary (line 66). | NEW |

---

## Phase 7: Branch & Infrastructure

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 15 | Feature branch never created or enforced | `lib/ship.js` | Ship.js creates `build/<phase-slug>` branch before builder dispatch. Check `git rev-parse --abbrev-ref HEAD` and create if on main. | NEW |
| 21 | Parallel builders share briefing.md — race | `lib/ship.js` | Write per-phase briefings `.ship/briefing-${phase.id}.md` | DONE (Phase 6) |
| 26 | checkpoint-fixes.md not scaffolded | `bin/init.js` | Add to init.js exec memory scaffolding | NEW |

---

## Phase 8: Low Priority & Competitive Gaps (do when convenient)

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 18 | update-task/update-phase CLI missing | `lib/pipeline-cli.js` | Add commands | DONE (Phase 2+3) |
| 24 | final-review.md write-only orphan | `template/.claude/commands/exec.md` | Have final review read-reports step include it | NEW |
| 27 | reviews.md self-read only | — | Document as intentional (PM's private review history) | SKIP |
| 28 | learnings.txt self-read only | — | Document as intentional (QA's private discoveries) | SKIP |
| 29 | No illustration web viewer | `app/visualize/page.js` | Add illustration viewer component | NEW |
| 30 | integration-check skips MajorPhase contracts | `lib/integration-check.js` | Extend to iterate majorPhases | DONE (Phase 2+3) |
| 31 | No persistent Playwright test generation | Protocols | QA/Design write spec tests | DONE (Playwright loop) |
| 32 | No interactive UI testing in walkthroughs | `template/.claude/commands/walkthrough.md` | Extend to use Playwright for interaction | NEW |
| 33 | No model escalation | `lib/agent-runner.js`, `lib/ship.js` | Add `--model` flag to spawnAgent, use Sonnet for build/resolve, Opus for exec/QA | NEW |

---

## Summary: What's NEW vs DONE

**Already fixed from previous audit rounds:** 15 items (8, 9, 10, 11, 12, 13, 16, 17, 18, 21, 23, 30, 31 + partial 35)

**New fixes needed:** 21 items

**Skipped:** 3 items (27, 28, 36 — acceptable as-is)

---

## Parallelization Map

```
Phase 1 (Critical blockers)     ─┐
Phase 2 (Infinite loop fixes)   ─┤──→ Phase 7 (Branch/infra)
Phase 4 (Briefing/distiller)    ─┤
Phase 5 (Research/slug)         ─┘
                                     Phase 3 (Schema) — mostly DONE, just #35
                                     Phase 6 (Memory) — #19 only
                                     Phase 8 (Low priority) — do anytime
```

**Phases 1, 2, 4, 5 can all start simultaneously** — they touch different parts of ship.js (different functions/line ranges) or different files entirely.

Phase 3 has only 1 new item (#35 — pipeline state transitions). Phase 6 has only 1 new item (#19 — archiveEntries header bug). Both are quick.

Phase 7 depends on Phase 1 (dev server must exist before branch enforcement matters). Phase 8 is lowest priority.

**Estimated scope:** 21 new fixes across 7 phases. Phases 1-2 are the most impactful (pipeline literally can't run real projects without them).
