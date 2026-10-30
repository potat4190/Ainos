// The audience window (present.html): a black page that shows the slides the
// presenter sends over BroadcastChannel('ainos-present'). Keys here are sent back
// to the presenter, so a clicker plugged into the projector machine still works.
import { h } from '../ui.js';
import { t } from '../i18n.js';
import { renderSlide } from './stage.js';

const NAV_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'Home', 'End']);

document.title = t('prAudienceTitle');
const root = document.getElementById('audience');
const stage = h('div', { class: 'stage pr-audience-stage' });
const promptText = h('span', {}, t('prWaiting'));
const prompt = h('div', { class: 'pr-prompt' }, promptText);
root.append(stage, prompt);
renderSlide(stage, null);

let slides = [];
let index = 0;
let placed = false;
let connected = false;
let ended = false;

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('ainos-present') : null;
const send = (msg) => { try { channel?.postMessage(msg); } catch { /* closed */ } };

function show() {
  renderSlide(stage, slides[index] || null);
}

function updatePrompt() {
  if (document.fullscreenElement || ended) { prompt.hidden = true; return; }
  prompt.hidden = false;
  promptText.textContent = !connected ? t('prWaiting') : placed ? t('prClickFullscreen') : t('prDragToProjector');
}

function endScreen() {
  ended = true;
  renderSlide(stage, { kind: 'end', title: t('prEndOfPresentation'), lines: [] });
  updatePrompt();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  window.close(); // works when the presenter opened this window
}

if (channel) {
  channel.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'deck' && Array.isArray(m.slides)) {
      slides = m.slides;
      index = Number(m.index) || 0;
      placed = !!m.placed;
      connected = true;
      ended = false;
      show();
      updatePrompt();
    } else if (m.type === 'go' && connected) {
      index = Number(m.index) || 0;
      show();
    } else if (m.type === 'end') {
      endScreen();
    }
  };
}
send({ type: 'hello' });

// Click: first go full screen, afterwards advance (like a slideshow).
document.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
  } else if (connected && !ended) {
    send({ type: 'key', key: 'ArrowRight' });
  }
});
document.addEventListener('contextmenu', (e) => {
  if (!document.fullscreenElement || !connected) return;
  e.preventDefault();
  send({ type: 'key', key: 'ArrowLeft' });
});
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (NAV_KEYS.has(e.key)) {
    e.preventDefault();
    if (connected && !ended) send({ type: 'key', key: e.key });
  }
});
document.addEventListener('fullscreenchange', updatePrompt);

// Hide the cursor when it's idle.
let idleTimer;
const wake = () => {
  document.body.classList.remove('pr-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('pr-idle'), 2000);
};
document.addEventListener('mousemove', wake);
wake();
updatePrompt();
