// Churches (orgs): roles and the one access helper every org-scoped route uses
// (spec 5.1-5.2). memberOrgIds is also used by the listener routes (lyrics
// visibility), so keep its signature.
import { HttpError } from './http.js';
import { isDemo, isChurchDemo, DEMO_ORG_ID } from './demo.js';

export const ROLES = ['admin', 'leader', 'operator', 'member'];

/** Who may do what: the roles table of spec 5.1, in one place. */
export const ROLE_CAN = Object.freeze({
  'org.view': ['admin', 'leader', 'operator', 'member'],
  'setlist.edit': ['admin', 'leader'],
  'song.edit': ['admin', 'leader'],
  'projection.run': ['admin', 'leader', 'operator'],
  'members.manage': ['admin'],
  'org.edit': ['admin'],
});

// What the shared church demo may never do, even as the demo church's admin (spec 5.7).
const CHURCH_DEMO_FORBIDDEN = new Set(['members.manage', 'org.edit']);

/** The ids of the orgs a user belongs to (for "global + my orgs" visibility). */
export async function memberOrgIds(store, user) {
  if (!user) return [];
  return (await store.all('SELECT org_id FROM org_members WHERE user_id = ?', [user.id])).map((r) => r.org_id);
}

const notFound = () => new HttpError(404, 'Church not found', 'not_found');

/**
 * The user's membership of orgId if their role allows `permission`.
 * Non-members get 404 (so they can't learn the org exists); members whose
 * role lacks the permission get 403 (so the UI can say why). The org id from
 * the client is only ever an input here: the membership comes from the
 * database. Returns { org_id, role, org: { id, name, default_language } }.
 */
export async function requireRole(store, user, orgId, permission) {
  const allowed = ROLE_CAN[permission];
  if (!allowed) throw new Error(`requireRole: unknown permission ${permission}`);
  if (!user?.id || typeof orgId !== 'string' || !orgId || orgId.length > 64) throw notFound();
  // The shared demo accounts: the listener demo has no church; the church demo only the demo church.
  if (isDemo(user) && !(isChurchDemo(user) && orgId === DEMO_ORG_ID)) throw notFound();
  const row = await store.get(`SELECT m.role, o.id, o.name, o.default_language FROM org_members m JOIN orgs o ON o.id = m.org_id
    WHERE m.org_id = ? AND m.user_id = ?`, [orgId, user.id]);
  if (!row) throw notFound();
  if (isChurchDemo(user) && CHURCH_DEMO_FORBIDDEN.has(permission)) {
    throw new HttpError(403, 'The shared demo can’t do this. Sign up to use it.', 'demo_not_allowed');
  }
  if (!allowed.includes(row.role)) throw new HttpError(403, 'Your role in this church can’t do this', 'forbidden_role');
  return { org_id: row.id, role: row.role, org: { id: row.id, name: row.name, default_language: row.default_language } };
}

/** What a role may do, for the UI (the server checks again on every request). */
export const permissionsOf = (role, user) => Object.keys(ROLE_CAN)
  .filter((p) => ROLE_CAN[p].includes(role) && !(isChurchDemo(user) && CHURCH_DEMO_FORBIDDEN.has(p)));
