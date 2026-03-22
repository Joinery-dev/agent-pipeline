import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import so the test file can exist before lib/transform.js does
async function loadTransform() {
  try {
    return await import('../lib/transform.js');
  } catch {
    return null;
  }
}

describe('slugify', () => {
  it('should convert text with special characters to a slug', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist and be importable');
    assert.ok(typeof mod.slugify === 'function', 'slugify should be exported');

    const result = mod.slugify('Hello World!');
    assert.equal(result, 'hello-world');
  });

  it('should handle unicode and multiple spaces', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');

    const result = mod.slugify('  Caf\u00e9  Latt\u00e9  ');
    assert.ok(typeof result === 'string', 'Should return a string');
    assert.ok(result.length > 0, 'Should not be empty');
    assert.ok(!result.startsWith('-'), 'Should not start with hyphen');
    assert.ok(!result.endsWith('-'), 'Should not end with hyphen');
    assert.ok(!/--/.test(result), 'Should not have consecutive hyphens');
  });

  it('should return empty string for empty input', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');

    const result = mod.slugify('');
    assert.equal(result, '');
  });
});

describe('truncate', () => {
  it('should not truncate short text', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');
    assert.ok(typeof mod.truncate === 'function', 'truncate should be exported');

    const result = mod.truncate('Hello', 10);
    assert.equal(result, 'Hello');
  });

  it('should truncate long text with ellipsis', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');

    const result = mod.truncate('Hello World, this is long', 10);
    assert.equal(result.length, 10, `Should be exactly maxLen characters, got: ${result.length}`);
    assert.ok(result.endsWith('...'), `Should end with "...", got: "${result}"`);
  });

  it('should return text unchanged at exact length', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');

    const result = mod.truncate('12345', 5);
    assert.equal(result, '12345');
  });
});

describe('groupBy', () => {
  it('should group objects by a key', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');
    assert.ok(typeof mod.groupBy === 'function', 'groupBy should be exported');

    const input = [
      { type: 'fruit', name: 'apple' },
      { type: 'veggie', name: 'carrot' },
      { type: 'fruit', name: 'banana' },
    ];
    const result = mod.groupBy(input, 'type');

    assert.ok(result.fruit, 'Should have fruit group');
    assert.ok(result.veggie, 'Should have veggie group');
    assert.equal(result.fruit.length, 2, 'Fruit group should have 2 items');
    assert.equal(result.veggie.length, 1, 'Veggie group should have 1 item');
  });
});

describe('unique', () => {
  it('should remove duplicates while preserving order', async () => {
    const mod = await loadTransform();
    assert.ok(mod, 'lib/transform.js should exist');
    assert.ok(typeof mod.unique === 'function', 'unique should be exported');

    const result = mod.unique([1, 2, 2, 3, 1, 4]);
    assert.deepEqual(result, [1, 2, 3, 4]);
  });
});
