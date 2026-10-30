// DOM helpers. Everything is built with h(), never innerHTML.
import { ICONS } from './icons.js';

const EXTRA_ICONS = {
  lyrics: '<path d="M12 2a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h-2v-3.1A7 7 0 0 1 5 11z" fill="currentColor"/>',
  book: '<path d="M4 4a2 2 0 0 1 2-2h13v17H6a1 1 0 0 0 0 2h13v2H6a3 3 0 0 1-3-3V4zm4 2v2h8V6z" fill="currentColor"/>',
  present: '<path d="M2 3h20v2h-1v10H3V5H2zm3 2v8h14V5zm6 11h2v2.6l3.7 2.6-1.1 1.6L12 20.4l-3.6 2.4-1.1-1.6L11 18.6z" fill="currentColor"/>',
  church: '<path d="M11 1h2v3h3v2h-3v2.6l7 4.4V22h-7v-5h-2v5H4v-9l7-4.4V6H8V4h3z" fill="currentColor"/>',
  globe: '<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm6.9 9a7 7 0 0 0-3.5-5.6c.6 1.5 1 3.4 1.1 5.6zm-4.4 0c-.2-3.3-1.3-5.4-2.5-6-1.2.6-2.3 2.7-2.5 6zM5.1 11h2.4c.1-2.2.5-4.1 1.1-5.6A7 7 0 0 0 5.1 11zm0 2a7 7 0 0 0 3.5 5.6c-.6-1.5-1-3.4-1.1-5.6zm4.4 0c.2 3.3 1.3 5.4 2.5 6 1.2-.6 2.3-2.7 2.5-6zm6.9 0c-.1 2.2-.5 4.1-1.1 5.6a7 7 0 0 0 3.5-5.6z" fill="currentColor"/>',
  up: '<path d="M12 6l7 7-1.4 1.4L12 8.8l-5.6 5.6L5 13z" fill="currentColor"/>',
  down: '<path d="M12 18l-7-7 1.4-1.4 5.6 5.6 5.6-5.6L19 11z" fill="currentColor"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z" fill="currentColor"/>',
  paste: '<path d="M9 2h6v2h4v18H5V4h4zm0 4H7v14h10V6h-2v2H9zm2-2v2h2V4z" fill="currentColor"/>',
  video: '<path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm7 4v6l5-3z" fill="currentColor"/>',
  text: '<path d="M4 4h16v3h-2V6h-5v12h2v2H9v-2h2V6H6v1H4z" fill="currentColor"/>',
  logout: '<path d="M4 3h9v2H6v14h7v2H4zm12.6 4.4L21.2 12l-4.6 4.6-1.4-1.4 2.2-2.2H10v-2h7.4l-2.2-2.2z" fill="currentColor"/>',
  fullscreen: '<path d="M3 3h7v2H5v5H3zm11 0h7v7h-2V5h-5zM3 14h2v5h5v2H3zm16 0h2v7h-7v-2h5z" fill="currentColor"/>',
};

/** Create an element: h('div', { class: 'x', onclick: fn, style: { color: 'red' } }, child, 'text', [more]). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** An inline SVG icon by name (see icons.js and EXTRA_ICONS). */
export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  // Icon bodies are our own constant markup (no user data): parsed as SVG.
  const body = ICONS[name] || EXTRA_ICONS[name] || '';
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, 'image/svg+xml');
  for (const n of [...doc.documentElement.childNodes]) svg.append(document.importNode(n, true));
  return svg;
}

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
export function toast(text) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/** A modal dialog using <dialog>. content: Node or array. Returns { dialog, close }. */
export function modal({ title, content, actions = [], wide = false, onClose }) {
  const dialog = h('dialog', { class: `modal${wide ? ' modal-wide' : ''}` });
  const close = () => { dialog.close(); dialog.remove(); onClose?.(); };
  dialog.append(
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
    h('div', { class: 'modal-body' }, content),
    ...(actions.length ? [h('div', { class: 'modal-actions' }, actions)] : []),
  );
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Cover art: a gradient square with a cross watermark, from a hue. */
export function cover(hue = 40, label = '', cls = 'cover') {
  return h('div', { class: cls, style: { '--hue': String(hue) } }, label ? h('span', {}, label) : null);
}
