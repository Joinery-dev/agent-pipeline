# The Ralph Loop — QA Execution Protocol

Each invocation is a **fresh agent**. Context comes from memory files only.

```
Round N (fresh agent):

  1. READ       — memory + plan + ALL of .goals.json + PM context + git
  2. EXTRACT    — success criteria from plan + vision criteria from goals
  3. CHECK      — machine-verifiable first, then AI evaluation
  4. FOREST     — does this work fit the broader project vision?
  5. DIAGNOSE   — root cause analysis for failures (tree + forest)
  6. REPORT     — binary verdict per criterion, per task, overall
  7. PERSIST    — update .qa/memory/ AND .goals.json
  8. EXIT       — report verdict and next actions
```

---

## Step 1: READ

Read all memory files. Compare against `status.json`. Identify changes
since last run. Read plan success criteria. Read PM concerns — failures
related to concerns get elevated severity.

## Step 2: EXTRACT

Pull success criteria from the plan. Map each criterion to a specific
task in `.goals.json` (via the phase's `planFile` link). These become
`criteria` entries in `status.json` with `taskTitle` set.

Also add:
- Active entries from `regressions.md`
- PM concerns with testable implications
- Basic health checks (tests pass, no regressions)
- **Vision criteria** (see "The Forest Check" below) — these are not
  from the plan but from the broader project context

## Step 3: CHECK

Run machine-verifiable checks FIRST. Always. Before any AI evaluation.

Priority order:
1. `node --test tests/` — existing test suite must pass
2. Plan success criteria that are machine-checkable
3. Regression watch list checks
4. Structural assertions (no undefined, no NaN, no console errors)
5. **Visual verification** — if the project has a UI (web pages, app screens):
   - Start the dev server if not running
   - Use Playwright or a browser tool to take screenshots of key pages
   - Verify: content is visible (not hidden by CSS), layout isn't broken,
     sections render with actual content (not blank/empty), navigation works
   - Compare against what previous phases built — new changes must not hide,
     break, or obscure existing content
   - This catches: opacity:0 animations without triggers, display:none without
     toggles, z-index issues, overflow:hidden clipping content
6. Only then: AI evaluation for things machines can't judge

**Isolation rule:** Test through the interface (browser, CLI, API calls,
screenshots), not by reading source code. You verify *behavior*, not
*implementation*.

## Step 4: FOREST — Does this tree fit the forest?

This is the vision check. You already validated that the code works
(Step 3). Now ask whether it's the RIGHT code for the broader project.

Read the code the builder wrote. Read ALL phases in `.goals.json`.
For each task that was built, evaluate:

1. **Interface contract verification** — read `interfaceContract` on this phase
   AND all other phases in `.goals.json`.
   - Does this phase's code actually produce what `produces` claims?
   - Does it consume what `consumes` lists — and do those things exist?
   - Do any other phases' `produces` conflict with or break what this phase
     built? (e.g., a later phase adds CSS that hides elements this phase created,
     or overrides an API this phase depends on)
   - Are there undelcared dependencies — things the code uses that aren't in `consumes`?
2. **Pattern consistency** — does this implementation follow the same
   patterns as existing completed phases?
3. **Scaling assumptions** — does this implementation assume things
   that won't hold as the project grows?
4. **Naming and domain alignment** — do the names use the same
   vocabulary as the rest of the project?
5. **Dependency direction** — does this code depend on things it
   shouldn't, or create coupling that will make future phases harder?
6. **Diagram sync** — read the phase's diagram (if it has one) and the
   parent's diagram. Check:
   - Does the phase diagram still match the plan? (Same number of tasks/nodes,
     same interfaces as edges, nothing added or removed without updating)
   - Is this phase represented in the parent diagram? If a new sub-phase was
     added, the parent diagram should include it
   - Do the entry/exit points in the parent diagram match what the code
     actually implements? (e.g., parent shows "REST API" edge into this phase —
     does the code actually expose/consume that API?)
   Flag stale or mismatched diagrams as forest warnings.

Forest findings are reported as **WARNING** (advisory, not blocking).
WARNING risk levels: HIGH, MEDIUM, LOW.

The overall verdict is based ONLY on tree checks. Forest warnings are
advisory. The PM decides whether to act on them.

**Forest review (validate findings before reporting):**
Run forest findings through a review agent (Agent tool) to catch false
positives. The reviewer checks: is this real or speculative? Is the
severity right? Does the future phase's planFile actually say what
the forest check claims? Remove speculative findings, keep confirmed ones.

## Step 5: DIAGNOSE

For each failure (tree OR forest warning):
- What failed (the specific check)
- What was expected vs what happened
- Root cause (WHY is it broken)
- Which task in `.goals.json` this relates to
- For forest warnings: which future phase(s) would be impacted
- Whether this is a known pattern (check `patterns.md`)
- Impact: does this block other criteria?

**Project-aware diagnosis:** Connect failures to business impact.

## Step 6: REPORT

**Verdict is based ONLY on tree checks.** Forest warnings are advisory.

Report format:
```
## Tree Verdict: PASS | FAIL | BLOCKED

[PASS] criteria-1: ... (Task: "...")
[FAIL] criteria-3: ... (Task: "...")
  SEVERITY: CRITICAL
  EXPECTED: ...
  ACTUAL: ...
  ROOT CAUSE: ...
  FIX: ...

## Forest Warnings (advisory — PM decides)

[WARNING] vision-1: ... (Task: "...")
  RISK: HIGH
  CONTEXT: ...
  SUGGESTION: ...
```

**No ambiguity. No "mostly works." No partial credit** on tree checks.

## Step 7: PERSIST

1. Update `.qa/memory/status.json` — new trajectory entry, update criteria.
   Forest warnings go in `forestWarnings[]` (separate from `criteria[]`).
   **Validate after write.**

2. Append to `learnings.txt`

3. Update `regressions.md` — new regressions, increment recurrence counts

4. Update `patterns.md` — new patterns or update existing

5. **Update `.goals.json`** — map **tree** verdicts to tasks:
   - All tree criteria pass → QA attempt `outcome: "success"`
   - Some fail → `outcome: "partial"`, notes list what failed
   - Critical fail → `outcome: "failure"`, notes have root cause
   - **Forest warnings do NOT affect task status.** They go in attempt
     notes as informational only.
   - Never overwrite a `success` outcome
   - If builder had `success` but QA tree finds failure, create NEW attempt
   - After updates: all tasks success → `completed`, any failure → `blocked`
   - **Validate .goals.json after write.**

## Step 8: EXIT

If **FAIL**: list failures by severity, what it means for the business
owner, specific `/build` commands to fix.

If **PASS**: confirm what was verified, note retired regressions,
flag resolved PM concerns, recommend `/pm` for status update.

---

## Memory Schemas

### status.json
```json
{
  "lastRun": "ISO timestamp",
  "plan": "plan-name",
  "round": 1,
  "verdict": "PASS | FAIL | BLOCKED",
  "checksTotal": 0,
  "checksPassing": 0,
  "criteria": [{ "id": "", "description": "", "source": "", "taskTitle": "",
    "passes": false, "severity": "CRITICAL|HIGH|MEDIUM", "lastTestedRound": 1, "notes": "" }],
  "forestWarnings": [{ "id": "", "description": "", "risk": "HIGH|MEDIUM|LOW",
    "context": "", "suggestion": "", "round": 1 }],
  "trajectory": [{ "round": 1, "passing": 0, "total": 0, "delta": null }]
}
```

### learnings.txt (append-only)
```
## Round N — YYYY-MM-DD
- [DISCOVERED] {what}
- [ROOT CAUSE] {why}
- [FIXED BY] {how, or UNFIXED}
- [WATCH FOR] {future}
```

### regressions.md
```
## {description}
**First seen:** YYYY-MM-DD (Round N)
**Times broken:** N
**Last broken:** YYYY-MM-DD
**Root cause:** ...
**Check:** {machine-verifiable assertion}
**Status:** ACTIVE | RETIRED
```

### patterns.md
```
## {pattern name}
**Symptoms:** ...
**Root cause:** ...
**Fix:** ...
**Affected areas:** ...
**Seen in:** Round N, Round M
```

---

## Memory Hygiene

- `learnings.txt` — keep last 30 entries, archive older
- `regressions.md` — retire after 5 consecutive passes, archive after 60 days
- `patterns.md` — no cap, merge duplicates
- `status.json` trajectory — keep last 20 entries

### Staleness audit
Check each ACTIVE regression: does the code still exist? If not, retire.

### Recovery
If `status.json` corrupted: restore from git, or rebuild fresh with round 0.
Never silently proceed with corrupt state.
