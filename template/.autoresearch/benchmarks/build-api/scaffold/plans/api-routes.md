# Plan: API Routes — User Endpoint

## Goal
Create a REST API route module at `lib/routes/users.js` that handles user CRUD operations using the pre-provided in-memory store (`lib/store.js`).

## Architecture
Single file: `lib/routes/users.js` with named ESM exports. Uses `lib/store.js` for data persistence.

## Endpoints

### GET /api/users/:id
- Import `getUser` from `../store.js`
- Accept an `id` parameter
- Return the user object as JSON if found
- Return `{ error: "Not found" }` with status 404 if no user with that ID exists
- Return `{ error: "Invalid id" }` with status 400 if the ID is not a valid positive integer

### POST /api/users
- Import `createUser` from `../store.js`
- Accept a JSON body with `name` and `email` fields
- Validate that `name` is a non-empty string
- Validate that `email` is a non-empty string containing `@`
- If validation fails, return `{ error: "..." }` with status 400
- On success, create the user and return the new user object with status 201

## Exports
- `handleGetUser(id)` — returns `{ status, body }` object
- `handleCreateUser(data)` — returns `{ status, body }` object

## Success Criteria
1. `lib/routes/users.js` exists and is valid JavaScript
2. Exports `handleGetUser(id)` function
3. Exports `handleCreateUser(data)` function
4. GET with valid id returns user object with status 200
5. GET with non-existent id returns 404
6. GET with invalid id (e.g. "abc") returns 400
7. POST with valid name + email creates user with status 201
8. POST with missing name returns 400
9. POST with invalid email (no @) returns 400
10. All tests in `tests/users.test.js` pass

## Files
- `lib/routes/users.js` (create)

## Notes
- Use the pre-provided `lib/store.js` — do NOT create a new store
- Return `{ status, body }` objects — do not use Express/HTTP directly
- Do not add external dependencies
