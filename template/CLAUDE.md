# Project

## Commands

- `npm run dev` — dev server
- `node --test tests/` — unit tests

## Code Conventions

- ES modules only — no CommonJS
- Server code in `lib/`, routes in `app/api/`, UI in `app/`, tests in `tests/`

## Git Protocols

- Commit to feature branches, not main
- Never force push
- Pull before push

## Agent Pipeline

This project uses the agent pipeline for structured development:
- `/exec <topic>` — strategic project decomposition (vision, phases, contracts, diagrams)
- `/pm` — project status and planning
- `/pm:research <topic>` — research best practices, competitors, and design patterns
- `/pm:plan <topic>` — create plans with goals tracking
- `/build <plan>` — execute plans
- `/qa <plan>` — validate builds
- `/resolve` — fix QA failures

See `.claude/agent-protocol.md` for the full schema and conventions.

## Do's and Don'ts

- DO ask before committing, pushing, or writing files when the user only asked a question
- DO distinguish questions from instructions
- DON'T hardcode values that should be configurable
- DON'T create files unless necessary — edit existing ones
