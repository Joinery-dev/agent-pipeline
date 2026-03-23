#!/usr/bin/env node

/**
 * report.js — Field report generator for inline autoresearch.
 *
 * Reads signals.jsonl and QA memory to produce a structured field report
 * that the nightly autoresearch system uses to prioritize and inform
 * its benchmark experiments.
 *
 * This system is read-only — it never modifies project conventions,
 * protocol files, or .goals.json. It only observes and reports.
 *
 * Usage:
 *   node .autoresearch/inline/report.js --generate    # generate field report
 *   node .autoresearch/inline/report.js --print        # print to stdout
 *   node .autoresearch/inline/report.js --summary      # one-line summary
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

// ── Paths ────────────────────────────────────────────────────────────────

const INLINE_DIR = resolve('.autoresearch/inline');
const SIGNALS_PATH = resolve(INLINE_DIR, 'signals.jsonl');
const REPORT_PATH = resolve(INLINE_DIR, 'field-report.json');
const GOALS_PATH = resolve('.goals.json');
const PATTERNS_PATH = resolve('.qa/memory/patterns.md');
const REGRESSIONS_PATH = resolve('.qa/memory/regressions.md');

// ── Signal reading ───────────────────────────────────────────────────────

function readSignals() {
  if (!existsSync(SIGNALS_PATH)) return [];
  try {
    return readFileSync(SIGNALS_PATH, 'utf-8').trim().split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Summary metrics ──────────────────────────────────────────────────────

function computeSummary(signals) {
  const taskSignals = signals.filter(s => s.type !== 'phase');
  if (taskSignals.length === 0) return null;

  const firstPassCount = taskSignals.filter(s => s.builder?.firstPassQA).length;

  return {
    totalTasks: taskSignals.length,
    firstPassQARate: firstPassCount / taskSignals.length,
    avgBuildAttempts: taskSignals.reduce((s, r) => s + (r.builder?.buildAttempts || 0), 0) / taskSignals.length,
    avgFixAttempts: taskSignals.reduce((s, r) => s + (r.builder?.fixAttempts || 0), 0) / taskSignals.length,
    avgRoundsToComplete: taskSignals.reduce((s, r) => s + (r.roundsToComplete || 0), 0) / taskSignals.length,
  };
}

// ── Per-agent analysis ───────────────────────────────────────────────────

function analyzePerAgent(signals) {
  const taskSignals = signals.filter(s => s.type !== 'phase');
  const phaseSignals = signals.filter(s => s.type === 'phase');

  if (taskSignals.length === 0) return {};

  // ── Builder signal → maps to build-basic, build-api, build-component benchmarks
  const builderFailureCounts = {};
  for (const s of taskSignals) {
    for (const cat of s.builder?.failureCategories || []) {
      builderFailureCounts[cat] = (builderFailureCounts[cat] || 0) + 1;
    }
  }
  const builderTopFailures = Object.entries(builderFailureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));

  const firstPassCount = taskSignals.filter(s => s.builder?.firstPassQA).length;

  const builder = {
    targetBenchmarks: ['build-basic', 'build-api', 'build-component'],
    firstPassQARate: +(firstPassCount / taskSignals.length).toFixed(3),
    avgBuildAttempts: +(taskSignals.reduce((s, r) => s + (r.builder?.buildAttempts || 0), 0) / taskSignals.length).toFixed(2),
    avgFixAttempts: +(taskSignals.reduce((s, r) => s + (r.builder?.fixAttempts || 0), 0) / taskSignals.length).toFixed(2),
    topFailures: builderTopFailures,
    tasks: taskSignals.length,
  };

  // ── QA signal → maps to qa-accuracy, qa-false-positives benchmarks
  const totalQAAttempts = taskSignals.reduce((s, r) => s + (r.qa?.attempts || 0), 0);
  const totalQAFailures = taskSignals.reduce((s, r) => s + (r.qa?.failures || 0), 0);
  const totalQASuccesses = taskSignals.reduce((s, r) => s + (r.qa?.successes || 0), 0);
  const totalRechecks = taskSignals.reduce((s, r) => s + (r.qa?.rechecks || 0), 0);
  const recheckSuccesses = taskSignals.filter(s => s.qa?.recheckSuccessRate === 1.0).length;

  const qa = {
    targetBenchmarks: ['qa-accuracy', 'qa-false-positives'],
    totalAttempts: totalQAAttempts,
    failureRate: totalQAAttempts > 0 ? +(totalQAFailures / totalQAAttempts).toFixed(3) : null,
    successRate: totalQAAttempts > 0 ? +(totalQASuccesses / totalQAAttempts).toFixed(3) : null,
    recheckCount: totalRechecks,
    recheckSuccessRate: totalRechecks > 0 ? +(recheckSuccesses / taskSignals.filter(s => (s.qa?.rechecks || 0) > 0).length).toFixed(3) : null,
    tasks: taskSignals.length,
  };

  // ── Resolver signal → maps to resolve-precision benchmark
  const tasksWithResolve = taskSignals.filter(s => (s.resolver?.attempts || 0) > 0);
  const resolveSucceeded = tasksWithResolve.filter(s => s.resolver?.succeeded).length;

  const resolver = {
    targetBenchmarks: ['resolve-precision'],
    tasksRequiringResolve: tasksWithResolve.length,
    fixSuccessRate: tasksWithResolve.length > 0 ? +(resolveSucceeded / tasksWithResolve.length).toFixed(3) : null,
    avgFixAttempts: tasksWithResolve.length > 0 ? +(tasksWithResolve.reduce((s, r) => s + (r.resolver?.fixAttempts || 0), 0) / tasksWithResolve.length).toFixed(2) : null,
  };

  // ── PM signal → maps to pm-planning benchmark
  const pm = {
    targetBenchmarks: ['pm-planning', 'pm-review'],
    phasesCompleted: phaseSignals.length,
    avgQARoundsPerPhase: phaseSignals.length > 0 ? +(phaseSignals.reduce((s, r) => s + (r.pm?.qaRoundsNeeded || 0), 0) / phaseSignals.length).toFixed(2) : null,
    avgCompletionRate: phaseSignals.length > 0 ? +(phaseSignals.reduce((s, r) => s + (r.pm?.completionRate || 0), 0) / phaseSignals.length).toFixed(3) : null,
  };

  return { builder, qa, resolver, pm };
}

// ── Failure analysis ─────────────────────────────────────────────────────

function analyzeFailures(signals) {
  const taskSignals = signals.filter(s => s.type !== 'phase');

  // Top categories (from builder failures)
  const categoryCounts = {};
  for (const s of taskSignals) {
    for (const cat of s.builder?.failureCategories || []) {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
  }
  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({
      category,
      count,
      rate: taskSignals.length > 0 ? +(count / taskSignals.length).toFixed(3) : 0,
    }));

  // By complexity tier
  const tiers = { low: [], medium: [], high: [] };
  for (const s of taskSignals) {
    const tier = s.complexityTier || 'medium';
    if (tiers[tier]) tiers[tier].push(s);
  }

  const failuresByComplexity = {};
  for (const [tier, items] of Object.entries(tiers)) {
    if (items.length === 0) continue;
    failuresByComplexity[tier] = {
      tasks: items.length,
      firstPassRate: +(items.filter(s => s.builder?.firstPassQA).length / items.length).toFixed(3),
    };
  }

  // By task type
  const typeGroups = {};
  for (const s of taskSignals) {
    const type = s.taskType || 'general';
    if (!typeGroups[type]) typeGroups[type] = [];
    typeGroups[type].push(s);
  }

  const failuresByTaskType = {};
  for (const [type, items] of Object.entries(typeGroups)) {
    const failureCats = {};
    for (const s of items) {
      for (const cat of s.builder?.failureCategories || []) {
        failureCats[cat] = (failureCats[cat] || 0) + 1;
      }
    }
    const topFailure = Object.entries(failureCats).sort((a, b) => b[1] - a[1])[0];

    failuresByTaskType[type] = {
      tasks: items.length,
      firstPassRate: +(items.filter(s => s.builder?.firstPassQA).length / items.length).toFixed(3),
      topFailure: topFailure ? topFailure[0] : null,
    };
  }

  return { topCategories, failuresByComplexity, failuresByTaskType };
}

// ── Trend analysis ───────────────────────────────────────────────────────

function analyzeTrends(signals) {
  const taskSignals = signals.filter(s => s.type !== 'phase');

  // Group by phase
  const phases = {};
  for (const s of taskSignals) {
    const key = s.phaseId || 'unknown';
    if (!phases[key]) phases[key] = { signals: [], firstTs: s.ts };
    phases[key].signals.push(s);
  }

  const phaseRates = Object.entries(phases)
    .sort((a, b) => a[1].firstTs.localeCompare(b[1].firstTs))
    .map(([phaseId, data]) => ({
      phaseId,
      rate: +(data.signals.filter(s => s.builder?.firstPassQA).length / data.signals.length).toFixed(3),
      tasks: data.signals.length,
    }));

  // Determine trend
  let improving = null;
  if (phaseRates.length >= 2) {
    const first = phaseRates[0].rate;
    const last = phaseRates[phaseRates.length - 1].rate;
    improving = last > first;
  }

  return {
    firstPassQARateByPhase: phaseRates,
    improving,
  };
}

// ── QA pattern extraction ────────────────────────────────────────────────

function extractQAPatterns() {
  const patterns = [];

  if (existsSync(PATTERNS_PATH)) {
    try {
      const content = readFileSync(PATTERNS_PATH, 'utf-8');
      const sections = content.split(/^## /m).slice(1);
      for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0].trim();
        const seenLine = lines.find(l => l.startsWith('**Seen in:**'));
        const rounds = seenLine ? (seenLine.match(/Round \d+/g) || []).length : 0;
        if (title && rounds > 0) {
          patterns.push(`${title} (seen ${rounds}x)`);
        }
      }
    } catch {}
  }

  if (existsSync(REGRESSIONS_PATH)) {
    try {
      const content = readFileSync(REGRESSIONS_PATH, 'utf-8');
      const sections = content.split(/^## /m).slice(1);
      for (const section of sections) {
        const lines = section.trim().split('\n');
        const title = lines[0].trim();
        const timesLine = lines.find(l => l.startsWith('**Times broken:**'));
        const times = timesLine ? parseInt(timesLine.match(/\d+/)?.[0] || '0') : 0;
        const statusLine = lines.find(l => l.startsWith('**Status:**'));
        const active = statusLine ? statusLine.includes('ACTIVE') : true;
        if (title && times > 0 && active) {
          patterns.push(`REGRESSION: ${title} (broken ${times}x)`);
        }
      }
    } catch {}
  }

  return patterns;
}

// ── Recommendations (deterministic, no LLM) ─────────────────────────────

function generateRecommendations(summary, failures, patterns) {
  const recs = [];

  if (!summary) return recs;

  // Based on top failure categories
  const catMap = {
    'test-failure': 'Builder protocol should emphasize running tests before reporting build success',
    'missing-feature': 'Builder protocol should verify all acceptance criteria are met before completion',
    'type-error': 'Builder protocol should run type checking (tsc, mypy, etc.) as part of verify step',
    'lint-failure': 'Builder protocol should run linter before reporting build success',
    'visual-regression': 'Builder protocol should reference visual-language.md tokens and verify responsive breakpoints',
    'build-error': 'Builder protocol should verify the project compiles/builds before reporting success',
    'integration': 'Builder protocol should verify cross-module interfaces match their contracts',
    'accessibility': 'Builder protocol should include accessibility checks (alt text, ARIA labels, keyboard nav)',
    'performance': 'Builder protocol should check for obvious performance issues (N+1 queries, unbounded lists)',
  };

  for (const cat of (failures.topCategories || []).slice(0, 3)) {
    if (catMap[cat.category]) {
      recs.push(catMap[cat.category]);
    }
  }

  // Based on complexity analysis
  if (failures.failuresByComplexity?.high?.firstPassRate < 0.30) {
    recs.push('High-complexity tasks fail frequently — Builder protocol should break large tasks into smaller verification checkpoints');
  }

  // Based on overall rate
  if (summary.firstPassQARate < 0.50) {
    recs.push('Overall first-pass QA rate is below 50% — fundamental protocol improvements needed');
  }

  // Based on fix attempts
  if (summary.avgFixAttempts > 1.0) {
    recs.push('Average fix attempts > 1 — Resolver protocol may need improvement alongside Builder');
  }

  return recs;
}

// ── Main report generation ───────────────────────────────────────────────

function generateReport() {
  const signals = readSignals();

  if (signals.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      reportVersion: 2,
      summary: null,
      note: 'No signal data collected yet',
    };
  }

  // Project identity
  let projectHash = 'unknown';
  try {
    const goals = JSON.parse(readFileSync(GOALS_PATH, 'utf-8'));
    const id = goals.name || goals.id || 'unknown';
    projectHash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  } catch {}

  const summary = computeSummary(signals);
  const perAgent = analyzePerAgent(signals);
  const failureAnalysis = analyzeFailures(signals);
  const trends = analyzeTrends(signals);
  const qaPatterns = extractQAPatterns();
  const recommendations = generateRecommendations(summary, failureAnalysis, qaPatterns);

  return {
    generatedAt: new Date().toISOString(),
    projectHash,
    reportVersion: 3,
    summary,
    perAgent,
    failureAnalysis,
    trends,
    qaPatterns,
    recommendations,
  };
}

// ── Auto-sync to agent-pipeline repo ─────────────────────────────────────

const CONFIG_PATH = resolve('ship-config.json');

function syncToAgentPipeline(report) {
  if (!report.projectHash || !report.summary) return false;

  // Read agentPipelineRoot from ship-config.json
  if (!existsSync(CONFIG_PATH)) return false;
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { return false; }

  const root = config.agentPipelineRoot;
  if (!root || !existsSync(root)) return false;

  const destDir = resolve(root, '.autoresearch', 'field-reports');
  const destFile = resolve(destDir, `${report.projectHash}.json`);

  try {
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, JSON.stringify(report, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--generate';

  if (!existsSync(INLINE_DIR)) mkdirSync(INLINE_DIR, { recursive: true });

  const report = generateReport();

  if (command === '--print') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === '--summary') {
    if (!report.summary) {
      console.log('No signal data yet.');
      return;
    }
    const s = report.summary;
    const topFail = report.failureAnalysis?.topCategories?.[0];
    console.log(`${s.totalTasks} tasks | ${(s.firstPassQARate * 100).toFixed(0)}% first-pass QA | top failure: ${topFail?.category || 'none'} (${topFail?.count || 0}x) | trend: ${report.trends?.improving === true ? 'improving' : report.trends?.improving === false ? 'declining' : 'unknown'}`);
    return;
  }

  if (command === '--generate') {
    // Write local copy
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    // Auto-sync to agent-pipeline repo for nightly consumption
    const synced = syncToAgentPipeline(report);

    if (report.summary) {
      console.log(JSON.stringify({
        generated: true,
        synced,
        tasks: report.summary.totalTasks,
        firstPassQARate: report.summary.firstPassQARate,
        topFailure: report.failureAnalysis?.topCategories?.[0]?.category || 'none',
        recommendations: report.recommendations?.length || 0,
      }));
    } else {
      console.log(JSON.stringify({ generated: true, synced: false, note: 'No signal data yet' }));
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Usage: node report.js [--generate|--print|--summary]');
  process.exit(1);
}

main();

export { generateReport, computeSummary, analyzeFailures, analyzeTrends, extractQAPatterns, generateRecommendations };
