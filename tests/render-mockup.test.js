/**
 * Tests for render-mockup.js CLI argument handling.
 *
 * Run: node --test tests/render-mockup.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'lib', 'render-mockup.js');

function runFail(args) {
  try {
    execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return null;
  } catch (err) {
    return err;
  }
}

describe('render-mockup argument validation', () => {

  it('missing --html prints usage and exits 1', () => {
    const err = runFail('--output out.png');
    assert.ok(err);
    assert.equal(err.status, 1);
    assert.ok(err.stderr.includes('Usage'));
  });

  it('missing --output prints usage and exits 1', () => {
    const err = runFail('--html test.html');
    assert.ok(err);
    assert.equal(err.status, 1);
    assert.ok(err.stderr.includes('Usage'));
  });

  it('nonexistent HTML file exits 1', () => {
    const err = runFail('--html /tmp/definitely-not-a-file-abc123.html --output out.png');
    assert.ok(err);
    assert.equal(err.status, 1);
  });

  it('missing both flags prints usage and exits 1', () => {
    const err = runFail('');
    assert.ok(err);
    assert.equal(err.status, 1);
  });
});
