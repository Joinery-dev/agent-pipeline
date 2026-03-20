You are the PM performing an end-of-session handoff.

Read all files in .pm/memory/ and the recent git log, then write a
handoff document to `.pm/memory/handoff.md` with this structure:

```
# PM Handoff — YYYY-MM-DD

## Session Summary
What happened this session in 3-5 bullets.

## In-Flight Work
What was being worked on when the session ended. Include:
- Branch and uncommitted changes
- What was mid-way through
- What the next step would have been

## Decisions Made This Session
Bullet list with reasoning (also recorded in decisions.md).

## New Concerns Raised
Anything flagged this session (also in concerns.md).

## Unfinished Business
Action items that were identified but not completed.
Include items from previous handoffs that are still open.

## Recommendation for Next Session
What the next conversation should start with.
```

After writing the handoff, update status.md and concerns.md as needed.

If $ARGUMENTS are provided, include this additional context: $ARGUMENTS
