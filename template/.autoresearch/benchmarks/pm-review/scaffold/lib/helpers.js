// Shared helper utilities

import { log } from './logger.js';

/**
 * Format a date to ISO string with validation.
 * @param {Date|string} date - The date to format
 * @returns {string} ISO date string
 */
export function formatDate(date) {
  if (date === undefined || date === null) {
    throw new Error('formatDate requires a date argument');
  }

  const parsed = typeof date === 'string' ? new Date(date) : date;

  if (!(parsed instanceof Date) || isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }

  return parsed.toISOString();
}

/**
 * Sanitize a string for safe display.
 * @param {string} input - The string to sanitize
 * @returns {string} Sanitized string
 */
export function sanitize(input) {
  if (typeof input !== 'string') {
    throw new TypeError('sanitize expects a string argument');
  }

  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deep clone an object safely.
 * @param {object} obj - The object to clone
 * @returns {object} A deep clone of the input
 */
export function deepClone(obj) {
  if (obj === undefined || obj === null) {
    throw new Error('deepClone requires a non-null argument');
  }

  if (typeof obj !== 'object') {
    throw new TypeError('deepClone expects an object');
  }

  return structuredClone(obj);
}

/**
 * Retry an async operation with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise<*>} Result of the function
 */
export async function retry(fn, maxRetries = 3) {
  if (typeof fn !== 'function') {
    throw new TypeError('retry expects a function as first argument');
  }

  if (typeof maxRetries !== 'number' || maxRetries < 1) {
    throw new Error('maxRetries must be a positive number');
  }

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
