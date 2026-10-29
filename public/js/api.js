export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

// Give up on a request after this long, so a stalled connection ends in a message instead of a spinner forever.
const TIMEOUT_MS = 20_000;

async function request(method, url, body, { timeout = TIMEOUT_MS } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (timeout && typeof AbortSignal.timeout === 'function') opts.signal = AbortSignal.timeout(timeout); // missing before Safari 16
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res, text;
  try {
    res = await fetch(url, opts);
    text = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new ApiError(0, 'The server took too long to answer', 'timeout');
    throw new ApiError(0, navigator.onLine ? 'Could not reach the server' : 'You are offline', navigator.onLine ? 'network' : 'offline');
  }
  // A proxy or the host can answer with an HTML error page instead of our JSON.
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401) for (const fn of listeners) fn();
    throw new ApiError(res.status, data?.error?.message || res.statusText || `Error ${res.status}`, data?.error?.code || (res.status >= 500 ? 'server' : undefined));
  }
  if (text && data === null) throw new ApiError(res.status, 'The server sent a response Ainos could not read', 'server');
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}, opts) => request('POST', u, b, opts),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

// Small in-memory cache of track objects, so the player and Connect can
// resolve ids to metadata without refetching.
const trackCache = new Map();
export function rememberTracks(tracks) {
  for (const t of tracks || []) if (t && t.id) trackCache.set(t.id, t);
}
export function cachedTrack(id) {
  return trackCache.get(id) || null;
}
export async function tracksByIds(ids) {
  const missing = [...new Set(ids)].filter((id) => !trackCache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const { tracks } = await api.get(`/api/tracks?ids=${missing.slice(i, i + 100).map(encodeURIComponent).join(',')}`);
    rememberTracks(tracks);
  }
  return ids.map((id) => trackCache.get(id)).filter(Boolean);
}
