/**
 * Cost Tracker — Actual token cost tracking for ship.js
 *
 * Usage:
 *   import { createTracker } from './cost-tracker.js';
 *   const tracker = createTracker(20.00, 'claude-opus-4-6');
 *   tracker.recordDispatch({ agent: 'build', taskId: '...', inputTokens: 45000, ... });
 *   console.log(tracker.summary());
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';

// ── Pricing Models ──────────────────────────────────────────────────

const PRICING = {
  'claude-opus-4-6': {
    input: 15.00 / 1_000_000,
    output: 75.00 / 1_000_000,
    cacheRead: 1.50 / 1_000_000,
    cacheWrite: 18.75 / 1_000_000,
  },
  'claude-sonnet-4-6': {
    input: 3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
    cacheRead: 0.30 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
  },
  'claude-haiku-4-5': {
    input: 0.80 / 1_000_000,
    output: 4.00 / 1_000_000,
    cacheRead: 0.08 / 1_000_000,
    cacheWrite: 1.00 / 1_000_000,
  },
};

// ── Cost Computation ────────────────────────────────────────────────

function computeCost(tokens, model) {
  const prices = PRICING[model] || PRICING['claude-opus-4-6'];
  return (
    (tokens.inputTokens || 0) * prices.input +
    (tokens.outputTokens || 0) * prices.output +
    (tokens.cacheReadTokens || 0) * prices.cacheRead +
    (tokens.cacheWriteTokens || 0) * prices.cacheWrite
  );
}

// ── Token Usage Parser ──────────────────────────────────────────────

/**
 * Parse token usage from Claude CLI output.
 * Looks for patterns like:
 *   "input_tokens": 45000
 *   "output_tokens": 12000
 *   Total tokens: 57000 (45000 input, 12000 output)
 *   Usage: input=45000 output=12000
 */
export function parseTokenUsage(output) {
  const tokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  // Try JSON format (stream-json)
  const inputMatch = output.match(/"input_tokens"\s*:\s*(\d+)/);
  const outputMatch = output.match(/"output_tokens"\s*:\s*(\d+)/);
  const cacheReadMatch = output.match(/"cache_read_input_tokens"\s*:\s*(\d+)/);
  const cacheWriteMatch = output.match(/"cache_creation_input_tokens"\s*:\s*(\d+)/);

  if (inputMatch) tokens.inputTokens = parseInt(inputMatch[1]);
  if (outputMatch) tokens.outputTokens = parseInt(outputMatch[1]);
  if (cacheReadMatch) tokens.cacheReadTokens = parseInt(cacheReadMatch[1]);
  if (cacheWriteMatch) tokens.cacheWriteTokens = parseInt(cacheWriteMatch[1]);

  // Try Claude Code summary format
  if (tokens.inputTokens === 0) {
    const totalMatch = output.match(/total_tokens:\s*(\d+)/);
    if (totalMatch) {
      // Estimate 80/20 split if only total available
      const total = parseInt(totalMatch[1]);
      tokens.inputTokens = Math.round(total * 0.8);
      tokens.outputTokens = Math.round(total * 0.2);
    }
  }

  return tokens;
}

// ── Tracker Factory ─────────────────────────────────────────────────

export function createTracker(budget = 20.0, model = 'claude-opus-4-6') {
  const costsFile = '.ship/costs.jsonl';
  let cumulative = 0;
  let dispatches = [];

  // Load existing costs from file
  if (existsSync(costsFile)) {
    const lines = readFileSync(costsFile, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        cumulative = entry.cumulative || cumulative + (entry.cost || 0);
        dispatches.push(entry);
      } catch { /* skip malformed lines */ }
    }
  }

  return {
    recordDispatch({ agent, taskId, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 }) {
      const cost = computeCost({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, model);
      cumulative += cost;

      const entry = {
        ts: new Date().toISOString(),
        agent,
        task: taskId,
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        cost: Math.round(cost * 1000) / 1000,
        cumulative: Math.round(cumulative * 1000) / 1000,
      };

      dispatches.push(entry);

      // Ensure .ship/ exists
      if (!existsSync('.ship')) mkdirSync('.ship', { recursive: true });
      appendFileSync(costsFile, JSON.stringify(entry) + '\n');

      return entry;
    },

    getCumulative() {
      const byAgent = {};
      for (const d of dispatches) {
        byAgent[d.agent] = (byAgent[d.agent] || 0) + (d.cost || 0);
      }
      // Round values
      for (const key of Object.keys(byAgent)) {
        byAgent[key] = Math.round(byAgent[key] * 1000) / 1000;
      }

      return {
        total: Math.round(cumulative * 1000) / 1000,
        remaining: Math.round((budget - cumulative) * 1000) / 1000,
        dispatches: dispatches.length,
        byAgent,
      };
    },

    isOverBudget() {
      return cumulative >= budget;
    },

    summary() {
      const cum = this.getCumulative();
      const lines = [
        `Cost: $${cum.total.toFixed(2)} / $${budget.toFixed(2)} budget ($${cum.remaining.toFixed(2)} remaining)`,
        `Dispatches: ${cum.dispatches}`,
      ];

      if (Object.keys(cum.byAgent).length > 0) {
        const agentBreakdown = Object.entries(cum.byAgent)
          .map(([agent, cost]) => `${agent}: $${cost.toFixed(2)}`)
          .join(', ');
        lines.push(`By agent: ${agentBreakdown}`);
      }

      // Find most expensive dispatch
      if (dispatches.length > 0) {
        const maxDispatch = dispatches.reduce((max, d) => (d.cost || 0) > (max.cost || 0) ? d : max, dispatches[0]);
        if (maxDispatch.cost > 0) {
          lines.push(`Most expensive: ${maxDispatch.agent} ($${maxDispatch.cost.toFixed(2)})`);
        }
      }

      if (this.isOverBudget()) {
        lines.push('⚠️  BUDGET EXHAUSTED');
      }

      return lines.join('\n');
    },

    reset() {
      cumulative = 0;
      dispatches = [];
      if (existsSync(costsFile)) writeFileSync(costsFile, '');
    },
  };
}
