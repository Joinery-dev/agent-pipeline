# CLAUDE.md Optimization

## Metric
Agent benchmark score (0.0-1.0) — measures downstream agent performance when reading this file.

## Context
CLAUDE.md is the first file every agent reads. It sets conventions, tone, and global rules.
Small improvements here cascade across ALL agents (Builder, QA, Resolver, PM, Exec, Design).

## What CAN change
- Wording and specificity of conventions
- Adding project-level rules that improve agent behavior
- Reordering sections for better agent comprehension
- Adding agent-specific hints that help all agents perform better
- Strengthening or clarifying do's and don'ts
- Adding patterns the agents should follow or avoid

## What must NOT change
- The Commands section (project-specific, users customize this)
- The Agent Pipeline section (documents real slash commands)
- The reference to agent-protocol.md
- The overall structure (sections with ## headers)
- Must remain concise — agents read this in every session, bloat wastes context

## Strategy
- One hypothesis per experiment
- Focus on rules that prevent common failures across all agents
- Prefer specific, actionable rules over generic advice
- "Always run tests before logging success" is better than "be thorough"
- Keep total length under 60 lines — every line costs context in every agent session
