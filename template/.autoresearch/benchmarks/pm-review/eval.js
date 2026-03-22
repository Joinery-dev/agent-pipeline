#!/usr/bin/env node

/**
 * eval.js — LOCKED benchmark evaluator for pm-review.
 *
 * DO NOT MODIFY during autoresearch runs. This is the prepare.py equivalent.
 *
 * Evaluates a workspace after a PM agent has performed a code review,
 * producing a single score from 0.0 to 1.0.
 *
 * Scoring:
 *   - Detected require() / CommonJS issue in auth.js:         15% weight
 *   - Detected hardcoded URL in auth.js:                      15% weight
 *   - Detected console.log security issue in auth.js:         15% weight
 *   - Detected missing error handling in api-client.js:       15% weight
 *   - Detected missing input validation in api-client.js:     10% weight
 *   - Did NOT flag helpers.js as having issues (no FP):       15% weight
 *   - Review has a verdict (PASS/FAIL/etc):                   10% weight
 *   - Review has structured findings with severity:            5% weight
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
    requireIssueDetected: false,
    hardcodedUrlDetected: false,
    consoleLogSecurityDetected: false,
    missingErrorHandlingDetected: false,
    missingValidationDetected: false,
    helpersClean: true,
    hasVerdict: false,
    hasStructuredFindings: false,
    reviewContent: null,
    error: null,
  };

  // ── Read reviews.md ────────────────────────────────────────────────

  let reviewContent = '';

  const reviewPath = resolve(dir, '.pm/memory/reviews.md');
  if (!existsSync(reviewPath)) {
    return { score: 0, details: { ...details, error: '.pm/memory/reviews.md not found' } };
  }

  try {
    reviewContent = readFileSync(reviewPath, 'utf-8');
  } catch {
    return { score: 0, details: { ...details, error: '.pm/memory/reviews.md not readable' } };
  }

  // If the file is still the initial empty state, score 0
  if (reviewContent.trim() === '# PM Reviews\n\nNo reviews yet.' || reviewContent.trim() === '# PM Reviews' || reviewContent.trim().length < 50) {
    return { score: 0, details: { ...details, error: 'reviews.md appears unmodified or nearly empty' } };
  }

  details.reviewContent = reviewContent.substring(0, 500) + (reviewContent.length > 500 ? '...' : '');

  const lower = reviewContent.toLowerCase();

  // ── 1. Detected require() / CommonJS issue in auth.js (weight: 0.15) ──

  const requireKeywords = ['require', 'commonjs', 'import', 'esm', 'es module'];
  // Must mention auth.js context AND the require/CommonJS issue
  const authSection = extractFileSection(reviewContent, 'auth');
  if (authSection) {
    const authLower = authSection.toLowerCase();
    details.requireIssueDetected = requireKeywords.some(kw => authLower.includes(kw));
  }
  // Fallback: check whole doc for require + auth co-occurrence
  if (!details.requireIssueDetected) {
    details.requireIssueDetected =
      (lower.includes('require') || lower.includes('commonjs')) &&
      lower.includes('auth');
  }

  // ── 2. Detected hardcoded URL in auth.js (weight: 0.15) ──────────

  const urlKeywords = ['hardcoded', 'hardcode', 'hard-coded', 'environment', 'env', 'api.example.com', 'api url', 'url'];
  if (authSection) {
    const authLower = authSection.toLowerCase();
    details.hardcodedUrlDetected = urlKeywords.some(kw => authLower.includes(kw));
  }
  if (!details.hardcodedUrlDetected) {
    details.hardcodedUrlDetected =
      (lower.includes('hardcoded') || lower.includes('hardcode') || lower.includes('hard-coded') ||
       lower.includes('environment') || lower.includes('env var') || lower.includes('api.example.com')) &&
      lower.includes('auth');
  }

  // ── 3. Detected console.log security issue in auth.js (weight: 0.15) ──

  const securityKeywords = ['console.log', 'console', 'sensitive', 'token', 'security', 'leak', 'logging'];
  if (authSection) {
    const authLower = authSection.toLowerCase();
    details.consoleLogSecurityDetected = securityKeywords.some(kw => authLower.includes(kw));
  }
  if (!details.consoleLogSecurityDetected) {
    details.consoleLogSecurityDetected =
      (lower.includes('console.log') || lower.includes('sensitive') ||
       (lower.includes('token') && (lower.includes('log') || lower.includes('security')))) &&
      lower.includes('auth');
  }

  // ── 4. Detected missing error handling in api-client.js (weight: 0.15) ──

  const errorHandlingKeywords = ['try', 'catch', 'error handling', 'unhandled', 'no error', 'missing error', 'try/catch', 'try-catch'];
  const apiSection = extractFileSection(reviewContent, 'api-client');
  if (apiSection) {
    const apiLower = apiSection.toLowerCase();
    details.missingErrorHandlingDetected = errorHandlingKeywords.some(kw => apiLower.includes(kw));
  }
  if (!details.missingErrorHandlingDetected) {
    details.missingErrorHandlingDetected =
      (lower.includes('try') || lower.includes('catch') || lower.includes('error handling')) &&
      lower.includes('api-client');
  }

  // ── 5. Detected missing input validation in api-client.js (weight: 0.10) ──

  const validationKeywords = ['validation', 'validate', 'undefined', 'null check', 'null', 'input', 'parameter', 'argument'];
  if (apiSection) {
    const apiLower = apiSection.toLowerCase();
    details.missingValidationDetected = validationKeywords.some(kw => apiLower.includes(kw));
  }
  if (!details.missingValidationDetected) {
    details.missingValidationDetected =
      (lower.includes('validation') || lower.includes('undefined') ||
       lower.includes('null check') || lower.includes('input')) &&
      lower.includes('api-client');
  }

  // ── 6. Did NOT flag helpers.js as having issues (weight: 0.15) ────

  // Check if helpers.js is mentioned in a negative context (as having an issue)
  const helpersSection = extractFileSection(reviewContent, 'helpers');
  if (helpersSection) {
    const helpersLower = helpersSection.toLowerCase();
    // If the helpers section contains severity markers, it's a false positive
    const hasSeverityMarker =
      helpersLower.includes('[critical]') ||
      helpersLower.includes('[high]') ||
      helpersLower.includes('[medium]') ||
      helpersLower.includes('[low]') ||
      helpersLower.includes('violation') ||
      helpersLower.includes('issue') ||
      helpersLower.includes('bug') ||
      helpersLower.includes('problem');

    // But if it says "no issues" or "clean" or "pass", that's fine
    const isPositive =
      helpersLower.includes('no issue') ||
      helpersLower.includes('no violation') ||
      helpersLower.includes('clean') ||
      helpersLower.includes('pass') ||
      helpersLower.includes('compliant') ||
      helpersLower.includes('no finding') ||
      helpersLower.includes('no problem') ||
      helpersLower.includes('looks good') ||
      helpersLower.includes('well-structured') ||
      helpersLower.includes('follows');

    if (hasSeverityMarker && !isPositive) {
      details.helpersClean = false;
    }
  }

  // ── 7. Review has a verdict (weight: 0.10) ────────────────────────

  details.hasVerdict =
    lower.includes('pass') ||
    lower.includes('fail') ||
    lower.includes('blocked') ||
    lower.includes('verdict');

  // ── 8. Review has structured findings with severity (weight: 0.05) ──

  details.hasStructuredFindings =
    lower.includes('[critical]') ||
    lower.includes('[high]') ||
    lower.includes('[medium]') ||
    lower.includes('[low]') ||
    lower.includes('severity');

  // ── Final score ───────────────────────────────────────────────────

  const score =
    (details.requireIssueDetected ? 0.15 : 0) +
    (details.hardcodedUrlDetected ? 0.15 : 0) +
    (details.consoleLogSecurityDetected ? 0.15 : 0) +
    (details.missingErrorHandlingDetected ? 0.15 : 0) +
    (details.missingValidationDetected ? 0.10 : 0) +
    (details.helpersClean ? 0.15 : 0) +
    (details.hasVerdict ? 0.10 : 0) +
    (details.hasStructuredFindings ? 0.05 : 0);

  return {
    score: Math.round(score * 1000) / 1000,
    details,
  };
}

/**
 * Extract the section of the review that discusses a specific file.
 * Looks for file name mentions and grabs surrounding context.
 */
function extractFileSection(content, fileBaseName) {
  const lines = content.split('\n');
  const pattern = new RegExp(fileBaseName, 'i');

  let sectionLines = [];
  let inSection = false;
  let blankCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      // Start capturing — include a few lines before for context
      const start = Math.max(0, i - 2);
      sectionLines.push(...lines.slice(start, i));
      inSection = true;
      blankCount = 0;
    }

    if (inSection) {
      sectionLines.push(lines[i]);

      if (lines[i].trim() === '') {
        blankCount++;
      } else {
        blankCount = 0;
      }

      // Stop after two consecutive blank lines or a new file header
      if (blankCount >= 2) {
        inSection = false;
      }

      // Stop if we hit a new file section (heading with a different file name)
      if (i > 0 && lines[i].startsWith('#') && !pattern.test(lines[i]) && sectionLines.length > 5) {
        inSection = false;
      }
    }
  }

  return sectionLines.length > 0 ? sectionLines.join('\n') : null;
}

// ── Run ──────────────────────────────────────────────────────────────

const result = evaluate(workDir);
console.log(JSON.stringify(result));
