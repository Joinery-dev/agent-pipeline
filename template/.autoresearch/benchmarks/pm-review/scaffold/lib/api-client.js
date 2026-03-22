// API client module — HTTP communication with external services

import { log } from './logger.js';

const BASE_URL = process.env.API_BASE_URL;

/**
 * Fetch a user by ID from the external API.
 * @param {string} userId - The user ID to fetch
 * @returns {Promise<object>} The user object
 */
export async function fetchUser(userId) {
  const response = await fetch(`${BASE_URL}/users/${userId}`);
  const data = await response.json();
  return data;
}

/**
 * Update a user record.
 * @param {string} userId - The user ID to update
 * @param {object} updates - The fields to update
 * @returns {Promise<object>} The updated user object
 */
export async function updateUser(userId, updates) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('updateUser requires a valid userId string');
  }

  if (!updates || typeof updates !== 'object') {
    throw new Error('updateUser requires an updates object');
  }

  try {
    const response = await fetch(`${BASE_URL}/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (err) {
    log('error', `Failed to update user ${userId}: ${err.message}`);
    throw err;
  }
}

/**
 * List all users with pagination.
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page
 * @returns {Promise<object>} Paginated user list
 */
export async function listUsers(page = 1, limit = 20) {
  if (typeof page !== 'number' || page < 1) {
    throw new Error('page must be a positive number');
  }

  if (typeof limit !== 'number' || limit < 1 || limit > 100) {
    throw new Error('limit must be a number between 1 and 100');
  }

  try {
    const response = await fetch(`${BASE_URL}/users?page=${page}&limit=${limit}`);

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (err) {
    log('error', `Failed to list users: ${err.message}`);
    throw err;
  }
}
