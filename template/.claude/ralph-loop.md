# The Ralph Loop — QA Execution Protocol

Each invocation is a **fresh agent**. Context comes from memory files only.

```
Round N (fresh agent):

  1. PREPARE    — read all context, extract success criteria
  2. CHECK      — machine-verifiable first, then AI evaluation, then forest
  3. DIAGNOSE   — root cause for every failure
  4. PERSIST    — update memory + .goals.json, report verdict
```

---

## Step 1: PREPARE

Read all context and extract what you're checking against:

**Read:**
- `.qa/memory/` (status.json, learnings.txt, regressions.md, patterns.md)
- `.goals.json` — ALL phases, not just the current one
- The plan file (via phase's `planFile`) — extract success criteria
- `.pm/memory/status.md` and `concerns.md` — failures related to concerns get elevated severity
- git log (last 15 commits), git diff --stat HEAD~5

**Extract criteria from:**
- Plan success criteria → map each to a specific task via `planFile` link
- Active entries from `regressions.md`
- PM concerns with testable implications
- Basic health checks (tests pass, no regressions)
- Vision criteria from broader project context (see Forest section in Step 2)

These become `criteria` entries in `status.json` with `taskTitle` set.

---

## Step 2: CHECK

### Tree checks (blocking — determine the verdict)

Run machine-verifiable checks FIRST. Always. Before any AI evaluation.

1. `node --test tests/` — existing test suite must pass
2. Plan success criteria that are machine-checkable
3. Regression watch list checks
4. Structural assertions (no undefined, no NaN, no console errors)
5. **Visual verification** — if the project has a UI:
   - Take screenshots of key pages (save to `.qa/screenshots/<phaseId>-<timestamp>/`)
   - Verify: content visible, layout not broken, sections render with actual content
   - Compare against what previous phases built — new changes must not break existing content
6. **Visual spec check** — if the plan has a `## Visual Specification`:
   - Compare screenshot against spec's described layout, hierarchy, mood, content flow
   - These are tree checks (blocking) — the spec is part of the plan
7. **Mockup comparison** — if the phase has `illustrations[]` in `.goals.json`:
   - Compare built page against mockup: same sections, proportions, color palette, hierarchy
   - Not pixel-perfect — compare structure and visual weight
   - Significant deviations are tree findings (blocking)
8. AI evaluation for things machines can't judge

**Isolation rule:** Test through the interface (browser, CLI, API), not source code.

### Forest checks (advisory — PM decides whether to act)

Read the code the builder wrote. Read ALL phases in `.goals.json`. Evaluate:

1. **Interface contracts** — does the code actually produce/consume what the contracts claim? Do other phases' outputs conflict with this phase?
2. **Pattern consistency** — same patterns as completed phases?
3. **Naming and domain alignment** — same vocabulary as the rest of the project?
4. **Dependency direction** — does this create coupling that makes future phases harder?
5. **Diagram sync** — does the phase diagram still match the plan and parent?
6. **Visual language compliance** — if `.claude/visual-language.md` exists, does the code use documented tokens? Flag hardcoded values.

Forest findings are **WARNING** (advisory, not blocking). Risk levels: HIGH, MEDIUM, LOW.

**The overall verdict is based ONLY on tree checks.** Forest warnings go in attempt notes as informational.

Run forest findings through a review agent (Agent tool) to catch false positives before reporting.

### Forest test codification

After forest analysis, encode HIGH and MEDIUM cross-cutting findings as
Playwright tests. These persist permanently — future builds must pass them.

Write to `tests/qa/<phaseId>.spec.js`:

```javascript
// tests/qa/<phaseId>.spec.js
// QA forest tests — Round N, YYYY-MM-DD
import { test, expect } from '@playwright/test';

test.describe('<Phase> — QA Forest Checks', () => {
  test('description of what is being verified', async ({ page }) => {
    await page.goto('/relevant-page');
    // assertion encoding the finding
  });
});
```

**What to codify:**
- Navigation links resolve to real pages (no 404s)
- Forms produce expected responses on submit
- Error states render (empty input, invalid data, missing auth)
- Data flows correctly between features built in different phases
- Accessibility: images have alt text, inputs have labels, focus works
- Cross-page consistency: nav, footer, header render on all pages
- Content completeness: no placeholder text, no empty sections

**What NOT to codify:**
- Tree verdicts (those go through pipeline-cli as attempt outcomes)
- Subjective assessments that can't be expressed as assertions
- One-off bugs better described in attempt notes

**If `tests/qa/<phaseId>.spec.js` already exists from a previous round,
READ it first. Append new tests — do not overwrite previous rounds' tests.**

If Playwright is not installed, skip this step. Write findings to memory
files only (existing behavior).

Commit new test files:
```
git add tests/qa/ && git commit -m "QA: forest tests for <phase>"
```

---

## Step 3: DIAGNOSE

For each failure (tree OR forest warning):
- What failed (the specific check)
- What was expected vs what happened
- Root cause (WHY is it broken)
- Which task in `.goals.json` this relates to
- For forest warnings: which future phase(s) would be impacted
- Whether this is a known pattern (check `patterns.md`)
- Impact: does this block other criteria?

**No ambiguity. No "mostly works." No partial credit** on tree checks.

---

## Step 4: PERSIST

### Update memory files

1. `.qa/memory/status.json` — new trajectory entry, update criteria. Forest warnings in `forestWarnings[]`. **Validate after write.**
2. `learnings.txt` — append new findings
3. `regressions.md` — new regressions, increment recurrence counts
4. `patterns.md` — new patterns or update existing

### Update .goals.json

Map **tree** verdicts to tasks:
- All tree criteria pass → QA attempt `outcome: "success"`
- Some fail → `outcome: "partial"`, notes list what failed
- Critical fail → `outcome: "failure"`, notes have root cause
- Forest warnings do NOT affect task status (informational in notes only)
- After updates: all tasks success → `completed`, any failure → `blocked`
- Include screenshot paths in attempt notes under `## Screenshots`
- **Validate .goals.json after write.**

### Report

**FAIL:** List failures by severity, business impact, specific `/build` commands to fix.
**PASS:** Confirm what was verified, note retired regressions, flag resolved PM concerns.

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
