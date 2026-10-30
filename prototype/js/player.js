// The player: one <audio> element for the hymns, plus "video" items that play
// in the official YouTube embed (shown by the now-playing panel). Emits:
//   'player'      on track change / play / pause   (detail: player.snapshot())
//   'time'        ~4× a second while playing         (detail: currentTime seconds)
import { HYMNS } from './data/hymns.js';
import { VIDEOS } from './data/videos.js';
import { emit, state, set } from './state.js';

const audio = new Audio();
audio.preload = 'auto';

export const player = {
  /** The queue being played: an array of item ids. */
  queue: [],
  index: -1,
  /** Current item: a hymn object, or a video object { type: 'video', ... } */
  current: null,

  item(id) {
    return HYMNS.find((h) => h.id === id) || VIDEOS.find((v) => v.id === id) || null;
  },
  snapshot() {
    return { current: this.current, playing: this.isPlaying(), time: this.time(), duration: this.duration() };
  },
  isPlaying() {
    return this.current?.type === 'video' ? this.videoPlaying : !audio.paused;
  },
  time() { return this.current?.type === 'video' ? 0 : audio.currentTime || 0; },
  duration() { return this.current?.type === 'video' ? 0 : (audio.duration || this.current?.duration || 0); },

  /** Play an item by id, with an optional queue (ids) to continue through. */
  play(id, queue) {
    const item = this.item(id);
    if (!item) return;
    if (queue) { this.queue = queue; this.index = queue.indexOf(id); }
    else if (!this.queue.includes(id)) { this.queue = [id]; this.index = 0; }
    else this.index = this.queue.indexOf(id);
    this.current = item;
    set({ recent: [id, ...state.recent.filter((x) => x !== id)].slice(0, 8) });
    if (item.type === 'video') {
      audio.pause();
      this.videoPlaying = true;
      if (state.panel === null || state.panel === 'lyrics') set({ panel: 'nowplaying' });
    } else {
      this.videoPlaying = false;
      audio.src = item.audio;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
    emit('player', this.snapshot());
  },
  toggle() {
    if (!this.current) { if (HYMNS[0]) this.play(HYMNS[0].id, HYMNS.map((h) => h.id)); return; }
    if (this.current.type === 'video') { this.videoPlaying = !this.videoPlaying; emit('player', this.snapshot()); return; }
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  },
  pause() { if (this.current?.type !== 'video') audio.pause(); },
  seek(seconds) {
    if (this.current?.type === 'video') return;
    audio.currentTime = Math.max(0, Math.min(seconds, this.duration() - 0.05));
    emit('time', audio.currentTime);
  },
  next() {
    if (this.index < this.queue.length - 1) this.play(this.queue[this.index + 1]);
    else if (this.current?.type !== 'video') { audio.pause(); audio.currentTime = 0; emit('player', this.snapshot()); }
  },
  prev() {
    if (this.time() > 3 || this.index <= 0) this.seek(0);
    else this.play(this.queue[this.index - 1]);
  },
  /** For the presentation's automatic mode: play a hymn from a time, and stop at another. */
  audio,
};

for (const ev of ['play', 'pause', 'loadedmetadata']) audio.addEventListener(ev, () => emit('player', player.snapshot()));
audio.addEventListener('ended', () => { emit('ended', player.current); player.next(); });
let raf;
const tick = () => { emit('time', audio.currentTime); raf = audio.paused ? null : requestAnimationFrame(tick); };
audio.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
audio.addEventListener('seeked', () => emit('time', audio.currentTime));
