# agent-pipeline

A multi-agent build pipeline for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Four specialized agents — PM, Builder, QA, and Resolver — collaborate through a shared state file (`.goals.json`) with schema-enforced validation, attempt tracking, and pipeline escalation.

## Quick Start

```bash
npx agent-pipeline init
```

This scaffolds into your project:

| What | Where |
|------|-------|
| Agent slash commands | `.claude/commands/` |
| Agent protocol docs | `.claude/agent-protocol.md`, `.claude/ralph-loop.md` |
| Pipeline engine | `lib/pipeline.js`, `lib/pipeline-cli.js` |
| Pipeline sync | `lib/pipeline-sync.js`, `lib/validate-plan.js` |
| Merge lifecycle | `lib/merge.js` |
| Project state | `.goals.json` |
| PM memory | `.pm/memory/` |
| QA memory | `.qa/memory/` |
| Plan files | `plans/` |

Files that already exist are skipped — safe to run on an existing project.

## How It Works

### The Pipeline

```
/pm:plan → /build → /qa → PASS → complete
                      │
                      ▼ FAIL
                   /resolve → /qa (recheck) → PASS → complete
                      │
                      ▼ FAIL
                   /pm (re-analyze) → /build → ...
                      │
                      ▼ FAIL (2x)
                   STOP — needs human intervention
```

### The Agents

| Command | Role | Owns |
|---------|------|------|
| `/pm` | Technical Program Manager. Owns project structure, tracks status, manages concerns. | `.goals.json` structure, `.pm/memory/` |
| `/pm:plan` | Creates plans + goals entries + phase diagrams in one step. | `plans/` |
| `/build` | Disciplined builder. Follows plans, logs attempts, stops on failure. | Source code |
| `/qa` | Quality engineer. Tests against plan criteria + vision fit. Never fixes code. | `.qa/memory/` |
| `/resolve` | Surgical fixer. Fixes exactly what QA flagged, nothing more. | (scoped writes) |
| `/debug` | Diagnostic tool. Reconstructs timeline, identifies root cause. | (read-only) |
| `/merge` | Safe merge lifecycle with conflict check, tests, and rollback. | (read-only) |
| `/pm:handoff` | End-of-session context preservation. | `.pm/memory/handoff.md` |
| `/pm:review` | Code review with structured verdicts. | `.pm/memory/reviews.md` |

### State Tracking

`.goals.json` is the single source of truth:

```
Project
└── majorPhases[]
    └── phases[]
        ├── tasks[]
        │   └── attempts[] (build, qa, build-fix, qa-recheck)
        ├── pipeline: { state, lastAgent, lastTimestamp }
        ├── dependsOn: phaseId[]
        ├── interfaceContract: { produces[], consumes[] }
        └── diagrams[]
```

All mutations go through `lib/pipeline-cli.js`, which enforces schema validation, status transitions, and atomic writes.

### Pipeline CLI

```bash
node lib/pipeline-cli.js validate
node lib/pipeline-cli.js add-phase --title "..." --desc "..."
node lib/pipeline-cli.js add-task <phaseId> --title "..." --desc "..."
node lib/pipeline-cli.js update-status <taskId> in-progress
node lib/pipeline-cli.js add-attempt <taskId> --type build --desc "..."
node lib/pipeline-cli.js update-attempt <taskId> <attemptId> --outcome success --notes "..."
node lib/pipeline-cli.js rollup <phaseId>
node lib/pipeline-cli.js set-pipeline <phaseId> awaiting-qa --agent build
node lib/pipeline-cli.js add-diagram <entityId> --title "..." --jsonFile /tmp/diagram.json
node lib/pipeline-cli.js check-deps <phaseId>
node lib/pipeline-cli.js stale-tasks
```

## Usage

After `init`, open Claude Code in your project and:

1. **`/pm`** — See project status (run this first to orient)
2. **`/pm:plan <topic>`** — Plan a feature or fix
3. **`/build <plan-name>`** — Build what was planned
4. **`/qa <plan-name>`** — Validate the build
5. **`/resolve`** — Fix QA failures surgically
6. **`/pm:handoff`** — Save context before ending a session

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Git (for merge lifecycle and branch management)

## License

MIT
