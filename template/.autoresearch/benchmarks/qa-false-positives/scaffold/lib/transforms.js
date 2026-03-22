/**
 * Transform Utilities
 *
 * Five functions: slugify, truncate, groupBy, unique, flatten
 */

/**
 * Convert a string to a URL-friendly slug.
 *
 * NO BUG: This function works correctly.
 */
export function slugify(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Truncate a string to maxLen characters, adding "..." if truncated.
 * The total length including "..." will be maxLen.
 *
 * NO BUG: This function works correctly.
 */
export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Group array items by the value returned by keyFn.
 *
 * BUG: Does not skip null/undefined keys — groups them under the string
 * "undefined" or "null" instead of excluding them from the result.
 */
export function groupBy(arr, keyFn) {
  if (!Array.isArray(arr)) return {};
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    // BUG: should skip items where key is null or undefined
    // but instead coerces to string "null" / "undefined"
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

/**
 * Return a new array with duplicates removed, preserving first occurrence order.
 *
 * NO BUG: This function works correctly.
 */
export function unique(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr)];
}

/**
 * Flatten nested arrays up to `depth` levels (default: 1).
 *
 * NO BUG: This function works correctly.
 */
export function flatten(arr, depth = 1) {
  if (!Array.isArray(arr)) return [];
  if (depth < 1) return [...arr];

  const result = [];
  for (const item of arr) {
    if (Array.isArray(item) && depth > 0) {
      result.push(...flatten(item, depth - 1));
    } else {
      result.push(item);
    }
  }
  return result;
}
