You are the PM creating a plan that is tracked in both `plans/`
and `.goals.json`. This command creates the plan file AND the goals
entries in one step.

---

## Input

`$ARGUMENTS` — topic or feature to plan.

---

## Step 1: Research

Before writing anything:
1. Read CLAUDE.md for project conventions
2. Read `.claude/agent-protocol.md` for shared conventions
3. Read `.goals.json` for current project state and existing phases
4. Read `.pm/memory/` for context, concerns, and prior decisions
5. Read any existing plans in `plans/` that relate to the topic
6. Explore the codebase to understand the current architecture around this topic

---

## Step 2: Write the plan

Create `plans/{topic-slug}.md` following the existing plan format:
- Goal statement
- Architecture fit (how it connects to existing systems)
- Major steps (high-level)
- Tasks with success criteria (each task is a buildable unit)
- Diagrams where they clarify structure

The plan is the source of detail. Goals entries are concise pointers.

---

## Step 3: Self-review

Run two review passes on the plan using the Agent tool:

**Pass 1: Architecture and quality review**
- Does it fit the existing architecture?
- Are success criteria testable?
- Are tasks ordered correctly (dependencies flow downward)?
- Is anything over-engineered or under-specified?

**Pass 2: Builder executability review**
- For each task: can the builder execute this unambiguously?
- Are there decisions the builder will have to make that aren't covered?
- Does each task name a specific area of the codebase (not vague like "update the system")?
- Are the `files[]` hints populated where possible?
- If a task depends on a previous task's output, is that dependency explicit?

Fix issues found in either pass before proceeding.

---

## Step 4: Create goals entries via Pipeline CLI

Use `lib/pipeline-cli.js` for all .goals.json mutations:

1. Create the phase:
```bash
node lib/pipeline-cli.js add-phase --title "Phase Name" --desc "One-line summary" --planFile "plans/topic-slug.md"
```
Save the returned `phaseId`.

2. For each plan task, create a task:
```bash
node lib/pipeline-cli.js add-task <phaseId> --title "Task Name" --desc "Concise description" --planFile "plans/topic-slug.md" --files "file1.js,file2.js"
```

3. Validate schema:
```bash
node lib/pipeline-cli.js validate
```

4. Validate plan quality:
```bash
node lib/validate-plan.js --phase <phaseId>
```
Fix any errors before proceeding. Warnings are advisory.

IDs, timestamps, and schema validation are handled automatically by pipeline-cli.

---

## Step 5: Create phase diagram

Build a React Flow diagram for the phase and store it in `.goals.json` via the pipeline CLI.

### 5a. Research the domain

Use an Explore agent to read the source code around this phase's topic. Trace inputs, outputs, data shapes, and connections. Understand the architecture before diagramming.

### 5b. Build the diagram

Follow the Turbo Flow design system exactly:
- **TurboNode**: conic gradient borders, dark `.inner`, icon + title + subline + fields
- **TurboEdge**: `getBezierPath`, gradient stroke, monospace label pills
- **GroupNode**: subtle tinted backgrounds (4-6% opacity) and accent borders
- **3-column grid layout**: `COL=400, cx(c) = c*COL, ry(r) = r*240`
- **Edge labels**: short (2-4 words) + full description in `data.flow`
- **Click-to-inspect**: detail text via `data.detail` on nodes

**Phase-level diagram content:**
- Each task as a `turbo` node (title, description snippet, file hints as fields)
- Task dependencies as edges
- Group nodes for logical clusters (e.g., "Data Layer", "API Layer", "UI Layer")

**Field names for .goals.json diagrams:** use `data.title` (not `data.label`) and `data.subline` (not `data.subtitle`). These match the Goals Side Panel types.

### 5c. Fit check

Before writing:
1. Find the parent majorPhase. If it has `diagrams[]`, read them
2. Find the node in the parent diagram that represents this phase
3. **Data contract check:** verify the new diagram's entry/exit points match what the parent expects (inputs coming in, outputs going out)
4. **Visual consistency:** use the same color group the parent assigns to this phase, same design system, same naming conventions
5. If no parent diagram exists, skip the fit check

### 5d. Write the diagram

Write the diagram JSON (nodes + edges) to a temp file, then store via CLI:
```bash
# Write the JSON to a temp file
# (nodes and edges arrays only — id/title/timestamps added by CLI)
cat > /tmp/diagram-<phaseId>.json << 'EOF'
{ "nodes": [...], "edges": [...] }
EOF

node lib/pipeline-cli.js add-diagram <phaseId> --title "Phase: <name>" --jsonFile /tmp/diagram-<phaseId>.json
```

### 5e. Playwright verification

Render the diagram, take a screenshot, verify layout quality. Fix edge spaghetti, overlapping groups, or unreadable labels before finalizing. Follow the same iterative screenshot loop as `/diagram`.

### Diagram detail levels

| Level      | Node granularity              | Edge meaning              |
|------------|------------------------------|---------------------------|
| Project    | One per major phase           | Phase dependencies        |
| MajorPhase | One per phase                 | Sequence / data flow      |
| Phase      | One per task + key modules    | Task deps, data contracts |
| Task       | One per file/function         | Call graph / data flow    |

---

## Step 6: Report

Tell the user:
- Plan file location
- Phase and task count added to .goals.json
- Diagram added (title, node/edge count)
- Recommended first task for `/build`

---

## Guardrails

- Do NOT create tasks in .goals.json without a corresponding plan file
- Do NOT modify existing phases or tasks — only add new ones
- Do NOT skip the self-review step
- Keep task descriptions concise — the plan file has the detail
- Follow all conventions from CLAUDE.md
