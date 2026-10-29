// Audit trail for church (org) actions: who did what, to what, when (spec S5).
// Call it with the transaction's handle, so the entry commits or rolls back
// together with the change it records:
//   await store.tx(async (t) => { ...; await audit(t, { orgId, userId: user.id, action: 'setlist.create', ... }); });
import { randomId } from './util.js';

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_DETAILS = 4096; // bytes of JSON
const MAX_TEXT = 200; // characters per string value in details

/** Shorten long strings (user-supplied names, pasted text) so an entry stays small. */
function clip(value) {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clip);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, clip(v)]));
  return value;
}

/** Write one audit entry and return its id. */
export async function audit(store, { orgId = null, userId = null, action, targetType = null, targetId = null, details = null, now = Date.now() }) {
  if (typeof action !== 'string' || action.length > 64 || !ACTION.test(action)) throw new Error(`audit: bad action name ${JSON.stringify(action)}`);
  let json = details == null ? null : JSON.stringify(clip(details));
  if (json && Buffer.byteLength(json) > MAX_DETAILS) json = JSON.stringify({ truncated: true });
  const id = randomId();
  await store.run('INSERT INTO audit_log (id, org_id, user_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, orgId, userId, action, targetType, targetId, json, now]);
  return id;
}
