# Design Agent Full Integration

## Goal

Bring the design review agent to full parity with PM and QA — structured memory, protocol, cross-agent wiring, quality gates, and visual language governance. Currently the design agent is a shallow command bolted onto the pipeline. This plan integrates it as a first-class citizen with the same depth as every other agent.

## Why This Matters

Without this, the pipeline produces code that works but looks inconsistent across phases. Each builder session reinvents the visual identity. Nobody tracks whether design quality is improving or degrading. The design review runs but its findings evaporate. The product degrades phase by phase with no mechanism to catch it.

## Architecture Fit

The design agent follows the same patterns established by PM and QA:

- **PM pattern**: owns `.pm/memory/`, has `pm-reference.md` for formats, ship.js writes to its memory even without explicit `/pm` invocation
- **QA pattern**: owns `.qa/memory/`, has `ralph-loop.md` as structured protocol, `lessons-sync.js` graduates patterns to conventions, forest + tree checks
- **Design pattern (new)**: owns `.design/memory/`, has `design-loop.md` as structured protocol, reads/writes to PM and QA memory, forest + tree checks, visual language governance

### Ownership Matrix (updated)

| Resource | PM | Builder | QA | Resolver | Design |
|---|---|---|---|---|---|
| `.goals.json` structure | OWNS | reads | reads | reads | reads |
| `.goals.json` tasks/attempts | reads | WRITES | WRITES | WRITES | reads |
| `.pm/memory/` | OWNS | reads | reads | reads | reads + writes concerns |
| `.qa/memory/` | reads | reads | OWNS | reads | reads + writes patterns |
| `.design/memory/` | reads | reads | reads | reads | OWNS |
| `.claude/visual-language.md` | creates + updates | reads | reads | reads | reads + recommends updates |
| `plans/` | OWNS | reads | reads | reads | reads |
| Source code | reads | WRITES | reads | WRITES | reads |
| Screenshots | reads | — | takes | — | takes |

---

## Phase 1: Memory Infrastructure

### 1.1 Directory structure

```
.design/memory/
├── status.json         — structured state (mirrors QA's status.json)
├── findings.md         — per-phase findings log (mirrors QA's learnings.txt)
├── visual-drift.md     — where the product diverges from visual-language.md
└── page-grades.json    — per-page grades across reviews with trajectory
```

### 1.2 Memory schemas

**status.json**
```json
{
  "lastRun": "ISO timestamp",
  "phase": "phase-title",
  "round": 1,
  "overallGrade": "B+",
  "specCompliance": { "met": 8, "total": 10 },
  "findings": {
    "shipBlockers": 0,
    "quality": 3,
    "polish": 5
  },
  "trajectory": [
    { "phase": "Foundation", "grade": "B", "specCompliance": "6/8" },
    { "phase": "Content", "grade": "B+", "specCompliance": "8/10" }
  ]
}
```

**page-grades.json**
```json
{
  "/": { "grades": [{ "phase": "Foundation", "grade": "B", "date": "..." }, { "phase": "Polish", "grade": "A-", "date": "..." }] },
  "/about": { "grades": [{ "phase": "Content", "grade": "A", "date": "..." }] }
}
```

**findings.md** (append-only, like QA learnings)
```
## Phase: Content & Messaging — 2026-03-21
- [QUALITY] Hero section lacks visual weight compared to About page
- [QUALITY] CTA buttons inconsistent sizing across pages
- [POLISH] Footer spacing tighter than other sections
- [ADDRESSED] Previous concern about flat hero — improved with gradient background
```

**visual-drift.md**
```
## Drift Log

### 2026-03-21 — Phase: Polish & Launch
- Typography: Phase added a third font weight not in visual-language.md
- Spacing: Section padding is 6rem on new pages, 4rem on Foundation pages
- Color: Amber accent used at 60% opacity on new pages, 100% on old pages
- STATUS: DRIFTING — recommend visual-language.md update or page fix
```

### 1.3 Hygiene rules

- `status.json` — overwritten each review
- `findings.md` — keep last 20 phase entries, archive older
- `visual-drift.md` — keep active drift items, archive resolved
- `page-grades.json` — keep all (it's the trajectory record)
- Recovery: if corrupted, reconstruct from screenshots + git history

### 1.4 Scaffolding

Update `init.js` to create `.design/memory/` with empty starter files.

### 1.5 Documentation

Add design memory schema to `agent-protocol.md` alongside PM and QA schemas.

**Files to modify:** `bin/init.js`, `.claude/agent-protocol.md`
**Files to create:** `.design/memory/status.json`, `.design/memory/findings.md`, `.design/memory/visual-drift.md`, `.design/memory/page-grades.json`

---

## Phase 2: Visual Language Document

### 2.1 The document

`.claude/visual-language.md` — the visual constitution. Created by the PM during the first UI phase. Referenced by every agent after.

```markdown
# Visual Language

## Brand Palette
| Token | Value | Usage |
|---|---|---|
| primary | #1e3a5f | Headings, primary buttons, key accents |
| secondary | #2d6a4f | Secondary buttons, success states |
| accent | #e07a2f | CTAs, highlights, emphasis |
...

## Typography
| Role | Font | Weight | Usage |
|---|---|---|---|
| display | DM Serif Display | 400 | h1-h3, pull quotes |
| body | Inter | 400-700 | Body text, UI elements |
...

## Spacing System
...

## Component Patterns
- Cards: rounded corners, subtle shadow, surface background
- Buttons: pill shape for primary, ghost for secondary
- Sections: full-width, generous vertical padding
...

## Mood & Personality
Confident, clear, professional but approachable. Not sterile.
Generous whitespace. The product should feel like it has room to breathe.

## Photo / Illustration Treatment
Editorial feel. Warm tones. No stock photo aesthetic.
Gradients as placeholder for photography — warm amber to navy.

## Responsive Principles
Mobile-first. Single column below 768px. Touch targets minimum 44px.
Navigation collapses to hamburger on mobile.
```

### 2.2 Creation flow

- PM encounters first UI phase → checks if `.claude/visual-language.md` exists
- If not: PM creates it as part of planning, before writing visual specs
- If yes: PM reads it and references it in the visual spec
- Design review can RECOMMEND updates (e.g., "the amber accent should be warmer") but PM decides whether to accept

### 2.3 Cross-agent reading

- **PM**: reads when writing visual specs. References explicitly.
- **Builder**: reads when implementing UI. Uses the documented tokens, not new ones.
- **QA**: reads during forest check. Flags code that uses undocumented colors/fonts.
- **Design**: reads as primary reference. Checks every page against it.

**Files to modify:** `pm:plan.md`, `build.md`, `ralph-loop.md`, `design-review.md`
**Files to create:** `.claude/visual-language.md` (blank scaffold in init.js)

---

## Phase 3: Design Review Protocol

### 3.1 Create `.claude/design-loop.md`

Structured 8-step protocol, mirroring QA's ralph-loop:

```
Round N (fresh agent):

  1. READ       — visual-language.md + spec + ALL pages + all memory
  2. CAPTURE    — screenshots at 1280px + 375px, save to .design/screenshots/
  3. SPEC CHECK — point-by-point against visual specification (tree, blocking)
  4. CONSISTENCY — against all pages across all phases (forest)
  5. MEMORY     — previous findings addressed? Patterns recurring? Drift?
  6. DIAGNOSE   — root cause for each issue
  7. REPORT     — SHIP-BLOCKER / QUALITY / POLISH per finding
  8. PERSIST    — update .design/memory/ + PM concerns + QA patterns
```

### 3.2 Step details

**Step 1: READ**
- `.claude/visual-language.md` — the visual constitution
- Plan file `## Visual Specification` — what this phase should look like
- ALL pages in the project (not just this phase)
- `.design/memory/status.json` — previous review state
- `.design/memory/page-grades.json` — grade history per page
- `.design/memory/visual-drift.md` — known drift items
- `.pm/memory/concerns.md` — design concerns from PM
- `.qa/memory/patterns.md` — visual patterns from QA

**Step 2: CAPTURE**
- Take full-page screenshots of every page at 1280px (desktop) and 375px (mobile)
- Save to `.qa/screenshots/design-review-<phase>-<timestamp>/`
- Note: if running in --print mode, ship.js visual-check.js handles this independently

**Step 3: SPEC CHECK (tree — blocking)**
- For each page described in the Visual Specification:
  - Layout matches? (described composition vs actual)
  - Hierarchy matches? (described prominence vs actual)
  - Mood matches? (described feeling vs actual)
  - Content flow matches? (described user path vs actual)
  - Key details match? (described colors, typography vs actual)
- Binary per point: MET or NOT MET
- Any NOT MET on a critical point = SHIP-BLOCKER

**Step 4: CONSISTENCY CHECK (forest)**
- Compare ALL pages against `.claude/visual-language.md`:
  - Same palette used consistently?
  - Same typography scale?
  - Same spacing rhythm?
  - Same component patterns?
- Compare THIS phase's pages against OTHER phases' pages:
  - Do they feel like the same product?
  - Has the visual language drifted?
- Findings go to `.design/memory/visual-drift.md`

**Step 5: MEMORY CHECK**
- Read `.design/memory/findings.md` — were previous findings addressed?
- Read `.design/memory/page-grades.json` — are page grades improving or degrading?
- Read `.pm/memory/concerns.md` — were PM's design concerns addressed?
- Track: how many previous findings are now resolved vs still open

**Step 6: DIAGNOSE**
- For each issue, identify root cause:
  - Builder didn't read visual-language.md
  - Visual spec was vague on this point
  - Design tokens not used (hardcoded values instead)
  - Cross-phase inconsistency (different builder sessions)
  - Visual language needs updating (the spec is outdated)

**Step 7: REPORT**
```
## Design Review: [phase]

**Spec compliance:** X/Y points met
**Overall grade:** A/B/C/D/F
**Grade trajectory:** [previous grades → current]

### Tree Findings (this phase)
[SHIP-BLOCKER] ... — spec point not met
[QUALITY] ... — noticeable deviation
[POLISH] ... — refinement opportunity

### Forest Findings (whole product)
[DRIFT] ... — visual language divergence
[INCONSISTENCY] ... — cross-phase visual mismatch

### Memory Findings
[RESOLVED] ... — previous finding addressed
[RECURRING] ... — previous finding NOT addressed
[NEW] ... — first time seeing this

### Previous Concerns Check
- Concern X: ADDRESSED / STILL OPEN
```

**Step 8: PERSIST**
- Update `.design/memory/status.json` — new trajectory entry, current state
- Append to `.design/memory/findings.md` — this phase's findings
- Update `.design/memory/page-grades.json` — new grades per page
- Update `.design/memory/visual-drift.md` — new drift items or resolve old ones
- Write QUALITY findings to `.pm/memory/concerns.md`
- Write recurring visual patterns to `.qa/memory/patterns.md`
- If visual-language.md needs updating, note recommendation in findings

### 3.3 Hygiene and recovery

Same pattern as ralph-loop:
- `status.json` trajectory — keep last 20 entries
- `findings.md` — keep last 20 phase entries, archive older
- `visual-drift.md` — resolve items when fixed, archive after 60 days
- `page-grades.json` — keep all (trajectory is valuable)
- Recovery: if corrupted, check git log, restore or reconstruct

**Files to create:** `.claude/design-loop.md`, `.claude/design-reference.md`
**Files to modify:** `.claude/commands/design-review.md`

---

## Phase 4: Ship.js Integration

### 4.1 Quality gate

New function `runQualityGate()` — runs before each new phase:

```
Read .pm/memory/concerns.md:
  Count OPEN design concerns older than 1 phase
  If 2+ unresolved across different phases → STOP

Read .qa/memory/patterns.md:
  Count visual patterns seen 3+ times
  If any → STOP

Read .design/memory/visual-drift.md:
  If DRIFTING status on 2+ items → STOP

CLEAN → proceed
FAILING → STOP with specific message about what's degrading
```

### 4.2 State machine integration

Design review becomes a proper state in the flow, not a bolted-on function:

After QA passes → state becomes `design-review`
Design review runs → if SHIP-BLOCKER → state becomes `design-fix` (PM → Builder → QA → Design confirm)
Design review clean → state becomes `complete`

### 4.3 Memory initialization

Ship.js creates `.design/memory/` if it doesn't exist on startup (like it ensures git repo).

### 4.4 Post-review actions

After design review:
- Run `rollup-all`
- Run integration check
- Log decision to PM memory
- If first UI phase and `.claude/visual-language.md` doesn't exist, log warning

**Files to modify:** `lib/ship.js`

---

## Phase 5: Cross-Agent Wiring

### 5.1 PM reads design memory

Update `pm.md` and `pm:plan.md` startup:
- Read `.design/memory/findings.md` — what design issues exist
- Read `.design/memory/visual-drift.md` — is the visual language drifting
- Read `.design/memory/page-grades.json` — which pages need more care
- If planning a UI phase and `.claude/visual-language.md` doesn't exist, CREATE IT

### 5.2 Builder reads visual language

Update `build.md` startup:
- Read `.claude/visual-language.md` — use established tokens
- Read `.design/memory/page-grades.json` — know which pages got low grades previously
- NEVER introduce colors, fonts, or spacing values not in visual-language.md without justification

### 5.3 QA reads design state

Update `ralph-loop.md` forest check:
- Read `.claude/visual-language.md` — flag code using undocumented design values
- Read `.design/memory/status.json` — know the visual quality trajectory
- Forest warning if code introduces tokens not in visual-language.md

### 5.4 Design reads everything

Update `design-loop.md` (created in Phase 3):
- Reads PM memory, QA memory, its own memory, visual-language.md
- Writes to all three memory systems

### 5.5 Lessons graduation

Update `lessons-sync.js` to also read `.design/memory/findings.md`:
- If a design issue appears in 3+ phase findings → graduate to `project-conventions.md`
- Example: "Hero sections must use the full brand palette — graduated from design finding seen in Foundation, Content, and Polish phases"

**Files to modify:** `pm.md`, `pm:plan.md`, `build.md`, `ralph-loop.md`, `lib/lessons-sync.js`

---

## Phase 6: Visual Spec Hierarchy Enforcement

### 6.1 Hierarchy

```
.claude/visual-language.md          ← project-level visual constitution
  ↓ referenced by
Major phase plan Visual Specification ← area-level layout patterns
  ↓ referenced by
Phase plan Visual Specification       ← page-specific specs
```

### 6.2 Reference chain

Each visual spec must explicitly reference the level above:
- Major phase spec: "Following the visual language defined in .claude/visual-language.md..."
- Phase spec: "Within the [major phase] layout, this phase implements..."

### 6.3 Design review verifies the chain

- Does the visual spec reference visual-language.md? If not: QUALITY finding.
- Does the visual spec reference the parent major phase spec? If not: QUALITY finding.
- Does the built output match the referenced spec? If not: severity depends on deviation.

**Files to modify:** `pm:plan.md`, `design-loop.md`

---

## Verification

1. `node lib/pipeline-cli.js validate` — passes with existing .goals.json
2. `npx agent-pipeline init` on a fresh directory — scaffolds all new files (`.design/memory/`, `.claude/visual-language.md`, `.claude/design-loop.md`, `.claude/design-reference.md`)
3. Run ship.js on a UI project — design review dispatches, writes to memory, quality gate functions
4. Run two consecutive phases — second phase's PM reads design findings from first, visual language is referenced not reinvented
5. All existing tests pass
