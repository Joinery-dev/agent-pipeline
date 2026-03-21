# The Design Loop — Design Review Execution Protocol

Each invocation is a **fresh agent**. Context comes from memory files only.

```
Round N (fresh agent):

  1. READ       — visual language + spec + ALL pages + all memory
  2. CAPTURE    — screenshots at 1280px + 375px
  3. SPEC CHECK — point-by-point against visual specification (tree)
  4. CONSISTENCY — against all pages across all phases (forest)
  5. MEMORY     — previous findings addressed? Patterns recurring?
  6. DIAGNOSE   — root cause for each issue
  7. REPORT     — SHIP-BLOCKER / QUALITY / POLISH per finding
  8. PERSIST    — update .design/memory/ + PM concerns + QA patterns
```

---

## Step 1: READ

Read all memory files. Build the full picture before looking at anything.

- `.claude/visual-language.md` — the visual constitution. This is your primary
  reference. Every judgment traces back to it.
- Plan file `## Visual Specification` — what this phase should look like.
  Verify it references visual-language.md. If it doesn't, note as QUALITY finding.
- `.design/memory/status.json` — previous review state and trajectory
- `.design/memory/page-grades.json` — grade history per page
- `.design/memory/findings.md` — previous findings (which are resolved?)
- `.design/memory/visual-drift.md` — known drift items
- `.pm/memory/concerns.md` — design concerns flagged by PM
- `.qa/memory/patterns.md` — visual patterns flagged by QA

## Step 2: CAPTURE

Take full-page screenshots of EVERY page in the project (not just this phase):

- Desktop: 1280 x 800 viewport
- Mobile: 375 x 812 viewport
- Save to `.qa/screenshots/design-review-<phase>-<timestamp>/`
- Name format: `<route>-desktop.png`, `<route>-mobile.png`
- Wait for animations to settle (1-2s after load)

**Note:** If running in autonomous mode (--print), you may not be able to
take screenshots. Ship.js runs `lib/visual-check.js` independently. In
interactive mode, always take screenshots yourself.

## Step 3: SPEC CHECK (tree — blocking)

For each page described in the Visual Specification, evaluate point by point:

- **Layout**: does the actual composition match the described layout?
- **Hierarchy**: is the described prominence achieved? Eye path correct?
- **Mood**: does the page convey the described feeling?
- **Content flow**: does the user path match the described flow?
- **Key details**: are the specified colors, typography, treatments used?

Binary per point: **MET** or **NOT MET**.

Any NOT MET on a critical layout/hierarchy point = **SHIP-BLOCKER**.
Minor detail mismatches = **QUALITY**.

## Step 4: CONSISTENCY CHECK (forest)

Compare ALL pages against `.claude/visual-language.md`:

1. **Palette compliance** — are all colors from the documented palette?
   Flag any hex values, rgb values, or Tailwind colors not in visual-language.md.
2. **Typography compliance** — are all fonts and weights from the documented scale?
3. **Spacing rhythm** — is the spacing system consistent across pages?
4. **Component patterns** — do cards, buttons, sections, nav follow the
   documented patterns?
5. **Cross-phase consistency** — do pages from THIS phase feel like they belong
   with pages from OTHER phases? Or do they look like different products?
6. **Drift detection** — has the visual language evolved since it was documented?
   If the code has drifted from visual-language.md, is it the code that's wrong
   or the document that needs updating?

Forest findings are **advisory** unless they indicate systematic drift affecting
multiple pages (which becomes a QUALITY finding).

## Step 5: MEMORY CHECK

Check previous state:

- Read `.design/memory/findings.md` — for each previous finding:
  - Is it **RESOLVED** (the issue no longer exists in screenshots)?
  - Is it **RECURRING** (still present despite being flagged)?
  - Is it **NEW** (first time seeing this)?
- Read `.design/memory/page-grades.json` — is each page's grade:
  - **IMPROVING** (trending up)?
  - **STABLE** (same grade)?
  - **DEGRADING** (trending down)?
- Read `.pm/memory/concerns.md` — were design concerns addressed?
- Read `.qa/memory/patterns.md` — are visual patterns still occurring?

RECURRING findings that have been flagged 2+ times get elevated one severity
level (POLISH → QUALITY, QUALITY → SHIP-BLOCKER).

## Step 6: DIAGNOSE

For each finding, identify root cause:

- **Builder didn't read visual-language.md** — hardcoded values instead of tokens
- **Visual spec was vague** — builder made reasonable but wrong interpretation
- **Design tokens not used** — builder used inline styles instead of system
- **Cross-phase inconsistency** — different builder sessions made different choices
- **Visual language outdated** — the spec doesn't reflect the evolved design
- **Missing visual spec** — no spec existed for this page, builder guessed

Root cause determines who fixes it:
- Builder issue → resolver or new build task
- Spec issue → PM revises spec
- Visual language outdated → PM updates visual-language.md

## Step 7: REPORT

```
## Design Review: [phase]

**Visual Specification compliance:** X/Y points met
**Overall grade:** [A/B/C/D/F]
**Grade trajectory:** [previous → current]
**Visual language compliance:** [compliant / drifting / non-compliant]

### Tree Findings (this phase — spec compliance)
[SHIP-BLOCKER] spec point: "..." — actual: "..." — root cause: ...
[QUALITY] spec point: "..." — actual: "..." — root cause: ...
[POLISH] "..." — root cause: ...

### Forest Findings (whole product — consistency)
[DRIFT] visual-language.md says X, pages show Y — affects N pages
[INCONSISTENCY] Phase A pages use X, Phase B pages use Y

### Memory Findings
[RESOLVED] previous finding "..." — now fixed
[RECURRING] previous finding "..." — still present (Nth time)
[NEW] first-time finding "..."

### Previous Concerns Check
- PM concern "X": ADDRESSED / STILL OPEN
- QA pattern "Y": ADDRESSED / STILL OPEN

### Page Grades
| Page | Previous | Current | Trend |
|------|----------|---------|-------|
| /    | B        | B+      | ↑     |
| /about | A      | A       | →     |
```

**No ambiguity. No "looks pretty good." Every finding references the spec or
visual-language.md. Every grade is justified.**

## Step 8: PERSIST

1. **Update `.design/memory/status.json`** — new trajectory entry, current state.
   Validate after write.

2. **Append to `.design/memory/findings.md`** — this phase's findings with date.
   Mark previous findings as RESOLVED if they no longer appear.

3. **Update `.design/memory/page-grades.json`** — new grade entry per page.

4. **Update `.design/memory/visual-drift.md`** — new drift items, resolve old ones.

5. **Write QUALITY+ findings to `.pm/memory/concerns.md`** — so PM addresses
   them in the next phase's visual spec.

6. **Write recurring visual patterns to `.qa/memory/patterns.md`** — so QA
   checks for them in future forest checks.

7. **If visual-language.md needs updating**, note the specific recommendation
   in findings. PM decides whether to accept.

---

## Memory Hygiene

### Size caps
- `status.json` trajectory — keep last 20 entries
- `findings.md` — keep last 20 phase entries, archive older to `findings-archive.md`
- `visual-drift.md` — resolve items when fixed, archive after 60 days
- `page-grades.json` — keep all (trajectory is the whole point)

### Staleness audit
Check each OPEN drift item against current screenshots. If fixed, resolve with:
`**Resolution:** auto-resolved — verified fixed in [phase]`.

### Recovery
If any memory file is missing or corrupted:
1. Check `git log -- .design/memory/{file}` for last good version
2. If in git, restore from last good commit
3. If not, reconstruct from screenshots + findings in attempt notes
4. Flag to user: "Reconstructed — may be incomplete"
