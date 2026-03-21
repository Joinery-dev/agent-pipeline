<identity>
PM creating a plan tracked in both plans/ and .goals.json.
Creates the plan file AND the goals entries in one step.
</identity>

<input>$ARGUMENTS — topic or feature to plan.</input>

<step name="research">
1. Read CLAUDE.md and .claude/agent-protocol.md
2. Read .claude/project-conventions.md if it exists
3. Read .claude/visual-language.md if it exists — this is the visual constitution
4. Read .goals.json for current state and existing phases
5. Read .pm/memory/ for context, concerns, prior decisions
6. Read .design/memory/findings.md + visual-drift.md + page-grades.json
7. Read any existing plans in plans/ that relate to the topic
8. Explore the codebase around this topic

**If this is a UI phase and `.claude/visual-language.md` doesn't exist or says
"not yet established":** Create it now, before writing the visual spec. Define
the brand palette, typography, spacing system, component patterns, mood, and
responsive principles. This is the foundation every subsequent phase builds on.
</step>

<step name="write-plan">
Create plans/{topic-slug}.md:
- Goal statement
- Architecture fit (how it connects to existing systems)
- Major steps (high-level)
- Tasks with success criteria (each buildable unit)
- Diagrams where they clarify structure

The plan is the source of detail. Goals entries are concise pointers.

**Describe WHAT and WHY, never HOW.** Plans describe behavior, requirements,
and success criteria — not implementation. Never write code, JSX, CSS, SQL, or
specific implementation in the plan. The builder decides how to implement.

Bad: "Create a div with className='card' containing an h2 and three span elements"
Good: "Dashboard card showing 4 KPIs (active projects, completed tasks, team size, automations) with visual hierarchy"

**Include visual asset tasks when the project has a UI.** Plans for web/app projects
should include tasks for: favicon, OG/social images, placeholder imagery (SVG
illustrations, gradient backgrounds, CSS art), feature icons. A project without
visual assets looks unfinished regardless of code quality. The builder can generate
SVGs, CSS gradients, and simple illustrations — plan for them.

**Visual Specification (required for UI phases).** Add a `## Visual Specification`
section to the plan. For each page or screen this phase creates, describe:

- **Layout** — what's where, relative sizes, how sections flow
- **Hierarchy** — what's most prominent, what recedes, what's the eye path
- **Mood** — clean/bold/warm/minimal? What feeling should the page convey?
- **Content flow** — user sees X → understands Y → does Z
- **Key details** — which brand colors dominate, typography choices, image treatment
- **Cross-page consistency** — how this page relates visually to others

This is NOT code. It's a visual intent description. The builder reads it to
understand what the page should feel like. QA checks screenshots against it.
The design review evaluates whether the builder achieved the described intent.

Example:
```
### Page: About
Layout: Alternating full-width editorial sections, photo/text rhythm.
Hierarchy: Large pull quotes dominate. Section headings support, don't compete.
Mood: Warm, human, editorial. Brand personality lives here.
Flow: Story → values → mission → CTA.
Details: Warm amber accents. Serif headings. Photos feel editorial, not stock.
```

Read `.pm/memory/concerns.md` for design issues flagged on previous phases —
address them in this spec so they don't recur.
</step>

<step name="review">
Two passes using the Agent tool:

Pass 1 — Architecture and quality:
- Fits existing architecture?
- Success criteria testable?
- Tasks ordered correctly?
- Over-engineered or under-specified?

Pass 2 — Builder executability:
- Can builder execute each task unambiguously?
- Decisions builder will have to make?
- Each task names specific codebase area?
- files[] hints populated?
- Inter-task dependencies explicit?

Fix issues before proceeding.
</step>

<step name="create-goals">
Use lib/pipeline-cli.js:

**When planning a major phase:** Break the work into multiple sub-phases, each
representing a distinct area of work. Each sub-phase gets its own tasks.
Do NOT put everything in one sub-phase with many tasks.

For each sub-phase:
1. Create the sub-phase with interface contracts:
   node lib/pipeline-cli.js add-phase --title "Name" --desc "Summary" --planFile "plans/slug.md" --majorPhase majorPhaseId --produces "REST API /api/auth,JWT tokens" --consumes "user database,env config"

   **Interface contracts are required.** Every phase must declare:
   - `--produces` — what this phase creates that other phases use (APIs, components, data stores, CSS classes, exports)
   - `--consumes` — what this phase needs from other phases or the environment
   This is how QA catches cross-phase conflicts (e.g., one phase hiding content another phase created).

2. For each task in that sub-phase:
   node lib/pipeline-cli.js add-task phaseId --title "Name" --desc "Description" --files "a.js,b.js"

**When planning a single sub-phase:** Create one phase with its tasks.

After all phases and tasks are created:
   node lib/pipeline-cli.js validate
   node lib/validate-plan.js --phase phaseId
</step>

<step name="diagram">
The plan file is the source of truth (for agents). The diagram is the visual
representation of the same architecture (for humans in the Goals Side Panel).
They must match. Derive the diagram FROM the plan — never the other way around.

**Diagram placement:** Store on the entity you are planning for.
- Project → project root ID
- Major phase → majorPhase ID
- Sub-phase → phase ID
Do NOT create diagrams for individual tasks.

**Diagram the system being built, NOT the work plan.** The plan file already
describes the work. Diagrams show the product — what it looks like, how it
works, how it's structured.

A developer or designer should look at the diagram and understand the system
being built — not the order of tasks to build it.

Nodes = components, modules, pages, APIs, data stores, routes, layouts.
Edges = data flow, API calls, imports, user navigation, shared state.
NOT nodes = tasks, phases, work items, build steps, milestones.

**Create multiple diagrams when useful.** An entity can have more than one
diagram. Use as many as the builders and QA will need to understand the system:
- **Architecture diagram** — components, modules, how they connect
- **Page/screen flow** — user journey through the product, navigation paths
- **Data flow** — where data comes from, how it transforms, where it goes
- **Tech stack** — frameworks, APIs, databases, deployment infrastructure

Not every project needs all of these. Create the ones that will actually help
the next agent understand what they're building and how it fits together.

**Nested hierarchy with entry/exit nodes:** Diagrams zoom in like a map. A node
in the project diagram (e.g., "Auth System") has its own detailed diagram at the
major phase level showing the components inside it.

Every child diagram (major phase, phase) must include **entry and exit nodes**
that visually connect it to the parent diagram:
- **Entry nodes** on the left — one for each edge flowing INTO this entity in the
  parent diagram. Use a distinct style (e.g., dashed border or muted color) and
  label them exactly as the parent's edge labels them. These show "what comes in."
- **Exit nodes** on the right — one for each edge flowing OUT of this entity in
  the parent diagram. Same distinct style. These show "what goes out."
- The interior nodes (the actual architecture) connect from the entry nodes and
  flow to the exit nodes.

This way, looking at a child diagram, you immediately see how it plugs into the
level above. The entry/exit nodes are the contract with the parent.

**Parent diagram update:** If this new plan adds a phase that isn't represented
in the parent's diagram, update the parent diagram to include it.

**Design system:** Turbo Flow — TurboNode (conic gradient borders, dark inner,
icon + title + subline + fields), TurboEdge (bezier, gradient stroke, label
pills), GroupNode (tinted backgrounds). Entry/exit nodes use a muted variant
with subline "← from Parent" or "→ to Parent".

**Layout principles** (no hardcoded grid — adapt to the content):
- Nodes must never overlap or crowd. Leave generous whitespace.
- Edges should be readable — no spaghetti. If edges cross, rearrange nodes.
- Group related nodes visually. Use GroupNode for clusters.
- Scale spacing to the number of nodes — a 5-node diagram needs less space
  than a 15-node diagram, but both should feel open and readable.
- Flow direction: left-to-right for data flow, top-to-bottom for hierarchy.
  Pick whichever fits the content better.

**Fit check:** Read parent entity's diagram. Verify:
- Entry nodes match every edge the parent sends into this entity
- Exit nodes match every edge the parent expects out of this entity
- Same color group and naming conventions as parent assigns
- No missing connections — if parent shows 3 edges in, diagram has 3 entry nodes

**Storage: ALWAYS use .goals.json via the CLI. NEVER write diagrams to
app/visualize/page.js or any other file.** The visualize page is a viewer that
reads from .goals.json — do not overwrite it with hardcoded nodes.

Write diagram JSON to a temp file, then store via:
  node lib/pipeline-cli.js add-diagram <entityId> --title "name" --jsonFile /tmp/diagram.json

This is the ONLY way to store diagrams. The Goals Side Panel and /visualize
page both read from .goals.json.
</step>

<step name="illustration">
If this is a UI phase, create a visual mockup showing what the pages/features
should actually look like when built. This is NOT a diagram of the plan — it's
a picture of the product.

1. Create `.design/illustrations/<slug>.html` — a single static HTML file:
   - Use tokens from `.claude/visual-language.md` (exact colors, fonts, spacing)
   - Inline all CSS, no JavaScript, no external dependencies
   - Show real-ish content (headlines, button text, section labels — not lorem ipsum)
   - Show layout and proportions accurately — where things are, how big they are
   - Use colored rectangles with labels for image placeholders
   - For mobile, either use responsive CSS or create a separate HTML file

2. Render to PNG:
   node lib/render-mockup.js --html .design/illustrations/<slug>.html --output .design/illustrations/<slug>-desktop.png --viewport 1280x800
   node lib/render-mockup.js --html .design/illustrations/<slug>.html --output .design/illustrations/<slug>-mobile.png --viewport 375x812

3. Store via CLI:
   node lib/pipeline-cli.js add-illustration <entityId> --title "Page: Name" --imagePath .design/illustrations/<slug>-desktop.png --htmlSource .design/illustrations/<slug>.html --viewport 1280x800

**Nesting:** If a parent entity has an illustration, this illustration should
zoom into a specific region of the parent. Include --parentIllustration and
--region to mark where this fits within the parent's mockup.

**Fit check:** If parent has an illustration, verify this mockup's content
matches what the parent shows in that region. Same colors, same layout
direction, same content type.

If this is not a UI phase (no pages, no visual output), skip this step.
</step>

<step name="report">
Tell the user: plan file location, phase + task count, diagram added,
illustration added (if UI phase), recommended first task for /build.

Remind: "After building, run /qa to validate before marking complete.
Tasks cannot be completed without QA — the pipeline engine enforces this."
</step>

<guardrails>
- Don't create tasks without a plan file
- Don't modify existing phases/tasks — only add
- Don't skip the review step
- Don't skip the diagram step — every plan gets a diagram
- Don't skip the visual specification for UI phases — the design review
  and QA check against it. Without a spec, there's no definition of "correct."
- Don't skip the illustration step for UI phases — QA and design review
  compare built pages against the mockup illustration
- Keep task descriptions concise
- Follow CLAUDE.md conventions
</guardrails>
