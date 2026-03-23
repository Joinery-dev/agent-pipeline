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

  it('should format JPY without decimal places', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.formatCurrency(1234, 'JPY');
    assert.ok(!result.includes('.'), `JPY should not have decimals, got: ${result}`);
    assert.ok(result.includes('1,234') || result.includes('1234'), `Should format number, got: ${result}`);
  });

  it('should format very large numbers with proper grouping', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.formatCurrency(1234567890.12, 'USD');
    assert.ok(result.includes('1,234,567,890'), `Should format billions with commas, got: ${result}`);
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

  it('should parse ISO datetime strings with time component', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.parseDate('2026-03-22T14:30:00Z');
    assert.ok(result instanceof Date, 'Should parse ISO datetime');
    assert.equal(result.getUTCHours(), 14, 'Should preserve hours');
  });

  it('should return null for empty string', async () => {
    const util = await loadUtil();
    assert.ok(util, 'lib/util.js should exist');
    const result = util.parseDate('');
    assert.equal(result, null, 'Empty string should return null');
  });
});
