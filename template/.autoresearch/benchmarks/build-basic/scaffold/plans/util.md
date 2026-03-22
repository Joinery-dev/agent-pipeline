# Plan: Utility Module

## Goal
Create a utility module at `lib/util.js` exporting two functions: `formatCurrency` and `parseDate`.

## Architecture
Single file: `lib/util.js` with named ESM exports.

## Success Criteria
1. `lib/util.js` exists and is valid JavaScript
2. Exports `formatCurrency(amount, currency)` function
3. Exports `parseDate(dateString)` function
4. `formatCurrency(1234.5, 'USD')` returns `"$1,234.50"`
5. `formatCurrency(1234.5, 'EUR')` returns `"EUR 1,234.50"` or uses euro symbol
6. `parseDate('2026-03-22')` returns a Date object for that date
7. `parseDate('invalid')` returns `null` (does not throw)
8. All tests in `tests/util.test.js` pass

## Files
- `lib/util.js` (create)

## Notes
- Use Intl.NumberFormat for currency formatting where appropriate
- parseDate should handle ISO 8601 date strings
- Do not add external dependencies
