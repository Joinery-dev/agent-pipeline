# Plan: Formatter Module

## Goal
Create a formatter module at `lib/formatter.js` exporting two functions: `formatAmount` and `formatPercent`.

## Architecture
Single file: `lib/formatter.js` with named ESM exports.

## Success Criteria
1. `lib/formatter.js` exists and is valid JavaScript
2. Exports `formatAmount(amount)` function
3. Exports `formatPercent(value)` function
4. `formatAmount(1234.5)` returns `"1,234.50"`
5. `formatAmount(0)` returns `"0.00"`
6. `formatAmount(-50.99)` returns `"-50.99"`
7. `formatPercent(0.856)` returns `"85.6%"`
8. All tests in `tests/formatter.test.js` pass

## Files
- `lib/formatter.js` (create)

## Notes
- formatAmount should handle positive, negative, and zero values
- formatPercent should multiply by 100 and add a % suffix
- Do not add external dependencies
