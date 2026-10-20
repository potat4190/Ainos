// DOM helpers. Everything user-provided goes in via text nodes, never innerHTML.

export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || tag === 'use' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
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

export function icon(name, cls = 'icon') {
  const svg = h('svg', { class: cls, 'aria-hidden': 'true' });
  svg.append(h('use', { href: `#i-${name}` }));
  return svg;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

export function fmtNumber(n) {
  return new Intl.NumberFormat().format(n);
}

export function fmtBytes(b) {
  if (!Number.isFinite(b)) return '–';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function img(src, cls = 'art', alt = '') {
  return h('img', { src, class: cls, alt, loading: 'lazy', decoding: 'async' });
}

/** 2x2 mosaic of covers, like generated playlist artwork. */
export function mosaic(covers, cls = 'art') {
  const list = (covers || []).filter(Boolean);
  if (list.length >= 4) return h('div', { class: `${cls} mosaic` }, list.slice(0, 4).map((c) => h('img', { src: c, alt: '', loading: 'lazy' })));
  if (list.length) return h('div', { class: `${cls} mosaic single` }, h('img', { src: list[0], alt: '', loading: 'lazy' }));
  return h('div', { class: `${cls} mosaic single` });
}

export function likedArt(cls = 'art') {
  return h('div', { class: `${cls} art-liked` }, icon('heart-fill'));
}

// ---------- toasts ----------
export function toast(message, { error = false, ms = 2800 } = {}) {
  const root = document.getElementById('toasts');
  const t = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message);
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- context menus ----------
let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('hashchange', closeMenu);

/** items: [{label, icon, onClick, disabled} | 'sep' | {label, submenu: [...]}] */
export function showMenu(anchorOrEvent, items) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const build = (list) => {
    clear(menu);
    for (const it of list) {
      if (it === 'sep') { menu.append(h('hr')); continue; }
      const b = h('button', { role: 'menuitem', disabled: it.disabled }, it.icon ? icon(it.icon) : null, it.label, it.submenu ? h('span', { class: 'dim', style: { 'margin-left': 'auto' } }, '›') : null);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.submenu) return build(it.submenu);
        closeMenu();
        it.onClick?.();
      });
      menu.append(b);
    }
  };
  build(items);
  document.getElementById('menu-root').append(menu);
  openMenu = menu;
  let x, y;
  if (anchorOrEvent instanceof MouseEvent && anchorOrEvent.type === 'contextmenu') {
    x = anchorOrEvent.clientX; y = anchorOrEvent.clientY;
  } else {
    const el = anchorOrEvent.currentTarget || anchorOrEvent.target || anchorOrEvent;
    const r = el.getBoundingClientRect();
    x = r.left; y = r.bottom + 4;
  }
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - mr.width - 8))}px`;
  menu.style.top = `${Math.max(8, y + mr.height > innerHeight - 8 ? y - mr.height - 8 : y)}px`;
  menu.querySelector('button')?.focus();
}

// ---------- dialog ----------
export function promptDialog({ title, fields, submitLabel = 'Save' }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog' });
    const inputs = {};
    form.append(h('h2', {}, title));
    for (const f of fields) {
      const input = f.type === 'textarea'
        ? h('textarea', { name: f.name, maxlength: f.max || 300, placeholder: f.placeholder || '' })
        : h('input', { name: f.name, maxlength: f.max || 100, placeholder: f.placeholder || '', required: f.required });
      input.value = f.value || '';
      inputs[f.name] = input;
      form.append(h('label', { class: 'field' }, f.label, input));
    }
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Cancel');
    form.append(h('div', { class: 'dialog-actions' }, cancel, h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, submitLabel)));
    const dlg = h('dialog', {}, form);
    document.body.append(dlg);
    let result = null;
    form.addEventListener('submit', () => {
      result = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    });
    cancel.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    Object.values(inputs)[0]?.select();
  });
}

/** Horizontal slider with pointer + keyboard support. onChange(fraction, final). */
export function bindSlider(el, { onInput, onCommit, step = 0.05 }) {
  let dragging = false;
  const frac = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    onInput?.(frac(e));
  });
  el.addEventListener('pointermove', (e) => { if (dragging) onInput?.(frac(e)); });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    onCommit?.(frac(e));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { dragging = false; el.classList.remove('dragging'); });
  el.addEventListener('keydown', (e) => {
    const cur = Number(el.getAttribute('aria-valuenow') || 0) / 100;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onCommit?.(Math.min(1, cur + step)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onCommit?.(Math.max(0, cur - step)); }
  });
  return { isDragging: () => dragging };
}

export function setSlider(el, fillEl, thumbEl, fraction) {
  const pct = `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`;
  fillEl.style.width = pct;
  if (thumbEl) thumbEl.style.left = pct;
  el.setAttribute('aria-valuenow', Math.round(fraction * 100));
}
