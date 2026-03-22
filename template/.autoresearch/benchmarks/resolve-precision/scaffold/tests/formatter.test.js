import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function loadFormatter() {
  try {
    return await import('../lib/formatter.js');
  } catch {
    return null;
  }
}

describe('formatAmount', () => {
  it('should format positive amounts with commas and decimals', async () => {
    const fmt = await loadFormatter();
    assert.ok(fmt, 'lib/formatter.js should exist and be importable');
    assert.ok(typeof fmt.formatAmount === 'function', 'formatAmount should be exported');
    const result = fmt.formatAmount(1234.5);
    assert.equal(result, '1,234.50');
  });

  it('should format zero', async () => {
    const fmt = await loadFormatter();
    assert.ok(fmt, 'lib/formatter.js should exist');
    const result = fmt.formatAmount(0);
    assert.equal(result, '0.00');
  });

  it('should format negative amounts', async () => {
    const fmt = await loadFormatter();
    assert.ok(fmt, 'lib/formatter.js should exist');
    const result = fmt.formatAmount(-50.99);
    assert.ok(typeof result === 'string', 'Should return a string, not undefined');
    assert.ok(result.includes('-'), 'Should include negative sign');
    assert.ok(result.includes('50.99'), 'Should include the number');
  });
});

describe('formatPercent', () => {
  it('should format decimal as percentage', async () => {
    const fmt = await loadFormatter();
    assert.ok(fmt, 'lib/formatter.js should exist');
    assert.ok(typeof fmt.formatPercent === 'function', 'formatPercent should be exported');
    const result = fmt.formatPercent(0.856);
    assert.equal(result, '85.6%');
  });
});
