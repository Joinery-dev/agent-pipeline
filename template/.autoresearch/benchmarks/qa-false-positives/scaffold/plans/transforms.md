# Plan: Transform Utilities

## Goal
Create a utility module at `lib/transforms.js` exporting five functions: `slugify`, `truncate`, `groupBy`, `unique`, and `flatten`.

## Architecture
Single file: `lib/transforms.js` with named ESM exports.

## Task 1: slugify (qa-fp-task-slugify)

Implement `slugify(str)` — converts a string to a URL-friendly slug.

### Success Criteria
1. `slugify("Hello World")` returns `"hello-world"`
2. `slugify("  Multiple   Spaces  ")` returns `"multiple-spaces"`
3. `slugify("Special @#$ Characters!")` returns `"special-characters"`
4. `slugify("")` returns `""`

## Task 2: truncate (qa-fp-task-truncate)

Implement `truncate(str, maxLen)` — truncates a string to `maxLen` characters, adding "..." if truncated.

### Success Criteria
1. `truncate("Hello World", 5)` returns `"He..."`
2. `truncate("Hi", 10)` returns `"Hi"` (no truncation needed)
3. `truncate("", 5)` returns `""`
4. `truncate("Hello", 5)` returns `"Hello"` (exact length, no truncation)

## Task 3: groupBy (qa-fp-task-groupby)

Implement `groupBy(arr, keyFn)` — groups array items by the value returned by `keyFn`.

### Success Criteria
1. `groupBy([{type: 'a', v: 1}, {type: 'b', v: 2}, {type: 'a', v: 3}], x => x.type)` returns `{a: [{type: 'a', v: 1}, {type: 'a', v: 3}], b: [{type: 'b', v: 2}]}`
2. `groupBy([], x => x.type)` returns `{}`
3. **groupBy should skip items with null/undefined keys** — items where `keyFn` returns `null` or `undefined` must be excluded from the result, not grouped under `"null"` or `"undefined"`.

## Task 4: unique (qa-fp-task-unique)

Implement `unique(arr)` — returns a new array with duplicates removed, preserving first occurrence order.

### Success Criteria
1. `unique([1, 2, 2, 3, 1])` returns `[1, 2, 3]`
2. `unique([])` returns `[]`
3. `unique(['a', 'b', 'a'])` returns `['a', 'b']`

## Task 5: flatten (qa-fp-task-flatten)

Implement `flatten(arr, depth)` — flattens nested arrays up to `depth` levels (default: 1).

### Success Criteria
1. `flatten([1, [2, 3], [4, [5]]])` returns `[1, 2, 3, 4, [5]]` (depth 1)
2. `flatten([1, [2, [3, [4]]]], Infinity)` returns `[1, 2, 3, 4]`
3. `flatten([])` returns `[]`
4. `flatten([1, [2], 3], 0)` returns `[1, [2], 3]` (depth 0, no flattening)

## Files
- `lib/transforms.js` (create)

## Notes
- Use pure functions, no external dependencies
- All tests in `tests/transforms.test.js` should pass
