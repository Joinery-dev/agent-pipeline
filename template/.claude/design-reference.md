# Design Reference — Memory File Formats and Procedures

Read this file when you need to write to .design/memory/ files.

---

## Memory Files

### status.json
```json
{
  "lastRun": "ISO timestamp",
  "phase": "phase-title",
  "round": 1,
  "overallGrade": "B+",
  "specCompliance": { "met": 8, "total": 10 },
  "findings": { "shipBlockers": 0, "quality": 3, "polish": 5 },
  "trajectory": [
    { "phase": "Foundation", "grade": "B", "specCompliance": "6/8", "date": "..." }
  ]
}
```

### findings.md (append-only per phase)
```
## Phase: [title] — YYYY-MM-DD
- [SHIP-BLOCKER] description
- [QUALITY] description
- [POLISH] description
- [RESOLVED] previous finding "..." — now fixed
- [RECURRING] previous finding "..." — still present
```

### visual-drift.md
```
## Drift Log

### YYYY-MM-DD — Phase: [title]
- Category: description of drift from visual-language.md
- STATUS: DRIFTING | RESOLVED | ACCEPTED (PM updated visual-language.md)
```

### page-grades.json
```json
{
  "/route": {
    "grades": [
      { "phase": "phase-title", "grade": "B+", "date": "ISO", "notes": "..." }
    ]
  }
}
```

---

## Severity Levels

| Level | Meaning | Action |
|---|---|---|
| SHIP-BLOCKER | Fundamentally doesn't match spec or visually broken | PM creates fix plan, builder fixes, re-review |
| QUALITY | Noticeable deviation from spec or cross-page inconsistency | Saved to .pm/memory/concerns.md for next phase |
| POLISH | Minor refinement opportunity | Logged in findings.md only |

RECURRING findings (flagged 2+ times) get elevated one severity level.

---

## Ownership
- You OWN `.design/memory/` — no other agent writes here
- You READ `.claude/visual-language.md` (PM owns, you recommend updates)
- You READ+WRITE `.pm/memory/concerns.md` (write QUALITY+ findings)
- You READ+WRITE `.qa/memory/patterns.md` (write recurring visual patterns)
- You READ plan files and `.goals.json` (never modify)

---

## Visual Language Governance

`.claude/visual-language.md` is the visual constitution:
- **PM creates it** during the first UI phase
- **PM updates it** when design legitimately evolves
- **Design review recommends** updates but doesn't make them
- **If code drifts from the document**: code is wrong, not the document
- **If the document is outdated**: recommend PM update it in findings
