# Plan: REST API Utilities

## Goal
Create a utility module at `lib/api.js` exporting three functions: `validateInput`, `countItems`, and `formatResponse`.

## Architecture
Single file: `lib/api.js` with named ESM exports.

## Task 1: validateInput (qa-task-validate)

Implement `validateInput(input)` — validates that API request input is a non-empty string.

### Success Criteria
1. `validateInput("hello")` returns `{ valid: true, value: "hello" }`
2. `validateInput("")` returns `{ valid: false, error: "Input must not be empty" }`
3. `validateInput(null)` returns `{ valid: false, error: "Input must be a string" }`

## Task 2: countItems (qa-task-count)

Implement `countItems(items, filter)` — counts items in an array, optionally filtering by a predicate.

### Success Criteria
1. `countItems([1, 2, 3])` returns `3`
2. `countItems([1, 2, 3, 4, 5], x => x > 2)` returns `3` (items 3, 4, 5)
3. `countItems([])` returns `0`

## Task 3: formatResponse (qa-task-format)

Implement `formatResponse(data, statusCode)` — wraps data in a standard API response envelope.

### Success Criteria
1. `formatResponse({ name: "test" }, 200)` returns `{ status: 200, data: { name: "test" }, ok: true }`
2. `formatResponse("not found", 404)` returns `{ status: 404, data: "not found", ok: false }`
3. `formatResponse(null, 204)` returns `{ status: 204, data: null, ok: true }`

## Files
- `lib/api.js` (create)

## Notes
- Use pure functions, no external dependencies
- All tests in `tests/api.test.js` should pass
