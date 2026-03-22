# The Design Loop — Design Review Execution Protocol

Each invocation is a **fresh agent**. Context comes from memory files only.

```
Round N (fresh agent):

  1. CAPTURE    — read all context + take screenshots
  2. CHECK      — spec compliance (tree) + consistency (forest)
  3. DIAGNOSE   — root cause + memory check (recurring/resolved/new)
  4. PERSIST    — update all memory files, report verdict
```

---

## Step 1: CAPTURE

Read all context and take screenshots:

**Read:**
- `.claude/visual-language.md` — the visual constitution. Primary reference.
- Plan file `## Visual Specification` — what this phase should look like
- `.design/memory/` (status.json, page-grades.json, findings.md, visual-drift.md)
- `.pm/memory/concerns.md` — design concerns flagged by PM
- `.qa/memory/patterns.md` — visual patterns flagged by QA

**Screenshot EVERY page** in the project (not just this phase):
- Desktop: 1280 x 800 viewport
- Mobile: 375 x 812 viewport
- Save to `.qa/screenshots/design-review-<phase>-<timestamp>/`
- Name format: `<route>-desktop.png`, `<route>-mobile.png`
- Wait for animations to settle (1-2s after load)

**Note:** In autonomous mode (--print), ship.js runs `lib/visual-check.js`
independently. In interactive mode, always take screenshots yourself.

---

## Step 2: CHECK

### Spec compliance (tree — blocking)

**If the phase has `illustrations[]` in .goals.json, the mockup is the
PRIMARY reference.** Compare built page against mockup:
- Layout match: same sections in same positions and proportions?
- Color match: same palette?
- Typography match: same heading/body hierarchy?
- Content hierarchy: same visual weight distribution?
- Proportions: hero same relative height? Sections same spacing?

Grade: A (near-identical) through F (completely different).
C or below on any critical area = **SHIP-BLOCKER**.

**If no illustration**, evaluate against text Visual Specification point by point:
- Layout, hierarchy, mood, content flow, key details
- Binary per point: **MET** or **NOT MET**
- NOT MET on critical layout/hierarchy = **SHIP-BLOCKER**
- Minor detail mismatches = **QUALITY**
- Note missing illustration as a QUALITY finding

### Consistency (forest — advisory)

Compare ALL pages against `.claude/visual-language.md`:
1. **Palette compliance** — all colors from documented palette?
2. **Typography compliance** — all fonts/weights from documented scale?
3. **Spacing rhythm** — consistent across pages?
4. **Component patterns** — cards, buttons, nav follow documented patterns?
5. **Cross-phase consistency** — pages from this phase feel like same product as other phases?
6. **Drift detection** — has the visual language evolved beyond the document?

Forest findings are advisory unless they indicate systematic drift across
multiple pages (which becomes a QUALITY finding).

---

## Step 3: DIAGNOSE

For each finding, identify root cause:
- **Builder didn't read visual-language.md** — hardcoded values instead of tokens
- **Visual spec was vague** — builder made reasonable but wrong interpretation
- **Cross-phase inconsistency** — different builder sessions made different choices
- **Visual language outdated** — spec doesn't reflect evolved design
- **Missing visual spec** — no spec existed, builder guessed

Root cause determines who fixes it:
- Builder issue → resolver or new build task
- Spec issue → PM revises spec
- Visual language outdated → PM updates visual-language.md

**Memory check:** For each finding from `.design/memory/findings.md`:
- **RESOLVED** — issue no longer exists in current screenshots
- **RECURRING** — still present despite being flagged (elevate severity: POLISH → QUALITY → SHIP-BLOCKER)
- **NEW** — first time seeing this

Check grade trajectory in `page-grades.json` — is each page improving, stable, or degrading?

---

## Step 4: PERSIST

### Update memory files
1. `.design/memory/status.json` — new trajectory entry, current state. Validate after write.
2. `.design/memory/findings.md` — append this phase's findings. Mark previous findings RESOLVED if fixed.
3. `.design/memory/page-grades.json` — new grade entry per page.
4. `.design/memory/visual-drift.md` — new drift items, resolve old ones.
5. `.pm/memory/concerns.md` — write QUALITY+ findings so PM addresses them.
6. `.qa/memory/patterns.md` — write recurring visual patterns for QA to check.

### Report

```
## Design Review: [phase]

**Visual Specification compliance:** X/Y points met
**Overall grade:** [A/B/C/D/F]
**Grade trajectory:** [previous → current]

### Tree Findings (spec compliance)
[SHIP-BLOCKER] spec point: "..." — actual: "..." — root cause: ...
[QUALITY] spec point: "..." — actual: "..." — root cause: ...

### Forest Findings (consistency)
[DRIFT] visual-language.md says X, pages show Y — affects N pages

### Memory Findings
[RESOLVED] previous finding "..." — now fixed
[RECURRING] previous finding "..." — still present (Nth time)

### Page Grades
| Page | Previous | Current | Trend |
|------|----------|---------|-------|
| /    | B        | B+      | ↑     |
```

**No ambiguity. Every finding references the spec or visual-language.md.
Every grade is justified.**

---

## Memory Hygiene

- `status.json` trajectory — keep last 20 entries
- `findings.md` — keep last 20 phase entries, archive older
- `visual-drift.md` — resolve items when fixed, archive after 60 days
- `page-grades.json` — keep all (trajectory is the whole point)
