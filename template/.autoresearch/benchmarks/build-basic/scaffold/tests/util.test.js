import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import so the test file can exist before lib/util.js does
async function loadUtil() {
  try {
    return await import('../lib/util.js');
  } catch {
    return null;
  }
}

describe('formatCurrency', () => {
  it('should format USD amounts with dollar sign and commas', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist and be importable');
    assert.ok(typeof util.formatCurrency === 'function', 'formatCurrency should be exported');
    const result = util.formatCurrency(1234.5, 'USD');
    assert.ok(result.includes('1,234'), `Should include formatted number, got: ${result}`);
    assert.ok(result.includes('$') || result.includes('USD'), `Should include currency symbol, got: ${result}`);
  });

  it('should format EUR amounts', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.formatCurrency(1234.5, 'EUR');
    assert.ok(typeof result === 'string', 'Should return a string');
    assert.ok(result.length > 0, 'Should not be empty');
  });

  it('should handle zero amount', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.formatCurrency(0, 'USD');
    assert.ok(result.includes('0'), `Should include zero, got: ${result}`);
  });

  it('should handle negative amounts', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.formatCurrency(-50.99, 'USD');
    assert.ok(typeof result === 'string', 'Should return a string');
  });
});

describe('parseDate', () => {
  it('should parse ISO date strings', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    assert.ok(typeof util.parseDate === 'function', 'parseDate should be exported');
    const result = util.parseDate('2026-03-22');
    assert.ok(result instanceof Date, 'Should return a Date object');
    assert.equal(result.getFullYear(), 2026);
  });

  it('should return null for invalid dates', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.parseDate('invalid');
    assert.equal(result, null, 'Should return null for invalid input');
  });
});
