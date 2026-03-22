/**
 * Tests for the add-illustration CLI command.
 *
 * Run: node --test tests/pipeline-cli-illustrations.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'lib', 'pipeline-cli.js');

function run(args, cwd) {
  return execSync(`node ${CLI} ${args}`, { cwd, encoding: 'utf-8', timeout: 10000 });
}

function runFail(args, cwd) {
  try {
    execSync(`node ${CLI} ${args}`, { cwd, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return null; // should not reach
  } catch (err) {
    return err;
  }
}

function makeMinimalGoals() {
  return {
    id: 'proj-1',
    name: 'Test Project',
    majorPhases: [{
      id: 'mp-1',
      title: 'MP1',
      status: 'not-started',
      phases: [{
        id: 'phase-1',
        title: 'Phase 1',
        status: 'not-started',
        order: 0,
        tasks: [{
          id: 'task-1',
          title: 'Task 1',
          status: 'not-started',
          attempts: [],
          createdAt: '2024-01-01T00:00:00.000Z',
        }],
      }],
    }],
  };
}

// ── Argument validation (no .goals.json needed) ─────────────────────────

describe('add-illustration argument validation', () => {

  it('missing entityId prints usage and exits 1', () => {
    const err = runFail('add-illustration');
    assert.ok(err);
    assert.equal(err.status, 1);
    assert.ok(err.stderr.includes('Usage') || err.stdout.includes('Usage'));
  });

  it('missing --title exits 1', () => {
    const err = runFail('add-illustration some-id --imagePath /tmp/x.png');
    assert.ok(err);
    assert.equal(err.status, 1);
  });

  it('missing --imagePath exits 1', () => {
    const err = runFail('add-illustration some-id --title "Test"');
    assert.ok(err);
    assert.equal(err.status, 1);
  });
});

// ── Integration tests (temp directory with .goals.json) ──────────────────

describe('add-illustration integration', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cli-ill-'));
    writeFileSync(join(tmpDir, '.goals.json'), JSON.stringify(makeMinimalGoals(), null, 2));
    // Create a dummy PNG file
    writeFileSync(join(tmpDir, 'mockup.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('valid args succeed and return illustrationId', () => {
    const out = run('add-illustration phase-1 --title "Homepage" --imagePath mockup.png', tmpDir);
    const result = JSON.parse(out);
    assert.ok(result.illustrationId);
    assert.equal(result.title, 'Homepage');
    assert.equal(result.entityId, 'phase-1');
  });

  it('illustration is stored in .goals.json', () => {
    const goals = JSON.parse(readFileSync(join(tmpDir, '.goals.json'), 'utf-8'));
    const phase = goals.majorPhases[0].phases[0];
    assert.ok(Array.isArray(phase.illustrations));
    assert.ok(phase.illustrations.length >= 1);
    const ill = phase.illustrations[phase.illustrations.length - 1];
    assert.equal(ill.title, 'Homepage');
    assert.equal(ill.imagePath, 'mockup.png');
  });

  it('--viewport parses correctly', () => {
    const out = run('add-illustration phase-1 --title "Mobile" --imagePath mockup.png --viewport 375x812', tmpDir);
    const result = JSON.parse(out);
    const goals = JSON.parse(readFileSync(join(tmpDir, '.goals.json'), 'utf-8'));
    const phase = goals.majorPhases[0].phases[0];
    const ill = phase.illustrations.find(i => i.id === result.illustrationId);
    assert.deepEqual(ill.viewport, { width: 375, height: 812 });
  });

  it('--region parses correctly', () => {
    const out = run('add-illustration phase-1 --title "Hero" --imagePath mockup.png --region 0,0,100,200', tmpDir);
    const result = JSON.parse(out);
    const goals = JSON.parse(readFileSync(join(tmpDir, '.goals.json'), 'utf-8'));
    const phase = goals.majorPhases[0].phases[0];
    const ill = phase.illustrations.find(i => i.id === result.illustrationId);
    assert.deepEqual(ill.region, { x: 0, y: 0, width: 100, height: 200 });
  });

  it('--region with 3 values exits 1', () => {
    const err = runFail('add-illustration phase-1 --title "Bad" --imagePath mockup.png --region 0,0,100', tmpDir);
    assert.ok(err);
    assert.equal(err.status, 1);
  });

  it('nonexistent image file exits 1', () => {
    const err = runFail('add-illustration phase-1 --title "Missing" --imagePath nope.png', tmpDir);
    assert.ok(err);
    assert.equal(err.status, 1);
  });

  it('nonexistent entity exits 1', () => {
    const err = runFail('add-illustration bad-id --title "Test" --imagePath mockup.png', tmpDir);
    assert.ok(err);
    assert.equal(err.status, 1);
  });
});
