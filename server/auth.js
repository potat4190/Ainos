import crypto from 'node:crypto';
import { HttpError, parseCookies } from './http.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_COOKIE = 'ainos_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// scrypt is CPU-heavy; the async version keeps the event loop free while hashing.
const scrypt = (password, salt, keylen, opts) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
const encode = (salt, hash) => `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return encode(salt, await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }));
}

/** Synchronous variant for the catalog generator. */
export function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return encode(salt, crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }));
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, n, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
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

export async function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await store.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, now, now + SESSION_TTL_MS]);
  return token;
}

export async function destroySession(store, token) {
  if (token) await store.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

/** Delete expired sessions (otherwise they are only removed when their token is used again). */
export function purgeExpiredSessions(store) {
  return store.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}

export function sessionCookie(token, { secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function userFromRequest(store, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = await store.get(`SELECT u.id, u.username, u.display_name, u.language, s.expires_at
              FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [sha256(token)]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await destroySession(store, token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, language: row.language || 'en', token };
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
