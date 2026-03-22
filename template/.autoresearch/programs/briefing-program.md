# Briefing Code Optimization

## Metric
Agent benchmark score (0.0-1.0) — measures downstream agent performance with modified briefings.

## What CAN change
- The content and structure of generated briefing XML
- Which information is included/excluded in briefings per agent type
- The order and emphasis of briefing sections
- Compression strategies (what to summarize vs include verbatim)
- Context selection logic (which memory files, how much history)

## What must NOT change
- The CLI interface (--agent, --task, --phase, --next flags)
- The output path (.ship/briefing.md)
- Reading from .goals.json via pipeline.js imports
- The agent type validation
- Error handling behavior

## Strategy
- One hypothesis per experiment
- Focus on information density: agents have limited context windows
- The briefing should front-load the most decision-relevant information
- Remove redundant or stale information that adds noise
- Match briefing content to what the specific agent type needs
