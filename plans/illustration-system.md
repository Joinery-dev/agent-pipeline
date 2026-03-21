# Illustration System — Visual Mockups in the Agent Pipeline

## Goal

Give the pipeline actual visual mockups that show what each page/feature should look like before it's built. Stored in .goals.json like diagrams, viewable in the Goals Side Panel, nested so child illustrations zoom into parent illustrations, and used by QA and design review as the ground truth for "does this match the plan?"

## Why This Matters

The visual spec is text: "Layout: alternating editorial sections, warm amber accents." The builder interprets that however it wants. Two builders reading the same spec produce visually different pages. Nobody catches it because there's no visual reference — only words describing visuals.

With illustrations, the PM creates a simple HTML mockup showing the actual layout, colors, and proportions. That mockup becomes the visual contract. QA screenshots the built page and compares it against the mockup. Design review evaluates spec compliance against something visible, not prose.

## Architecture Fit

Illustrations follow the exact same patterns as diagrams:

| Aspect | Diagrams | Illustrations |
|---|---|---|
| Storage | `diagrams[]` on entity in .goals.json | `illustrations[]` on entity in .goals.json |
| CLI | `add-diagram --jsonFile` | `add-illustration --imagePath --htmlSource` |
| Validation | nodes/edges checked | imagePath exists, region valid |
| Nesting | entry/exit nodes | region field (x, y, width, height in parent) |
| Fit check | edges match parent | region exists within parent dimensions |
| Viewer | app/visualize (React Flow) | Goals Side Panel (image display) |
| API | /api/diagrams | /api/illustrations |
| PM creates | required step in pm:plan | required step in pm:plan (UI phases) |
| QA uses | diagram sync in forest | mockup-vs-built comparison |
| Design uses | consistency check | primary spec compliance reference |

---

## Phase 1: Schema and Storage

### 1.1 .goals.json schema

```
Illustration (optional on Project, MajorPhase, Phase)
├── id: string (UUID)
├── title: string
├── imagePath: string (relative path to PNG)
├── htmlSource: string (relative path to source HTML mockup)
├── viewport: { width: number, height: number }
├── region?: { x: number, y: number, width: number, height: number }
│            (where this illustration sits within its parent's illustration)
├── parentIllustrationId?: string (links to the parent's illustration)
├── createdAt: string (ISO 8601)
└── updatedAt: string (ISO 8601)
```

### 1.2 Nesting via regions

```
Project illustration: full product (all pages thumbnailed side by side)
├── region defined: null (this is the root)
│
Major phase illustration: full page mockup
├── region in parent: { x: 200, y: 0, width: 400, height: 600 }
│   (points to where this page's thumbnail is in the project illustration)
│
Phase illustration: specific section of the page
├── region in parent: { x: 0, y: 0, width: 1280, height: 500 }
│   (points to the hero area within the major phase's full page mockup)
```

The region says "I am a zoomed-in view of THIS area in my parent." The Goals Side Panel can draw a highlight box on the parent to show where the child zooms into.

### 1.3 Validation in pipeline.js

Add to `validateGoals()`:
- If `illustrations[]` present, check each has: id, title, imagePath, createdAt, updatedAt
- If `region` present, check it has x, y, width, height (all numbers >= 0)
- If `parentIllustrationId` present, verify that ID exists somewhere in the goals tree
- Don't error when absent — backwards compatible

**Files to modify:** `lib/pipeline.js`

---

## Phase 2: CLI Command

### 2.1 `add-illustration` command

```bash
node lib/pipeline-cli.js add-illustration <entityId> \
  --title "Homepage Hero" \
  --imagePath ".design/illustrations/homepage-hero-desktop.png" \
  --htmlSource ".design/illustrations/homepage-hero.html" \
  --viewport "1280x800" \
  --parentIllustration <parentIllustrationId> \
  --region "0,0,1280,500"
```

- Validates imagePath exists on disk
- Validates htmlSource exists on disk (if provided)
- Validates parentIllustrationId exists in .goals.json (if provided)
- Parses viewport "WxH" into { width, height }
- Parses region "x,y,w,h" into { x, y, width, height }
- Creates { id, title, imagePath, htmlSource, viewport, region, parentIllustrationId, createdAt, updatedAt }
- Pushes to `entity.illustrations[]`
- Writes via `writeGoals()`

**Files to modify:** `lib/pipeline-cli.js`

---

## Phase 3: Mockup Rendering Script

### 3.1 `lib/render-mockup.js`

Standalone script that takes an HTML file and produces PNG screenshots:

```bash
node lib/render-mockup.js --html .design/illustrations/homepage.html \
  --output .design/illustrations/homepage-desktop.png \
  --viewport 1280x800

node lib/render-mockup.js --html .design/illustrations/homepage.html \
  --output .design/illustrations/homepage-mobile.png \
  --viewport 375x812
```

- Uses Playwright to render the HTML file
- Takes a full-page screenshot
- Saves to the specified output path
- Returns JSON: { output, viewport, fileSize }
- Gracefully skips if Playwright not installed

Ship.js calls this after the PM writes mockup HTML, before storing the illustration.

**Files to create:** `lib/render-mockup.js`

---

## Phase 4: PM Workflow

### 4.1 HTML mockup conventions

Add to pm:plan instructions. When creating an illustration:

- Create `.design/illustrations/<slug>.html` — a single static HTML file
- Use tokens from `.claude/visual-language.md` (colors, fonts, spacing)
- Keep it simple — show layout, proportions, content hierarchy
- No JavaScript, no frameworks, no external dependencies
- Inline all CSS
- Use real-ish content (not lorem ipsum) — headlines, button text, section labels
- Show the grid: where things are, how big they are relative to each other
- Include placeholder boxes for images (colored rectangles with labels)
- Mobile: create a separate HTML or use responsive CSS in the same file

### 4.2 Nesting workflow

When the PM creates:

**Project-level illustration:**
- Shows all pages as thumbnails arranged in a layout
- Each thumbnail is a simplified version of the full page
- Labels identify which major phase each page belongs to

**Major phase illustration:**
- Full page mockup at 1280px
- All sections shown with correct proportions
- Labeled regions for each sub-phase's area
- Reference: "This is where [phase title] fits: the hero section, top 500px"

**Phase illustration:**
- Zoomed-in view of just this phase's section
- More detail than the parent — actual content, button styles, spacing
- Region field references where this sits in the parent

### 4.3 PM:plan step

New step between "create-goals" and "diagram":

```
<step name="illustration">
If this is a UI phase:

1. Check if parent entity has an illustration
2. Write HTML mockup to .design/illustrations/<slug>.html
   using visual-language.md tokens
3. Render to PNG via: node lib/render-mockup.js --html <file> --output <png> --viewport 1280x800
4. Also render mobile: node lib/render-mockup.js --html <file> --output <png-mobile> --viewport 375x812
5. Store via: node lib/pipeline-cli.js add-illustration <entityId> --title "..." --imagePath <png> --htmlSource <html>
6. If parent has an illustration, include --parentIllustration and --region

Fit check: if parent illustration exists, verify this illustration's
content matches the region the parent shows for this area.
</step>
```

### 4.4 Guardrail

Add to guardrails: "Don't skip the illustration step for UI phases — QA and design review check against it."

**Files to modify:** `.claude/commands/pm:plan.md`

---

## Phase 5: QA Integration

### 5.1 Ralph-loop update

In Step 3 (CHECK), add after visual spec check:

```
7. **Mockup comparison** — if the phase has illustrations[] in .goals.json:
   - Take a screenshot of the built page
   - Compare layout, proportions, colors against the mockup illustration
   - Flag significant deviations as tree findings (blocking)
   - The mockup is the visual contract — "does the built page match the mockup?"
```

### 5.2 Comparison approach

Not pixel-perfect diffing (too brittle). Instead:
- Are the same sections present in the same order?
- Are the proportions roughly right (hero takes ~viewport height, sections have similar padding)?
- Are the colors from the same palette?
- Is the content hierarchy the same (what's biggest, what's smallest)?

### 5.3 Design memory update

`.design/memory/status.json` adds mockup comparison scores:
```json
{
  "mockupCompliance": {
    "/": { "score": 0.85, "notes": "Layout matches, colors slightly off" },
    "/about": { "score": 0.92, "notes": "Close match" }
  }
}
```

**Files to modify:** `.claude/ralph-loop.md`, `.claude/design-loop.md`

---

## Phase 6: Design Review Integration

### 6.1 Design-loop update

In Step 3 (SPEC CHECK), the mockup illustration becomes the PRIMARY reference:

```
If the phase has illustrations in .goals.json:
  - The illustration IS the spec. Compare built screenshots against it.
  - Point-by-point: layout match? Hierarchy match? Colors match? Proportions match?
  - Grade the match: A (near-identical) through F (completely different)
  - This replaces text-based spec checking — the image is more precise than words

If no illustration exists:
  - Fall back to text visual specification (current behavior)
  - Note absence as QUALITY finding
```

### 6.2 Forest check with illustrations

In Step 4 (CONSISTENCY):
- Compare all pages' illustrations against each other — do they use the same palette, spacing, component patterns?
- Compare built pages against each other AND against their mockups
- Flag: "Page A matches its mockup but Page B doesn't" = inconsistent build quality

**Files to modify:** `.claude/design-loop.md`

---

## Phase 7: Viewer and API

### 7.1 API route

`app/api/illustrations/route.js` — serves all illustrations from .goals.json:

```javascript
// Same pattern as /api/diagrams
// Collects illustrations[] from project, majorPhases, phases
// Returns flat array with _source context
```

### 7.2 Goals Side Panel

The Electron app needs to:
- Read `illustrations[]` from entities (same way it reads `diagrams[]`)
- Display the image from `imagePath`
- Show parent-child nesting: clicking a region in the parent navigates to the child
- Display comparison: mockup on left, built screenshot on right (if both exist)

This is a Goals Side Panel change, not an agent-pipeline change. Note it here for implementation.

**Files to create:** `app/api/illustrations/route.js`

---

## Phase 8: Scaffolding

### 8.1 init.js additions

- Create `.design/illustrations/` directory
- Add `render-mockup.js` to lib files list
- Add `app/api/illustrations/route.js` to viewer files

### 8.2 agent-protocol.md additions

Document Illustration schema alongside Diagram schema.

### 8.3 pipeline-cli.js help text

Add `add-illustration` to the commands list.

**Files to modify:** `bin/init.js`, `.claude/agent-protocol.md`, `lib/pipeline-cli.js`

---

## Phase 9: Builder Integration

### 9.1 Builder reads illustrations

Update `build.md` startup:
- Read illustrations on the phase entity — this is what the page should look like
- Reference the mockup when making visual decisions
- If the mockup shows amber CTAs on a navy hero, build that — don't improvise

### 9.2 Builder self-review includes mockup check

Update `build.md` self-review step:
- After building, take a screenshot of the page
- Visually compare against the mockup illustration
- If it looks significantly different, adjust before logging success

**Files to modify:** `.claude/commands/build.md`

---

## Verification

1. `node lib/pipeline-cli.js validate` — passes with existing .goals.json (no illustrations = OK)
2. `node lib/pipeline-cli.js add-illustration <id> --title "Test" --imagePath <png>` — works
3. `node lib/render-mockup.js --html test.html --output test.png --viewport 1280x800` — produces PNG
4. `npx agent-pipeline init` scaffolds `.design/illustrations/`, render-mockup.js, /api/illustrations
5. PM creates mockup HTML → render → store → visible in Goals Side Panel
6. QA compares built page against mockup illustration
7. Design review uses mockup as primary spec reference
8. Nested illustrations show region highlighting in Goals Side Panel
