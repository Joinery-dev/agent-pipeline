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

## Execution Order

Run phases in this order. Each phase builds on findings from the previous.

1. **Wiring Audit** — find disconnected components before testing them
2. **Schema Validation** — find contract mismatches before testing data flow
3. **Edge Case Stress** — break individual components
4. **State Machine Simulation** — break the orchestration
5. **Recovery and Resume** — break crash recovery
6. **Context Budget** — find scale limits
7. **Prompt Correctness** — break agent behavior
8. **Dependency/Environment** — break the runtime
9. **Competitive Analysis** — find strategic gaps

Each phase produces an audit file. Issues are prioritized as:
- **Critical** — system produces wrong results or silently skips major functionality
- **High** — data loss, infinite loops, state corruption
- **Medium** — degraded behavior, missing validation, format drift
- **Low** — cosmetic, documentation, unlikely edge cases
- **Competitive** — capability gaps vs the market
