import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, cpSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

// Import testable functions (autoresearch.js guards main() from running on import)
const { parseProposerOutput, loadBenchmark, createState } = await import('../lib/autoresearch.js');

// ── parseProposerOutput ──────────────────────────────────────────────

describe('parseProposerOutput', () => {
  it('should parse hypothesis and protocol from well-formed output', () => {
    const output = '{"type":"result","result":"HYPOTHESIS: Add explicit test guidance in verify step\\n---PROTOCOL---\\n<identity>\\nYou are the Builder.\\n</identity>\\n<execution>\\nNew content here\\n</execution>"}';

    const result = parseProposerOutput(output);
    assert.equal(result.success, true);
    assert.equal(result.hypothesis, 'Add explicit test guidance in verify step');
    assert.ok(result.newProtocol.includes('<identity>'));
    assert.ok(result.newProtocol.includes('New content here'));
  });

  it('should handle protocol in code blocks as fallback', () => {
    const output = '{"type":"result","result":"HYPOTHESIS: Test change\\n```markdown\\n<identity>\\nFull protocol here with enough content to pass the length check for validation\\n</identity>\\n```"}';

    const result = parseProposerOutput(output);
    assert.equal(result.success, true);
    assert.equal(result.hypothesis, 'Test change');
    assert.ok(result.newProtocol.includes('<identity>'));
  });

  it('should return failure for empty output', () => {
    const result = parseProposerOutput('');
    assert.equal(result.success, false);
  });

  it('should return failure for output without protocol marker or code blocks', () => {
    const output = '{"type":"result","result":"HYPOTHESIS: Some idea\\nBut no protocol"}';
    const result = parseProposerOutput(output);
    assert.equal(result.success, false);
  });

  it('should handle multi-line stream-json output', () => {
    const output = [
      '{"type":"assistant","tool":{"name":"Read"}}',
      '{"type":"assistant","message":"Analyzing protocol..."}',
      '{"type":"result","result":"HYPOTHESIS: Simplify preflight\\n---PROTOCOL---\\n<identity>\\nYou are the Builder — focused and disciplined craftsman.\\n</identity>\\n<startup>\\n1. Read CLAUDE.md\\n</startup>"}',
    ].join('\n');

    const result = parseProposerOutput(output);
    assert.equal(result.success, true);
    assert.equal(result.hypothesis, 'Simplify preflight');
    assert.ok(result.newProtocol.includes('Builder'));
  });

  it('should extract unknown hypothesis when HYPOTHESIS line is missing', () => {
    const output = '{"type":"result","result":"---PROTOCOL---\\n<identity>\\nYou are the Builder — disciplined craftsman who follows blueprints exactly.\\n</identity>"}';

    const result = parseProposerOutput(output);
    assert.equal(result.success, true);
    assert.equal(result.hypothesis, 'Unknown hypothesis');
  });
});

// ── createState ──────────────────────────────────────────────────────

describe('createState', () => {
  it('should create a valid initial state', () => {
    const state = createState('template/.claude/commands/build.md', 'build-basic');
    assert.equal(state.targetFile, 'template/.claude/commands/build.md');
    assert.equal(state.benchmark, 'build-basic');
    assert.equal(state.iteration, 0);
    assert.equal(state.bestScore, 0);
    assert.equal(state.keptVersions, 0);
    assert.equal(state.baseline, null);
    assert.ok(state.startedAt);
    assert.ok(Array.isArray(state.history));
    assert.equal(state.history.length, 0);
  });
});

// ── loadBenchmark ────────────────────────────────────────────────────

describe('loadBenchmark', () => {
  it('should throw for non-existent benchmark', () => {
    assert.throws(() => loadBenchmark('nonexistent-benchmark-xyz'), /Benchmark not found/);
  });
});

// ── eval.js (benchmark evaluator) ────────────────────────────────────

describe('eval.js benchmark evaluator', () => {
  const evalPath = resolve('template', '.autoresearch', 'benchmarks', 'build-basic', 'eval.js');
  const scaffoldPath = resolve('template', '.autoresearch', 'benchmarks', 'build-basic', 'scaffold');

  it('should score 0 for empty scaffold', () => {
    if (!existsSync(evalPath) || !existsSync(scaffoldPath)) return;

    const output = execSync(`node "${evalPath}" "${scaffoldPath}"`, { encoding: 'utf-8' });
    const result = JSON.parse(output);

    assert.equal(result.score, 0);
    assert.equal(result.details.testsRan, true);
    assert.equal(result.details.testsPassed, 0);
    assert.equal(result.details.filesFound.length, 0);
    assert.equal(result.details.goalsUpdated, false);
  });

  it('should detect file creation and goals updates (test scoring skipped in nested runner)', () => {
    // Note: Node's test runner captures subprocess output, making nested
    // `node --test` calls return empty. We test file detection and goals
    // scoring which don't depend on nested test execution.
    if (!existsSync(evalPath) || !existsSync(scaffoldPath)) return;

    const tmpWork = resolve('/tmp', `eval-test-${Date.now()}`);
    cpSync(scaffoldPath, tmpWork, { recursive: true });
    writeFileSync(resolve(tmpWork, 'package.json'), '{"type":"module"}');
    mkdirSync(resolve(tmpWork, 'lib'), { recursive: true });
    writeFileSync(resolve(tmpWork, 'lib', 'util.js'), 'export function formatCurrency() {}');

    try {
      const output = execSync(`node "${evalPath}" "${tmpWork}"`, { encoding: 'utf-8' });
      const result = JSON.parse(output);

      // File detection should work (0.3 weight)
      assert.ok(result.details.filesFound.includes('lib/util.js'), 'Should detect lib/util.js');
      assert.ok(result.score >= 0.3, `Score should be >= 0.3 from file detection, got ${result.score}`);
    } finally {
      rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  it('should score goals state updates correctly', () => {
    if (!existsSync(evalPath) || !existsSync(scaffoldPath)) return;

    const tmpWork = resolve('/tmp', `eval-test-full-${Date.now()}`);
    cpSync(scaffoldPath, tmpWork, { recursive: true });
    writeFileSync(resolve(tmpWork, 'package.json'), '{"type":"module"}');
    mkdirSync(resolve(tmpWork, 'lib'), { recursive: true });
    writeFileSync(resolve(tmpWork, 'lib', 'util.js'), 'export function formatCurrency() {}');

    // Update .goals.json to simulate builder having run
    const goals = JSON.parse(readFileSync(resolve(tmpWork, '.goals.json'), 'utf-8'));
    const task = goals.majorPhases[0].phases[0].tasks[0];
    task.status = 'in-progress';
    task.attempts.push({
      id: 'test-attempt',
      type: 'build',
      round: 1,
      description: 'Built utility module',
      outcome: 'success',
      notes: 'All tests pass',
      createdAt: new Date().toISOString(),
    });
    goals.majorPhases[0].phases[0].pipeline = {
      state: 'awaiting-qa',
      lastAgent: 'build',
      lastTimestamp: new Date().toISOString(),
    };
    writeFileSync(resolve(tmpWork, '.goals.json'), JSON.stringify(goals, null, 2));

    try {
      const output = execSync(`node "${evalPath}" "${tmpWork}"`, { encoding: 'utf-8' });
      const result = JSON.parse(output);

      // File (0.3) + state (0.2) = at least 0.5 without test scoring
      assert.ok(result.score >= 0.5, `Score should be >= 0.5 with files + state, got ${result.score}`);
      assert.ok(result.details.goalsUpdated, '.goals.json should show as updated');
      assert.ok(result.details.hasAttempt, 'Should detect build attempt');
      assert.equal(result.details.pipelineState, 'awaiting-qa');
    } finally {
      rmSync(tmpWork, { recursive: true, force: true });
    }
  });
});
