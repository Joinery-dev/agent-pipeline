#!/usr/bin/env node

/**
 * integration-check.js — Verify interface contracts between phases.
 *
 * Reads interfaceContract.produces and .consumes from all phases in
 * .goals.json and checks that producers actually exist and consumers
 * can access what they need.
 *
 * Usage:
 *   node lib/integration-check.js                    # check all phases
 *   node lib/integration-check.js --major <id|title> # check one major phase
 *   node lib/integration-check.js --dry-run          # show contracts only
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const GOALS_PATH = resolve('.goals.json');

const args = process.argv.slice(2);
let filterMajor = null;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--major' && args[i + 1]) filterMajor = args[++i];
  if (args[i] === '--dry-run') dryRun = true;
}

if (!existsSync(GOALS_PATH)) {
  console.log(JSON.stringify({ skipped: true, reason: 'No .goals.json' }));
  process.exit(0);
}

let goals;
try {
  goals = JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
} catch (err) {
  console.error(`[integration-check] failed to parse .goals.json: ${err.message}`);
  console.log(JSON.stringify({ skipped: true, reason: `Invalid .goals.json: ${err.message}` }));
  process.exit(1);
}

function getAllPhases() {
  if (Array.isArray(goals.majorPhases)) {
    const phases = [];
    for (const mp of goals.majorPhases) {
      if (filterMajor) {
        const match = mp.id === filterMajor ||
          mp.title.toLowerCase().includes(filterMajor.toLowerCase());
        if (!match) continue;
      }
      if (Array.isArray(mp.phases)) phases.push(...mp.phases);
    }
    return phases;
  }
  return goals.phases || [];
}

const phases = getAllPhases();

// ── Collect contracts ───────────────────────────────────────────────────

const producers = new Map(); // "REST API /api/auth" → phase title
const consumers = new Map(); // "REST API /api/auth" → [phase titles]

for (const phase of phases) {
  const contract = phase.interfaceContract;
  if (!contract) continue;

  for (const item of (contract.produces || [])) {
    producers.set(item, phase.title);
  }
  for (const item of (contract.consumes || [])) {
    if (!consumers.has(item)) consumers.set(item, []);
    consumers.get(item).push(phase.title);
  }
}

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    producers: Object.fromEntries(producers),
    consumers: Object.fromEntries(consumers),
    phasesChecked: phases.length,
  }, null, 2));
  process.exit(0);
}

// ── Check contracts ─────────────────────────────────────────────────────

const issues = [];

// 1. Unmet dependencies — consumer needs something nobody produces
for (const [item, consumerPhases] of consumers) {
  if (!producers.has(item)) {
    // Check if it's an environment dependency (not from another phase)
    const isEnv = /env|config|database|sqlite|node|npm/i.test(item);
    if (!isEnv) {
      issues.push({
        type: 'unmet-dependency',
        severity: 'HIGH',
        item,
        consumers: consumerPhases,
        message: `"${item}" is consumed by ${consumerPhases.join(', ')} but no phase produces it`,
      });
    }
  }
}

// 2. Unused producers — phase produces something nobody consumes
for (const [item, producerPhase] of producers) {
  if (!consumers.has(item)) {
    issues.push({
      type: 'unused-producer',
      severity: 'LOW',
      item,
      producer: producerPhase,
      message: `"${item}" is produced by ${producerPhase} but no phase consumes it`,
    });
  }
}

// 3. Incomplete contracts — phases with tasks but no interface contract
for (const phase of phases) {
  if (phase.tasks?.length > 0 && !phase.interfaceContract) {
    issues.push({
      type: 'missing-contract',
      severity: 'MEDIUM',
      phase: phase.title,
      message: `Phase "${phase.title}" has ${phase.tasks.length} tasks but no interfaceContract`,
    });
  }
}

// 4. Verify completed producers actually exist in code
for (const [item, producerPhase] of producers) {
  const phase = phases.find(p => p.title === producerPhase);
  if (phase?.status !== 'completed') continue;

  // Try to verify the produced interface exists
  // Check for API routes, exported functions, database tables, etc.
  const checks = [];

  if (/api|route|endpoint/i.test(item)) {
    // Check for API route files
    const routeMatch = item.match(/\/api\/\S+/);
    if (routeMatch) {
      const routePath = `app${routeMatch[0]}/route.js`;
      if (!existsSync(resolve(routePath))) {
        checks.push(`API route file not found: ${routePath}`);
      }
    }
  }

  if (/component|page/i.test(item)) {
    // Check that the file/component exists somewhere
    const nameMatch = item.match(/(\w+(?:Page|Component|Layout))/);
    if (nameMatch) {
      try {
        const grep = execSync(`grep -rl "${nameMatch[1]}" app/ lib/ 2>/dev/null`, {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (!grep) checks.push(`Component "${nameMatch[1]}" not found in codebase`);
      } catch (err) {
        // grep returns non-zero when no matches found — expected behavior
        checks.push(`Component "${nameMatch[1]}" not found in codebase`);
      }
    }
  }

  if (checks.length > 0) {
    issues.push({
      type: 'phantom-producer',
      severity: 'HIGH',
      item,
      producer: producerPhase,
      message: `"${item}" is marked as produced by completed phase "${producerPhase}" but: ${checks.join('; ')}`,
    });
  }
}

// ── MajorPhase-level contract checks ─────────────────────────────────

const mpProducers = new Map(); // "category" → majorPhase title
const mpConsumers = new Map(); // "category" → [majorPhase titles]

if (Array.isArray(goals.majorPhases)) {
  for (const mp of goals.majorPhases) {
    if (filterMajor) {
      const match = mp.id === filterMajor ||
        mp.title.toLowerCase().includes(filterMajor.toLowerCase());
      if (!match) continue;
    }
    const contract = mp.interfaceContract;
    if (!contract) continue;

    for (const item of (contract.produces || [])) {
      mpProducers.set(item, mp.title);
    }
    for (const item of (contract.consumes || [])) {
      if (!mpConsumers.has(item)) mpConsumers.set(item, []);
      mpConsumers.get(item).push(mp.title);
    }
  }

  // 5. Unmet MajorPhase dependencies — consumed but not produced
  for (const [item, consumerMPs] of mpConsumers) {
    if (!mpProducers.has(item)) {
      const isEnv = /env|config|database|sqlite|node|npm/i.test(item);
      if (!isEnv) {
        issues.push({
          type: 'unmet-dependency',
          severity: 'HIGH',
          level: 'majorPhase',
          item,
          consumers: consumerMPs,
          message: `MajorPhase contract: "${item}" is consumed by ${consumerMPs.join(', ')} but no major phase produces it`,
        });
      }
    }
  }

  // 6. Unused MajorPhase producers — produced but not consumed
  for (const [item, producerMP] of mpProducers) {
    if (!mpConsumers.has(item)) {
      issues.push({
        type: 'unused-producer',
        severity: 'LOW',
        level: 'majorPhase',
        item,
        producer: producerMP,
        message: `MajorPhase contract: "${item}" is produced by ${producerMP} but no major phase consumes it`,
      });
    }
  }

  // 7. Missing MajorPhase contracts — has phases but no interfaceContract
  for (const mp of goals.majorPhases) {
    if (filterMajor) {
      const match = mp.id === filterMajor ||
        mp.title.toLowerCase().includes(filterMajor.toLowerCase());
      if (!match) continue;
    }
    if ((mp.phases || []).length > 0 && !mp.interfaceContract) {
      issues.push({
        type: 'missing-contract',
        severity: 'MEDIUM',
        level: 'majorPhase',
        phase: mp.title,
        message: `MajorPhase "${mp.title}" has ${mp.phases.length} phases but no interfaceContract`,
      });
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────────

const result = {
  phasesChecked: phases.length,
  contractsFound: producers.size + consumers.size,
  majorPhaseContractsFound: mpProducers.size + mpConsumers.size,
  issues,
  passed: issues.filter(i => i.severity === 'HIGH').length === 0,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
