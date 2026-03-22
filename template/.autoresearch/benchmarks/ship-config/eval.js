#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for ship-config.
 *
 * DO NOT MODIFY during autoresearch runs. This is the ground-truth scorer.
 *
 * Evaluates a workspace after a proposer has modified ship-config.json.
 * Pure parameter-range validation — no agent spawning required.
 *
 * Scoring (weights):
 *   - Config is valid JSON:                    10%
 *   - All values are numbers:                  10%
 *   - maxQARounds in [2, 5]:                   15%
 *   - maxPMReplans in [1, 3]:                  10%
 *   - maxBuildBatch in [3, 8]:                 15%
 *   - progressCheckIntervalMs in [120000, 600000]:  15%
 *   - maxChecksWithoutProgress in [1, 4]:      10%
 *   - No extreme values (nothing > 10x or < 0.1x default):  15%
 *
 * Usage:
 *   node eval.js <workspace-dir>
 *   → stdout: JSON { score, details }
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const workDir = process.argv[2];
if (!workDir) {
  console.error('Usage: node eval.js <workspace-dir>');
  process.exit(1);
}

const DEFAULTS = {
  maxQARounds: 3,
  maxPMReplans: 2,
  maxDesignRounds: 3,
  maxBuildBatch: 5,
  maxExecRestarts: 3,
  progressCheckIntervalMs: 300000,
  heartbeatIntervalMs: 30000,
  maxChecksWithoutProgress: 2,
};

function inRange(value, min, max) {
  return typeof value === 'number' && value >= min && value <= max;
}

function evaluate(dir) {
  const configPath = resolve(dir, 'ship-config.json');
  const details = {
    validJson: false,
    allNumbers: false,
    rangeChecks: {},
    extremeValues: [],
    configFound: false,
  };

  // ── 0. Config file exists ────────────────────────────────────────

  if (!existsSync(configPath)) {
    return { score: 0, details: { ...details, error: 'ship-config.json not found' } };
  }
  details.configFound = true;

  // ── 1. Valid JSON (weight: 0.10) ─────────────────────────────────

  let config;
  let jsonScore = 0;

  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
    details.validJson = true;
    jsonScore = 1;
  } catch (err) {
    return { score: 0, details: { ...details, error: `Invalid JSON: ${err.message}` } };
  }

  // ── 2. All values are numbers (weight: 0.10) ────────────────────

  let numbersScore = 0;
  const expectedKeys = Object.keys(DEFAULTS);
  const allNumbers = expectedKeys.every(k => typeof config[k] === 'number');
  details.allNumbers = allNumbers;
  numbersScore = allNumbers ? 1 : 0;

  // ── 3. Range checks (individual weights) ────────────────────────

  // maxQARounds in [2, 5] — weight 0.15
  const qaOk = inRange(config.maxQARounds, 2, 5);
  details.rangeChecks.maxQARounds = { value: config.maxQARounds, min: 2, max: 5, ok: qaOk };
  const qaScore = qaOk ? 1 : 0;

  // maxPMReplans in [1, 3] — weight 0.10
  const pmOk = inRange(config.maxPMReplans, 1, 3);
  details.rangeChecks.maxPMReplans = { value: config.maxPMReplans, min: 1, max: 3, ok: pmOk };
  const pmScore = pmOk ? 1 : 0;

  // maxBuildBatch in [3, 8] — weight 0.15
  const batchOk = inRange(config.maxBuildBatch, 3, 8);
  details.rangeChecks.maxBuildBatch = { value: config.maxBuildBatch, min: 3, max: 8, ok: batchOk };
  const batchScore = batchOk ? 1 : 0;

  // progressCheckIntervalMs in [120000, 600000] — weight 0.15
  const progressOk = inRange(config.progressCheckIntervalMs, 120000, 600000);
  details.rangeChecks.progressCheckIntervalMs = { value: config.progressCheckIntervalMs, min: 120000, max: 600000, ok: progressOk };
  const progressScore = progressOk ? 1 : 0;

  // maxChecksWithoutProgress in [1, 4] — weight 0.10
  const checksOk = inRange(config.maxChecksWithoutProgress, 1, 4);
  details.rangeChecks.maxChecksWithoutProgress = { value: config.maxChecksWithoutProgress, min: 1, max: 4, ok: checksOk };
  const checksScore = checksOk ? 1 : 0;

  // ── 4. No extreme values (weight: 0.15) ─────────────────────────
  //    Nothing > 10x default or < 0.1x default

  let extremeScore = 1;
  for (const key of expectedKeys) {
    const val = config[key];
    const def = DEFAULTS[key];
    if (typeof val !== 'number' || typeof def !== 'number') continue;
    if (def === 0) continue; // avoid division by zero
    const ratio = val / def;
    if (ratio > 10 || ratio < 0.1) {
      details.extremeValues.push({ key, value: val, default: def, ratio: Math.round(ratio * 100) / 100 });
      extremeScore = 0;
    }
  }

  // ── Final score ─────────────────────────────────────────────────

  const score =
    (jsonScore * 0.10) +
    (numbersScore * 0.10) +
    (qaScore * 0.15) +
    (pmScore * 0.10) +
    (batchScore * 0.15) +
    (progressScore * 0.15) +
    (checksScore * 0.10) +
    (extremeScore * 0.15);

  return {
    score: Math.round(score * 1000) / 1000,
    details,
  };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
