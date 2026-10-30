// In-memory app state and a tiny event bus. Nothing is stored on a server;
// the setlist and language survive a reload through localStorage only.
const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) fn(detail);
}

const saved = (() => { try { return JSON.parse(localStorage.getItem('ainos-prototype') || '{}'); } catch { return {}; } })();

export const state = {
  /** null (signed out), 'listener' or 'church' */
  role: saved.role || null,
  lang: saved.lang || 'en',
  /** Right panel: 'nowplaying' | 'lyrics' | null (closed) */
  panel: 'nowplaying',
  /** Ids of recently played items (hymn ids or 'video:<id>') */
  recent: saved.recent || ['holy-holy-holy', 'amazing-grace'],
  /** Church setlist items, see js/views/church.js; null = use the sample */
  setlist: saved.setlist || null,
};

export function save() {
  try {
    localStorage.setItem('ainos-prototype', JSON.stringify({ role: state.role, lang: state.lang, recent: state.recent, setlist: state.setlist }));
  } catch { /* private mode: in-memory only */ }
}

export function set(patch) {
  Object.assign(state, patch);
  save();
  emit('state', patch);
}
