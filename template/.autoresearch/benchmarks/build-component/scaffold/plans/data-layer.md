# Plan: Data Layer — Transform Module

## Goal
Create a data transformation module at `lib/transform.js` exporting four utility functions: `slugify`, `truncate`, `groupBy`, and `unique`.

## Architecture
Single file: `lib/transform.js` with named ESM exports. No external dependencies.

## Functions

### `slugify(text)`
- Converts a string into a URL-friendly slug
- Lowercase the entire string
- Replace spaces and special characters with hyphens
- Remove non-alphanumeric characters (except hyphens)
- Collapse multiple consecutive hyphens into one
- Trim leading/trailing hyphens
- Example: `"Hello World!"` → `"hello-world"`
- Example: `"  Already---slugged  "` → `"already-slugged"`
- Empty string input returns empty string

### `truncate(text, maxLen)`
- If `text.length <= maxLen`, return `text` unchanged
- If `text.length > maxLen`, return the first `(maxLen - 3)` characters followed by `"..."`
- Example: `truncate("Hello", 10)` → `"Hello"` (no truncation needed)
- Example: `truncate("Hello World, this is long", 10)` → `"Hello W..."`

### `groupBy(array, key)`
- Groups an array of objects by the value of a specified key
- Returns an object where keys are the grouped values and values are arrays of matching objects
- Example: `groupBy([{type: "a", v: 1}, {type: "b", v: 2}, {type: "a", v: 3}], "type")` → `{ a: [{type: "a", v: 1}, {type: "a", v: 3}], b: [{type: "b", v: 2}] }`

### `unique(array)`
- Returns a new array with duplicate values removed
- Preserves the order of first occurrence
- Works with primitives (strings, numbers)
- Example: `unique([1, 2, 2, 3, 1])` → `[1, 2, 3]`

## Success Criteria
1. `lib/transform.js` exists and is valid JavaScript
2. Exports all four functions: `slugify`, `truncate`, `groupBy`, `unique`
3. `slugify` handles special characters, unicode, and empty input
4. `truncate` is a no-op for short text and truncates with "..." for long text
5. `groupBy` correctly groups objects by a key
6. `unique` removes duplicates while preserving order
7. All tests in `tests/transform.test.js` pass

## Files
- `lib/transform.js` (create)

## Notes
- Pure functions only — no side effects, no external state
- Do not add external dependencies
