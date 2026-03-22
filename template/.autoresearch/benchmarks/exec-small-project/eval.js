#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for exec-small-project.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after an Exec agent has decomposed a small project
 * into major phases, producing a single score from 0.0 to 1.0.
 *
 * Key difference from exec-decompose: target range is 2-4 phases (not 3-7).
 * Tests whether exec can right-size for a small project and not over-decompose.
 *
 * Scoring:
 *   - Phase count in range 2-4:                               25% weight
 *   - All phases have produces AND consumes:                   20% weight
 *   - Project has vision set:                                  10% weight
 *   - Phase descriptions are specific (>20 chars):             10% weight
 *   - No phase is too granular (each desc implies 2+ tasks):   15% weight
 *   - All phases have title and description:                   10% weight
 *   - Dependency graph is acyclic:                             10% weight
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
    allDescriptionsSpecific: false,
    noTooGranularPhases: false,
    allHaveTitleAndDesc: false,
    isAcyclic: false,
    tooGranularPhases: [],
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

  // ── 1. Phase count in range 2-4 (weight: 0.25) ───────────────────

  let phaseCountScore = 0;
  if (majorPhases.length >= 2 && majorPhases.length <= 4) {
    details.phaseCountInRange = true;
    phaseCountScore = 1;
  } else if (majorPhases.length > 0) {
    if (majorPhases.length === 1) {
      // Too few — only 1 phase for a 3-page site is under-decomposed
      phaseCountScore = 0.5;
    } else if (majorPhases.length === 5) {
      // Slightly over — partial credit
      phaseCountScore = 0.5;
    } else if (majorPhases.length >= 6) {
      // Way over-decomposed — penalize progressively
      phaseCountScore = Math.max(0, 1 - (majorPhases.length - 4) * 0.25);
    }
  }

  // ── 2. All phases have non-empty produces AND consumes (weight: 0.20) ──

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
    // First phase is allowed to have empty consumes
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

  // ── 4. Phase descriptions are specific (>20 chars each) (weight: 0.10) ──

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

  // ── 5. No phase is too granular (each implies 2+ tasks) (weight: 0.15) ──

  let granularityScore = 0;
  if (majorPhases.length > 0) {
    // A phase is "too granular" if its description is very short or implies
    // a single task (e.g., "Add favicon", "Set page title").
    // We heuristically check: description should be >40 chars (implying
    // substance), OR title should suggest a multi-task scope.
    const TOO_GRANULAR_THRESHOLD = 40;
    let nonGranularCount = 0;

    for (const mp of majorPhases) {
      const desc = (mp.description || '').trim();
      const title = (mp.title || '').trim();

      // Check if the phase implies substantial work (multi-task scope)
      const isSubstantial =
        desc.length > TOO_GRANULAR_THRESHOLD ||
        // Titles with "and" or commas suggest multiple concerns
        /\band\b|,/.test(title) ||
        /\band\b|,/.test(desc) ||
        // Titles suggesting a whole section/area are fine
        /page|layout|design|style|component|content|deploy|setup|config/i.test(title);

      if (isSubstantial) {
        nonGranularCount++;
      } else {
        details.tooGranularPhases.push({ title, descLength: desc.length });
      }
    }

    granularityScore = nonGranularCount / majorPhases.length;
    details.noTooGranularPhases = nonGranularCount === majorPhases.length;
  }

  // ── 6. All phases have both title and description (weight: 0.10) ──

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

  // ── 7. Dependency graph is acyclic (weight: 0.10) ────────────────

  let acyclicScore = 0;
  if (majorPhases.length > 0) {
    const isAcyclic = checkAcyclic(majorPhases);
    details.isAcyclic = isAcyclic;
    acyclicScore = isAcyclic ? 1 : 0;
  }

  // ── Final score ─────────────────────────────────────────────────

  const score =
    (phaseCountScore * 0.25) +
    (contractScore * 0.20) +
    (visionScore * 0.10) +
    (descSpecificScore * 0.10) +
    (granularityScore * 0.15) +
    (titleDescScore * 0.10) +
    (acyclicScore * 0.10);

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
