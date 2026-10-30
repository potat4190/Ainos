// Slide rendering shared by this-screen mode, the presenter view and the audience window.
// White on pure black, centred, the font size binary-searched so the text fits about 90%
// of the container. Re-fits whenever the container resizes. Sizes go through CSS custom
// properties (CSSOM), never style= attributes, so it runs under the strict CSP.
import { h, clear } from '../ui.js';

// Largest font size per kind, as a fraction of the stage height, so short lines aren't huge.
const CAP = { title: 0.13, song: 0.095, scripture: 0.075, text: 0.1 };

const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => { for (const e of entries) fit(e.target); })
  : null;
const observed = new WeakSet();

const lineEls = (lines) => (Array.isArray(lines) ? lines : []).map((l) => h('div', { class: 'stage-line' }, String(l ?? '')));

/**
 * Render one slide into container (any sized element). slide null or kind 'blank' = black.
 * slide: { kind: 'title'|'song'|'scripture'|'text'|'blank'|'end', title?, lines?, label?, attribution? }
 */
export function renderSlide(container, slide) {
  clear(container);
  container.classList.add('stage');
  const kind = ['title', 'song', 'scripture', 'text', 'end'].includes(slide?.kind) ? slide.kind : 'blank';
  container.dataset.kind = kind;
  let text = null;
  let foot = null;
  if (kind === 'title') {
    text = h('div', { class: 'stage-text stage-wrap' },
      h('div', { class: 'stage-line stage-title' }, slide.title || ''),
      slide.sub ? h('div', { class: 'stage-sub' }, slide.sub) : null);
  } else if (kind === 'song') {
    text = h('div', { class: 'stage-text' }, lineEls(slide.lines));
    if (slide.label) foot = h('div', { class: 'stage-foot' }, slide.label);
  } else if (kind === 'scripture') {
    text = h('div', { class: 'stage-text stage-wrap stage-scripture' }, lineEls(slide.lines));
    if (slide.attribution) foot = h('div', { class: 'stage-foot stage-attr' }, slide.attribution);
  } else if (kind === 'text') {
    text = h('div', { class: 'stage-text stage-wrap' }, lineEls(slide.lines));
  } else if (kind === 'end') {
    container.append(h('div', { class: 'stage-end' }, slide.title || ''));
  }
  if (text) container.append(text);
  if (foot) container.append(foot);
  container.classList.toggle('has-foot', !!foot);
  if (ro && !observed.has(container)) { ro.observe(container); observed.add(container); }
  fit(container);
}

/** Fit the text of a rendered stage to its current size. */
export function fit(container) {
  const W = container.clientWidth;
  const H = container.clientHeight;
  if (!W || !H) return;
  container.style.setProperty('--stage-small', `${Math.max(5, H * 0.034).toFixed(2)}px`);
  const box = container.querySelector(':scope > .stage-text');
  if (!box) return;
  const foot = container.querySelector(':scope > .stage-foot');
  const maxW = W * 0.9;
  const maxH = H * (foot ? 0.8 : 0.9);
  box.style.setProperty('--stage-w', `${maxW.toFixed(2)}px`);
  let lo = 1;
  let hi = Math.max(2, H * (CAP[container.dataset.kind] || 0.1));
  const fits = (px) => {
    box.style.setProperty('--slide-size', `${px.toFixed(2)}px`);
    return box.scrollWidth <= maxW + 0.5 && box.scrollHeight <= maxH + 0.5;
  };
  if (fits(hi)) return;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  box.style.setProperty('--slide-size', `${lo.toFixed(2)}px`);
}
