import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteStore, pgConnection } from '../server/store.js';
import { rateLimiter, rateLimit, purgeRateLimits } from '../server/auth.js';
import { HttpError } from '../server/http.js';

test('Postgres connections check the server certificate, except on this machine', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(pgConnection(`postgres://u:p@${host}:5432/db`, '').ssl, false, host);
  const remote = 'postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  assert.equal(pgConnection(remote, '').ssl, true, 'checked against the system CAs');
  assert.deepEqual(pgConnection(remote, '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----').ssl,
    { ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----' }, 'or against DATABASE_CA_CERT, pasted with literal \\n');
});

test('rate limits are shared by every server process on the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-limits-'));
  const file = path.join(dir, 'ainos.db');
  // Two connections to one database stand in for two serverless instances.
  const a = sqliteStore(file);
  const b = sqliteStore(file);
  try {
    const limitA = rateLimiter(a, { name: 'auth', limit: 3, windowMs: 60_000 });
    const limitB = rateLimiter(b, { name: 'auth', limit: 3, windowMs: 60_000 });
    const ip = '203.0.113.7';
    assert.deepEqual([await limitA(ip), await limitB(ip), await limitA(ip), await limitB(ip)], [true, true, true, false]);
    assert.equal(await limitA('198.51.100.1'), true, 'other keys have their own count');
    assert.equal(await rateLimiter(a, { name: 'retrain', limit: 1, windowMs: 60_000 })(ip), true, 'so do other limiters');

    await a.run('UPDATE rate_limits SET window_start = 0');
    assert.equal(await limitB(ip), true, 'a new window starts once the old one is over');
    await purgeRateLimits(a);
    assert.deepEqual((await a.all('SELECT key FROM rate_limits ORDER BY key')).map((r) => r.key), [`auth:${ip}`], 'old windows are purged');
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rateLimit throws 429 with Retry-After, keeps per-minute and per-day windows apart, and day windows survive the purge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-limits-'));
  const store = sqliteStore(path.join(dir, 'ainos.db'));
  const limited = (err) => err instanceof HttpError && err.status === 429 && err.code === 'rate_limited';
  try {
    const t0 = 1_800_000_000_000;
    const perMinute = { limit: 2, windowSec: 60 };
    await rateLimit(store, 'user:7:scripture', { ...perMinute, now: t0 });
    await rateLimit(store, 'user:7:scripture', { ...perMinute, now: t0 + 1000 });
    const err = await rateLimit(store, 'user:7:scripture', { ...perMinute, now: t0 + 20_000 }).catch((e) => e);
    assert.ok(limited(err), 'the third hit in a minute is refused');
    assert.equal(err.headers['Retry-After'], '40', 'seconds until the window that started at t0 ends');
    await rateLimit(store, 'user:7:scripture', { ...perMinute, now: t0 + 61_000 }); // next window

    // The same key with a day window counts separately from its minute window.
    const perDay = { limit: 3, windowSec: 86_400 };
    for (const dt of [0, 1000, 61_000]) await rateLimit(store, 'user:7:scripture', { ...perDay, now: t0 + dt });
    const dayErr = await rateLimit(store, 'user:7:scripture', { ...perDay, now: t0 + 3600_000 }).catch((e) => e);
    assert.ok(limited(dayErr));
    assert.equal(dayErr.headers['Retry-After'], String(86_400 - 3600));
    await rateLimit(store, 'user:8:scripture', { ...perDay, now: t0 }); // other users have their own count

    // A day window opened two hours ago is still in force after housekeeping.
    await store.run('UPDATE rate_limits SET window_start = ? WHERE key = ?', [Date.now() - 2 * 3600_000, 'user:7:scripture/86400s']);
    await purgeRateLimits(store);
    assert.ok(await store.get('SELECT 1 AS x FROM rate_limits WHERE key = ?', ['user:7:scripture/86400s']), 'not purged early');

    await assert.rejects(rateLimit(store, 'x', { limit: 1, windowSec: 2 * 86_400 }), /purged early/, 'windows longer than a day are refused');
    // Misconfiguration fails loudly instead of letting every request through.
    for (const opts of [{ windowSec: 60 }, { limit: 1 }, { limit: 0, windowSec: 60 }, { limit: 1, windowSec: -60 }, { limit: 1, windowSec: 0 },
      { limit: 1.5, windowSec: 60 }, { limit: NaN, windowSec: 60 }, { limit: '5', windowSec: 60 }, { limit: 1, windowSecs: 60 }]) {
      await assert.rejects(rateLimit(store, 'k', opts), /rateLimit: /, JSON.stringify(opts));
    }
    await assert.rejects(rateLimit(store, '', perMinute), /key required/);
    await rateLimit(store, 'user:9:daily', { limit: 1, windowSec: 86_400 }); // a day is the longest window
    await assert.rejects(rateLimit(store, 'user:9:daily', { limit: 1, windowSec: 86_401 }), /purged early/);
    // The per-minute limiters check their options the same way.
    for (const opts of [{ name: 'auth', windowMs: 60_000 }, { name: 'auth', limit: 3 }, { name: 'auth', limit: 3, windowMs: 2 * 3600_000 },
      { name: 'a/b', limit: 3, windowMs: 60_000 }, { limit: 3, windowMs: 60_000 }]) {
      assert.throws(() => rateLimiter(store, opts), /rateLimiter: /, JSON.stringify(opts));
    }

    // Housekeeping: the per-minute limiters' rows (no "/" in the key) go after
    // an hour, rateLimit() rows after a day.
    const now = Date.now();
    await store.run('DELETE FROM rate_limits');
    for (const [key, age] of [['auth:203.0.113.7', 2 * 3600_000], ['auth:203.0.113.8', 30 * 60_000], ['user:9:x/86400s', 2 * 3600_000], ['user:9:y/60s', 26 * 3600_000]]) {
      await store.run('INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1)', [key, now - age]);
    }
    await purgeRateLimits(store, now);
    assert.deepEqual((await store.all('SELECT key FROM rate_limits ORDER BY key')).map((r) => r.key), ['auth:203.0.113.8', 'user:9:x/86400s']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
