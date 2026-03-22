---
name: Design quality gate — implemented
description: Design quality gate is now enforced in ship.js. SHIP-BLOCKERs loop the full pipeline (build → QA → design) up to MAX_DESIGN_ROUNDS=3. Quality gate thresholds lowered to 1.
type: project
---

Completed 2026-03-22. Design quality gate is fully enforced:
- SHIP-BLOCKERs set pipeline state to `qa-failed`, looping the phase through build → QA → design
- MAX_DESIGN_ROUNDS = 3 safety valve prevents infinite loops
- Quality gate thresholds: 1 open concern blocks, 1 visual drift item blocks, 3+ recurring QA patterns blocks
- Round tracking via `.design/memory/status.json` (incremented each review, reset on pass)
