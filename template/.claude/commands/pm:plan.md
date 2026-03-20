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

1. Create phase:
   node lib/pipeline-cli.js add-phase --title "Name" --desc "Summary" --planFile "plans/slug.md"

2. For each task:
   node lib/pipeline-cli.js add-task phaseId --title "Name" --desc "Description" --files "a.js,b.js"

3. Validate:
   node lib/pipeline-cli.js validate
   node lib/validate-plan.js --phase phaseId
</step>

<step name="diagram">
Build a React Flow diagram for the phase and store in .goals.json.

Research the domain with an Explore agent first. Then build using
Turbo Flow design system: TurboNode (conic gradient borders, dark inner,
icon + title + subline + fields), TurboEdge (bezier, gradient stroke,
label pills), GroupNode (tinted backgrounds).

Layout: 3-column grid (COL=400, cx(c) = c*COL, ry(r) = r*240).

Fit check: if parent majorPhase has diagrams, verify entry/exit points
match, use same color group and naming conventions.

Write JSON to temp file, store via:
  node lib/pipeline-cli.js add-diagram phaseId --title "Phase: name" --jsonFile /tmp/diagram.json

Render, screenshot, verify layout. Fix before finalizing.
</step>

<step name="report">
Tell the user: plan file location, phase + task count, diagram added,
recommended first task for /build.
</step>

<guardrails>
- Don't create tasks without a plan file
- Don't modify existing phases/tasks — only add
- Don't skip the review step
- Keep task descriptions concise
- Follow CLAUDE.md conventions
</guardrails>
