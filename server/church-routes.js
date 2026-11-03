// Church routes: orgs, members, setlists, org songs and lyrics, the church demo sign-in.
// Owner: Phase 5 (churches, setlists, church demo). Registered by createApp (server/app.js) with the shared context.
//
// Isolation rule (spec 5.2): every route starts with requireRole(), and every
// org-scoped query carries the org in its WHERE. Child rows (setlist items)
// are only reached through a setlist row that matched (id, org_id).
import crypto from 'node:crypto';
import { HttpError, sendJson, readJson } from './http.js';
import { hashPassword, createSession, sessionCookie, rateLimiter, rateLimit, setSessionDemoRole } from './auth.js';
import { audit } from './audit.js';
import { str, usfmRef } from './validate.js';
import { randomId, searchText } from './util.js';
import { inList } from './store.js';
import { referenceName } from './scripture.js';
import { toSlides } from './slides.js';
import { SECTION_LABEL } from './songs.js';
import { requireRole, permissionsOf, effectiveRole, ROLES } from './orgs.js';
import { assertNotDemo, resetChurchDemo, isChurchDemo, CHURCH_DEMO_USERNAME, CHURCH_DEMO_PASSWORD, DEMO_ORG_ID, DEMO_SESSION_TTL_MS } from './demo.js';
import { parseLyrics } from '../public/js/lyrics-parse.js';

// Same list as LANGUAGES in server/app.js (not imported: app.js imports this module).
const LANGUAGES = ['en', 'hi', 'ne', 'zh', 'ja', 'es'];
export const LIMITS = Object.freeze({
  setlistsPerOrg: 500, itemsPerSetlist: 40, openInvitesPerOrg: 50, textChars: 500, songsPerOrg: 2000,
  sectionsPerSong: 30, linesPerSection: 12, charsPerLine: 120, arrangementLength: 100, pasteChars: 20_000, orgsPerUser: 20,
});
const KINDS = ['song', 'scripture', 'text', 'blank'];
const SECTION_ORDER = ['I', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'PC', 'C', 'C2', 'B', 'T', 'E'];

const bad = (message) => new HttpError(400, message, 'invalid_input');
const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
/** An id from the URL: 404 for anything that can't be one of ours. */
const idParam = (v, what) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw notFound(what);
  return v;
};
const optionalId = (v, name) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw bad(`${name} is not valid`);
  return v;
};
/** A service date: YYYY-MM-DD that is a real day, or null. */
function serviceDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('service_date must look like 2026-11-01');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('service_date is not a real day');
  return v;
}
// Invites (spec 5.3): a week to use them; one person for admin and leader, a whole team otherwise.
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const INVITE_USES = Object.freeze({ admin: 1, leader: 1, operator: 25, member: 25 });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const roleParam = (v) => {
  if (!ROLES.includes(v)) throw bad(`role must be one of: ${ROLES.join(', ')}`);
  return v;
};
const splitLines = (s) => String(s ?? '').split('\n');
const firstLine = (s) => splitLines(s)[0].slice(0, 80);
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/**
 * @param {object} ctx { r, store, auth, catalog, scripture, adminIds, clientIp, isSecure, trustProxy, log }
 *   r: Router (r.get/post/put/patch/delete(pattern, handler)); auth(handler) adds ctx.user or 401s.
 */
export function register({ r, store, auth, scripture, clientIp, isSecure, trustProxy }) {
  // ---------------- the church demo sign-in ----------------
  // Like "Try the demo" (server/app.js): reset, then sign in, with the same limits and session length.
  const demoLimiter = rateLimiter(store, { name: 'church-demo', limit: 6, windowMs: 60_000 });
  const demoLimiterAll = rateLimiter(store, { name: 'church-demo-all', limit: 60, windowMs: 60_000 });
  r.post('/api/auth/church-demo', async ({ req, res }) => {
    if (!(await demoLimiter(clientIp(req))) || !(await demoLimiterAll('all'))) throw new HttpError(429, 'Too many demo sign-ins, wait a minute', 'rate_limited');
    const { language } = await readJson(req);
    const exists = await store.get('SELECT 1 AS x FROM users WHERE lower(username) = ? AND is_simulated = 0', [CHURCH_DEMO_USERNAME]);
    const passwordHash = exists ? null : await hashPassword(CHURCH_DEMO_PASSWORD);
    const userId = await resetChurchDemo(store, { language: LANGUAGES.includes(language) ? language : 'en', passwordHash });
    const token = await createSession(store, userId, { ttlMs: DEMO_SESSION_TTL_MS });
    sendJson(res, 200, { ok: true, org_id: DEMO_ORG_ID },
      { 'Set-Cookie': sessionCookie(token, { secure: isSecure(req, { trustProxy }), maxAgeMs: DEMO_SESSION_TTL_MS }) });
  });

  // ---------------- orgs ----------------
  r.post('/api/orgs', auth(async ({ req, res, user }) => {
    assertNotDemo(user);
    const body = await readJson(req);
    const name = str(body.name, { name: 'name', min: 1, max: 80 });
    const language = LANGUAGES.includes(body.language) ? body.language : (LANGUAGES.includes(user.language) ? user.language : 'en');
    await rateLimit(store, `user:${user.id}:org-create`, { limit: 5, windowSec: 86_400, message: 'Too many churches created today' });
    const id = randomId();
    await store.tx(async (t) => {
      const { n } = await t.get('SELECT COUNT(*) AS n FROM org_members WHERE user_id = ?', [user.id]);
      if (Number(n) >= LIMITS.orgsPerUser) throw new HttpError(409, `You can belong to at most ${LIMITS.orgsPerUser} churches`, 'limit_reached');
      const now = Date.now();
      await t.run('INSERT INTO orgs (id, name, default_language, bible_version_id, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)', [id, name, language, user.id, now]);
      await t.run("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)", [id, user.id, now]);
      await audit(t, { orgId: id, userId: user.id, action: 'org.create', targetType: 'org', targetId: id, details: { name, language } });
    });
    sendJson(res, 201, await orgDto(user, id));
  }));

  r.get('/api/me/orgs', auth(async ({ res, user }) => {
    const rows = await store.all('SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?', [user.id]);
    // The church demo only ever sees the demo church.
    const visible = isChurchDemo(user) ? rows.filter((o) => o.id === DEMO_ORG_ID) : rows;
    sendJson(res, 200, visible.map(({ id, name, role }) => ({ id, name, role: effectiveRole(user, id, role) })).sort((a, b) => a.name.localeCompare(b.name)));
  }));

  async function orgDto(user, orgId) {
    const m = await requireRole(store, user, orgId, 'org.view');
    const demo = m.org.id === DEMO_ORG_ID;
    return { ...m.org, role: m.role, permissions: permissionsOf(m.role, user), is_demo: demo, ...(demo && isChurchDemo(user) ? { can_preview_roles: true } : {}) };
  }

  r.get('/api/orgs/:orgId', auth(async ({ res, user, params }) => {
    sendJson(res, 200, await orgDto(user, params.orgId));
  }));

  r.patch('/api/orgs/:orgId', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'org.edit');
    const body = await readJson(req);
    const name = str(body.name, { name: 'name', min: 1, max: 80 });
    await store.tx(async (t) => {
      await t.run('UPDATE orgs SET name = ? WHERE id = ?', [name, m.org_id]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'org.rename', targetType: 'org', targetId: m.org_id, details: { before: m.org.name, after: name } });
    });
    sendJson(res, 200, await orgDto(user, m.org_id));
  }));

  // Members see names and roles only, within their own church (spec 5.5). Admins
  // also get each member's user id, which the member-management routes take.
  r.get('/api/orgs/:orgId/members', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'org.view');
    const manager = permissionsOf(m.role, user).includes('members.manage');
    const rows = await store.all('SELECT u.id, u.display_name, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?', [m.org_id]);
    const rank = (role) => ROLES.indexOf(role);
    sendJson(res, 200, rows.map((x) => ({ ...(manager ? { id: Number(x.id) } : {}), display_name: x.display_name, role: x.role, is_me: Number(x.id) === Number(user.id) }))
      .sort((a, b) => rank(a.role) - rank(b.role) || a.display_name.localeCompare(b.display_name)));
  }));

  // ---------------- member management (spec 5.2, 5.6) ----------------
  /** A member of this org by user id ('me' = the caller), found by org AND user, or 404. */
  async function memberRow(q, orgId, raw, user) {
    const id = raw === 'me' ? Number(user.id) : /^[1-9]\d{0,15}$/.test(String(raw)) ? Number(raw) : null;
    const row = id ? await q.get('SELECT user_id, role FROM org_members WHERE org_id = ? AND user_id = ?', [orgId, id]) : null;
    if (!row) throw notFound('Member not found');
    return { userId: Number(row.user_id), role: row.role };
  }
  // Touch the org row first: on Postgres this locks it, so two admins demoting
  // each other at once run one after the other and the last-admin check holds.
  const lockOrg = (t, orgId) => t.run('UPDATE orgs SET created_at = created_at WHERE id = ?', [orgId]);
  /** 409 when taking `member` out of the admin role would leave the church without one. */
  async function keepAnAdmin(t, orgId, member) {
    if (member.role !== 'admin') return;
    const { n } = await t.get("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'admin'", [orgId]);
    if (Number(n) <= 1) throw new HttpError(409, 'A church needs at least one admin: make someone else an admin first', 'last_admin');
  }

  r.patch('/api/orgs/:orgId/members/:userId', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'members.manage');
    const role = roleParam((await readJson(req)).role);
    const changed = await store.tx(async (t) => {
      await lockOrg(t, m.org_id);
      const target = await memberRow(t, m.org_id, params.userId, user);
      if (target.role === role) return { user_id: target.userId, role };
      if (role !== 'admin') await keepAnAdmin(t, m.org_id, target);
      await t.run('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?', [role, m.org_id, target.userId]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'member.role', targetType: 'user', targetId: String(target.userId), details: { before: target.role, after: role } });
      return { user_id: target.userId, role };
    });
    sendJson(res, 200, changed);
  }));

  // An admin removes someone, or anyone leaves ('me'). The shared demo does neither.
  r.delete('/api/orgs/:orgId/members/:userId', auth(async ({ res, user, params }) => {
    assertNotDemo(user);
    const self = params.userId === 'me' || params.userId === String(user.id);
    const m = await requireRole(store, user, params.orgId, self ? 'org.view' : 'members.manage');
    await store.tx(async (t) => {
      await lockOrg(t, m.org_id);
      const target = await memberRow(t, m.org_id, self ? 'me' : params.userId, user);
      await keepAnAdmin(t, m.org_id, target);
      await t.run('DELETE FROM org_members WHERE org_id = ? AND user_id = ?', [m.org_id, target.userId]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: self ? 'member.leave' : 'member.remove', targetType: 'user', targetId: String(target.userId), details: { role: target.role } });
    });
    sendJson(res, 200, { ok: true });
  }));

  // ---------------- invites (spec 5.3) ----------------
  const inviteDto = (x) => ({
    id: x.id, role: x.role, created_at: Number(x.created_at), expires_at: Number(x.expires_at), max_uses: Number(x.max_uses), uses: Number(x.uses),
  });

  r.post('/api/orgs/:orgId/invites', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'members.manage');
    assertNotDemo(user);
    const role = roleParam((await readJson(req)).role);
    await rateLimit(store, `user:${user.id}:invite-create`, { limit: 30, windowSec: 86_400, message: 'Too many invites made today, try again tomorrow' });
    // 32 random bytes; only the hash is kept, so the link can be shown this once.
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const row = { id: randomId(), role, created_at: now, expires_at: now + INVITE_TTL_MS, max_uses: INVITE_USES[role], uses: 0 };
    await store.tx(async (t) => {
      const { n } = await t.get('SELECT COUNT(*) AS n FROM org_invites WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses', [m.org_id, now]);
      if (Number(n) >= LIMITS.openInvitesPerOrg) throw new HttpError(409, `A church can have at most ${LIMITS.openInvitesPerOrg} open invites: revoke some first`, 'limit_reached');
      await t.run('INSERT INTO org_invites (id, org_id, role, token_hash, created_by, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [row.id, m.org_id, role, sha256(token), user.id, now, row.expires_at, row.max_uses]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'invite.create', targetType: 'invite', targetId: row.id, details: { role, max_uses: row.max_uses, expires_at: row.expires_at } });
    });
    sendJson(res, 201, { ...inviteDto(row), token, path: `/#/join/${token}` });
  }));

  // Open invites only (not revoked, expired or used up); tokens are never shown again.
  r.get('/api/orgs/:orgId/invites', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'members.manage');
    const rows = await store.all('SELECT id, role, created_at, expires_at, max_uses, uses FROM org_invites WHERE org_id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses',
      [m.org_id, Date.now()]);
    sendJson(res, 200, rows.map(inviteDto).sort((a, b) => b.created_at - a.created_at));
  }));

  r.delete('/api/orgs/:orgId/invites/:id', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'members.manage');
    const id = idParam(params.id, 'Invite not found');
    await store.tx(async (t) => {
      const { changes } = await t.run('UPDATE org_invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL', [Date.now(), id, m.org_id]);
      if (!changes) throw notFound('Invite not found');
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'invite.revoke', targetType: 'invite', targetId: id });
    });
    sendJson(res, 200, { ok: true });
  }));

  // Every failure gives the same answer, so a link reveals nothing about why it doesn't work.
  const inviteInvalid = () => new HttpError(404, 'This invite link isn’t valid. Ask your church’s admin for a new one.', 'invite_invalid');
  r.post('/api/invites/redeem', auth(async ({ req, res, user }) => {
    assertNotDemo(user);
    const message = 'Too many invite attempts, try again in an hour';
    await rateLimit(store, `ip:${clientIp(req)}:invite-redeem`, { limit: 10, windowSec: 3600, message });
    await rateLimit(store, `user:${user.id}:invite-redeem`, { limit: 10, windowSec: 3600, message });
    const { token } = await readJson(req);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw inviteInvalid();
    // Looked up by hash: the token itself is never compared or stored.
    const joined = await store.tx(async (t) => {
      const now = Date.now();
      const inv = await t.get('SELECT id, org_id, role FROM org_invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses', [sha256(token), now]);
      if (!inv) throw inviteInvalid();
      const existing = await t.get('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?', [inv.org_id, user.id]);
      if (existing) return { org_id: inv.org_id, role: existing.role, already_member: true }; // the invite isn't used up
      const { n } = await t.get('SELECT COUNT(*) AS n FROM org_members WHERE user_id = ?', [user.id]);
      if (Number(n) >= LIMITS.orgsPerUser) throw new HttpError(409, `You can belong to at most ${LIMITS.orgsPerUser} churches`, 'limit_reached');
      // Counted with a guard, so two people taking the last use at once can't both get in.
      const { changes } = await t.run('UPDATE org_invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL', [inv.id]);
      if (!changes) throw inviteInvalid();
      await t.run('INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [inv.org_id, user.id, inv.role, now]);
      await audit(t, { orgId: inv.org_id, userId: user.id, action: 'invite.redeem', targetType: 'invite', targetId: inv.id, details: { role: inv.role } });
      return { org_id: inv.org_id, role: inv.role, already_member: false };
    });
    const org = await store.get('SELECT name FROM orgs WHERE id = ?', [joined.org_id]);
    sendJson(res, 200, { ...joined, name: org?.name ?? '' });
  }));

  // ---------------- the church demo's role preview (spec 5.7) ----------------
  // Stored on this session only; requireRole() honours it only for the church
  // demo in the demo church, so it can never raise anyone's rights elsewhere.
  r.put('/api/orgs/:orgId/demo-role', auth(async ({ req, res, user, params }) => {
    if (!isChurchDemo(user) || params.orgId !== DEMO_ORG_ID) throw new HttpError(403, 'Only the church demo can preview roles', 'forbidden_role');
    const role = roleParam((await readJson(req)).role);
    const demoRole = role === 'admin' ? null : role;
    await setSessionDemoRole(store, user.token, demoRole);
    sendJson(res, 200, await orgDto({ ...user, demoRole }, DEMO_ORG_ID));
  }));

  // ---------------- setlists ----------------
  /** The setlist row, found by id AND org, or 404. */
  async function setlistRow(q, orgId, id) {
    const row = await q.get('SELECT id, name, service_date, updated_at FROM setlists WHERE id = ? AND org_id = ?', [idParam(id, 'Setlist not found'), orgId]);
    if (!row) throw notFound('Setlist not found');
    return row;
  }

  /** A setlist with its items, each with a title to show. */
  async function setlistDto(orgId, id) {
    const s = await setlistRow(store, orgId, id);
    const items = await store.all(`SELECT i.id, i.position, i.kind, i.song_id, i.arrangement_id, i.source_id, i.usfm_ref, i.text
      FROM setlist_items i JOIN setlists s ON s.id = i.setlist_id WHERE i.setlist_id = ? AND s.org_id = ? ORDER BY i.position`, [s.id, orgId]);
    const songIds = [...new Set(items.filter((i) => i.song_id).map((i) => i.song_id))];
    const songs = new Map(songIds.length
      ? (await store.all(`SELECT id, title, artist, org_id FROM songs WHERE id IN (${inList(songIds)}) AND (org_id IS NULL OR org_id = ?)`, [...songIds, orgId])).map((x) => [x.id, x])
      : []);
    return {
      id: s.id, name: s.name, service_date: s.service_date, updated_at: Number(s.updated_at),
      items: items.map((i) => {
        const song = i.song_id ? songs.get(i.song_id) : null;
        const title = i.kind === 'song' ? song?.title ?? '' : i.kind === 'scripture' ? referenceName(i.usfm_ref) : i.kind === 'text' ? firstLine(i.text) : '';
        return {
          id: i.id, kind: i.kind, title, song_id: i.song_id, arrangement_id: i.arrangement_id, source_id: i.source_id, usfm_ref: i.usfm_ref, text: i.text,
          ...(i.kind === 'song' ? { artist: song?.artist ?? '', org_song: !!song?.org_id, missing: !song } : {}),
        };
      }),
    };
  }

  r.get('/api/orgs/:orgId/setlists', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'org.view');
    const rows = await store.all(`SELECT s.id, s.name, s.service_date, s.updated_at, (SELECT COUNT(*) FROM setlist_items i WHERE i.setlist_id = s.id) AS item_count
      FROM setlists s WHERE s.org_id = ?`, [m.org_id]);
    // Newest service first, undated ones last; sorted here so both databases agree.
    rows.sort((a, b) => (b.service_date || '').localeCompare(a.service_date || '') || Number(b.updated_at) - Number(a.updated_at));
    sendJson(res, 200, rows.map((x) => ({ id: x.id, name: x.name, service_date: x.service_date, updated_at: Number(x.updated_at), item_count: Number(x.item_count) })));
  }));

  r.post('/api/orgs/:orgId/setlists', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'setlist.edit');
    const body = await readJson(req);
    const name = str(body.name, { name: 'name', min: 1, max: 100 });
    const date = serviceDate(body.service_date);
    const id = randomId();
    await store.tx(async (t) => {
      const { n } = await t.get('SELECT COUNT(*) AS n FROM setlists WHERE org_id = ?', [m.org_id]);
      if (Number(n) >= LIMITS.setlistsPerOrg) throw new HttpError(409, `A church can keep at most ${LIMITS.setlistsPerOrg} setlists`, 'limit_reached');
      await t.run('INSERT INTO setlists (id, org_id, name, service_date, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, m.org_id, name, date, user.id, Date.now()]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'setlist.create', targetType: 'setlist', targetId: id, details: { name, service_date: date } });
    });
    sendJson(res, 201, await setlistDto(m.org_id, id));
  }));

  r.get('/api/orgs/:orgId/setlists/:id', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'org.view');
    sendJson(res, 200, await setlistDto(m.org_id, params.id));
  }));

  r.patch('/api/orgs/:orgId/setlists/:id', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'setlist.edit');
    const body = await readJson(req);
    const set = {};
    if ('name' in body) set.name = str(body.name, { name: 'name', min: 1, max: 100 });
    if ('service_date' in body) set.service_date = serviceDate(body.service_date);
    if (!Object.keys(set).length) throw bad('Nothing to change: send name or service_date');
    await store.tx(async (t) => {
      const before = await setlistRow(t, m.org_id, params.id);
      const cols = Object.keys(set);
      await t.run(`UPDATE setlists SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
        [...cols.map((c) => set[c]), Date.now(), before.id, m.org_id]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'setlist.update', targetType: 'setlist', targetId: before.id,
        details: { before: { name: before.name, service_date: before.service_date }, after: set } });
    });
    sendJson(res, 200, await setlistDto(m.org_id, params.id));
  }));

  r.delete('/api/orgs/:orgId/setlists/:id', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'setlist.edit');
    await store.tx(async (t) => {
      const s = await setlistRow(t, m.org_id, params.id);
      await t.run('DELETE FROM setlist_items WHERE setlist_id IN (SELECT id FROM setlists WHERE id = ? AND org_id = ?)', [s.id, m.org_id]);
      await t.run('DELETE FROM setlists WHERE id = ? AND org_id = ?', [s.id, m.org_id]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'setlist.delete', targetType: 'setlist', targetId: s.id, details: { name: s.name } });
    });
    sendJson(res, 200, { ok: true });
  }));

  /** Check a client's item list against this org's data; returns clean rows. */
  async function cleanItems(q, orgId, items) {
    if (!Array.isArray(items)) throw bad('items must be a list');
    if (items.length > LIMITS.itemsPerSetlist) throw bad(`A setlist can hold at most ${LIMITS.itemsPerSetlist} items`);
    const rows = items.map((it, i) => {
      if (!it || typeof it !== 'object') throw bad(`items[${i}] must be an object`);
      const kind = it.kind;
      if (!KINDS.includes(kind)) throw bad(`items[${i}].kind must be one of: ${KINDS.join(', ')}`);
      const row = { kind, song_id: null, arrangement_id: null, source_id: null, usfm_ref: null, text: null };
      if (kind === 'song') {
        row.song_id = optionalId(it.song_id, `items[${i}].song_id`);
        if (!row.song_id) throw bad(`items[${i}].song_id is required`);
        row.arrangement_id = optionalId(it.arrangement_id, `items[${i}].arrangement_id`);
        row.source_id = optionalId(it.source_id, `items[${i}].source_id`);
      } else if (kind === 'scripture') {
        row.usfm_ref = usfmRef(it.usfm_ref, { name: `items[${i}].usfm_ref` });
      } else if (kind === 'text') {
        row.text = str(it.text, { name: `items[${i}].text`, min: 1, max: LIMITS.textChars, multiline: true });
        if (splitLines(row.text).length > 12) throw bad(`items[${i}].text can have at most 12 lines`);
      }
      return row;
    });
    // Songs must be global or this church's; arrangements and sources must belong to that song (and be visible).
    const ids = (key) => [...new Set(rows.map((x) => x[key]).filter(Boolean))];
    const songIds = ids('song_id');
    if (songIds.length) {
      const ok = new Set((await q.all(`SELECT id FROM songs WHERE id IN (${inList(songIds)}) AND (org_id IS NULL OR org_id = ?)`, [...songIds, orgId])).map((x) => x.id));
      const i = rows.findIndex((x) => x.song_id && !ok.has(x.song_id));
      if (i >= 0) throw bad(`items[${i}].song_id: song not found`);
    }
    const arrIds = ids('arrangement_id');
    if (arrIds.length) {
      const songOf = new Map((await q.all(`SELECT id, song_id FROM song_arrangements WHERE id IN (${inList(arrIds)}) AND (org_id IS NULL OR org_id = ?)`, [...arrIds, orgId])).map((x) => [x.id, x.song_id]));
      const i = rows.findIndex((x) => x.arrangement_id && songOf.get(x.arrangement_id) !== x.song_id);
      if (i >= 0) throw bad(`items[${i}].arrangement_id: arrangement not found for that song`);
    }
    const srcIds = ids('source_id');
    if (srcIds.length) {
      const songOf = new Map((await q.all(`SELECT id, song_id FROM song_sources WHERE id IN (${inList(srcIds)})`, srcIds)).map((x) => [x.id, x.song_id]));
      const i = rows.findIndex((x) => x.source_id && songOf.get(x.source_id) !== x.song_id);
      if (i >= 0) throw bad(`items[${i}].source_id: source not found for that song`);
    }
    return rows;
  }

  r.put('/api/orgs/:orgId/setlists/:id/items', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'setlist.edit');
    const { items } = await readJson(req);
    await store.tx(async (t) => {
      const s = await setlistRow(t, m.org_id, params.id);
      // Touch the setlist first: on Postgres this locks its row, so two saves at once run one after the other.
      await t.run('UPDATE setlists SET updated_at = ? WHERE id = ? AND org_id = ?', [Date.now(), s.id, m.org_id]);
      const rows = await cleanItems(t, m.org_id, items);
      const before = (await t.get('SELECT COUNT(*) AS n FROM setlist_items WHERE setlist_id = ?', [s.id])).n;
      await t.run('DELETE FROM setlist_items WHERE setlist_id = ?', [s.id]);
      for (const [pos, x] of rows.entries()) {
        await t.run('INSERT INTO setlist_items (id, setlist_id, position, kind, song_id, arrangement_id, source_id, usfm_ref, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [randomId(), s.id, pos, x.kind, x.song_id, x.arrangement_id, x.source_id, x.usfm_ref, x.text]);
      }
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'setlist.items.replace', targetType: 'setlist', targetId: s.id,
        details: { before: Number(before), after: rows.length, kinds: rows.map((x) => x.kind) } });
    });
    sendJson(res, 200, await setlistDto(m.org_id, params.id));
  }));

  // ---------------- songs ----------------
  // The songs a setlist can use: global songs with global lyrics (the hymns),
  // global songs this church has pasted lyrics for, and the church's own songs.
  r.get('/api/orgs/:orgId/songs', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'org.view');
    const rows = await store.all(`SELECT s.id, s.title, s.artist, s.language, s.org_id FROM songs s
      WHERE s.org_id = ? OR (s.org_id IS NULL AND EXISTS (SELECT 1 FROM song_sections x WHERE x.song_id = s.id AND (x.org_id IS NULL OR x.org_id = ?)))
      LIMIT 3000`, [m.org_id, m.org_id]);
    sendJson(res, 200, rows.map((x) => ({ id: x.id, title: x.title, artist: x.artist, language: x.language, org_song: x.org_id !== null }))
      .sort((a, b) => Number(b.org_song) - Number(a.org_song) || a.title.localeCompare(b.title)));
  }));

  r.post('/api/orgs/:orgId/songs', auth(async ({ req, res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'song.edit');
    const body = await readJson(req);
    const title = str(body.title, { name: 'title', min: 1, max: 120 });
    const artist = body.artist == null ? '' : str(body.artist, { name: 'artist', max: 120 });
    const text = str(body.text, { name: 'text', min: 1, max: LIMITS.pasteChars, multiline: true });
    // Parsed here, never trusted from the client (spec 4.2).
    const { sections, arrangement } = parseLyrics(text);
    if (!sections.length) throw bad('No lyrics found in text');
    if (sections.length > LIMITS.sectionsPerSong) throw bad(`A song can have at most ${LIMITS.sectionsPerSong} sections`);
    for (const s of sections) {
      if (!SECTION_LABEL.test(s.label)) throw bad(`Section ${s.label}: at most 9 verses, and labels like V1, C, B`);
      if (s.lines.length > LIMITS.linesPerSection) throw bad(`Section ${s.label} has more than ${LIMITS.linesPerSection} lines: split it with a blank line`);
      const long = s.lines.find((l) => [...l].length > LIMITS.charsPerLine);
      if (long) throw bad(`Section ${s.label}: lines can be at most ${LIMITS.charsPerLine} characters`);
    }
    if (arrangement.length > LIMITS.arrangementLength) throw bad('The song repeats too many sections');
    await rateLimit(store, `user:${user.id}:org-song`, { limit: 60, windowSec: 3600, message: 'Too many songs added, try again later' });
    const songId = randomId();
    const arrangementId = randomId();
    const language = m.org.default_language;
    await store.tx(async (t) => {
      const { n } = await t.get('SELECT COUNT(*) AS n FROM songs WHERE org_id = ?', [m.org_id]);
      if (Number(n) >= LIMITS.songsPerOrg) throw new HttpError(409, `A church can keep at most ${LIMITS.songsPerOrg} songs`, 'limit_reached');
      const now = Date.now();
      await t.run('INSERT INTO songs (id, title, artist, language, ccli_number, public_domain, org_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)',
        [songId, title, artist, language, m.org_id, user.id, now, now]);
      for (const s of sections) {
        const lines = s.lines.join('\n');
        await t.run('INSERT INTO song_sections (id, song_id, language, label, lines, folded, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [randomId(), songId, language, s.label, lines, searchText(s.lines.join(' '), ''), m.org_id]);
      }
      await t.run('INSERT INTO song_arrangements (id, song_id, org_id, name, section_order) VALUES (?, ?, ?, ?, ?)',
        [arrangementId, songId, m.org_id, 'Default', JSON.stringify(arrangement)]);
      await audit(t, { orgId: m.org_id, userId: user.id, action: 'song.create', targetType: 'song', targetId: songId,
        details: { title, sections: sections.map((s) => s.label), arrangement } });
    });
    sendJson(res, 201, { id: songId, title, artist, language, org_song: true, arrangement_id: arrangementId, sections, arrangement });
  }));

  // ---------------- slides (for the Present dialog) ----------------
  /** Slides for one song item, from global + this org's lyrics only. */
  async function songSlides(orgId, item) {
    const song = await store.get('SELECT id, title, language, org_id FROM songs WHERE id = ? AND (org_id IS NULL OR org_id = ?)', [item.song_id, orgId]);
    if (!song) return { title: '', slides: [], source: null, hasTimings: false };
    // Sections: this church's row wins over the global one for the same label.
    const rows = await store.all('SELECT language, label, lines, org_id FROM song_sections WHERE song_id = ? AND (org_id IS NULL OR org_id = ?)', [song.id, orgId]);
    const lang = rows.some((x) => x.language === song.language) ? song.language : rows[0]?.language;
    const byLabel = new Map();
    for (const x of rows.filter((x) => x.language === lang)) if (!byLabel.has(x.label) || x.org_id) byLabel.set(x.label, x);
    const sections = [...byLabel.values()]
      .sort((a, b) => SECTION_ORDER.indexOf(a.label) - SECTION_ORDER.indexOf(b.label))
      .map((x) => ({ label: x.label, lines: splitLines(x.lines) }));

    // Arrangement: the item's, else the church's own, else the hymn's recording order.
    const arrangements = await store.all('SELECT id, org_id, name, section_order FROM song_arrangements WHERE song_id = ? AND (org_id IS NULL OR org_id = ?)', [song.id, orgId]);
    const arr = arrangements.find((a) => a.id === item.arrangement_id)
      || arrangements.filter((a) => a.org_id).sort((a, b) => a.name.localeCompare(b.name))[0]
      || arrangements.find((a) => !a.org_id && a.name === 'Recording')
      || arrangements.filter((a) => !a.org_id).sort((a, b) => a.name.localeCompare(b.name))[0];
    const known = new Set(sections.map((s) => s.label));
    let order = arr ? parseJson(arr.section_order, []) : [];
    order = Array.isArray(order) ? order.filter((l) => known.has(l)) : [];
    if (!order.length) order = sections.map((s) => s.label);

    // Source: the item's, else the native recording, else a YouTube video.
    const sources = await store.all("SELECT id, source, track_id, youtube_video_id FROM song_sources WHERE song_id = ? AND available = 1 ORDER BY source, id", [song.id]);
    const src = sources.find((x) => x.id === item.source_id) || sources.find((x) => x.source === 'ainos') || sources.find((x) => x.source === 'youtube') || null;
    const source = !src ? null : src.source === 'ainos' ? { type: 'track', trackId: src.track_id } : { type: 'youtube', videoId: src.youtube_video_id };

    // Timings for that one recording: this church's, else global.
    let timings = null;
    if (src) {
      const trows = await store.all('SELECT timings, offset_ms, org_id, arrangement_id FROM lyric_timings WHERE source_id = ? AND language = ? AND (org_id IS NULL OR org_id = ?)', [src.id, lang, orgId]);
      const pick = trows.sort((a, b) => Number(!!b.org_id) - Number(!!a.org_id) || Number(b.arrangement_id === arr?.id) - Number(a.arrangement_id === arr?.id))[0];
      const list = pick ? parseJson(pick.timings, null) : null;
      if (Array.isArray(list) && list.length) timings = list.map((x) => ({ ...x, ms: Number(x.ms) + Number(pick.offset_ms || 0) }));
    }
    return { title: song.title, slides: toSlides(sections, order, { maxLines: 4, timings }), source, hasTimings: !!timings };
  }

  r.get('/api/orgs/:orgId/setlists/:id/slides', auth(async ({ res, user, params }) => {
    const m = await requireRole(store, user, params.orgId, 'projection.run');
    const s = await setlistDto(m.org_id, params.id);
    const items = [];
    for (const [i, it] of s.items.entries()) {
      const base = { id: it.id, kind: it.kind, title: it.title, slides: [], source: null, hasTimings: false };
      if (it.kind === 'song') {
        items.push({ ...base, ...(await songSlides(m.org_id, it)), id: it.id, kind: it.kind });
      } else if (it.kind === 'scripture') {
        const p = await scripture.getPassage({ usfm: it.usfm_ref, language: user.language });
        const reference = p.reference || referenceName(it.usfm_ref);
        const attribution = p.version ? [p.version.abbreviation || p.version.title, p.version.copyright].filter(Boolean).join(' · ') : null;
        items.push({ ...base, title: reference, slides: [{ id: `scripture-${i}`, label: reference, lines: [p.text || reference], attribution }] });
      } else if (it.kind === 'text') {
        items.push({ ...base, slides: [{ id: `text-${i}`, label: 'text', lines: splitLines(it.text) }] });
      } else {
        items.push({ ...base, slides: [{ id: `blank-${i}`, label: 'blank', lines: [] }] });
      }
    }
    sendJson(res, 200, { setlist: { id: s.id, name: s.name, service_date: s.service_date }, items });
  }));
}
