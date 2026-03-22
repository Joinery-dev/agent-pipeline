You are tuning the orchestration parameters for the ship.js pipeline.

The file `ship-config.json` controls how the autonomous pipeline orchestrator behaves:

- **maxQARounds** — Maximum QA review cycles before the pipeline gives up. Too low means premature failure on complex tasks; too high wastes budget on unfixable issues.
- **maxPMReplans** — Maximum times the PM agent can re-plan after a phase fails. Allows recovery from bad plans but burns context if set too high.
- **maxDesignRounds** — Maximum design review iterations. Similar tradeoff to QA rounds.
- **maxBuildBatch** — Maximum tasks dispatched to the Builder in a single batch. Too low means excessive round-trips; too high risks context window overflow and unfocused output.
- **maxExecRestarts** — Maximum times the exec orchestrator restarts after a crash. Safety valve against infinite restart loops.
- **progressCheckIntervalMs** — How often (in ms) the orchestrator checks whether agents are making real progress. Too frequent adds overhead; too infrequent lets stalled agents waste time.
- **heartbeatIntervalMs** — How often (in ms) the orchestrator logs a heartbeat. Mainly for observability.
- **maxChecksWithoutProgress** — How many consecutive progress checks with zero progress before killing a stalled agent. Combined with progressCheckIntervalMs, this sets the stall timeout.

Your goal: modify `ship-config.json` to optimize these parameters for a typical full-stack web project pipeline run. Consider:

1. Build+QA cycles typically need 2-3 rounds for complex features
2. Context windows are ~200k tokens — batches over 5-6 tasks risk overflow
3. Progress checks every 2-5 minutes balance responsiveness vs overhead
4. A stall timeout of 5-10 minutes catches stuck agents without false positives

Read the current `ship-config.json`, reason about optimal values, and write your tuned version back.
