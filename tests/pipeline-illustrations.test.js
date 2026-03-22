/**
 * Tests for validateGoals() — illustration validation paths.
 *
 * Run: node --test tests/pipeline-illustrations.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoals } from '../lib/pipeline.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeGoals(overrides = {}) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    majorPhases: [{
      id: 'mp-1',
      title: 'Major Phase 1',
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
    ...overrides,
  };
}

function makeIllustration(overrides = {}) {
  return {
    id: 'ill-1',
    title: 'Homepage Mockup',
    imagePath: '/tmp/mockup.png',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('validateGoals — illustration validation', () => {

  it('valid illustration passes', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration()],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, true, `Unexpected errors: ${result.errors.join(', ')}`);
  });

  it('missing id produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ id: '' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing id')));
  });

  it('missing title produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ title: '' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing title')));
  });

  it('missing imagePath produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ imagePath: '' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing imagePath')));
  });

  it('missing createdAt produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ createdAt: '' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing createdAt')));
  });

  it('missing updatedAt produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ updatedAt: '' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('missing updatedAt')));
  });

  it('valid region passes', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({
        region: { x: 0, y: 10, width: 100, height: 200 },
      })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, true, `Unexpected errors: ${result.errors.join(', ')}`);
  });

  it('region with non-numeric fields produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({
        region: { x: 'a', y: 10, width: 100, height: 200 },
      })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('region must have numeric')));
  });

  it('region missing width produces error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({
        region: { x: 0, y: 0 },
      })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('region must have numeric')));
  });

  it('illustration without region passes (optional)', () => {
    const ill = makeIllustration();
    assert.equal(ill.region, undefined);
    const goals = makeGoals({ illustrations: [ill] });
    const result = validateGoals(goals);
    assert.equal(result.valid, true);
  });

  it('parentIllustrationId does not cause validation error', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ parentIllustrationId: 'some-parent-id' })],
    });
    const result = validateGoals(goals);
    assert.equal(result.valid, true);
  });
});

describe('validateGoals — illustrations at different entity levels', () => {

  it('validates illustrations at project level', () => {
    const goals = makeGoals({
      illustrations: [makeIllustration({ id: '' })],
    });
    const result = validateGoals(goals);
    assert.ok(result.errors.some(e => e.includes('Project.Illustration')));
  });

  it('validates illustrations at majorPhase level', () => {
    const goals = makeGoals();
    goals.majorPhases[0].illustrations = [makeIllustration({ id: 'mp-ill', title: '' })];
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('MajorPhase[0].Illustration')));
  });

  it('validates illustrations at phase level', () => {
    const goals = makeGoals();
    goals.majorPhases[0].phases[0].illustrations = [makeIllustration({ id: 'ph-ill', imagePath: '' })];
    const result = validateGoals(goals);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Phase[0].Illustration')));
  });

  it('no illustrations is fine (backwards compatible)', () => {
    const goals = makeGoals();
    assert.equal(goals.illustrations, undefined);
    const result = validateGoals(goals);
    assert.equal(result.valid, true);
  });

  it('empty illustrations array is fine', () => {
    const goals = makeGoals({ illustrations: [] });
    const result = validateGoals(goals);
    assert.equal(result.valid, true);
  });
});
