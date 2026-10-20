export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

async function request(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, navigator.onLine ? 'Could not reach the server' : 'You are offline', 'network');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) for (const fn of listeners) fn();
    throw new ApiError(res.status, data?.error?.message || res.statusText, data?.error?.code);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
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
