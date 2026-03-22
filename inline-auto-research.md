# Inline Auto-Research: Continuous Protocol Optimization

> This document captures the design for a **future** inline autoresearch system
> that improves agent protocols continuously as the pipeline runs real work.
> Build the overnight Karpathy Loop first, prove the pattern, then come back here.

---

## The Hard Problems (and why most naive implementations fail)

Porting the Karpathy Loop pattern carelessly would produce something that looks
like autoresearch but doesn't actually converge. These are the problems the
inline version must solve.

### Problem 1: Non-reproducible evaluation

Karpathy runs the same benchmark every time. The pipeline runs a different task
every time. A protocol change might look good because the next task was easy,
not because the protocol improved. **You can't compare single data points across
different tasks.**

**Solution**: Windowed comparison. Don't evaluate after one run. Accumulate a
window of N outcomes under each protocol version, then compare the windows. The
noise of individual task difficulty averages out across the window.

### Problem 2: Who watches the watchmen?

If you optimize the Builder's protocol using QA pass rate as the metric, and
the QA protocol also drifts... QA could become more lenient, which makes
Builder's metric go up without actual improvement. The evaluation itself is
compromised.

**Solution**: One-agent-at-a-time lock. At any moment, exactly ONE agent's
protocol is in experiment mode. All others are frozen. The frozen QA protocol
is the locked evaluation — the `prepare.py` equivalent. When you want to
optimize QA, you freeze Builder and use a different metric.

### Problem 3: The metric must be extractable from real work

Karpathy computes `val_bpb` automatically. We need a metric that falls out of
the pipeline's existing operation without extra LLM calls.

**Solution**: Everything we need is already in `.goals.json`. Every QA verdict,
every attempt count, every resolve cycle is recorded as structured data. The
signal collector just reads what's already there.

### Problem 4: Iteration speed

Karpathy gets 12 experiments/hour. You might get 1-3 pipeline runs per day.

**Solution**: Granularity shift. A pipeline run isn't one data point — it's N
data points, where N is the number of tasks in the phase. A phase with 5 tasks
produces 5 independent signals about whether the Builder's protocol worked.
Each task's QA verdict is an independent experiment outcome.

### Problem 5: Protocol changes must be safe and reversible

Agent protocols are load-bearing markdown files. A bad mutation could break
the entire pipeline.

**Solution**: Git-tagged protocol versions + automatic revert. Every protocol
change gets a version tag. If the window metrics decline, the system does a
`git checkout` on the protocol file — exactly Karpathy's keep/discard rule.

---

## The Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     NORMAL PIPELINE FLOW                           │
│                                                                    │
│  PM plans ──→ Builder builds ──→ QA evaluates ──→ Resolve if needed│
│                    │                    │                │          │
│                    │ after each         │ after each     │ after    │
│                    │ build attempt      │ QA verdict     │ resolve  │
│                    ▼                    ▼                ▼          │
│               ┌─────────────────────────────────────────────┐      │
│               │            SIGNAL COLLECTOR                  │      │
│               │  Extracts structured outcome from .goals.json│      │
│               │  Appends to .autoresearch/signals.jsonl      │      │
│               │  Zero LLM calls — pure data extraction       │      │
│               └──────────────────┬──────────────────────────┘      │
│                                  │                                  │
│                                  ▼                                  │
│               ┌─────────────────────────────────────────────┐      │
│               │          EXPERIMENT ENGINE                    │      │
│               │  Checks: enough data points?                 │      │
│               │  Compares: current window vs baseline window  │      │
│               │  Decides: keep / revert / propose new change │      │
│               │  One LLM call per experiment cycle (~5 tasks) │      │
│               └──────────────────┬──────────────────────────┘      │
│                                  │                                  │
│                            keep / revert                            │
│                                  │                                  │
│                                  ▼                                  │
│               ┌─────────────────────────────────────────────┐      │
│               │     PROTOCOL FILES (git-versioned)           │      │
│               │  build.md  ←── currently in experiment       │      │
│               │  qa.md     ←── locked (evaluation infra)     │      │
│               │  resolve.md ←── locked                       │      │
│               │  pm.md     ←── locked                        │      │
│               └─────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

### Layer 1: Signal Collector (passive, zero cost)

After every QA verdict, the collector extracts a structured record from what's
already in `.goals.json`:

```jsonl
{"ts":"2026-03-22T14:30:00Z","agent":"builder","protocolVersion":"builder-v3","taskId":"abc","phaseId":"xyz","complexity":3,"firstPassQA":true,"buildAttempts":1,"resolveAttempts":0,"failureCategories":[],"qaChecksPassed":8,"qaChecksTotal":10,"timeMs":340000}
{"ts":"2026-03-22T15:10:00Z","agent":"builder","protocolVersion":"builder-v3","taskId":"def","phaseId":"xyz","complexity":5,"firstPassQA":false,"buildAttempts":1,"resolveAttempts":1,"failureCategories":["test-failure","missing-feature"],"qaChecksPassed":6,"qaChecksTotal":10,"timeMs":720000}
```

Where each field comes from:
- `firstPassQA` — task has a QA/qa-recheck attempt with outcome `success` AND zero `build-fix` attempts
- `buildAttempts` — count of `build` type attempts on the task
- `resolveAttempts` — count of `build-fix` type attempts
- `failureCategories` — parsed from QA attempt notes (the structured failure reasons QA already writes)
- `complexity` — derived from `task.files.length` + plan criteria count (proxy for difficulty)
- `qaChecksPassed/Total` — parsed from QA's structured verdict (already in attempt notes)

This costs nothing. No extra LLM calls. It's just reading `.goals.json` data
that already exists and writing a JSONL line.

### Layer 2: Experiment Engine (the core loop)

This is the brain. It manages the experiment lifecycle:

```
State machine:
  IDLE → PROPOSING → RUNNING → EVALUATING → IDLE
                                    ↓
                              KEEP or REVERT
```

**IDLE**: No active experiment. Collecting baseline signal. When baseline window
reaches N data points, compute baseline metrics and freeze them.

**PROPOSING**: Triggered when one of:
- Baseline window is full and we're ready to try an improvement
- A failure category appeared 2+ times in the current window
- Current window metrics are below baseline by threshold

The proposal step is the one LLM call. It reads:
1. The current protocol file (e.g., `build.md`)
2. Recent failure categories from the signal log
3. The baseline metrics vs current metrics
4. The human-written `program.md` constraints for this agent
5. QA patterns from `.qa/memory/patterns.md`

It outputs: a targeted, single-hypothesis diff to the protocol file.

**RUNNING**: The modified protocol is in use. Collecting data points. After N
data points under the new version, transition to EVALUATING.

**EVALUATING**: Compare the experiment window against the baseline window:
- Primary metric: `firstPassQARate` (for Builder)
- If improved by >5% → **KEEP** (advance baseline to new version)
- If declined by >5% → **REVERT** (git checkout the protocol file)
- If within 5% → **INCONCLUSIVE** (extend the window by N/2 more data points,
  then re-evaluate; if still inconclusive after extension, revert)

### Layer 3: The Lock File

`.autoresearch/experiment.json`:

```json
{
  "state": "running",
  "activeExperiment": {
    "agent": "builder",
    "protocolFile": "template/.claude/commands/build.md",
    "version": "builder-v4",
    "baselineVersion": "builder-v3",
    "hypothesis": "Add explicit guidance for test coverage in the verify step, targeting the 'test-failure' category that appeared 3x in last window",
    "startedAt": "2026-03-22T14:00:00Z",
    "dataPoints": 3,
    "windowSize": 5
  },
  "baseline": {
    "firstPassQARate": 0.60,
    "avgResolveAttempts": 0.40,
    "windowDataPoints": 5
  },
  "locked": ["qa.md", "resolve.md", "pm.md", "ralph-loop.md"],
  "history": [
    {
      "version": "builder-v3",
      "hypothesis": "Emphasize reading patterns.md during preflight",
      "result": "kept",
      "improvement": "+12% firstPassQARate",
      "dataPoints": 10
    }
  ]
}
```

### Layer 4: Human Control (`program.md` per agent)

`.autoresearch/builder-program.md`:

```markdown
# Builder Protocol Optimization

## Metric
firstPassQARate — percentage of tasks passing QA without a resolve cycle

## What can change
- Wording and specificity of instructions within existing steps
- Emphasis on specific patterns or failure categories
- Adding sub-checks or references to memory files
- Removing vague/generic guidance that doesn't correlate with outcomes

## What must NOT change
- The step sequence: preflight -> mark-in-progress -> implement -> verify -> self-review -> log-outcome -> phase-rollup -> report
- Pipeline-cli.js usage for all .goals.json writes
- The "NEVER mark a task completed" rule
- Test-running requirements
- The guardrails section

## Strategy
- One hypothesis per experiment (single change)
- Prioritize targeting failure categories seen 2+ times
- Prefer adding specificity over adding steps
- Prefer removing noise over adding content
```

### Integration into ship.js

Four surgical hook points:

**Hook 1 — After QA verdict** (~line 1424, the `awaiting-qa` case):
```javascript
// After reconcileQAStatuses(phase.id)
runSignalCollector(phase.id);  // extract and log structured outcomes
```

**Hook 2 — After resolve cycle** (~line 1488, the `qa-failed` case):
```javascript
// After each /resolve completes
runSignalCollector(phase.id);  // log the resolve outcome too
```

**Hook 3 — Start of each iteration** (~line 1210):
```javascript
// After quality gate check
runExperimentCheck();  // evaluate if experiment window is full -> keep/revert/propose
```

**Hook 4 — Lessons sync hook** (after phase completion, ~line 1517):
```javascript
// After runRollupAll()
runLessonsSync();      // existing
runExperimentCheck();  // final evaluation point for the phase
```

---

## Per-Agent Metrics (The Single Scalar)

Each agent needs one number. Keeping it to one is critical — Karpathy's insight
about Goodhart's Law applies here too.

| Agent       | Metric                     | Why This One                              |
|-------------|----------------------------|-------------------------------------------|
| **Builder** | First-pass QA rate         | Directly measures build quality           |
| **QA**      | Regression catch rate      | Measures QA thoroughness                  |
| **Resolver**| Fix success rate           | Measures surgical precision               |
| **PM**      | Plan completion rate       | Measures plan quality                     |

---

## What's Immutable (prepare.py equivalent)

- `pipeline.js` — schema validation
- `ralph-loop.md` — QA evaluation protocol (when Builder is being optimized)
- The signal collection logic itself
- The experiment engine's comparison logic

---

## Inline vs Overnight Comparison

| Karpathy (overnight)                | Inline version                              |
|-------------------------------------|---------------------------------------------|
| Dedicated loop doing nothing but experiments | Piggybacks on real pipeline work    |
| Same benchmark repeated             | Different tasks, windowed comparison        |
| 12 experiments/hour                 | 1 experiment per ~5 tasks                   |
| Agent runs the eval                 | Eval data falls out of existing QA verdicts |
| Separate compute budget             | One extra LLM call per experiment cycle     |
| Explicit "run overnight" invocation | Always on — every pipeline run contributes  |

---

## How It Compounds With Existing Systems

```
lessons-sync.js     ->  WHAT keeps going wrong     (reactive, content)
agent memory files  ->  WHAT happened recently      (session context)
autoresearch loop   ->  HOW to work better          (proactive, process)
```

These create a triple feedback loop:
1. QA finds a pattern -> `patterns.md`
2. Pattern seen 3x -> `lessons-sync` graduates it to conventions
3. Autoresearch reads failure categories -> modifies protocol to prevent the pattern class
4. Modified protocol -> fewer instances of that pattern -> QA sees it less
5. Result: the pattern that used to require 3 failures to fix now gets prevented after 1

---

## The Startup Sequence

1. **Cold start**: System runs in IDLE mode, collecting signal without modifying
   anything. First 10 tasks build the baseline window.
2. **First experiment**: After 10 baseline data points, the system has enough
   signal to propose its first modification. It picks the agent with the lowest
   firstPassQARate.
3. **Steady state**: After ~20-30 tasks total, the system has one full experiment
   cycle complete. From here, it runs continuously.

---

## Build Order (when we return to this)

1. `lib/autoresearch/signal-collector.js` — Pure deterministic data extraction
2. `lib/autoresearch/experiment-engine.js` — State machine + one LLM call for proposals
3. `.autoresearch/builder-program.md` — Human constraints for Builder optimization
4. 4 hook points in `ship.js` — Wire into existing pipeline
5. Later: `qa-program.md`, `resolver-program.md` — Extend to other agents

---

## Sources

- [karpathy/autoresearch - GitHub](https://github.com/karpathy/autoresearch)
- [autoresearch: Blueprint for Self-Improving Agents - mager.co](https://www.mager.co/blog/2026-03-14-autoresearch-pattern/)
- [AutoVoiceEvals — prompt optimization via autoresearch](https://alexeyondata.substack.com/p/karpathys-autoresearch-went-viral)
- [Karpathy's Autoresearch for PMs](https://www.news.aakashg.com/p/autoresearch-guide-for-pms)
- [AutoResearch Loop for Business Optimization - MindStudio](https://www.mindstudio.ai/blog/what-is-autoresearch-loop-karpathy-business-optimization)
- [The Karpathy Loop: 700 experiments - Fortune](https://fortune.com/2026/03/17/andrej-karpathy-loop-autonomous-ai-agents-future/)
