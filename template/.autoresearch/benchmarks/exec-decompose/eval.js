#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for exec-decompose.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after an Exec agent has decomposed a project into
 * major phases with interface contracts, producing a single score from 0.0
 * to 1.0.
 *
 * Scoring:
 *   - Phase count in range 3-7:                        20% weight
 *   - All phases have non-empty produces AND consumes:  25% weight
 *   - Project has a vision set:                         10% weight
 *   - No duplicate produces across phases:              15% weight
 *   - Phase descriptions are specific (>20 chars each): 10% weight
 *   - Dependency graph is acyclic:                      10% weight
 *   - Each phase has both title and description:        10% weight
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

function evaluate(dir) {
  const details = {
    phaseCount: 0,
    phaseCountInRange: false,
    allHaveProduces: false,
    allHaveConsumes: false,
    hasVision: false,
    noDuplicateProduces: false,
    allDescriptionsSpecific: false,
    isAcyclic: false,
    allHaveTitleAndDesc: false,
    errors: [],
  };

  let goals;
  try {
    goals = JSON.parse(readFileSync(resolve(dir, '.goals.json'), 'utf-8'));
  } catch (err) {
    details.errors.push(`Failed to read .goals.json: ${err.message}`);
    return { score: 0, details };
  }

  const majorPhases = goals.majorPhases || [];
  details.phaseCount = majorPhases.length;

  // ── 1. Phase count in range 3-7 (weight: 0.20) ───────────────────

  let phaseCountScore = 0;
  if (majorPhases.length >= 3 && majorPhases.length <= 7) {
    details.phaseCountInRange = true;
    phaseCountScore = 1;
  } else if (majorPhases.length > 0) {
    // Partial credit: closer to range gets more credit
    if (majorPhases.length < 3) {
      phaseCountScore = majorPhases.length / 3;
    } else {
      // More than 7: degrade gracefully
      phaseCountScore = Math.max(0, 1 - (majorPhases.length - 7) * 0.2);
    }
  }

  // ── 2. All phases have non-empty produces AND consumes (weight: 0.25) ──

  let contractScore = 0;
  if (majorPhases.length > 0) {
    let phasesWithProduces = 0;
    let phasesWithConsumes = 0;

    for (const mp of majorPhases) {
      const ic = mp.interfaceContract;
      if (ic && Array.isArray(ic.produces) && ic.produces.length > 0) {
        phasesWithProduces++;
      }
      if (ic && Array.isArray(ic.consumes) && ic.consumes.length > 0) {
        phasesWithConsumes++;
      }
    }

    const producesRatio = phasesWithProduces / majorPhases.length;
    // First phase is allowed to have empty consumes, so check n-1
    const consumesExpected = Math.max(1, majorPhases.length - 1);
    const consumesRatio = Math.min(1, phasesWithConsumes / consumesExpected);

    contractScore = (producesRatio + consumesRatio) / 2;

    details.allHaveProduces = phasesWithProduces === majorPhases.length;
    details.allHaveConsumes = phasesWithConsumes >= consumesExpected;
  }

  // ── 3. Project has a vision set (weight: 0.10) ───────────────────

  let visionScore = 0;
  if (goals.vision && typeof goals.vision === 'string' && goals.vision.trim().length > 0) {
    details.hasVision = true;
    visionScore = 1;
  }

  // ── 4. No duplicate produces across phases (weight: 0.15) ────────

  let duplicateScore = 0;
  if (majorPhases.length > 0) {
    const allProduces = [];
    for (const mp of majorPhases) {
      const ic = mp.interfaceContract;
      if (ic && Array.isArray(ic.produces)) {
        allProduces.push(...ic.produces);
      }
    }

    const uniqueProduces = new Set(allProduces.map(p => p.toLowerCase().trim()));
    if (allProduces.length === 0) {
      duplicateScore = 0;
    } else if (uniqueProduces.size === allProduces.length) {
      details.noDuplicateProduces = true;
      duplicateScore = 1;
    } else {
      // Partial credit based on uniqueness ratio
      duplicateScore = uniqueProduces.size / allProduces.length;
    }
  }

  // ── 5. Phase descriptions are specific (>20 chars each) (weight: 0.10) ──

  let descSpecificScore = 0;
  if (majorPhases.length > 0) {
    let specificCount = 0;
    for (const mp of majorPhases) {
      if (mp.description && mp.description.trim().length > 20) {
        specificCount++;
      }
    }
    descSpecificScore = specificCount / majorPhases.length;
    details.allDescriptionsSpecific = specificCount === majorPhases.length;
  }

  // ── 6. Dependency graph is acyclic (weight: 0.10) ────────────────

  let acyclicScore = 0;
  if (majorPhases.length > 0) {
    const isAcyclic = checkAcyclic(majorPhases);
    details.isAcyclic = isAcyclic;
    acyclicScore = isAcyclic ? 1 : 0;
  }

  // ── 7. Each phase has both title and description (weight: 0.10) ──

  let titleDescScore = 0;
  if (majorPhases.length > 0) {
    let completeCount = 0;
    for (const mp of majorPhases) {
      if (mp.title && mp.title.trim().length > 0 &&
          mp.description && mp.description.trim().length > 0) {
        completeCount++;
      }
    }
    titleDescScore = completeCount / majorPhases.length;
    details.allHaveTitleAndDesc = completeCount === majorPhases.length;
  }

  // ── Final score ─────────────────────────────────────────────────

  const score =
    (phaseCountScore * 0.20) +
    (contractScore * 0.25) +
    (visionScore * 0.10) +
    (duplicateScore * 0.15) +
    (descSpecificScore * 0.10) +
    (acyclicScore * 0.10) +
    (titleDescScore * 0.10);

  return {
    score: Math.round(score * 1000) / 1000, // 3 decimal places
    details,
  };
}

/**
 * Check if the dependency graph formed by produces/consumes is acyclic.
 *
 * Build a directed graph where phase A -> phase B means B consumes something
 * that A produces. Then check for cycles using topological sort (Kahn's algorithm).
 */
function checkAcyclic(majorPhases) {
  // Map: produced artifact (lowercase) -> phase index
  const producerMap = new Map();
  for (let i = 0; i < majorPhases.length; i++) {
    const ic = majorPhases[i].interfaceContract;
    if (ic && Array.isArray(ic.produces)) {
      for (const p of ic.produces) {
        producerMap.set(p.toLowerCase().trim(), i);
      }
    }
  }

  // Build adjacency list: edges[producer] = [consumer, ...]
  const adj = Array.from({ length: majorPhases.length }, () => []);
  const inDegree = new Array(majorPhases.length).fill(0);

  for (let i = 0; i < majorPhases.length; i++) {
    const ic = majorPhases[i].interfaceContract;
    if (ic && Array.isArray(ic.consumes)) {
      for (const c of ic.consumes) {
        const producerIdx = producerMap.get(c.toLowerCase().trim());
        if (producerIdx !== undefined && producerIdx !== i) {
          adj[producerIdx].push(i);
          inDegree[i]++;
        }
      }
    }
  }

  // Kahn's algorithm for topological sort
  const queue = [];
  for (let i = 0; i < majorPhases.length; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    visited++;
    for (const neighbor of adj[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  return visited === majorPhases.length;
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
