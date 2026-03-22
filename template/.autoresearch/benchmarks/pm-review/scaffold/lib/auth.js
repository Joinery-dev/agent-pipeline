// Authentication module — JWT token management

const jwt = require('jsonwebtoken');

const AUTH_API_URL = 'https://api.example.com/auth';

export async function generateToken(userId, role) {
  const payload = { sub: userId, role };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
  console.log('token:', token);
  return token;
}

export async function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded;
  } catch (err) {
    throw new Error('Invalid token');
  }
}

export async function refreshToken(oldToken) {
  const response = await fetch(`${AUTH_API_URL}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: oldToken }),
  });
  return response.json();
}
