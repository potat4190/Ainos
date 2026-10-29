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

export async function createSession(store, userId, { ttlMs = SESSION_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await store.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, now, now + ttlMs]);
  return token;
}

export async function destroySession(store, token) {
  if (token) await store.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

/** Delete expired sessions (otherwise they are only removed when their token is used again). */
export function purgeExpiredSessions(store) {
  return store.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(maxAgeMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = ({ secure = false } = {}) => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

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

/**
 * Fixed-window rate limiter (per key), e.g. login attempts per IP. Counts live
 * in the database, so serverless instances share one limit instead of each
 * allowing `limit` on its own. Resolves to false once the key is over it.
 */
export function rateLimiter(store, { name, limit, windowMs }) {
  return async (key) => (await hit(store, `${name}:${key}`, windowMs)).hits <= limit;
}

/** Count one hit on a key's current window (starting a new window if the last one is over). */
async function hit(store, key, windowMs, now = Date.now()) {
  const row = await store.get(`INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1)
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN rate_limits.window_start >= ? THEN rate_limits.hits + 1 ELSE 1 END,
      window_start = CASE WHEN rate_limits.window_start >= ? THEN rate_limits.window_start ELSE excluded.window_start END
    RETURNING hits, window_start`, [key, now, now - windowMs, now - windowMs]);
  return { hits: row.hits, windowStart: Number(row.window_start) };
}

// The longest window any limit uses (a day), plus an hour of slack.
const LONGEST_WINDOW_MS = 25 * 3600 * 1000;

/**
 * Rate limit for routes: counts a hit on `key` and throws 429 with a
 * Retry-After header once it is over `limit` in the current window. Keys name
 * who and what, e.g. `user:${user.id}:scripture` or `ip:${ip}:invite`; the
 * window length is part of the stored key, so one key can carry a per-minute
 * and a per-day limit.
 */
export async function rateLimit(store, key, { limit, windowSec, message = 'Too many requests, try again later', now = Date.now() }) {
  if (windowSec * 1000 > LONGEST_WINDOW_MS) throw new Error('rate-limit windows longer than a day would be purged early');
  const windowMs = windowSec * 1000;
  const { hits, windowStart } = await hit(store, `${key}/${windowSec}s`, windowMs, now);
  if (hits > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    throw new HttpError(429, message, 'rate_limited', { 'Retry-After': String(retryAfter) });
  }
}

/** Delete rate-limit windows that ended long ago (older than any window in use). */
export function purgeRateLimits(store, olderThanMs = LONGEST_WINDOW_MS) {
  return store.run('DELETE FROM rate_limits WHERE window_start < ?', [Date.now() - olderThanMs]);
}

/** HMAC-signed, expiring media URLs (like a CDN's signed URLs). */
export function signMediaPath(secret, pathname, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', secret).update(`${pathname}:${exp}`).digest('base64url');
  return `${pathname}?exp=${exp}&sig=${sig}`;
}

/**
 * secrets: the current secret, or [current, previous] while a rotation is in
 * progress, so URLs signed just before the switch keep working until they
 * expire (see "Rotating secrets" in README.md). New URLs are always signed
 * with the current one.
 */
export function verifyMediaSignature(secrets, pathname, exp, sig) {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return false; }
  return [secrets].flat().filter(Boolean).some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(`${pathname}:${exp}`).digest();
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}
