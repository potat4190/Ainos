// Global catalog admins (owner decision Q8): user ids listed in the
// ADMIN_USER_IDS environment variable, comma-separated, checked only on the
// server. There is no is_admin column. A shared demo account is never an
// admin, even if its id is listed. Every admin action is audit-logged by the
// route that performs it.
import { isDemo } from './demo.js';
import { HttpError } from './http.js';

/** The set of admin user ids (as strings) in an ADMIN_USER_IDS value; anything that isn't a positive integer is ignored. */
export function parseAdminIds(value = '') {
  return new Set(String(value).split(',').map((s) => s.trim()).filter((s) => /^[1-9]\d{0,17}$/.test(s)));
}

export function isAdmin(user, adminIds) {
  return !!user && !isDemo(user) && adminIds.has(String(user.id));
}

/** Throws 403 unless the user is a catalog admin. */
export function assertAdmin(user, adminIds) {
  if (!isAdmin(user, adminIds)) throw new HttpError(403, 'Only catalog admins can do this', 'not_admin');
}
