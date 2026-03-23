# System Testing Protocol

A comprehensive protocol for finding every bug in a multi-component system. Designed for agent pipelines but applicable to any system where multiple autonomous components communicate through shared state.

---

## Phase 1: Wiring Audit

**Goal:** Verify every connection between components has both a sender and receiver.

### 1.1 Export/Import chain
For every `import` in every file, verify the imported function/value is actually exported by the source. For every `export`, verify something imports it. Dead exports are dead code.

### 1.2 Two-sided references
For every file path, CLI command, field name, or config key referenced in one component:
- Is it created/defined somewhere?
- Is the creator actually called before the reader?
- Is the format the reader expects the same format the writer produces?

### 1.3 Scaffolding completeness
For every file the system reads at runtime:
- Is it created by the scaffolder/initializer?
- Or is it created at runtime by another component?
- If runtime-created, what happens if that component hasn't run yet?

### 1.4 Dead code detection
For every function, file, CLI command, or config field:
- Is it called from anywhere?
- Is the caller itself reachable from the entry point?
- If not, delete it or document why it exists.

---

## Phase 2: Schema and Contract Validation

**Goal:** Verify every shared data structure has one definition that all producers and consumers agree on.

### 2.1 Protocol vs implementation
For every field in the schema/protocol documentation:
- Does the validator actually check it?
- Does the CLI actually set it?
- Is the field required or optional? Does the code match?

### 2.2 Enum validation
For every field that should be one of a fixed set of values:
- Does the code validate against the enum?
- What happens when an invalid value is passed?
- Can an agent write an invalid value that corrupts state?

### 2.3 Status transition validation
For every state machine in the system:
- Are transitions validated or can any state jump to any other?
- What happens on invalid transitions?
- Are there states with no exit (deadlocks)?
- Are there transitions that skip required steps?

### 2.4 Cross-component format contracts
For every shared data structure (JSON files, memory files, CLI output):
- List every producer (who writes it)
- List every consumer (who reads it)
- For each field: does the producer's field name, type, and format match what every consumer expects?
- Test with `typeof` checks, not just "it doesn't crash"

---

## Phase 3: Edge Case Stress Testing

**Goal:** Break the system with unusual inputs, sizes, and timing.

### 3.1 Input edge cases
For every field the user or an agent can set:
- Empty string
- Very long string (10K+ characters)
- Special characters: `"`, `'`, `\n`, `\t`, `\0`, `<`, `>`, `&`
- Shell metacharacters: `` ` ``, `$()`, `;`, `|`, `&&`
- Unicode: emoji, CJK, RTL, zero-width characters
- JSON breakers: `}`, `]`, `"`, nested objects as strings
- Null bytes (`\x00`)

### 3.2 Scale stress
Test at 1x, 10x, 50x, and 100x expected project size:
- How many entities before performance degrades?
- How large before files exceed context windows or memory limits?
- What's the first thing that breaks at scale?

### 3.3 Corrupt state recovery
For every persisted file:
- Empty file
- Malformed JSON/markdown
- Missing required fields
- Null values where objects expected
- Duplicate IDs
- Circular references
- File exists but is a directory
- File is read-only
- Trailing garbage after valid content

### 3.4 Concurrent access
- Rapid sequential writes to the same file
- External modification between a component's read and write
- Unknown fields injected externally — are they preserved or stripped?

---

## Phase 4: State Machine Simulation

**Goal:** Trace every possible path through the orchestrator and verify each transition works.

### 4.1 Dry run
Walk through a complete run for a simple project. At each step:
- What exact command runs?
- What files are read? Do they exist yet?
- What files are written? In what format?
- What state is the system in after?
- What happens next?

Flag anywhere the chain would break.

### 4.2 Every state entry
For each state in the state machine, verify:
- How is this state entered? (Which transitions lead here?)
- What happens in this state?
- What are all the exit paths?
- What happens if the action in this state fails?

### 4.3 Escalation paths
For every failure handling chain:
- Trace the full escalation: retry → replan → escalate → human
- Does each level get the failure context from the previous level?
- Do counters survive across iterations? Across restarts?
- Is there an upper bound? Does the system eventually stop or loop forever?

### 4.4 Loop detection
For every cycle in the state machine:
- What's the exit condition?
- Can the exit condition become unreachable? (e.g., counter resets)
- What's the maximum number of iterations?
- What happens if a step in the loop resets a previous step's state?

---

## Phase 5: Recovery and Resume

**Goal:** Verify the system can recover from a crash at any point.

### 5.1 Mid-iteration crash
For every step in the main loop, simulate a crash after that step:
- What state is persisted?
- What state is only in memory (lost)?
- Does `--resume` pick up correctly?
- Does it skip already-completed work?
- Does it redo partially-completed work?

### 5.2 Counter and flag persistence
For every in-memory variable that affects flow control:
- Is it persisted to disk?
- If not, what happens when it resets on restart?
- Can a non-persisted counter cause unbounded retries?

### 5.3 False completion
After every possible crash point, does `--resume` incorrectly declare success?
- Empty state looks complete?
- Partial rollup looks complete?
- One completed sub-phase masks incomplete siblings?

---

## Phase 6: Context and Resource Budget

**Goal:** Verify the system doesn't silently degrade when resources are constrained.

### 6.1 Context window measurement
For each component that consumes context (LLM agents):
- Measure exact token count of every file loaded at startup
- Measure how the primary state file scales with project size
- Calculate at what project size the context blows the window
- Identify the file that grows fastest

### 6.2 Redundant reads
For each file an agent reads:
- Is this information already in the briefing/summary?
- If the briefing replaces the raw file, can the raw read be removed?
- What's the cost of the redundancy at scale?

### 6.3 Pre-flight checks
Before dispatching any resource-intensive operation:
- Is there a guard that estimates cost/size/duration?
- What happens when the estimate exceeds limits?
- Is the failure mode graceful (skip with warning) or silent (degrade)?

---

## Phase 7: Agent Prompt Correctness

**Goal:** Verify that the instructions given to autonomous agents are internally consistent and produce the intended behavior.

### 7.1 Command existence
For every CLI command, tool, or file path mentioned in an agent prompt:
- Does it actually exist?
- Is the syntax shown in the prompt correct?
- Do the flags and arguments match the actual CLI parser?

### 7.2 Cross-agent format contracts
Trace every data handoff between agents:
- Agent A writes file/field X in format Y
- Agent B reads file/field X expecting format Z
- Does Y === Z?

Test the full chain: Builder writes → QA reads → Resolver reads QA's output → Builder reads Resolver's output.

### 7.3 Contradictions
For each agent prompt, check:
- Does it tell the agent to do X in one place and not-X in another?
- Are there impossible instructions (read a file that doesn't exist yet)?
- Are there ambiguous instructions where two interpretations produce different behavior?

### 7.4 Ownership
For every shared file:
- Which agent owns it (read+write)?
- Which agents have read-only access?
- Is this declared in each agent's prompt?
- Can two agents write to the same file? If so, is the ordering guaranteed?

### 7.5 Guardrail enforcement
For every guardrail stated in a prompt:
- Is it enforced by code, or is it honor-system only?
- If honor-system, what happens when violated?
- Is the violation detectable by any downstream component?

---

## Phase 8: Dependency and Environment

**Goal:** Verify the system handles missing or broken dependencies gracefully.

### 8.1 Optional dependencies
For each optional dependency (Playwright, dev server, external tools):
- What happens when it's not installed?
- Is the skip silent or logged?
- Does a skipped dependency cause downstream components to produce wrong results?
- Does "all tests passed" still display when tests couldn't run?

### 8.2 External service availability
For each external service (dev server, git, npm, web search):
- What happens when it's unavailable?
- Is there a timeout?
- Is the failure distinguishable from a success-with-no-results?

### 8.3 Version compatibility
For each dependency:
- What versions are supported?
- What happens with a newer/older version?
- Are version-specific APIs used without checking?

---

## Phase 9: Competitive Analysis

**Goal:** Identify capability gaps by comparing against the state of the art.

### 9.1 Feature matrix
Build a comparison table against 3-5 comparable systems. For each capability:
- Do we have it?
- If not, how hard would it be to add?
- If yes, is our implementation better or worse?

### 9.2 Architecture comparison
For each competing architecture pattern:
- What do they do differently?
- What are the tradeoffs?
- Is there something we should adopt?

### 9.3 Failure mode comparison
For each way competing systems handle failures:
- Do they handle it better than us?
- Do they have failure modes we don't?
- What can we learn from their escalation strategies?

---

## Phase 9: Security

**Goal:** Verify the system doesn't expose data, allow injection, or enable unauthorized actions.

### 9.1 Injection surfaces
For every field that accepts user/external input: can it execute code, read arbitrary files, write to unexpected locations, or manipulate queries?

### 9.2 Authentication and authorization
For every protected operation: can it be accessed without auth? Can privileges be escalated? Are secrets exposed in logs or state files?

### 9.3 Data exposure
For every output: does it contain sensitive data? Are temp files cleaned up? Can state files be read to extract secrets?

### 9.4 Dependency vulnerabilities
Run `npm audit` or equivalent. Check for known CVEs. Are dependencies pinned?

---

## Phase 10: Error Handling Coverage

**Goal:** Verify every failure path is handled, not just the happy path.

### 10.1 Throwable functions
For every function that can throw: is the call wrapped? Does the catch handle meaningfully or swallow? Does the error propagate correctly?

### 10.2 Runtime failures
Test: network timeout, disk full, permission denied, process killed mid-operation, out of memory, invalid external response.

### 10.3 Error distinguishability
For every error: can you tell WHICH error from the output? Is "no results" distinguishable from "failed to check"?

---

## Phase 11: Idempotency

**Goal:** Verify running the same operation twice produces the same result.

### 11.1 Create operations
Run every create operation twice. Does it duplicate, error, or no-op?

### 11.2 Update operations
Run every update twice. Same result as once? Corrupts on double-apply?

### 11.3 Side effects
For operations with side effects (commits, file writes, API calls): what happens on retry? Are side effects guarded?

---

## Phase 12: Observability

**Goal:** Verify you can diagnose failures without reading source code.

### 12.1 Log coverage
For every major operation: is start/success/failure logged with enough context?

### 12.2 Error messages
Do errors say what went wrong, where, and what to do about it?

### 12.3 State visibility
At any point: can you determine what the system is doing, how far along, and what's next — from logs alone?

### 12.4 Silent failures
For every skip/degrade: is it logged? Can "skipped" be confused with "succeeded with no results"?

---

## Phase 13: Backwards Compatibility

**Goal:** Verify the system handles state from older versions.

### 13.1 Schema evolution
For every persisted structure: what happens when an older file (missing new fields) is read? Crash, default, or migrate?

### 13.2 Missing new fields
For every recently-added field: is there a default? Does every consumer handle undefined?

### 13.3 Deprecated fields
For removed/renamed fields: does old data cause errors? Is there a migration?

---

## Phase 14: Rollback and Recovery

**Goal:** Verify you can undo damage and return to a known good state.

### 14.1 Undo operations
For every destructive operation: can it be undone? Is there a backup?

### 14.2 Checkpoint integrity
For every checkpoint: does it capture enough to restore? Can you continue from a checkpoint?

### 14.3 Partial failure recovery
For multi-step operations: what if step 3 of 5 fails? Consistent state or half-applied?

---

## Phase 15: Performance

**Goal:** Find operations that are too slow or degrade at scale.

### 15.1 Timing baseline
How long does each operation take at normal scale? At 10x? Is there a timeout?

### 15.2 Blocking operations
Does the user get feedback during long operations? Can they be cancelled?

### 15.3 Scaling behavior
For list-processing operations: O(n), O(n^2), worse? At what n is it unacceptable?

---

## Phase 16: Configuration Surface

**Goal:** Verify every config option works at its boundaries.

### 16.1 Flag inventory
List every flag, env var, and config option with defaults and valid ranges.

### 16.2 Boundary testing
Test at 0, 1, max, max+1, negative, and non-numeric for every numeric config.

### 16.3 Flag combinations
Test contradictory, dependent, and all-at-once flag combinations.

### 16.4 Missing config
What happens when config files are missing, empty, or have unexpected keys?

---

## Phase 17: Competitive Analysis

**Goal:** Identify capability gaps by comparing against the state of the art.

### 17.1 Feature matrix
Build a comparison table against 3-5 comparable systems.

### 17.2 Architecture comparison
What do competitors do differently? What are the tradeoffs?

### 17.3 Failure mode comparison
How do competitors handle failures? What can we learn?

---

## Execution Order

Run phases in this order. Each phase builds on findings from the previous.

1. **Wiring Audit** — find disconnected components before testing them
2. **Schema Validation** — find contract mismatches before testing data flow
3. **Edge Case Stress** — break individual components
4. **State Machine Simulation** — break the orchestration
5. **Recovery and Resume** — break crash recovery
6. **Resource Budget** — find scale limits
7. **Prompt Correctness** — break agent/instruction behavior
8. **Dependency/Environment** — break the runtime
9. **Security** — find injection, exposure, auth gaps
10. **Error Handling** — break every failure path
11. **Idempotency** — run everything twice
12. **Observability** — diagnose from the outside
13. **Backwards Compatibility** — read old state
14. **Rollback** — undo damage
15. **Performance** — find slow paths
16. **Configuration** — break every flag
17. **Competitive Analysis** — find strategic gaps

Each phase produces an audit file. Issues are prioritized as:
- **Critical** — system produces wrong results or silently skips major functionality
- **High** — data loss, infinite loops, state corruption
- **Medium** — degraded behavior, missing validation, format drift
- **Low** — cosmetic, documentation, unlikely edge cases
- **Competitive** — capability gaps vs the market
