// Minimal email and password accounts with server-side sessions.
// Already have auth? Keep yours: the offerwall code only needs the signed-in user ID.

import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_TTL = 30 * 24 * 3600;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, key] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when the email is unknown, so both paths take about the same time.
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Only a hash of the session token is stored, so a database leak does not leak sessions. */
export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(name, value, { secure, maxAge }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Fixed-window limiter in memory. Fine for one process; use your proxy or Redis for more. */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return function allow(key) {
    const t = Date.now();
    const entry = hits.get(key);
    if (!entry || t - entry.start > windowMs) {
      if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}
