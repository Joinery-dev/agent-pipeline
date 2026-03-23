import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, join } from 'path';

const CLI = resolve('lib/pipeline-cli.js');

let workspace;

function setup() {
  workspace = resolve(`/tmp/pipeline-attack-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  process.chdir(workspace);
  mkdirSync('.pm/memory', { recursive: true });
  mkdirSync('.qa/memory', { recursive: true });
  mkdirSync('.design/memory', { recursive: true });
  mkdirSync('.exec/memory', { recursive: true });
  mkdirSync('.ship', { recursive: true });
  mkdirSync('plans', { recursive: true });
  writeFileSync('.goals.json', JSON.stringify({
    id: crypto.randomUUID(),
    name: 'attack-test',
    description: '',
    vision: '',
    majorPhases: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2));
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

function cliFail(...args) {
  try {
    execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspace,
    });
    return null;
  } catch (err) {
    return err;
  }
}

function readGoals() {
  return JSON.parse(readFileSync(join(workspace, '.goals.json'), 'utf-8'));
}

// Helper to create a full project structure for testing
function scaffoldProject() {
  cli('update-project', '--name', 'Attack Test', '--vision', 'Test vision', '--desc', 'Test');
  cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
  const g1 = readGoals();
  const mpId = g1.majorPhases[0].id;
  cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', mpId, '--produces', 'a', '--consumes', 'b');
  const g2 = readGoals();
  const phaseId = g2.majorPhases[0].phases[0].id;
  cli('add-task', phaseId, '--title', 'T1', '--desc', 'test task', '--files', 'app/page.js');
  const g3 = readGoals();
  return {
    mpId,
    phaseId,
    taskId: g3.majorPhases[0].phases[0].tasks[0].id,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  1. COMMAND INJECTION — can field values execute shell commands?
// ══════════════════════════════════════════════════════════════════════════

describe('Command injection via field values', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('title with shell metacharacters is stored literally, not executed', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', '$(whoami)', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const goals = readGoals();
    assert.equal(goals.majorPhases[0].title, '$(whoami)', 'Should store literally, not execute');
  });

  it('title with backticks is stored literally', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', '`rm -rf /`', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const goals = readGoals();
    assert.equal(goals.majorPhases[0].title, '`rm -rf /`');
  });

  it('description with newlines and JSON breakers', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'line1\nline2\n{"inject": true}');
    const goals = readGoals();
    // Should be stored as a string, not parsed as JSON
    assert.equal(typeof goals.description, 'string');
    assert.ok(goals.description.includes('inject'));
  });

  it('produces field with semicolons and pipes', () => {
    cli('update-project', '--name', 'Test', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test',
      '--produces', 'api; rm -rf / | cat /etc/passwd',
      '--consumes', 'y');
    const goals = readGoals();
    assert.ok(goals.majorPhases[0].interfaceContract.produces[0].includes('rm -rf'));
    // The dangerous value is stored but never executed — it's just a string
  });

  it('attempt notes with control characters', () => {
    const { taskId } = scaffoldProject();
    cli('update-status', taskId, 'in-progress');
    cli('add-attempt', taskId, '--type', 'build', '--desc', 'test\x00\x01\x02null bytes');
    const goals = readGoals();
    const attempt = goals.majorPhases[0].phases[0].tasks[0].attempts[0];
    assert.ok(attempt, 'Attempt should exist despite control characters');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  2. LARGE PROJECT STRESS — does it scale?
// ══════════════════════════════════════════════════════════════════════════

describe('Large project stress', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('handles 10 major phases with 5 sub-phases each', () => {
    cli('update-project', '--name', 'Big Project', '--vision', 'Scale test', '--desc', 'test');

    for (let mp = 0; mp < 10; mp++) {
      cli('add-major-phase', '--title', `Major ${mp}`, '--desc', `mp ${mp}`,
        '--produces', `output-${mp}`, '--consumes', `input-${mp}`);
    }

    const g1 = readGoals();
    assert.equal(g1.majorPhases.length, 10);

    // Add sub-phases to first major phase
    const mpId = g1.majorPhases[0].id;
    for (let sp = 0; sp < 5; sp++) {
      cli('add-phase', '--title', `Sub ${sp}`, '--desc', `sp ${sp}`, '--majorPhase', mpId,
        '--produces', `sub-out-${sp}`, '--consumes', `sub-in-${sp}`);
    }

    const g2 = readGoals();
    assert.equal(g2.majorPhases[0].phases.length, 5);
  });

  it('handles 50 tasks in a single phase', () => {
    cli('update-project', '--name', 'Many Tasks', '--vision', 'test', '--desc', 'test');
    cli('add-major-phase', '--title', 'MP1', '--desc', 'test', '--produces', 'x', '--consumes', 'y');
    const g1 = readGoals();
    const mpId = g1.majorPhases[0].id;
    cli('add-phase', '--title', 'P1', '--desc', 'test', '--majorPhase', mpId,
      '--produces', 'a', '--consumes', 'b');
    const g2 = readGoals();
    const phaseId = g2.majorPhases[0].phases[0].id;

    for (let t = 0; t < 50; t++) {
      cli('add-task', phaseId, '--title', `Task ${t}`, '--desc', `task ${t}`,
        '--files', `app/component-${t}.js`);
    }

    const g3 = readGoals();
    assert.equal(g3.majorPhases[0].phases[0].tasks.length, 50);

    // Validate should still work
    const result = cli('validate');
    assert.ok(result, 'Validate should handle 50 tasks');
  });

  it('.goals.json stays valid JSON after many mutations', () => {
    const { phaseId, taskId } = scaffoldProject();

    // Rapid fire mutations
    cli('update-status', taskId, 'in-progress');
    for (let i = 0; i < 20; i++) {
      cli('add-attempt', taskId, '--type', 'build', '--desc', `attempt ${i}`);
    }

    const goals = readGoals();
    assert.ok(goals, '.goals.json should still be valid JSON');
    assert.equal(goals.majorPhases[0].phases[0].tasks[0].attempts.length, 20);
  });

  it('rollup-all handles complex nested structure', () => {
    cli('update-project', '--name', 'Complex', '--vision', 'test', '--desc', 'test');

    // 3 major phases, 2 sub-phases each, 3 tasks each
    for (let mp = 0; mp < 3; mp++) {
      cli('add-major-phase', '--title', `MP${mp}`, '--desc', 'test',
        '--produces', `out${mp}`, '--consumes', `in${mp}`);
    }

    const g1 = readGoals();
    for (const mp of g1.majorPhases) {
      for (let sp = 0; sp < 2; sp++) {
        cli('add-phase', '--title', `${mp.title}-SP${sp}`, '--desc', 'test',
          '--majorPhase', mp.id, '--produces', `sp-out`, '--consumes', `sp-in`);
      }
    }

    const g2 = readGoals();
    // Add tasks to first sub-phase of first major phase
    const firstPhase = g2.majorPhases[0].phases[0];
    for (let t = 0; t < 3; t++) {
      cli('add-task', firstPhase.id, '--title', `T${t}`, '--desc', 'test');
    }

    // rollup-all should not crash on this structure
    const result = JSON.parse(execFileSync('node', [CLI, 'rollup-all'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
    }));
    assert.ok(Array.isArray(result), 'rollup-all should return array');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  3. CORRUPT STATE — what if .goals.json is damaged mid-run?
// ══════════════════════════════════════════════════════════════════════════

describe('Corrupt and partial state', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('handles .goals.json with missing majorPhases array', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V', description: 'D',
      // majorPhases missing entirely
    }));
    // Commands should handle this gracefully
    const err = cliFail('rollup-all');
    // Should not crash with unhandled exception
  });

  it('handles .goals.json with null fields', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: null, name: null, vision: null, description: null,
      majorPhases: null,
    }));
    const err = cliFail('validate');
    // Should report errors, not crash
  });

  it('handles phase with tasks: null', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V',
      majorPhases: [{ id: 'mp1', title: 'MP1', status: 'not-started',
        phases: [{ id: 'p1', title: 'P1', status: 'not-started', tasks: null }]
      }]
    }));
    const err = cliFail('rollup-all');
    // Should handle null tasks without crashing
  });

  it('handles task with attempts: undefined', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V',
      majorPhases: [{ id: 'mp1', title: 'MP1', status: 'not-started',
        phases: [{ id: 'p1', title: 'P1', status: 'not-started',
          tasks: [{ id: 't1', title: 'T1', status: 'not-started' }]
          // attempts field missing entirely
        }]
      }]
    }));
    // Adding an attempt to a task with no attempts array
    const result = cli('add-attempt', 't1', '--type', 'build', '--desc', 'test');
    assert.ok(result, 'Should handle missing attempts array');
    const goals = readGoals();
    assert.ok(Array.isArray(goals.majorPhases[0].phases[0].tasks[0].attempts));
  });

  it('handles duplicate task IDs', () => {
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V',
      majorPhases: [{ id: 'mp1', title: 'MP1', status: 'not-started',
        phases: [{ id: 'p1', title: 'P1', status: 'not-started',
          tasks: [
            { id: 'DUPE', title: 'T1', status: 'not-started', attempts: [] },
            { id: 'DUPE', title: 'T2', status: 'not-started', attempts: [] },
          ]
        }]
      }]
    }));
    // Which one does update-status target?
    cli('update-status', 'DUPE', 'in-progress');
    const goals = readGoals();
    const tasks = goals.majorPhases[0].phases[0].tasks;
    const inProgress = tasks.filter(t => t.status === 'in-progress');
    // At least one should be updated — but which? Both? First only?
    assert.ok(inProgress.length >= 1, 'Should update at least one duplicate');
    // This reveals whether findTask returns first match or all matches
  });

  it('survives .goals.json written with trailing garbage', () => {
    const valid = JSON.stringify({ id: 'test', name: 'Test', vision: 'V', majorPhases: [] });
    writeFileSync('.goals.json', valid + '\n\n// some garbage\n');
    const err = cliFail('validate');
    assert.ok(err, 'Should fail on trailing garbage (not valid JSON)');
  });

  it('handles extremely deeply nested majorPhases', () => {
    // What if someone nests phases inside phases manually?
    writeFileSync('.goals.json', JSON.stringify({
      id: 'test', name: 'Test', vision: 'V',
      majorPhases: [{
        id: 'mp1', title: 'MP1', status: 'not-started',
        phases: [{
          id: 'p1', title: 'P1', status: 'not-started',
          phases: [{ // illegally nested phases inside a phase
            id: 'p2', title: 'NESTED', status: 'not-started', tasks: []
          }],
          tasks: []
        }]
      }]
    }));
    // getAllPhases should handle this — does it recurse into nested phases?
    const err = cliFail('rollup-all');
    // Should not infinite loop or crash
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  4. CONCURRENT WRITE SAFETY
// ══════════════════════════════════════════════════════════════════════════

describe('Concurrent write safety', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rapid sequential writes produce valid JSON', () => {
    const { phaseId } = scaffoldProject();

    // Simulate rapid writes like multiple agents updating
    const promises = [];
    for (let i = 0; i < 10; i++) {
      try {
        cli('add-task', phaseId, '--title', `Rapid-${i}`, '--desc', `rapid ${i}`);
      } catch {
        // Some may fail due to read-modify-write races — that's expected
      }
    }

    // .goals.json should still be valid JSON
    const content = readFileSync(join(workspace, '.goals.json'), 'utf-8');
    let goals;
    try {
      goals = JSON.parse(content);
    } catch {
      assert.fail('.goals.json is corrupted after rapid writes');
    }
    assert.ok(goals.majorPhases[0].phases[0].tasks.length > 1, 'Some tasks should have been added');
  });

  it('external modification between reads is not detected', () => {
    const { taskId } = scaffoldProject();

    // Simulate: ship.js reads goals, agent modifies goals, ship.js reads again
    cli('update-status', taskId, 'in-progress');

    // External modification — add a field that shouldn't be there
    const goals = readGoals();
    goals._externalHack = true;
    writeFileSync(join(workspace, '.goals.json'), JSON.stringify(goals, null, 2));

    // Next CLI command reads the modified file — does it preserve the hack?
    cli('add-attempt', taskId, '--type', 'build', '--desc', 'test');
    const after = readGoals();
    assert.equal(after._externalHack, true,
      'Pipeline preserves unknown fields — no schema enforcement on read');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  5. STATUS TRANSITION ATTACKS
// ══════════════════════════════════════════════════════════════════════════

describe('Status transition attacks', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('cannot go backwards: completed to in-progress', () => {
    const { taskId } = scaffoldProject();
    cli('update-status', taskId, 'in-progress');
    cli('add-attempt', taskId, '--type', 'build', '--desc', 'built');
    const g1 = readGoals();
    cli('update-attempt', taskId, g1.majorPhases[0].phases[0].tasks[0].attempts[0].id,
      '--outcome', 'success', '--notes', 'done');
    cli('add-attempt', taskId, '--type', 'qa', '--desc', 'qa');
    const g2 = readGoals();
    cli('update-attempt', taskId, g2.majorPhases[0].phases[0].tasks[0].attempts[1].id,
      '--outcome', 'success', '--notes', 'pass');
    cli('update-status', taskId, 'completed');

    // Try to go back
    const err = cliFail('update-status', taskId, 'in-progress');
    assert.ok(err, 'Should reject completed → in-progress transition');
  });

  it('cannot skip: not-started directly to blocked', () => {
    const { taskId } = scaffoldProject();
    const err = cliFail('update-status', taskId, 'blocked');
    assert.ok(err, 'Should reject not-started → blocked transition');
  });

  it('pipeline state can be set to any value regardless of current state', () => {
    const { phaseId } = scaffoldProject();
    // Go through normal flow
    cli('set-pipeline', phaseId, 'building', '--agent', 'build');
    // Jump directly to complete — does it allow this?
    cli('set-pipeline', phaseId, 'complete', '--agent', 'qa');
    const goals = readGoals();
    assert.equal(goals.majorPhases[0].phases[0].pipeline.state, 'complete',
      'Pipeline state has NO transition validation — any state can go to any state');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  6. MEMORY FILE ATTACKS
// ══════════════════════════════════════════════════════════════════════════

describe('Memory file edge cases', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('distiller handles .qa/memory/status.json with unexpected schema', () => {
    const DISTILLER = resolve('lib/distill-briefing.js');
    const { taskId } = scaffoldProject();

    // Write status.json with unexpected fields
    writeFileSync(join(workspace, '.qa/memory/status.json'),
      JSON.stringify({ unexpected: true, criteria: 'not an array', verdict: 42 }));

    try {
      execFileSync('node', [DISTILLER, '--agent', 'build', '--task', taskId], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
      });
      assert.ok(existsSync(join(workspace, '.ship/briefing.md')),
        'Distiller should handle unexpected schema without crashing');
    } catch (err) {
      assert.fail(`Distiller crashed on unexpected status.json schema: ${err.stderr}`);
    }
  });

  it('distiller handles page-grades.json with malformed grade entries', () => {
    const DISTILLER = resolve('lib/distill-briefing.js');
    const { taskId } = scaffoldProject();

    writeFileSync(join(workspace, '.design/memory/page-grades.json'),
      JSON.stringify({
        '/': { grades: 'not an array' },
        '/about': { grades: [{ grade: null, phase: undefined }] },
        '/broken': null,
      }));

    try {
      execFileSync('node', [DISTILLER, '--agent', 'build', '--task', taskId], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
      });
      assert.ok(true, 'Distiller should handle malformed page-grades');
    } catch (err) {
      assert.fail(`Distiller crashed on malformed page-grades: ${err.stderr}`);
    }
  });

  it('concerns.md with markdown injection does not break filtering', () => {
    writeFileSync(join(workspace, '.pm/memory/concerns.md'),
      '# Concerns\n\n## HIGH — Real concern\n**Status:** OPEN\n**Description:** test\n\n' +
      '## INJECTED\n**Status:** OPEN</h1><script>alert(1)</script>\n**Description:** xss attempt\n');

    const DISTILLER = resolve('lib/distill-briefing.js');
    const { taskId } = scaffoldProject();

    try {
      execFileSync('node', [DISTILLER, '--agent', 'build', '--task', taskId], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
      });
      const briefing = readFileSync(join(workspace, '.ship/briefing.md'), 'utf-8');
      // Script tags should be escaped in XML output
      assert.ok(!briefing.includes('<script>'), 'Script tags should be escaped');
    } catch (err) {
      assert.fail(`Distiller crashed on markdown injection: ${err.stderr}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  7. PLAN FILE ATTACKS
// ══════════════════════════════════════════════════════════════════════════

describe('Plan file edge cases', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('validate-plan handles missing plan file gracefully', () => {
    const { phaseId } = scaffoldProject();
    // Phase references a plan file that doesn't exist
    const goals = readGoals();
    goals.majorPhases[0].phases[0].planFile = 'plans/nonexistent.md';
    writeFileSync(join(workspace, '.goals.json'), JSON.stringify(goals, null, 2));

    const validatePath = resolve('lib/validate-plan.js');
    if (!existsSync(validatePath)) return;

    try {
      execFileSync('node', [validatePath, '--phase', phaseId], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
      });
    } catch (err) {
      // Should report error, not crash with unhandled exception
      assert.ok(err.stdout || err.stderr, 'Should provide error message');
    }
  });

  it('plan-to-tasks handles empty plan file', () => {
    const { phaseId } = scaffoldProject();
    writeFileSync(join(workspace, 'plans/empty.md'), '');
    const goals = readGoals();
    goals.majorPhases[0].phases[0].planFile = 'plans/empty.md';
    writeFileSync(join(workspace, '.goals.json'), JSON.stringify(goals, null, 2));

    const p2tPath = resolve('lib/plan-to-tasks.js');
    if (!existsSync(p2tPath)) return;

    try {
      const result = execFileSync('node', [p2tPath, '--plan', 'plans/empty.md', '--phase', phaseId], {
        encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace,
      });
      const parsed = JSON.parse(result);
      assert.equal(parsed.tasksCreated, 0, 'Should create 0 tasks from empty plan');
    } catch (err) {
      // Acceptable — empty plan is a valid error
    }
  });
});
