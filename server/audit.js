// Audit trail for church (org) actions: who did what, to what, when (spec S5).
// Call it with the transaction's handle, so the entry commits or rolls back
// together with the change it records:
//   await store.tx(async (t) => { ...; await audit(t, { orgId, userId: user.id, action: 'setlist.create', ... }); });
import { randomId } from './util.js';

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_DETAILS = 4096; // bytes of JSON
const MAX_TEXT = 200; // characters per string value in details
const MAX_DEPTH = 4;

/**
 * Shorten long strings (user-supplied names, pasted text), long lists and deep
 * nesting, so an entry stays small and a strange value can't fail the action.
 */
function clip(value, depth = 0) {
  if (typeof value === 'string') return cut(value, MAX_TEXT, '…');
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '…';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => clip(v, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k.slice(0, 64), clip(v, depth + 1)]));
  }
  return value;
}

function detailsJson(details) {
  if (details == null) return null;
  try {
    const json = JSON.stringify(clip(details));
    return Buffer.byteLength(json) > MAX_DETAILS ? JSON.stringify({ truncated: true }) : json;
  } catch {
    return JSON.stringify({ unserializable: true }); // e.g. a BigInt; never fail the action over its log entry
  }
}

/** At most n code points (never half a surrogate pair), with a marker when cut. */
function cut(s, n, marker = '') {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join('') + marker : s;
}

// Postgres TEXT cannot hold NUL, and an INSERT that fails would roll back the action being recorded.
const shortText = (v) => (v == null ? null : cut(String(v).replace(/\u0000/g, ''), 100));
// user.id is a number (SQLite) or a digit string (Postgres BIGINT); anything else is not a user.
const userIdOf = (v) => (Number.isSafeInteger(v) || (typeof v === 'string' && /^\d{1,15}$/.test(v)) ? Number(v) : null);

/** Write one audit entry and return its id. */
export async function audit(store, { orgId = null, userId = null, action, targetType = null, targetId = null, details = null, now = Date.now() }) {
  if (typeof action !== 'string' || action.length > 64 || !ACTION.test(action)) throw new Error(`audit: bad action name ${JSON.stringify(action)}`);
  const id = randomId();
  await store.run('INSERT INTO audit_log (id, org_id, user_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, shortText(orgId), userIdOf(userId), action, shortText(targetType), shortText(targetId), detailsJson(details), now]);
  return id;
}
