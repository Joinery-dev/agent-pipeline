import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, truncate, groupBy, unique, flatten } from '../lib/transforms.js';

// ── slugify ──────────────────────────────────────────────────────────

describe('slugify', () => {
  it('should convert a simple string to a slug', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
  });

  it('should handle multiple spaces and special characters', () => {
    assert.equal(slugify('  Multiple   Spaces  '), 'multiple-spaces');
    assert.equal(slugify('Special @#$ Characters!'), 'special-characters');
  });
});

// ── truncate ─────────────────────────────────────────────────────────

describe('truncate', () => {
  it('should truncate a long string with ellipsis', () => {
    assert.equal(truncate('Hello World', 5), 'He...');
  });

  it('should not truncate a short string', () => {
    assert.equal(truncate('Hi', 10), 'Hi');
    assert.equal(truncate('Hello', 5), 'Hello');
  });
});

// ── groupBy ──────────────────────────────────────────────────────────

describe('groupBy', () => {
  it('should group items by key function', () => {
    const input = [
      { type: 'a', v: 1 },
      { type: 'b', v: 2 },
      { type: 'a', v: 3 },
    ];
    const result = groupBy(input, x => x.type);
    assert.deepStrictEqual(result, {
      a: [{ type: 'a', v: 1 }, { type: 'a', v: 3 }],
      b: [{ type: 'b', v: 2 }],
    });
  });

  it('should skip items with null or undefined keys', () => {
    // This test FAILS — the bug: null/undefined keys are not skipped
    const input = [
      { type: 'a', v: 1 },
      { type: null, v: 2 },
      { type: undefined, v: 3 },
      { type: 'a', v: 4 },
    ];
    const result = groupBy(input, x => x.type);
    // Should only contain the 'a' group — null/undefined items excluded
    assert.deepStrictEqual(result, {
      a: [{ type: 'a', v: 1 }, { type: 'a', v: 4 }],
    });
  });
});

// ── unique ───────────────────────────────────────────────────────────

describe('unique', () => {
  it('should remove duplicate numbers', () => {
    assert.deepStrictEqual(unique([1, 2, 2, 3, 1]), [1, 2, 3]);
  });

  it('should remove duplicate strings', () => {
    assert.deepStrictEqual(unique(['a', 'b', 'a']), ['a', 'b']);
  });
});

// ── flatten ──────────────────────────────────────────────────────────

describe('flatten', () => {
  it('should flatten one level by default', () => {
    assert.deepStrictEqual(flatten([1, [2, 3], [4, [5]]]), [1, 2, 3, 4, [5]]);
  });

  it('should flatten deeply with Infinity', () => {
    assert.deepStrictEqual(flatten([1, [2, [3, [4]]]], Infinity), [1, 2, 3, 4]);
  });
});
