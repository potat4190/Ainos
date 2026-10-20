import crypto from 'node:crypto';
import { HttpError, parseCookies } from './http.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_COOKIE = 'ainos_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, n, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, _ . -', 'bad_username');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'Password must be at least 8 characters', 'bad_password');
  }
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionCookie(token, { secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function userFromRequest(db, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(`SELECT u.id, u.username, u.display_name, u.plan, s.expires_at
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, plan: row.plan, token };
}

/** Tiny fixed-window rate limiter (per key), e.g. login attempts per IP. */
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    h.count++;
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return h.count <= limit;
  };
}

/** HMAC-signed, expiring media URLs (like a CDN's signed URLs). */
export function signMediaPath(secret, pathname, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', secret).update(`${pathname}:${exp}`).digest('base64url');
  return `${pathname}?exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(secret, pathname, exp, sig) {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${pathname}:${exp}`).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
