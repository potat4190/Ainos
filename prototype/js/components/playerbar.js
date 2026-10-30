// Player bar (Spotify-style): now playing on the left, transport and seek in
// the centre, lyrics / now-playing panel toggles and volume on the right.
import { h, icon, fmtTime } from '../ui.js';
import { t } from '../i18n.js';
import { state, set, on } from '../state.js';
import { player } from '../player.js';
import { artFor } from '../views/home.js';

let offs = [];

// Space toggles play/pause, unless focus is in a field or on a control (registered once).
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  if (el?.closest?.('input, textarea, select, button, a, summary, [contenteditable=""], [contenteditable="true"], [role="button"]')) return;
  if (!state.role || !document.getElementById('playerbar') || document.querySelector('dialog[open]') || document.fullscreenElement) return;
  e.preventDefault();
  player.toggle();
});

export function mountPlayerBar(el) {
  offs.forEach((f) => f()); offs = [];
  let dragging = false;

  const art = h('div', { class: 'pb-art' });
  const title = h('div', { class: 'pb-title' });
  const artist = h('div', { class: 'pb-artist' });
  const left = h('div', { class: 'pb-left' }, art, h('div', { class: 'pb-meta' }, title, artist));

  const playBtn = h('button', { class: 'pb-play', onclick: () => player.toggle() });
  const prevBtn = h('button', { class: 'icon-btn pb-prev', 'aria-label': t('previous'), title: t('previous'), onclick: () => player.prev() }, icon('prev'));
  const nextBtn = h('button', { class: 'icon-btn pb-next', 'aria-label': t('next'), title: t('next'), onclick: () => player.next() }, icon('next'));
  const cur = h('span', { class: 'pb-time' }, '0:00');
  const dur = h('span', { class: 'pb-time' }, '0:00');
  const seek = h('input', { class: 'pb-seek range', type: 'range', min: '0', max: '1', step: '0.1', value: '0', 'aria-label': t('seek') });
  const yt = h('span', { class: 'pb-yt' }, icon('video', 'icon icon-xs'), t('playingOnYoutube'));
  const seekRow = h('div', { class: 'pb-seekrow' }, cur, seek, dur);
  const centre = h('div', { class: 'pb-centre' }, h('div', { class: 'pb-controls' }, prevBtn, playBtn, nextBtn), seekRow, yt);

  const lyricsBtn = h('button', { class: 'icon-btn pb-lyrics', 'aria-label': t('lyrics'), title: t('lyrics'),
    onclick: () => set({ panel: state.panel === 'lyrics' ? 'nowplaying' : 'lyrics' }) }, icon('lyrics'));
  const npBtn = h('button', { class: 'icon-btn pb-np', 'aria-label': t('nowPlayingPanel'), title: t('nowPlayingPanel'),
    onclick: () => set({ panel: state.panel === 'nowplaying' ? null : 'nowplaying' }) }, icon('nowplaying'));
  const vol = h('input', { class: 'pb-vol range', type: 'range', min: '0', max: '1', step: '0.01', value: String(player.audio.volume), 'aria-label': t('volume') });
  const volIcon = h('span', { class: 'pb-volicon' }, icon(player.audio.volume ? 'volume' : 'mute'));
  const right = h('div', { class: 'pb-right' }, lyricsBtn, npBtn, h('div', { class: 'pb-volwrap' }, volIcon, vol));

  const empty = h('div', { class: 'pb-empty' }, icon('sparkle', 'icon icon-xs'), t('pickHymn'));
  el.append(left, empty, centre, right);

  const fill = (input, val, max) => input.style.setProperty('--pct', `${max > 0 ? Math.min(100, (val / max) * 100) : 0}%`);

  function paintTime(time) {
    if (dragging) return;
    const d = player.duration();
    seek.max = String(d || 1);
    seek.value = String(time || 0);
    cur.textContent = fmtTime(time);
    dur.textContent = fmtTime(d);
    fill(seek, time, d);
  }

  function paint() {
    const item = player.current;
    const isVideo = item?.type === 'video';
    const playing = player.isPlaying();
    el.classList.toggle('pb-idle', !item);
    el.classList.toggle('pb-video', isVideo);
    art.replaceChildren(item ? artFor(item, 'cover pb-cover') : h('div', { class: 'cover pb-cover pb-cover-empty' }));
    title.textContent = item ? item.title : '';
    artist.textContent = item ? (isVideo ? t('officialVideo', { artist: item.artist }) : item.artist) : '';
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', t(playing ? 'pause' : 'play'));
    playBtn.title = t(playing ? 'pause' : 'play');
    seek.disabled = !item || isVideo;
    prevBtn.disabled = !item;
    nextBtn.disabled = !item || player.index >= player.queue.length - 1;
    yt.hidden = !isVideo;
    seekRow.hidden = isVideo;
    paintTime(player.time());
  }

  function paintPanel() {
    lyricsBtn.classList.toggle('active', state.panel === 'lyrics');
    lyricsBtn.setAttribute('aria-pressed', String(state.panel === 'lyrics'));
    npBtn.classList.toggle('active', state.panel === 'nowplaying');
    npBtn.setAttribute('aria-pressed', String(state.panel === 'nowplaying'));
  }

  seek.addEventListener('input', () => {
    dragging = true;
    cur.textContent = fmtTime(Number(seek.value));
    fill(seek, Number(seek.value), Number(seek.max));
  });
  seek.addEventListener('change', () => { dragging = false; player.seek(Number(seek.value)); });
  vol.addEventListener('input', () => {
    player.audio.volume = Number(vol.value);
    fill(vol, player.audio.volume, 1);
    volIcon.replaceChildren(icon(player.audio.volume ? 'volume' : 'mute'));
  });
  fill(vol, player.audio.volume, 1);

  paint();
  paintPanel();
  offs.push(on('player', () => { if (el.isConnected) paint(); }));
  offs.push(on('time', (time) => { if (el.isConnected && player.current?.type !== 'video') paintTime(time); }));
  offs.push(on('state', (patch) => { if (el.isConnected && patch && 'panel' in patch) paintPanel(); }));
}
