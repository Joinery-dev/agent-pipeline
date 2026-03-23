# Audit 3 Implementation Plan

98 issues from audit3.md (original #1-36, adversarial #37-95, breaker #96-98). Items already fixed from previous audit rounds marked DONE.

---

## Phase 1: Critical Crashes & Security (do first — these crash or compromise the system)

All independent files. Fix in parallel.

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 37 | `result` ReferenceError crashes parallel builds | `lib/ship.js:~1621` | Move `let result;` declaration before the parallel build check (before the switch). | NEW |
| 38 | `maxAgents` undefined in default case | `lib/ship.js:~2119` | Replace `iteration = maxAgents` with `shouldStop = true` | DONE (B2) |
| 39 | plan-to-tasks stdout contamination — deterministic path always fails | `lib/plan-to-tasks.js` | Change progress `console.log` calls to `console.error` (or suppress), so only final JSON goes to stdout. | NEW |
| 40 | visual-check dev server process leak — `server.pid` never set | `lib/visual-check.js:~551` | Fix: return `{ started, running, proc, pid: proc.pid }` from `ensureDevServer()`. Fix cleanup to use `proc.pid`. Set `detached: true` on spawn if using process group kill. | NEW |
| 41 | Non-atomic .goals.json writes — crash-corruption risk | `lib/pipeline.js:68-69` | Write to temp file then rename: `writeFileSync(path + '.tmp', json); renameSync(path + '.tmp', path);` | NEW |
| 42 | No file locking on .goals.json read-modify-write | `lib/pipeline.js:58-74` | Add advisory file locking (lockfile or `flock`-style). Or: use a lock file `.goals.json.lock` with PID check. | NEW |
| 43 | agent-runner.js — no `proc.on('error')` handler | `lib/agent-runner.js:~70` | Add `proc.on('error', (err) => { resolve({ success: false, output: '', stderr: err.message, ... }); });` | NEW |
| 44 | agent-runner.js — no SIGKILL escalation after SIGTERM | `lib/agent-runner.js:~147` | After SIGTERM, set a 10s timeout. If process still alive, send SIGKILL. | NEW |
| 45 | Interactive mode passes `-p` flag — breaks multi-turn chat | `lib/agent-runner.js:~71` | Remove `-p` flag in interactive mode. Pass command as initial context via stdin or `--resume` with session file. | NEW |
| 46 | Shell injection via branch/tag names in merge.js | `lib/merge.js:250,287` | Replace `execSync(cmd)` string interpolation with `execFileSync('git', [...args])` array form. | NEW |
| 47 | Shell injection in integration-check.js | `lib/integration-check.js:~155` | Replace `execSync(\`grep ...\`)` with `execFileSync('grep', [...args])` array form. Or use Node's `Grep` equivalent (readFileSync + string matching). | NEW |

---

## Phase 2: Critical Pipeline Blockers (pipeline can't run real projects without these)

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 1 | Dev server never starts — visual pipeline silently skipped | `lib/ship.js` | Add `startDevServer()` / `stopDevServer()` helpers. Start before first visual step, keep alive across iterations, kill on exit. Pass port to downstream tools. | NEW |
| 2 | Quality gate blocks on first concern (>= 1) | `lib/ship.js:~1393` | Raise back to `>= 3` | NEW |
| 3 | Visual drift threshold too aggressive (>= 1) | `lib/ship.js:~1419` | Raise back to `>= 2` | NEW |

---

## Phase 3: Infinite Loop & State Corruption Prevention

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 4 | RESTART never clears phase state | `lib/ship.js` | After RESTART: set-pipeline idle, reset task statuses, clear QA attempts. All 4 RESTART paths. | NEW |
| 5 | PM task replacement resets QA counter → infinite loop | `lib/ship.js` | Track QA rounds at phase level (`phase.pipeline.qaRounds`) or increment `replanCount` whenever PM dispatched for failure. | NEW |
| 48 | Phase completion infinite loop when rollupAll fails silently | `lib/ship.js:~1877` | Check return value of `runRollupAll()`. If phase status didn't change to completed, don't enter complete case again. Add seen-phase guard. | NEW |
| 53 | replanCount leaks across phases | `lib/ship.js:~1500` | Reset `replanCount = 0` when moving to a new phase (in the `complete` case or when `phase.id` changes). | NEW |
| 94 | Main loop has no hard iteration cap | `lib/ship.js` | Add MAX_ITERATIONS constant, check in while condition | DONE (R1) |

---

## Phase 4: Schema, Validation & Data Integrity

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 8 | pipeline.lastAgent accepts any string | `lib/pipeline.js` | Validate against agent enum | DONE |
| 9 | MajorPhase fields not validated | `lib/pipeline.js` | Add MajorPhase validation | DONE |
| 10 | Attempt.children contradicts protocol | `lib/pipeline.js` | Remove `children: []` | DONE |
| 11 | MajorPhase contract/dependsOn not in protocol | `agent-protocol.md` | Add as optional fields | DONE |
| 12 | planFile required but not enforced | `agent-protocol.md` | Mark optional | DONE |
| 34/95 | add-attempt crashes on missing attempts array | `lib/pipeline.js` | Guard: `if (!Array.isArray(task.attempts)) task.attempts = [];` | NEW |
| 35 | Pipeline state transitions not validated | `lib/pipeline.js` | Add VALID_PIPELINE_TRANSITIONS map. Add `completed → in-progress` escape hatch. | NEW |
| 52 | Zero-task phase rolls up to completed via vacuous truth | `lib/pipeline.js` | Guard in rollupPhaseStatus | DONE (B4) |
| 67 | parseFlags treats empty string as boolean true | `lib/pipeline-cli.js:~34` | Change: `flags[key] = args[i+1] !== undefined && !args[i+1].startsWith('--') ? args[i+1] : true;` to handle empty strings correctly. | NEW |
| 68 | parseInt("abc") for --order produces NaN | `lib/pipeline-cli.js:~293` | Validate: `const order = parseInt(val); if (isNaN(order)) throw new Error('--order must be a number');` | NEW |
| 69 | addAttempt doesn't auto-update task status | `lib/pipeline.js` | When adding attempt to `not-started` task, auto-transition to `in-progress`. | NEW |
| 70 | add-task to completed phase leaves status inconsistent | `lib/pipeline-cli.js` | When adding task to completed phase, reset phase status to `in-progress`. | NEW |
| 71 | getStaleTasks mutates attempts array via .sort() | `lib/pipeline.js:~487` | Use `[...task.attempts].sort(...)` to avoid mutation. | NEW |
| 76 | rollup-all skips zero-task phases inconsistently | `lib/pipeline-cli.js:~151` | Align with direct rollup behavior. | NEW |
| 86 | Major phase dependsOn never validated | `lib/pipeline.js` | Add majorPhase.dependsOn validation in validateGoals (check refs exist, no self-ref). | NEW |
| 87 | Diagram/illustration IDs not checked for global uniqueness | `lib/pipeline.js` | Add diagram/illustration IDs to `checkId()` calls. | NEW |
| 96 | 1MB CLI arguments cause stack overflow | `lib/pipeline-cli.js` | Add `--notes-file <path>` flag to `update-attempt` that reads notes from file. | NEW |
| 97 | Circular dependencies — no cycle detection | `lib/pipeline.js` | Add cycle detection (topological sort or DFS) to `validateGoals()`. | NEW |
| 98 | Parallel CLI writes cause lost updates — no file locking | `lib/pipeline.js` | Same as #42 — advisory file locking on writeGoals. | NEW (=42) |

---

## Phase 5: Ship.js Orchestration Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 6 | No briefing for initial exec planning | `lib/ship.js:~1544` | Add `runDistiller('exec')` before interactive exec spawn | NEW |
| 7 | Research slug mismatch exec vs runResearch | `lib/ship.js:~333` | Scan `.pm/research/` for recent files, not just exact slug match | NEW |
| 13 | 3 resolve dispatches lack briefings | `lib/ship.js` | Add `runDistiller('resolve')` before each | DONE |
| 14 | Resolve distiller receives title not ID | `lib/ship.js:~1854` | Change `getFailedTasks` to return `{id, title}`, pass `task.id` | NEW |
| 15 | Feature branch never created or enforced | `lib/ship.js` | Create branch before builder dispatch | NEW |
| 22 | Journey planning output parsing fragile | `lib/ship.js` | Agent writes to `.ship/journeys.txt`, ship.js reads file | NEW |
| 25 | runDistiller passes --next for PM/exec | `lib/ship.js` | Don't push `--next` for PM/exec modes | NEW |
| 49 | Failed final review still declares success | `lib/ship.js:~2085` | Check `finalResult.success` before declaring pipeline success | NEW |
| 50 | runPlaywrightTestGate returns passed:true on crash | `lib/ship.js:~318` | Return `{ passed: false, skipped: false, error: true }` on infrastructure failure | NEW |
| 51 | Integration check failures treated as "skipped" | `lib/ship.js:~511` | Parse exit code 1 as real failure, not skipped | NEW |
| 54 | findPhaseByPlan substring match returns wrong phase | `lib/ship.js:~138` | Prefer exact match over substring. Return null on ambiguous matches. | NEW |
| 55 | break vs continue after RESTART in qa-failed | `lib/ship.js:~1834` | Change `break` to `continue` to match other RESTART handlers | NEW |
| 59 | QA told "max 5 rounds" but ship.js escalates after 3 | `qa.md` / `ship-config.json` | Align: either change qa.md to say 3, or change default to 5. | NEW |
| 60 | reconcileTaskStatuses bypasses pipeline-cli.js | `lib/ship.js:~440-705` | Refactor to use pipeline-cli.js commands or pipeline.js functions with validation. | NEW |
| 61 | memory-hygiene exit code 1 discards results | `lib/ship.js:~328` | Parse `err.stdout` in the catch block (hygiene exits 1 on warnings). | NEW |
| 62 | goalsJsonHash uses file length not content hash | `lib/ship.js:~873` | Use a fast hash (string hashCode or first/last 100 chars comparison). | NEW |
| 63 | hasRealProgress is one-directional — misses reverts | `lib/ship.js:~876` | Check for any change (increase OR decrease) in diff size / file count. | NEW |
| 64 | Final review decision parsing reads accumulated file | `lib/ship.js:~2093` | Only parse the LAST section of decisions.md (after last `## ` header). | NEW |
| 65 | Exec escalation context has shell-escaping issues | `lib/ship.js:~1225` | Escape double quotes in briefing string, or write to temp file and pass path. | NEW |
| 66 | topic mutation corrupts research and phase lookup | `lib/ship.js:~1685` | Use separate `currentTopic` variable for research, preserve original `topic`. | NEW |
| 77 | Error swallowing across ship.js critical paths | `lib/ship.js` | At minimum: log caught errors instead of silent discard. Add `logVerbose('error', ...)` in each catch. | NEW |

---

## Phase 6: Briefing & Distiller Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 16 | MajorPhase summary dead read | `lib/distill-briefing.js` | On-the-fly summary fallback | DONE |
| 20 | Build distiller fails when all tasks completed | `lib/distill-briefing.js:~66` | Accept completed tasks as valid, or generate phase-level briefing | NEW |
| 23 | Walkthrough agent type not supported | `lib/distill-briefing.js` | Add type + builder | DONE |
| 72 | extractSuccessCriteria matches wrong section | `lib/distill-briefing.js:~142` | Use exact title match (full line `## Title` not substring) | NEW |
| 84 | No size cap on PM/exec briefings | `lib/distill-briefing.js` | Truncate task details after 30 tasks, summarize remainder | NEW |
| 85 | esc() doesn't strip XML-illegal control characters | `lib/distill-briefing.js:~651` | Strip chars 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F in `esc()` | NEW |

---

## Phase 7: Memory Hygiene & Init Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 17 | Memory hygiene: 9 rules not implemented | `lib/memory-hygiene.js` | All 9 rules | DONE |
| 19 | archiveEntries destroys headers + doubles ## markers | `lib/memory-hygiene.js` | Preserve header before split. Fix `.join('\n')`. Fix no-op ternary. | NEW |
| 26 | checkpoint-fixes.md not scaffolded | `bin/init.js` | Add to exec memory scaffolding | NEW |
| 80 | init.js assumes Next.js project structure | `bin/init.js:~362` | Guard `app/` file copies with framework detection. Skip if not Next.js. | NEW |
| 81 | init.js never updates existing files — no upgrade path | `bin/init.js` | Add `--force` or `--update` flag that overwrites existing lib/ files | NEW |

---

## Phase 8: Agent Protocol Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 45 | Interactive `-p` flag breaks multi-turn (also in Phase 1) | `lib/agent-runner.js` | Remove `-p` in interactive mode | NEW (=Phase 1) |
| 58 | /exec references AskUserQuestion — not a Claude Code tool | `template/.claude/commands/exec.md` | Replace with valid approach (user prompt via stdin, or restructure as non-interactive) | NEW |
| 59 | QA told max 5 but ship.js uses 3 (also Phase 5) | `template/.claude/commands/qa.md` | Align documentation | NEW (=Phase 5) |
| 73 | /resolve doesn't read patterns.md or regressions.md | `template/.claude/commands/resolve.md` | Add to startup reads | NEW |
| 74 | /build sets awaiting-qa even with incomplete tasks | `template/.claude/commands/build.md` | Only set awaiting-qa when all tasks in batch have success attempts | NEW |
| 75 | WebSearch/WebFetch require MCP config not set up | `template/.claude/commands/exec.md`, `pm:research.md` | Document MCP requirement, or add MCP setup to init.js | NEW |
| 92 | pm:plan and pm:research have duplicate step numbering | `template/.claude/commands/pm:plan.md`, `pm:research.md` | Fix step numbers | NEW |

---

## Phase 9: Infrastructure & Tool Fixes

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 21 | Parallel builders share briefing.md — race | `lib/ship.js` | Per-phase briefing files | DONE |
| 56 | Browser process leaks in link-check.js | `lib/link-check.js:~75` | Add `finally { await browser.close() }` + `process.on('SIGTERM', cleanup)` | NEW |
| 57 | link-check.js no process.exit() | `lib/link-check.js:~231` | Add `process.exit(exitCode)` at end | NEW |
| 78 | test-runner.js crashes if tests/ missing | `lib/test-runner.js:52,82,89` | Add `existsSync('tests')` guard before `readdirSync` | NEW |
| 79 | link-check.js content regex false-positives | `lib/link-check.js:~173` | Use more specific regex or skip CSS/JSON file extensions | NEW |
| 82 | Chunk-split JSON in stream-json monitoring | `lib/agent-runner.js:~115` | Buffer partial lines across chunks (split on `\n`, keep incomplete last segment) | NEW |
| 83 | Timeout/exit race reports success as killed | `lib/agent-runner.js:~144` | Check `killed` flag in close handler, don't set if process already exited | NEW |
| 88 | lsof is macOS/Linux only | `lib/link-check.js`, `lib/screenshot-grid.js` | Use `net.createServer().listen().close()` for port detection (cross-platform) | NEW |
| 89 | screenshot-grid file:// URLs break on spaces | `lib/screenshot-grid.js:~133` | Use `pathToFileURL()` from `url` module | NEW |
| 90 | playwright-gate.js operator precedence | `lib/playwright-gate.js:97` | Add `\|\| 0` fallbacks | DONE (B6) |
| 91 | plan-to-tasks.js operator precedence in file filter | `lib/plan-to-tasks.js:~83` | Add parens: `f && (f.includes('.') \|\| f.includes('/'))` | NEW |

---

## Phase 10: Low Priority & Competitive Gaps

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| 18 | update-task/update-phase CLI missing | `lib/pipeline-cli.js` | Commands added | DONE |
| 24 | final-review.md write-only orphan | `exec.md` | Have final review include it | NEW |
| 27 | reviews.md self-read only | — | Intentional | SKIP |
| 28 | learnings.txt self-read only | — | Intentional | SKIP |
| 29 | No illustration web viewer | `app/visualize/page.js` | Add viewer component | NEW |
| 30 | integration-check skips MajorPhase contracts | `lib/integration-check.js` | Extend to majorPhases | DONE |
| 31 | No persistent Playwright test generation | Protocols | QA/Design write specs | DONE |
| 32 | No interactive UI testing in walkthroughs | `walkthrough.md` | Extend with Playwright interaction | NEW |
| 33 | No model escalation for cost optimization | `lib/agent-runner.js`, `lib/ship.js` | Add `--model` flag, Sonnet default for build/resolve | NEW |
| 36 | Unknown fields silently preserved | — | Acceptable | SKIP |
| 93 | writeGoals verification races with concurrent writers | `lib/pipeline.js` | Covered by #42 file locking fix | DONE (=42) |

---

## Tally

| Category | Total | DONE | NEW | SKIP |
|----------|-------|------|-----|------|
| Phase 1: Critical crashes & security | 11 | 1 | 10 | 0 |
| Phase 2: Critical pipeline blockers | 3 | 0 | 3 | 0 |
| Phase 3: Infinite loop prevention | 5 | 1 | 4 | 0 |
| Phase 4: Schema & validation | 20 | 5 | 14 | 1 |
| Phase 5: Ship.js orchestration | 22 | 1 | 21 | 0 |
| Phase 6: Briefing & distiller | 6 | 2 | 4 | 0 |
| Phase 7: Memory hygiene & init | 5 | 1 | 4 | 0 |
| Phase 8: Agent protocols | 7 | 0 | 7 | 0 |
| Phase 9: Infrastructure & tools | 11 | 1 | 10 | 0 |
| Phase 10: Low priority & competitive | 13 | 5 | 5 | 3 |
| **TOTAL** | **98** (+5 dupes) | **17** | **82** | **4** |

---

## Parallelization Map

```
Phase 1 (Crashes/security)     ─┐
Phase 2 (Pipeline blockers)    ─┤
Phase 3 (Infinite loops)       ─┤──→ Phase 5 (Ship.js orchestration — largest, depends on 1-3)
Phase 4 (Schema/validation)    ─┤
Phase 6 (Briefing/distiller)   ─┤
Phase 7 (Memory/init)          ─┤
Phase 8 (Agent protocols)      ─┤
Phase 9 (Infrastructure/tools) ─┘
                                     Phase 10 (Low priority) — do anytime
```

**Phases 1, 2, 3, 4, 6, 7, 8, 9 can all start simultaneously** — they touch mostly different files:
- Phase 1: agent-runner.js, merge.js, plan-to-tasks.js, visual-check.js, pipeline.js (atomic writes)
- Phase 2: ship.js (dev server, quality gate thresholds)
- Phase 3: ship.js (RESTART paths, replan counter, loop guards)
- Phase 4: pipeline.js (validation), pipeline-cli.js (flags, commands)
- Phase 6: distill-briefing.js
- Phase 7: memory-hygiene.js, init.js
- Phase 8: template/.claude/ markdown files
- Phase 9: link-check.js, test-runner.js, screenshot-grid.js, agent-runner.js (buffering)

**Note: Phases 2, 3, and 5 all touch ship.js.** Phases 2+3 touch different functions than Phase 5. Run 2+3 first, then 5.

**Estimated scope:** 82 new fixes across 10 phases. Phases 1-3 are the most critical (crashes, security holes, infinite loops).
