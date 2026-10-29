import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteStore } from '../server/store.js';
import { audit } from '../server/audit.js';

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainos-audit-'));
  const store = sqliteStore(path.join(dir, 'ainos.db'));
  try {
    await fn(store);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('audit() records who did what to which org, when', () => withStore(async (store) => {
  const id = await audit(store, { orgId: 'org1', userId: 7, action: 'setlist.create', targetType: 'setlist', targetId: 's1', details: { name: 'Sunday' }, now: 1000 });
  assert.match(id, /^[A-Za-z0-9]{22}$/);
  const row = await store.get('SELECT * FROM audit_log WHERE id = ?', [id]);
  assert.deepEqual({ ...row, details: JSON.parse(row.details) },
    { id, org_id: 'org1', user_id: 7, action: 'setlist.create', target_type: 'setlist', target_id: 's1', details: { name: 'Sunday' }, created_at: 1000 });
  // Org, user, target and details are optional (e.g. a global admin action).
  const bare = await audit(store, { action: 'catalog.scripture_update' });
  assert.deepEqual({ ...(await store.get('SELECT org_id, user_id, target_type, details FROM audit_log WHERE id = ?', [bare])) },
    { org_id: null, user_id: null, target_type: null, details: null });
  assert.deepEqual((await store.all('SELECT id FROM audit_log WHERE org_id = ? ORDER BY created_at', ['org1'])).map((r) => r.id), [id]);
}));

test('audit() commits and rolls back with the transaction it is part of', () => withStore(async (store) => {
  await assert.rejects(store.tx(async (t) => {
    await audit(t, { orgId: 'org1', action: 'org.rename' });
    throw new Error('the change failed');
  }));
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM audit_log')).n, 0);
}));

test('audit() keeps entries small and refuses malformed action names', () => withStore(async (store) => {
  const long = 'x'.repeat(5000);
  const id = await audit(store, { action: 'lyrics.update', details: { text: long, lines: Array(100).fill('line') } });
  const details = JSON.parse((await store.get('SELECT details FROM audit_log WHERE id = ?', [id])).details);
  assert.equal(details.text.length, 201, 'long text clipped');
  assert.equal(details.lines.length, 50, 'long lists clipped');
  const huge = await audit(store, { action: 'lyrics.update', details: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'y'.repeat(200)])) });
  assert.deepEqual(JSON.parse((await store.get('SELECT details FROM audit_log WHERE id = ?', [huge])).details), { truncated: true });
  for (const action of ['', 'Setlist.Create', 'setlist create', 'setlist..create', '.x', 'x.', `a${'b'.repeat(64)}`, null, 5]) {
    await assert.rejects(audit(store, { action }), /bad action name/, String(action));
  }
}));
