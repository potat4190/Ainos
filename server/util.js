import crypto from 'node:crypto';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random 22-char base62 id, the same shape Spotify uses for its ids. */
export function randomId(len = 22) {
  let s = '';
  while (s.length < len) {
    for (const b of crypto.randomBytes(len)) {
      if (b < 248 && s.length < len) s += B62[b % 62]; // 248 = 4*62, avoids modulo bias
    }
  }
  return s;
}

export function seededId(rnd, len = 22) {
  let s = '';
  for (let i = 0; i < len; i++) s += B62[Math.floor(rnd() * 62)];
  return s;
}

/** Small, fast, seedable PRNG so the generated catalog is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export const toUri = (kind, id) => `ainos:${kind}:${id}`;

/** ISO-8601 week label, e.g. "2026-W43". Discover Weekly refreshes per week. */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function isoDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic Fisher-Yates shuffle. */
export function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
