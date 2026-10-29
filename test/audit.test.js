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
  const kept = await store.tx((t) => audit(t, { orgId: 'org1', action: 'org.create' }));
  assert.ok(await store.get('SELECT 1 AS x FROM audit_log WHERE id = ?', [kept]), 'committed with its transaction');
  await store.run('DELETE FROM audit_log');
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
  // Nothing in details can fail the action it records.
  let deep = 'bottom';
  for (let i = 0; i < 20_000; i++) deep = [deep];
  const circular = { name: 'loop' };
  circular.self = circular;
  for (const details of [{ body: deep }, circular, { n: 10n }]) {
    const entry = await audit(store, { action: 'lyrics.update', details });
    assert.ok(JSON.parse((await store.get('SELECT details FROM audit_log WHERE id = ?', [entry])).details));
  }
  const clipped = await audit(store, { action: 'lyrics.update', targetType: 't'.repeat(500), targetId: 'i'.repeat(500), orgId: 'o'.repeat(500) });
  assert.deepEqual({ ...(await store.get('SELECT length(target_type) AS a, length(target_id) AS b, length(org_id) AS c FROM audit_log WHERE id = ?', [clipped])) }, { a: 100, b: 100, c: 100 });
  // Postgres TEXT can't hold NUL; cuts never split a surrogate pair; Dates stay readable; user ids are numbers.
  const odd = await audit(store, { action: 'lyrics.update', userId: '7', targetId: 'a\u0000b', details: { at: new Date(0), text: '\u{1f64f}'.repeat(300) } });
  const oddRow = await store.get('SELECT user_id, target_id, details FROM audit_log WHERE id = ?', [odd]);
  assert.equal(oddRow.user_id, 7);
  assert.equal(oddRow.target_id, 'ab');
  const oddDetails = JSON.parse(oddRow.details);
  assert.equal(oddDetails.at, '1970-01-01T00:00:00.000Z');
  assert.equal(oddDetails.text, '\u{1f64f}'.repeat(200) + '…');
  assert.equal(oddDetails.text.isWellFormed(), true);
  for (const userId of ['not-a-number', true, '', [], '0x1f', ' 7 ', 1.5, -1.5]) {
    const noUser = await audit(store, { action: 'x', userId });
    assert.equal((await store.get('SELECT user_id FROM audit_log WHERE id = ?', [noUser])).user_id, null, JSON.stringify(userId));
  }
  for (const action of ['', 'Setlist.Create', 'setlist create', 'setlist..create', '.x', 'x.', `a${'b'.repeat(64)}`, null, 5]) {
    await assert.rejects(audit(store, { action }), /bad action name/, String(action));
  }
}));
