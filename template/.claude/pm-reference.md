# PM Reference — Memory File Formats and Procedures

Read this file when you need to write to .pm/memory/ files. Not needed
for status reports — only for memory updates.

---

## Memory Files (update after EVERY interaction)

### decisions.md
Format: `## YYYY-MM-DD — Title` → Decision, Why, Alternatives considered

### concerns.md
```
## SEVERITY — Title
**Opened:** YYYY-MM-DD
**Status:** OPEN | WATCHING | ESCALATED | RESOLVED
**Description:** ...
**Resolution:** (filled when resolved)
```
- New concerns start OPEN
- 3+ sessions without resolution → ESCALATED (call out prominently)
- When resolved: change status, add resolution, don't delete

### reviews.md
```
## YYYY-MM-DD — Title
**Scope:** what was reviewed
**Verdict:** PASS | PASS WITH ITEMS | FAIL | BLOCKED
**Action items:** (with status: DONE / OPEN)
**Follow-up:** did previous action items get addressed?
```

### status.md
- Last review date + delta since last review
- Branch state
- Pipeline state
- Goals snapshot (phase names + completion %)
- Top concerns + open action items

---

## Memory Hygiene

### Size caps
- decisions.md — last 20 entries, archive older
- concerns.md — RESOLVED older than 30 days → archive
- reviews.md — last 15, archive older
- status.md — overwritten each time

### Staleness audit
Check each OPEN concern against code and git. If fixed, resolve with:
`**Resolution:** auto-resolved — verified fixed in {commit}`

### Recovery
If memory file missing/corrupted:
1. Check git log for last good version
2. Restore from git or reconstruct from observable state
3. Flag to user: "Reconstructed — may be incomplete"

---

## Research Briefs (.pm/research/)

Research briefs are produced by `/pm:research` and consumed by `/pm:plan`.

### Format
```
# Research: {Topic}

**Date:** YYYY-MM-DD
**Focus:** {what was researched and why}
**Project context:** {how this relates to our project}

## Key Findings
{3–5 most important takeaways}

## Competitor Analysis
### {Name}
- **What they do:** ...
- **Strengths:** ...
- **Weaknesses:** ...
- **Relevant to us:** ...

## Best Practices
{Specific, actionable — not generic advice}

## Design Patterns
{UI/UX patterns with concrete examples}

## Technical Approaches
{Architecture patterns, libraries — only if relevant}

## Recommendations for Planning
{5–10 actionable items framed as "Our plan should..."}

## Sources
{URLs with one-line descriptions}
```

### Lifecycle
- Created by `/pm:research` before planning
- Read by `/pm:plan` to inform plan decisions
- Not modified after creation — run research again for updates
- ship.js auto-skips research if a brief already exists for the topic

---

## Ownership
- You OWN .goals.json structure and .pm/memory/
- You READ .qa/memory/status.json and regressions.md
- If QA blocks a plan, acknowledge in decisions.md before overriding

## After /pm:review — Goals sync
If reviewed code relates to a task, add review verdict to attempt notes.
If PASS and task in-progress, recommend completed.

## After concern resolution — Goals sync
If a resolved concern maps to a task, update task status.
