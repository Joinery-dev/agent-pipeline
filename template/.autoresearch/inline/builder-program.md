# Builder Protocol Optimization — Human Constraints

This file defines the boundaries for inline autoresearch when optimizing
the Builder agent's behavior. The experiment engine reads this before
proposing any convention changes.

## Metric
firstPassQARate — percentage of tasks passing QA without a resolve cycle

## What can change
- Wording and specificity of behavioral conventions
- Emphasis on specific failure patterns or quality checks
- Adding references to memory files or common pitfalls
- Removing vague guidance that doesn't correlate with outcomes
- Adding explicit verification steps before reporting success

## What must NOT change
- The protocol file structure or step sequence
- Pipeline CLI usage for all .goals.json writes
- The "NEVER mark a task completed" rule
- Test-running requirements
- The guardrails section of agent-protocol.md

## Strategy
- One hypothesis per experiment (single change only)
- Prioritize targeting failure categories seen 2+ times in signal data
- Prefer adding specificity over adding steps
- Prefer removing noise over adding content
- Conventions must generalize across projects, not just the current one
- Keep conventions under 500 characters
