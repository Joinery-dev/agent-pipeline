# Protocol Optimization

## Metric
Benchmark score (0.0-1.0) from eval.js — higher is better.

## What CAN change
- Wording and specificity within existing steps
- Emphasis on patterns, failure categories, or quality checks
- Adding sub-checks, references to memory files, clarifying examples
- Removing vague or generic instructions that add noise

## What must NOT change
- The overall step sequence and structure
- Pipeline-cli.js usage for all .goals.json writes
- Test-running requirements
- Role boundaries (Builder never marks tasks completed, etc.)
- The guardrails/ownership sections
- Exec: the escalation decision framework (CONTINUE/RESTART binary)
- Exec: the pipeline meta-knowledge section (phase boundary rules, common failure modes)
- PM: the research step structure (search -> fetch -> synthesize)

## Strategy
- One hypothesis per experiment (single targeted change)
- If the same failure mode appeared in multiple reverted experiments, try a different approach
- Prefer adding specificity over adding new steps
- Prefer removing noise over adding content
- Read the experiment history carefully — don't repeat hypotheses that were already reverted
