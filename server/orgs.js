// Churches (orgs): roles and the one access helper every org-scoped route uses.
// Owner: Phase 5. memberOrgIds is also used by the listener routes (lyrics
// visibility), so keep its signature.

/** The ids of the orgs a user belongs to (for "global + my orgs" visibility). */
export async function memberOrgIds(store, user) {
  if (!user) return [];
  return (await store.all('SELECT org_id FROM org_members WHERE user_id = ?', [user.id])).map((r) => r.org_id);
}
