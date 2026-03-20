<identity>
PM creating a plan tracked in both plans/ and .goals.json.
Creates the plan file AND the goals entries in one step.
</identity>

<input>$ARGUMENTS — topic or feature to plan.</input>

<step name="research">
1. Read CLAUDE.md and .claude/agent-protocol.md
2. Read .claude/project-conventions.md if it exists
3. Read .goals.json for current state and existing phases
4. Read .pm/memory/ for context, concerns, prior decisions
5. Read any existing plans in plans/ that relate to the topic
6. Explore the codebase around this topic
</step>

<step name="write-plan">
Create plans/{topic-slug}.md:
- Goal statement
- Architecture fit (how it connects to existing systems)
- Major steps (high-level)
- Tasks with success criteria (each buildable unit)
- Diagrams where they clarify structure

The plan is the source of detail. Goals entries are concise pointers.
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
describes the work. The diagram shows the architecture — components, modules,
pages, APIs, data stores, and how they connect.

At each level, diagram what the system looks like when this work is done:
- **Project level** — the major systems/areas and how they integrate
- **Major phase level** — the components/modules being built and their interfaces
- **Phase level** — the files, APIs, data flows, and how they connect

Nodes = components, modules, pages, APIs, data stores, services.
Edges = data flow, API calls, imports, user navigation.
NOT nodes = tasks, work items, build steps.

The diagram should be something a developer looks at and says "oh, that's how
the system fits together" — not "that's the order we build things."

**Nested hierarchy:** Diagrams zoom in like a map. A node in the project diagram
(e.g., "Auth System") has its own detailed diagram at the major phase level
showing the components inside it (login page, JWT middleware, user store, etc.).

**Parent diagram update:** If this new plan adds a phase that isn't represented
in the parent's diagram, update the parent diagram to include it.

**Design system:** Turbo Flow — TurboNode (conic gradient borders, dark inner,
icon + title + subline + fields), TurboEdge (bezier, gradient stroke, label
pills), GroupNode (tinted backgrounds). 3-column grid layout (COL=400,
cx(c) = c*COL, ry(r) = r*240).

**Fit check:** Read parent entity's diagram. Verify:
- This diagram's entry points match what the parent shows flowing in
- This diagram's exit points match what the parent shows flowing out
- Same color group and naming conventions as parent assigns

Write JSON to temp file, store via:
  node lib/pipeline-cli.js add-diagram <entityId> --title "name" --jsonFile /tmp/diagram.json
</step>

<step name="report">
Tell the user: plan file location, phase + task count, diagram added,
recommended first task for /build.
</step>

<guardrails>
- Don't create tasks without a plan file
- Don't modify existing phases/tasks — only add
- Don't skip the review step
- Don't skip the diagram step — every plan gets a diagram
- Keep task descriptions concise
- Follow CLAUDE.md conventions
</guardrails>
