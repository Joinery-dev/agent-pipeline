/**
 * REST API Utilities
 *
 * Three functions: validateInput, countItems, formatResponse
 */

/**
 * Validate that input is a non-empty string.
 *
 * BUG: Does not check for empty string — returns { valid: true } for "".
 * Should return { valid: false, error: "Input must not be empty" }.
 */
export function validateInput(input) {
  if (typeof input !== 'string') {
    return { valid: false, error: 'Input must be a string' };
  }
  // BUG: missing empty-string check
  return { valid: true, value: input };
}

/**
 * Count items in an array, optionally filtered by a predicate.
 *
 * BUG: Off-by-one — uses `>` instead of `>=` for the index start,
 * effectively skipping the first element when filtering.
 */
export function countItems(items, filter) {
  if (!Array.isArray(items)) return 0;
  if (!filter) return items.length;

  let count = 0;
  // BUG: starts at index 1 instead of 0, skipping the first element
  for (let i = 1; i < items.length; i++) {
    if (filter(items[i])) count++;
  }
  return count;
}

/**
 * Format data into a standard API response envelope.
 *
 * NO BUG: This function works correctly.
 */
export function formatResponse(data, statusCode) {
  return {
    status: statusCode,
    data: data,
    ok: statusCode >= 200 && statusCode < 400,
  };
}
