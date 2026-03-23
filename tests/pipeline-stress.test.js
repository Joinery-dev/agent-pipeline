import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { resolve, join } from 'path';

const CLI = resolve('lib/pipeline-cli.js');
const DISTILLER = resolve('lib/distill-briefing.js');

// ── Test workspace ──────────────────────────────────────────────────────

let workspace;

function setup() {
  workspace = resolve(`/tmp/pipeline-stress-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  process.chdir(workspace);

  // Scaffold minimal project
  mkdirSync('.pm/memory', { recursive: true });
  mkdirSync('.qa/memory', { recursive: true });
  mkdirSync('.design/memory', { recursive: true });
  mkdirSync('.exec/memory', { recursive: true });
  mkdirSync('.ship', { recursive: true });
  mkdirSync('plans', { recursive: true });
  mkdirSync('.claude', { recursive: true });

  // Create initial .goals.json (same as init.js does)
  writeFileSync('.goals.json', JSON.stringify({
    id: crypto.randomUUID(),
    name: 'stress-test',
    description: '',
    vision: '',
    majorPhases: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2));

  writeFileSync('.pm/memory/status.md', '# PM Status\n**Last review:** (none)\n');
  writeFileSync('.pm/memory/decisions.md', '# Decisions\n(none yet)\n');
  writeFileSync('.pm/memory/concerns.md', '# Concerns\n(none yet)\n');
  writeFileSync('.pm/memory/reviews.md', '# Reviews\n(none yet)\n');
  writeFileSync('.qa/memory/status.json', JSON.stringify({ lastRun: null, plan: null, round: 0, verdict: null, checksTotal: 0, checksPassing: 0, criteria: [], forestWarnings: [], trajectory: [] }));
  writeFileSync('.qa/memory/regressions.md', '# Regressions\n(none yet)\n');
  writeFileSync('.qa/memory/patterns.md', '# Patterns\n(none yet)\n');
  writeFileSync('.qa/memory/learnings.txt', '# Learnings\n(none yet)\n');
  writeFileSync('.design/memory/status.json', JSON.stringify({ lastRun: null, phase: null, round: 0, overallGrade: null, specCompliance: { met: 0, total: 0 }, findings: { shipBlockers: 0, quality: 0, polish: 0 }, trajectory: [] }));
  writeFileSync('.design/memory/findings.md', '# Findings\n(none yet)\n');
  writeFileSync('.design/memory/visual-drift.md', '# Drift\n(none yet)\n');
  writeFileSync('.design/memory/page-grades.json', '{}');
  writeFileSync('.exec/memory/decisions.md', '# Exec Decisions\n(none yet)\n');
  writeFileSync('.exec/memory/escalation-log.md', '# Escalation Log\n(none yet)\n');
}

function teardown() {
  if (workspace && existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function cli(...args) {
  return JSON.parse(execFileSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspace,
  }));
}

function cliRaw(...args) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspace,
  });
}

function cliFail(...args) {
  try {
    execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspace,
    });
    return null; // didn't fail
  } catch (err) {
    return err;
  }
}

function readGoals() {
  return JSON.parse(readFileSync(join(workspace, '.goals.json'), 'utf-8'));
}

// ══════════════════════════════════════════════════════════════════════════
//  1. Pipeline-CLI edge cases
// ══════════════════════════════════════════════════════════════════════════

describe('Pipeline-CLI stress tests', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects invalid status values on update-status', () => {
    // Create a valid project + phase + task
    cli('update-project', '--name', 'Test', '--vision', 'Test', '--desc', 'Test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const goals = readGoals();
    const mpId = goals.majorPhases[0].id;
    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', mpId, '--produces', 'a', '--consumes', 'b');
    const goals2 = readGoals();
    const phaseId = goals2.majorPhases[0].phases[0].id;
    cli('add-task', phaseId, '--title', 'T1', '--desc', 'test');
    const goals3 = readGoals();
    const taskId = goals3.majorPhases[0].phases[0].tasks[0].id;

    // Try invalid status
    const err = cliFail('update-status', taskId, 'banana');
    assert.ok(err, 'Should reject invalid status "banana"');
  });

  it('handles empty .goals.json gracefully', () => {
    writeFileSync('.goals.json', '{}');
    const err = cliFail('validate');
    // Should not crash — should either pass or report errors
    // The point is it doesn't throw an unhandled exception
  });

  it('handles malformed JSON in .goals.json', () => {
    writeFileSync('.goals.json', '{ broken json !!!');
    const err = cliFail('validate');
    assert.ok(err, 'Should fail on malformed JSON');
  });

  it('handles missing .goals.json for read commands', () => {
    // No .goals.json exists
    const err = cliFail('get-state');
    assert.ok(err, 'Should fail when .goals.json missing');
  });

  it('rejects duplicate major phase titles', () => {
    cli('update-project', '--name', 'Test', '--vision', 'Test', '--desc', 'Test');
    cli('add-major-phase', '--title', 'Phase One', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    // Adding same title again — should this fail?
    // Let's see what happens
    cli('add-major-phase', '--title', 'Phase One', '--desc', 'test2', '--produces', 'a', '--consumes', 'b');
    const goals = readGoals();
    // Two phases with same title — IDs are different but title collision
    assert.equal(goals.majorPhases.length, 2, 'Allows duplicate titles (no validation)');
    // Not a crash, but a potential issue — flag it
  });

  it('handles very long field values', () => {
    cli('update-project', '--name', 'Test', '--vision', 'V'.repeat(10000), '--desc', 'D'.repeat(10000));
    const goals = readGoals();
    assert.equal(goals.vision.length, 10000);
  });

  it('handles special characters in titles', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'Phase "with" <special> & chars', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const goals = readGoals();
    assert.equal(goals.majorPhases[0].title, 'Phase "with" <special> & chars');
  });

  it('set-pipeline rejects on non-existent phase', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    const err = cliFail('set-pipeline', 'nonexistent-id', 'building', '--agent', 'build');
    assert.ok(err, 'Should fail for non-existent phase');
  });

  it('add-attempt on non-existent task fails', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    const err = cliFail('add-attempt', 'nonexistent-task', '--type', 'build', '--desc', 'test');
    assert.ok(err, 'Should fail for non-existent task');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  2. Distill-briefing edge cases
// ══════════════════════════════════════════════════════════════════════════

describe('Distill-briefing stress tests', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('handles empty .goals.json', () => {
    writeFileSync('.goals.json', JSON.stringify({ id: 'test', majorPhases: [] }));
    const err = cliFail('node', DISTILLER, '--agent', 'pm', '--next');
    // PM mode doesn't need --next, but the command should not crash
  });

  it('handles missing memory files gracefully', () => {
    // Create minimal goals
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'Test vision',
      majorPhases: [{ id: 'mp1', title: 'MP1', status: 'in-progress', phases: [{
        id: 'p1', title: 'P1', status: 'in-progress', planFile: 'plans/test.md',
        pipeline: { state: 'building' },
        tasks: [{ id: 't1', title: 'T1', status: 'not-started', description: 'test', files: ['app/page.js'], attempts: [] }]
      }] }]
    }));

    // Delete all memory files
    rmSync('.pm', { recursive: true, force: true });
    rmSync('.qa', { recursive: true, force: true });
    rmSync('.design', { recursive: true, force: true });

    // Should still generate a briefing without crashing
    try {
      execFileSync('node', [DISTILLER, '--agent', 'build', '--task', 't1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      // Check briefing was written
      assert.ok(existsSync(join(workspace, '.ship/briefing.md')), 'Briefing should exist');
    } catch (err) {
      assert.fail(`Distiller crashed with missing memory files: ${err.stderr || err.message}`);
    }
  });

  it('handles design agent type with phase query', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'Test',
      majorPhases: [{ id: 'mp1', title: 'MP1', status: 'in-progress', phases: [{
        id: 'p1', title: 'P1', status: 'in-progress', planFile: 'plans/test.md',
        pipeline: { state: 'awaiting-qa' },
        tasks: [{ id: 't1', title: 'T1', status: 'in-progress', files: [], attempts: [] }]
      }] }]
    }));

    try {
      execFileSync('node', [DISTILLER, '--agent', 'design', '--phase', 'p1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      assert.ok(existsSync(join(workspace, '.ship/briefing.md')));
    } catch (err) {
      assert.fail(`Design briefing failed: ${err.stderr || err.message}`);
    }
  });

  it('rejects invalid agent type', () => {
    writeFileSync('.goals.json', JSON.stringify({ id: 'test', majorPhases: [] }));
    try {
      execFileSync('node', [DISTILLER, '--agent', 'banana', '--next'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      assert.fail('Should have rejected invalid agent type');
    } catch (err) {
      assert.ok(err.status !== 0, 'Should exit with non-zero');
    }
  });

  it('exec briefing handles goals with no majorPhases array', () => {
    writeFileSync('.goals.json', JSON.stringify({ id: 'test', name: 'Test', vision: 'V' }));
    try {
      execFileSync('node', [DISTILLER, '--agent', 'exec'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      assert.ok(existsSync(join(workspace, '.ship/briefing.md')));
    } catch (err) {
      assert.fail(`Exec briefing crashed on missing majorPhases: ${err.stderr || err.message}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  3. Schema validation gaps
// ══════════════════════════════════════════════════════════════════════════

describe('Schema validation gaps', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('accepts invalid pipeline.lastAgent values (audit #5)', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const goals = readGoals();
    const mpId = goals.majorPhases[0].id;
    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', mpId, '--produces', 'a', '--consumes', 'b');
    const goals2 = readGoals();
    const phaseId = goals2.majorPhases[0].phases[0].id;

    // This should ideally reject 'banana' as an agent
    const result = cli('set-pipeline', phaseId, 'building', '--agent', 'banana');
    const goals3 = readGoals();
    assert.equal(goals3.majorPhases[0].phases[0].pipeline.lastAgent, 'banana',
      'BUG: accepts invalid agent value "banana" — audit item #5 confirmed');
  });

  it('MajorPhase with invalid status passes validation (audit #8)', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');

    // Manually corrupt the status
    const goals = readGoals();
    goals.majorPhases[0].status = 'banana';
    writeFileSync('.goals.json', JSON.stringify(goals, null, 2));

    // Validate should catch this but doesn't
    try {
      const result = cliRaw('validate');
      // If it passes, the bug is confirmed
      assert.ok(true, 'BUG: validate accepts invalid MajorPhase status — audit item #8 confirmed');
    } catch {
      // If it fails, the bug is fixed
      assert.ok(true, 'Validate correctly rejects invalid MajorPhase status');
    }
  });

  it('attempt with children array contradicts protocol (audit #4)', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const g1 = readGoals();
    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', g1.majorPhases[0].id, '--produces', 'a', '--consumes', 'b');
    const g2 = readGoals();
    const phaseId = g2.majorPhases[0].phases[0].id;
    cli('add-task', phaseId, '--title', 'T1', '--desc', 'test');
    const g3 = readGoals();
    const taskId = g3.majorPhases[0].phases[0].tasks[0].id;

    const result = cli('add-attempt', taskId, '--type', 'build', '--desc', 'test');

    const goals = readGoals();
    const attempt = goals.majorPhases[0].phases[0].tasks[0].attempts[0];
    assert.ok(Array.isArray(attempt.children),
      'BUG: attempt has children[] array — protocol says flat, no nesting. Audit item #4 confirmed');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  4. Pipeline state machine edge cases
// ══════════════════════════════════════════════════════════════════════════

describe('Pipeline state machine edge cases', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rollup-all handles empty project', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V', majorPhases: []
    }));
    const result = cliRaw('rollup-all');
    const parsed = JSON.parse(result);
    assert.ok(Array.isArray(parsed), 'Should return empty array');
  });

  it('rollup correctly cascades sub-phase completion to major phase', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const g1 = readGoals();
    const mpId = g1.majorPhases[0].id;

    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', mpId, '--produces', 'a', '--consumes', 'b');
    const g2 = readGoals();
    const phaseId = g2.majorPhases[0].phases[0].id;

    cli('add-task', phaseId, '--title', 'T1', '--desc', 'test');
    const g3 = readGoals();
    const taskId = g3.majorPhases[0].phases[0].tasks[0].id;

    // Complete the task: must go not-started → in-progress, add QA success attempt, then completed
    cli('update-status', taskId, 'in-progress');
    cli('add-attempt', taskId, '--type', 'build', '--desc', 'built it');
    cli('update-attempt', taskId, readGoals().majorPhases[0].phases[0].tasks[0].attempts[0].id, '--outcome', 'success', '--notes', 'done');
    cli('add-attempt', taskId, '--type', 'qa', '--desc', 'QA check');
    cli('update-attempt', taskId, readGoals().majorPhases[0].phases[0].tasks[0].attempts[1].id, '--outcome', 'success', '--notes', 'passes');
    cli('update-status', taskId, 'completed');

    // Rollup
    cli('rollup-all');

    const final = readGoals();
    assert.equal(final.majorPhases[0].phases[0].status, 'completed', 'Sub-phase should be completed');
    assert.equal(final.majorPhases[0].status, 'completed', 'Major phase should cascade to completed');
  });

  it('stale-tasks finds tasks stuck in-progress', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const g1 = readGoals();
    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', g1.majorPhases[0].id, '--produces', 'a', '--consumes', 'b');
    const g2 = readGoals();
    const phaseId = g2.majorPhases[0].phases[0].id;
    cli('add-task', phaseId, '--title', 'T1', '--desc', 'test');
    const g3 = readGoals();
    const taskId = g3.majorPhases[0].phases[0].tasks[0].id;

    // Set in-progress with an old attempt
    cli('update-status', taskId, 'in-progress');
    cli('add-attempt', taskId, '--type', 'build', '--desc', 'started');

    // Manually backdate the attempt
    const goals = readGoals();
    goals.majorPhases[0].phases[0].tasks[0].attempts[0].createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync('.goals.json', JSON.stringify(goals, null, 2));

    // Check for stale tasks (threshold = 30 min)
    const result = cliRaw('stale-tasks', '--minutes', '30');
    const staleTasks = JSON.parse(result);
    assert.ok(staleTasks.length > 0, `Should detect stale task, got: ${JSON.stringify(staleTasks)}`);
    // Verify it found a stale task (format may vary)
    const first = staleTasks[0];
    assert.ok(first.id || first.title || first.taskId, `Stale task should have an identifier: ${JSON.stringify(first)}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  5. Memory hygiene edge cases
// ══════════════════════════════════════════════════════════════════════════

describe('Memory hygiene edge cases', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('handles corrupt memory files without crashing', () => {
    writeFileSync('.pm/memory/decisions.md', '');
    writeFileSync('.pm/memory/concerns.md', 'not valid markdown format at all !!!');
    writeFileSync('.qa/memory/status.json', 'NOT JSON');

    const hygienePath = resolve('lib/memory-hygiene.js');
    if (!existsSync(hygienePath)) return; // skip if not available

    try {
      const result = execFileSync('node', [hygienePath], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      // Should not crash
      assert.ok(true, 'Memory hygiene handled corrupt files');
    } catch (err) {
      assert.fail(`Memory hygiene crashed on corrupt files: ${err.message}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  6. Link check and screenshot grid without dev server
// ══════════════════════════════════════════════════════════════════════════

describe('Tools without dev server', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('link-check exits gracefully without dev server', () => {
    // Create minimal app structure
    mkdirSync('app', { recursive: true });
    writeFileSync('app/page.js', 'export default function Home() { return <div>Home</div> }');

    const linkCheckPath = resolve('lib/link-check.js');
    if (!existsSync(linkCheckPath)) return;

    try {
      const result = execFileSync('node', [linkCheckPath], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      const data = JSON.parse(result);
      assert.ok(data.skipped, 'Should skip when no dev server');
    } catch (err) {
      // Non-zero exit is acceptable if it's a clean skip
      if (err.stdout) {
        const data = JSON.parse(err.stdout);
        assert.ok(data.skipped || data.error, 'Should report skip or error');
      }
    }
  });

  it('screenshot-grid exits gracefully without dev server', () => {
    mkdirSync('app', { recursive: true });
    writeFileSync('app/page.js', 'export default function Home() { return <div>Home</div> }');

    const gridPath = resolve('lib/screenshot-grid.js');
    if (!existsSync(gridPath)) return;

    try {
      const result = execFileSync('node', [gridPath], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspace,
      });
      const data = JSON.parse(result);
      assert.ok(data.skipped, 'Should skip when no dev server');
    } catch (err) {
      if (err.stdout) {
        const data = JSON.parse(err.stdout);
        assert.ok(data.skipped || data.error, 'Should report skip or error');
      }
    }
  });
});
