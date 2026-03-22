import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import so the test file can exist before lib/routes/users.js does
async function loadRoutes() {
  try {
    return await import('../lib/routes/users.js');
  } catch {
    return null;
  }
}

describe('handleGetUser', () => {
  it('should return a user for a valid id', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist and be importable');
    assert.ok(typeof routes.handleGetUser === 'function', 'handleGetUser should be exported');

    // First create a user so we can GET it
    const { handleCreateUser, handleGetUser } = routes;
    const created = handleCreateUser({ name: 'Alice', email: 'alice@example.com' });
    assert.equal(created.status, 201, `POST should return 201, got: ${created.status}`);

    const result = handleGetUser(created.body.id);
    assert.equal(result.status, 200, `GET should return 200, got: ${result.status}`);
    assert.equal(result.body.name, 'Alice');
    assert.equal(result.body.email, 'alice@example.com');
  });

  it('should return 400 for an invalid id', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist');

    const result = routes.handleGetUser('abc');
    assert.equal(result.status, 400, `Should return 400 for invalid id, got: ${result.status}`);
    assert.ok(result.body.error, 'Should include error message');
  });

  it('should return 404 for a missing user', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist');

    const result = routes.handleGetUser(99999);
    assert.equal(result.status, 404, `Should return 404 for missing user, got: ${result.status}`);
    assert.ok(result.body.error, 'Should include error message');
  });
});

describe('handleCreateUser', () => {
  it('should create a user with valid data', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist');
    assert.ok(typeof routes.handleCreateUser === 'function', 'handleCreateUser should be exported');

    const result = routes.handleCreateUser({ name: 'Bob', email: 'bob@example.com' });
    assert.equal(result.status, 201, `Should return 201, got: ${result.status}`);
    assert.ok(result.body.id, 'Created user should have an id');
    assert.equal(result.body.name, 'Bob');
    assert.equal(result.body.email, 'bob@example.com');
  });

  it('should return 400 when name is missing', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist');

    const result = routes.handleCreateUser({ email: 'test@example.com' });
    assert.equal(result.status, 400, `Should return 400 for missing name, got: ${result.status}`);
    assert.ok(result.body.error, 'Should include error message');
  });

  it('should return 400 for invalid email (no @)', async () => {
    const routes = await loadRoutes();
    assert.ok(routes, 'lib/routes/users.js should exist');

    const result = routes.handleCreateUser({ name: 'Charlie', email: 'not-an-email' });
    assert.equal(result.status, 400, `Should return 400 for invalid email, got: ${result.status}`);
    assert.ok(result.body.error, 'Should include error message');
  });
});
