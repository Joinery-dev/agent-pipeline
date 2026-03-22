#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for design-review.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a Design Review agent has run, producing a
 * single score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Red button color violation detected:        20% weight
 *   - Border-radius violation detected:           20% weight
 *   - Wrong font violation detected:              15% weight
 *   - Dashboard NOT flagged (correct pass):       15% weight
 *   - Findings file has content:                  15% weight
 *   - Status file updated with verdict/grade:     15% weight
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

function evaluate(dir) {
  const details = {
    redButtonDetected: false,
    borderRadiusDetected: false,
    wrongFontDetected: false,
    dashboardCorrectPass: false,
    findingsHasContent: false,
    statusUpdated: false,
  };

  // Read findings file
  const findingsPath = resolve(dir, '.design/memory/findings.md');
  let findingsContent = '';
  if (existsSync(findingsPath)) {
    findingsContent = readFileSync(findingsPath, 'utf-8');
  }

  const findingsLower = findingsContent.toLowerCase();

  // ── 1. Red button color violation detected (weight: 0.20) ─────────

  // The homepage uses #ff0000 red instead of #1a73e8 for buttons.
  // Agent should mention: "red", "#ff0000", "ff0000", or "button color"
  let redButtonScore = 0;
  if (
    findingsLower.includes('red') ||
    findingsLower.includes('#ff0000') ||
    findingsLower.includes('ff0000') ||
    findingsLower.includes('button color') ||
    findingsLower.includes('button') && findingsLower.includes('color')
  ) {
    details.redButtonDetected = true;
    redButtonScore = 1;
  }

  // ── 2. Border-radius violation detected (weight: 0.20) ────────────

  // Settings page uses 4px border-radius instead of 12px.
  // Agent should mention: "border-radius", "4px", "rounded", or "radius"
  let borderRadiusScore = 0;
  if (
    findingsLower.includes('border-radius') ||
    findingsLower.includes('border radius') ||
    findingsLower.includes('4px') ||
    findingsLower.includes('rounded') ||
    findingsLower.includes('radius')
  ) {
    details.borderRadiusDetected = true;
    borderRadiusScore = 1;
  }

  // ── 3. Wrong font violation detected (weight: 0.15) ───────────────

  // Settings page uses Arial instead of Inter.
  // Agent should mention: "Arial", "font", "font-family"
  let wrongFontScore = 0;
  if (
    findingsLower.includes('arial') ||
    (findingsLower.includes('font') && findingsLower.includes('settings'))
  ) {
    details.wrongFontDetected = true;
    wrongFontScore = 1;
  }

  // ── 4. Dashboard NOT flagged as having violations (weight: 0.15) ───

  // The dashboard page has no violations. The agent should not flag it.
  // We check that the findings mention dashboard but in a "pass" or "no violation" context,
  // OR that the findings don't specifically call out dashboard violations.
  let dashboardScore = 0;

  // Check per-line for dashboard-specific violation or pass language.
  // We split into lines so "No violations found" on one line doesn't bleed
  // into a dashboard mention on a different line.
  const findingsLines = findingsContent.split('\n');

  // A "dashboard line" is any line mentioning dashboard
  const dashboardLines = findingsLines.filter(l => /dashboard/i.test(l));

  // Violation words that indicate the dashboard itself has a problem
  const violationRe = /(?:ship-blocker|not met|incorrect|wrong|mismatch|fail|error|broken)/i;
  // A line saying "violation" alone is ambiguous — only count it if it does NOT
  // also say "no violation"
  function lineHasViolation(line) {
    if (violationRe.test(line)) return true;
    if (/violation/i.test(line) && !/no violation/i.test(line)) return true;
    return false;
  }

  const hasDashboardViolation = dashboardLines.some(l => lineHasViolation(l));

  const passRe = /(?:pass|correct|compliant|no violation|no issue|meets spec|clean|good|no findings)/i;
  const hasDashboardPass = dashboardLines.some(l => passRe.test(l));

  if (hasDashboardPass && !hasDashboardViolation) {
    // Explicitly noted dashboard as passing — best case
    details.dashboardCorrectPass = true;
    dashboardScore = 1;
  } else if (!hasDashboardViolation) {
    // Didn't mention dashboard violations — acceptable
    details.dashboardCorrectPass = true;
    dashboardScore = 1;
  } else if (hasDashboardPass && hasDashboardViolation) {
    // Mixed signals — partial credit
    dashboardScore = 0.5;
  }
  // else: flagged dashboard with violations — 0

  // ── 5. Findings file has content (weight: 0.15) ───────────────────

  let findingsContentScore = 0;
  // Findings should have meaningful content beyond the initial header
  const strippedFindings = findingsContent.replace(/^#.*$/gm, '').trim();
  if (strippedFindings.length > 50) {
    details.findingsHasContent = true;
    findingsContentScore = 1;
  } else if (strippedFindings.length > 10) {
    details.findingsHasContent = true;
    findingsContentScore = 0.5;
  }

  // ── 6. Status updated with verdict or grade (weight: 0.15) ────────

  let statusScore = 0;
  const statusPath = resolve(dir, '.design/memory/status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'));

      // Check if status has been meaningfully updated
      const hasGrade = status.overallGrade && status.overallGrade !== null;
      const hasPhase = status.phase && status.phase !== null;
      const hasLastRun = status.lastRun && status.lastRun !== null;
      const hasFindings = status.findings && (
        status.findings.shipBlockers > 0 ||
        status.findings.quality > 0 ||
        status.findings.polish > 0
      );
      const hasSpecCompliance = status.specCompliance && status.specCompliance.total > 0;
      const hasVerdict = status.verdict || status.overallGrade;

      if (hasGrade || hasVerdict) {
        details.statusUpdated = true;
        statusScore = 1;
      } else if (hasPhase || hasLastRun || hasFindings || hasSpecCompliance) {
        details.statusUpdated = true;
        statusScore = 0.7;
      }
    } catch {
      // JSON parse error — status not properly updated
    }
  }

  // ── Final score ───────────────────────────────────────────────────

  const score =
    (redButtonScore * 0.20) +
    (borderRadiusScore * 0.20) +
    (wrongFontScore * 0.15) +
    (dashboardScore * 0.15) +
    (findingsContentScore * 0.15) +
    (statusScore * 0.15);

  return {
    score: Math.round(score * 1000) / 1000, // 3 decimal places
    details,
  };
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
