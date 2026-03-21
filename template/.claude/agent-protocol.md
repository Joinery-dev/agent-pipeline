# Agent Protocol — Shared Conventions

This file is the single source of truth for cross-agent contracts.
All agent commands (`/pm`, `/pm:plan`, `/build`, `/qa`, `/resolve`) reference this file.

---

## .goals.json Schema

```
Project (root)
├── id: string (UUID)
├── name: string
├── description: string
├── vision: string (project-level goal/milestone)
└── majorPhases: MajorPhase[]

MajorPhase (grouping layer)
├── id: string (UUID)
├── title: string
├── description: string
├── status: Status
├── phases: Phase[] (buildable work within this major phase)
├── order: number
└── summary: string (optional — auto-generated rollup of phase statuses)

Phase (nested inside a MajorPhase)
├── id: string (UUID)
├── title: string
├── description: string
├── status: "not-started" | "in-progress" | "completed" | "blocked"
├── planFile: string (relative path, e.g. "plans/topic-slug.md")
├── order: number (0-indexed, determines execution sequence)
├── tasks: Task[]
├── pipeline: { state, lastAgent, lastTimestamp } (explicit pipeline state)
├── dependsOn: string[] (optional — phase IDs that must be completed first)
└── interfaceContract: (optional) {
      produces: string[] (what this phase creates for downstream phases)
      consumes: string[] (what this phase needs from upstream phases)
    }

Task
├── id: string (UUID)
├── title: string
├── description: string
├── status: "not-started" | "in-progress" | "completed" | "blocked"
├── planFile: string (same as parent phase, or specific)
├── files: string[] (optional — hint for relevant file paths)
├── attempts: Attempt[] (flat list, no nesting)
└── createdAt: string (ISO 8601 timestamp)

Attempt (flat — NO children/nesting)
├── id: string (UUID)
├── type: "build" | "qa" | "build-fix" | "qa-recheck"
├── round: number (auto-incremented per type)
├── description: string
├── outcome: "in-progress" | "success" | "failure" | "partial"
├── notes: string
└── createdAt: string (ISO 8601 timestamp)

Pipeline State (on Phase)
├── state: "idle" | "building" | "awaiting-qa" | "qa-failed" | "complete"
├── lastAgent: "pm" | "build" | "qa" | "resolve" | null
└── lastTimestamp: string (ISO 8601) | null

Diagram (optional on Project, MajorPhase, Phase, Task)
├── id: string (UUID)
├── title: string
├── nodes: DiagramNode[]
├── edges: DiagramEdge[]
├── createdAt: string (ISO 8601)
└── updatedAt: string (ISO 8601)

DiagramNode
├── id: string
├── type: "turbo" | "group"
├── position: { x: number, y: number }
├── data:
│   ├── icon?: string
│   ├── title: string
│   ├── subline?: string
│   ├── fields?: { name: string, type: string }[]
│   ├── detail?: string
│   ├── color?: "purple" | "amber" | "blue" | "green" | "pink"
│   └── label?: string (group nodes only)
├── style?: Record<string, string | number>
├── parentId?: string (for nodes inside a group)
└── extent?: "parent"

DiagramEdge
├── id: string
├── source: string
├── target: string
├── type?: "turbo"
├── label?: string (short, 2-4 words)
├── data?: { flow?: string } (longer description)
└── markerEnd?: string
```

---

## .goals.json Write Protocol

**Preferred:** Use `lib/pipeline-cli.js` for all .goals.json operations:
```bash
# Project & structure
node lib/pipeline-cli.js update-project --name "..." --desc "..." --vision "..."
node lib/pipeline-cli.js add-major-phase --title "..." --desc "..." --produces "a,b" --consumes "c,d"
node lib/pipeline-cli.js update-major-phase <id|title> --desc "..." --produces "..." --consumes "..."
node lib/pipeline-cli.js get-major-phase <id|title>
node lib/pipeline-cli.js add-phase --title "..." --desc "..." --majorPhase <id|title> --produces "..." --consumes "..."
node lib/pipeline-cli.js add-task <phaseId> --title "..." --desc "..." --files "a.js,b.js"

# Pipeline state
node lib/pipeline-cli.js add-attempt <taskId> --type build --desc "..."
node lib/pipeline-cli.js update-attempt <taskId> <attemptId> --outcome success --notes "..."
node lib/pipeline-cli.js update-status <taskId> in-progress
node lib/pipeline-cli.js set-pipeline <phaseId> awaiting-qa --agent build
node lib/pipeline-cli.js rollup <phaseId>
node lib/pipeline-cli.js rollup-major <majorPhaseId|title>
node lib/pipeline-cli.js rollup-all
node lib/pipeline-cli.js get-state <phaseId>
node lib/pipeline-cli.js check-deps <phaseId>
node lib/pipeline-cli.js stale-tasks

# Artifacts
node lib/pipeline-cli.js add-diagram <entityId> --title "..." --jsonFile /tmp/diagram.json
node lib/pipeline-cli.js add-illustration <entityId> --title "..." --imagePath <png> --htmlSource <html>
node lib/pipeline-cli.js validate
```

This enforces schema validation, status transition rules, QA gates, and atomic writes.

**Hard gates enforced by the engine:**
- Tasks cannot be marked `completed` without a QA attempt with `outcome: success`
- `--majorPhase` accepts UUID, exact title, or substring title match
- `rollup-all` cascades from sub-phases up through major phases

**Fallback** (if pipeline-cli.js is unavailable):
1. **Read** — `JSON.parse(fs.readFileSync('.goals.json', 'utf-8'))`
2. **Mutate** — modify the in-memory object (never string manipulation)
3. **Write** — `fs.writeFileSync('.goals.json', JSON.stringify(data, null, 2))`
4. **Validate** — `node -e "JSON.parse(require('fs').readFileSync('.goals.json','utf-8'))"`

If malformed on read, **STOP** and alert the user — never auto-repair.

---

## ID Generation

All UUIDs are generated via Node.js:

```bash
node -e "console.log(crypto.randomUUID())"
```

Run this command for each ID you need. Never hardcode or reuse IDs.

---

## Structured Attempt Note Format

Both Builder and QA use this format for attempt `notes`:

```
## Files Changed
- path/to/file.js (created | modified | deleted)

## Approach
Brief description of what was done and why this approach was chosen.

## Tests
- Ran: node --test tests/relevant.test.js
- Result: N/N passing
- New tests written: [list or "none"]

## Risks / Watch Items
- Anything the next agent should pay attention to
```

Every field must be specific. "Various changes" or "Standard approach"
are not acceptable — if you can't be specific, you don't understand
what you just did.

---

## Severity Levels

Used by QA for criteria and by all agents for concerns/findings:

| Level    | Meaning                                              |
|----------|------------------------------------------------------|
| CRITICAL | Will break current or future functionality. Blocks.  |
| HIGH     | Will require significant rework. Should block.       |
| MEDIUM   | Inconsistency or tech debt. Track but don't block.   |

**CRITICAL means "will break", not "might be suboptimal".**
Don't inflate severity — it causes unnecessary rework cycles.

---

## Agent Ownership Matrix

| Resource                 | PM         | Builder    | QA         | Resolver   | Design     |
|--------------------------|------------|------------|------------|------------|------------|
| `.goals.json` structure  | **OWNS**   | reads      | reads      | reads      | reads      |
| `.goals.json` tasks/attempts | reads  | **WRITES** | **WRITES** | **WRITES** | reads      |
| `.pm/memory/`            | **OWNS**   | reads      | reads      | reads      | reads+writes concerns |
| `.qa/memory/`            | reads      | reads      | **OWNS**   | reads      | reads+writes patterns |
| `.design/memory/`        | reads      | reads      | reads      | reads      | **OWNS**   |
| `.claude/visual-language.md` | creates+updates | reads | reads  | reads      | reads+recommends |
| `plans/`                 | **OWNS**   | reads      | reads      | reads      | reads      |
| Source code              | reads      | **WRITES** | reads      | **WRITES** | reads      |
| Screenshots              | reads      | —          | takes      | —          | takes      |

- **OWNS** = creates, modifies, deletes
- **WRITES** = modifies specific fields within the owner's structure
- **reads** = read-only access

---

## Design Memory Schema

```
.design/memory/
├── status.json       — current state, grades, trajectory
├── findings.md       — per-phase findings log (append-only)
├── visual-drift.md   — where product diverges from visual-language.md
└── page-grades.json  — per-page grades with history

.design/illustrations/  — HTML mockup sources and rendered PNGs

.claude/visual-language.md  — visual constitution (palette, type, spacing, mood)
.claude/design-loop.md      — 8-step design review protocol
.claude/design-reference.md — memory format documentation
```

## Illustration Schema

```
Illustration (optional on Project, MajorPhase, Phase)
├── id: string (UUID)
├── title: string
├── imagePath: string (relative path to PNG)
├── htmlSource?: string (relative path to source HTML mockup)
├── viewport?: { width: number, height: number }
├── region?: { x: number, y: number, width: number, height: number }
│            (where this illustration sits within parent's illustration)
├── parentIllustrationId?: string
├── createdAt: string (ISO 8601)
└── updatedAt: string (ISO 8601)
```

Store via:
```bash
node lib/render-mockup.js --html <html> --output <png> --viewport 1280x800
node lib/pipeline-cli.js add-illustration <entityId> --title "Title" --imagePath <png> --htmlSource <html> --viewport 1280x800
```

---

## Status Enum Values

### Phase status
- `not-started` — no tasks have begun
- `in-progress` — at least one task is being worked on
- `completed` — all tasks completed and QA passed
- `blocked` — a task is blocked (dependency, QA failure, or error)

### Task status
- `not-started` — no attempts yet
- `in-progress` — builder is actively working
- `completed` — builder succeeded and QA passed
- `blocked` — QA failed or dependency not met

### Attempt outcome
- `in-progress` — currently being worked on
- `success` — builder or QA reports success
- `failure` — builder or QA reports failure
- `partial` — some criteria pass, some fail (QA only)

---

## Phase Status Rollup Rules

The PM is authoritative for phase status. Rollup logic:

1. **All tasks `completed`** → phase `completed`
2. **Any task `blocked`** → phase `blocked`
3. **Any task `in-progress`** → phase `in-progress`
4. **All tasks `not-started`** → phase `not-started`

Rules are evaluated in priority order (1 wins over 2, etc.).

---

## Pipeline Escalation Path

```
/pm:plan → /build → /qa → PASS → complete
                      │
                      ▼ FAIL
                   /resolve → /qa (recheck) → PASS → complete
                      │
                      ▼ FAIL
                   /pm (re-analyze) → /build → /qa → ...
                      │
                      ▼ FAIL (2x)
                   STOP — needs human intervention
```

- `/resolve` creates `build-fix` attempts (targeted fixes from QA diagnosis)
- `/qa` rechecks create `qa-recheck` attempts
- After resolver failure, PM is escalated to revise the plan
- After 2 PM re-plans with no progress, pipeline stops
