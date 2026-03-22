import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, countItems, formatResponse } from '../lib/api.js';

// ── validateInput ────────────────────────────────────────────────────

describe('validateInput', () => {
  it('should accept a valid non-empty string', () => {
    const result = validateInput('hello');
    assert.deepStrictEqual(result, { valid: true, value: 'hello' });
  });

  it('should reject an empty string', () => {
    // This test FAILS — the bug: empty string is not rejected
    const result = validateInput('');
    assert.deepStrictEqual(result, { valid: false, error: 'Input must not be empty' });
  });

  it('should reject null input', () => {
    const result = validateInput(null);
    assert.deepStrictEqual(result, { valid: false, error: 'Input must be a string' });
  });
});

// ── countItems ───────────────────────────────────────────────────────

describe('countItems', () => {
  it('should count all items without a filter', () => {
    assert.equal(countItems([1, 2, 3]), 3);
  });

  it('should count filtered items correctly', () => {
    // This test FAILS — the bug: off-by-one skips index 0
    // [1,2,3,4,5].filter(x => x > 2) = [3,4,5] → 3 expected
    // But the bug starts at index 1, so it only checks [2,3,4,5]
    // and filters to [3,4,5] → gets 3... let's adjust so the bug is visible
    // With filter x => x >= 1: all 5 should match, but skipping index 0 gives 4
    assert.equal(countItems([1, 2, 3, 4, 5], x => x >= 1), 5);
  });

  it('should return 0 for empty array', () => {
    assert.equal(countItems([]), 0);
  });
});

// ── formatResponse ───────────────────────────────────────────────────

describe('formatResponse', () => {
  it('should format a success response', () => {
    const result = formatResponse({ name: 'test' }, 200);
    assert.deepStrictEqual(result, { status: 200, data: { name: 'test' }, ok: true });
  });

  it('should format an error response', () => {
    const result = formatResponse('not found', 404);
    assert.deepStrictEqual(result, { status: 404, data: 'not found', ok: false });
  });

  it('should handle null data with 204', () => {
    const result = formatResponse(null, 204);
    assert.deepStrictEqual(result, { status: 204, data: null, ok: true });
  });
});
