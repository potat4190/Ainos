import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteStore, pgConnection } from '../server/store.js';
import { rateLimiter, purgeRateLimits } from '../server/auth.js';

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
