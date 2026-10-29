// Playback engine.
//
// Design follows what Spotify has documented about its clients:
//  * Two "decks" (audio elements). When <= 30 s remain in the current track the
//    next track is resolved and starts buffering on the spare deck, so the
//    transition is instant (Kreitz & Niemelä 2010: prefetch at 30 s / 10 s left).
//  * Playback latency (click -> first audio) and stutters are measured and
//    reported, the same health metrics Spotify optimizes for.
//  * Loudness normalization: per-track gain from the manifest towards a target
//    (Loud -11 / Normal -14 / Quiet -19 LUFS) without letting peaks clip.
//  * Every play produces play_start / play_end events, batched and sent to the
//    event pipeline; plays of >= 30 s become "streams" server-side.
//  * A user queue that plays before the rest of the context, shuffle that keeps
//    the current track first, and repeat off / context / track.
//  * Crossfade (Settings, 0-12 s): when a song ends on its own and the next
//    one is already buffered on the spare deck, the next one starts early and
//    the two decks fade across on an equal-power curve (crossfade.js).

import { api, tracksByIds, rememberTracks } from './api.js';
import { t } from './i18n.js';
import { crossfadeMs, shouldStartCrossfade, fadeCurve, equalPowerGains } from './crossfade.js';

export const LOUDNESS_TARGETS = { loud: -11, normal: -14, quiet: -19 };
const PREFETCH_WINDOW_MS = 30_000;
const MANIFEST_TTL_MS = 45 * 60_000;
const DEFAULTS = { quality: 'auto', normalize: true, loudness: 'normal', volume: 0.8, muted: false, autocache: true, crossfade: 0 };

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

// Only kinds that have a page in the router (app.js ROUTES) get a link;
// e.g. ainos:chart:* and ainos:track:* have no page and return null.
const ID_ROUTES = new Set(['album', 'artist', 'playlist', 'mix', 'radio', 'genre']);
export function uriToRoute(uri) {
  if (uri === 'ainos:downloads') return '#/downloads';
  if (uri === 'ainos:recent') return '#/recent';
  const m = /^ainos:(\w+):(.+)$/.exec(uri || '');
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === 'collection') return '#/liked';
  if (kind === 'stats') return '#/stats';
  if (kind === 'search') return `#/search?q=${encodeURIComponent(id)}`;
  if (ID_ROUTES.has(kind)) return `#/${kind}/${encodeURIComponent(id)}`;
  return null;
}

function shuffleRest(n, first) {
  const rest = [...Array(n).keys()].filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first >= 0 ? [first, ...rest] : rest;
}

export class Player extends EventTarget {
  constructor({ deviceId }) {
    super();
    this.deviceId = deviceId;
    this.settings = { ...DEFAULTS, ...store.get('ainos.settings', {}) };
    this.me = null;
    this.decks = [this.#makeDeck(), this.#makeDeck()];
    this.active = 0;
    this.ctx = null;
    this.context = null;     // { uri, title, tracks }
    this.order = [];         // playback order (indices into context.tracks)
    this.index = -1;         // position in order
    this.userQueue = [];     // tracks added with "Add to queue"
    this.track = null;
    this.shuffle = false;
    this.repeat = 'off';
    this.isPlaying = false;
    this.session = null;     // the current play: ms played, reasons, latency...
    this.prefetch = { trackId: null, state: 'idle' };
    this.metrics = { latencies: [], stutters: 0, prefetchHits: 0, coldStarts: 0 };
    this.manifests = new Map();
    this.queue = [];         // outgoing events
    this.remote = null;      // state of another active device (Connect)
    this.resumeState = null; // last known state when no device is active
    this.connect = null;
    this.loadToken = 0;
    this.lastReport = 0;
    this.downloads = store.get('ainos.downloads', {});
    this.xfade = null;       // { outgoing deck, ms, timers } while two decks overlap
    this.pendingXfade = null;

    setInterval(() => this.flush(), 15_000);
    addEventListener('pagehide', () => {
      this.#endSession('endplay');
      this.flush({ beacon: true });
    });
    this.#mediaSessionHandlers();
  }

  // ---------------------------------------------------------------- decks
  #makeDeck() {
    const audio = new Audio();
    audio.preload = 'auto';
    // gain = loudness normalization; fade = crossfade envelope (1 = full).
    const deck = { audio, gain: null, fadeNode: null, fade: 1, source: null, trackId: null, track: null, manifest: null, gainDb: 0 };
    const isActive = () => deck === this.decks[this.active];
    audio.addEventListener('timeupdate', () => isActive() && this.#onTime());
    audio.addEventListener('ended', () => isActive() && this.#onEnded());
    audio.addEventListener('playing', () => isActive() && this.#onPlaying());
    audio.addEventListener('play', () => { if (isActive()) { this.isPlaying = true; this.#changed(); } });
    audio.addEventListener('pause', () => { if (isActive()) { this.isPlaying = false; this.#changed(); } });
    // A buffer underrun during playback is a stutter; waiting right after a seek is expected.
    audio.addEventListener('seeking', () => { deck.lastSeek = performance.now(); });
    audio.addEventListener('waiting', () => {
      if (!isActive() || !this.session?.started || performance.now() - (deck.lastSeek || 0) < 2000) return;
      this.session.stutters++;
      this.metrics.stutters++;
      this.#emit('debug');
    });
    audio.addEventListener('progress', () => this.#emit('buffer'));
    audio.addEventListener('canplaythrough', () => {
      if (!isActive() && this.prefetch.trackId === deck.trackId && this.prefetch.state === 'loading') {
        this.prefetch.state = 'ready';
        this.#emit('debug');
      }
    });
    audio.addEventListener('error', () => isActive() && deck.trackId && this.#onError(audio.error));
    return deck;
  }
  get deck() { return this.decks[this.active]; }
  get spare() { return this.decks[1 - this.active]; }

  #ensureGraph() {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      for (const d of this.decks) {
        if (d.source) continue;
        d.source = this.ctx.createMediaElementSource(d.audio);
        d.gain = this.ctx.createGain();
        d.fadeNode = this.ctx.createGain();
        d.fadeNode.gain.value = d.fade;
        d.source.connect(d.gain).connect(d.fadeNode).connect(this.ctx.destination);
        this.#applyGain(d);
      }
    } catch (err) {
      console.warn('[ainos] Web Audio unavailable, normalization limited to attenuation', err);
    }
  }

  normalizationGainDb(n) {
    if (!n || !this.settings.normalize) return 0;
    const target = LOUDNESS_TARGETS[this.settings.loudness] ?? -14;
    return Math.min(target - n.loudness_lufs, -1 - n.peak_db);
  }

  #applyGain(deck) {
    deck.gainDb = deck.manifest ? this.normalizationGainDb(deck.manifest.normalization) : 0;
    const lin = Math.pow(10, deck.gainDb / 20);
    const vol = this.settings.muted ? 0 : this.settings.volume;
    if (deck.gain) {
      deck.gain.gain.value = lin;
      deck.audio.volume = vol;
    } else {
      deck.audio.volume = Math.min(1, vol * Math.min(1, lin) * deck.fade);
    }
  }

  #unload(deck) {
    deck.audio.pause();
    if (deck === this.deck) this.isPlaying = false;
    deck.audio.removeAttribute('src');
    deck.audio.load();
    deck.trackId = null; deck.track = null; deck.manifest = null;
  }

  // ------------------------------------------------------------- manifests
  #quality() {
    if (this.settings.quality !== 'auto') return this.settings.quality;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g|3g/.test(c.effectiveType || ''))) return 'low';
    return 'high';
  }

  async getManifest(trackId) {
    const hit = this.manifests.get(trackId);
    if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.m;
    try {
      const m = await api.get(`/api/tracks/${trackId}/manifest?quality=${this.#quality()}`);
      this.manifests.set(trackId, { m, at: Date.now() });
      return m;
    } catch (err) {
      // Offline: downloaded tracks keep their manifest; the service worker
      // serves the audio from cache regardless of the expired URL signature.
      if (this.downloads[trackId]) return this.downloads[trackId].manifest;
      throw err;
    }
  }

  /** Resolves false (deck untouched) when `isCurrent()` says the load went stale while the manifest was in flight. */
  async #load(deck, track, isCurrent = () => true) {
    const manifest = await this.getManifest(track.id);
    if (!isCurrent()) return false;
    deck.trackId = track.id;
    deck.track = track;
    deck.manifest = manifest;
    deck.audio.src = manifest.file.url;
    deck.audio.load();
    this.#applyGain(deck);
    return true;
  }

  // -------------------------------------------------------------- playback
  trackAt(i) {
    return this.context?.tracks[this.order[i]] || null;
  }

  async startTrack(track, { reason = 'clickrow', positionMs = 0, autoplay = true } = {}) {
    if (!track) return;
    const token = ++this.loadToken;
    const t0 = performance.now();
    const xfade = this.pendingXfade;
    this.pendingXfade = null;
    this.#endCrossfade(); // any other start cuts a fade still running
    let prefetched = false;
    if (this.spare.trackId === track.id && this.spare.audio.src && !this.spare.audio.error) {
      const outgoing = this.deck;
      const crossfading = xfade?.outgoing === outgoing;
      if (crossfading) this.#setFade(this.spare, 0);
      else this.#unload(outgoing);
      this.active = 1 - this.active;
      prefetched = true;
      this.metrics.prefetchHits++;
      if (crossfading) this.#beginCrossfade(outgoing, this.deck, xfade.ms);
    } else {
      this.#unload(this.spare);
      this.deck.audio.pause();
      this.metrics.coldStarts++;
      try {
        // A newer startTrack may finish first; this one must not then overwrite its src.
        await this.#load(this.deck, track, () => token === this.loadToken);
      } catch (err) {
        if (token === this.loadToken) this.#emit('error', { message: t('cantPlay', { title: track.title }), cause: err });
        return;
      }
      if (token !== this.loadToken) return;
    }
    this.prefetch = { trackId: null, state: 'idle' };
    this.track = track;
    this.session = { trackId: track.id, msPlayed: 0, lastPos: positionMs, reasonStart: reason, contextUri: this.context?.uri || null, t0, latencyLogged: false, prefetched, stutters: 0, started: false };
    const audio = this.deck.audio;
    if (positionMs > 0) {
      const seekTo = () => { audio.currentTime = positionMs / 1000; };
      if (audio.readyState >= 1) seekTo(); else audio.addEventListener('loadedmetadata', seekTo, { once: true });
    }
    this.#log('play_start', { track_id: track.id, reason, position_ms: positionMs });
    this.#updateMediaSession();
    this.#changed();
    if (autoplay) await this.#doPlay();
    this.reportState(true);
  }

  async #doPlay() {
    this.#ensureGraph();
    try {
      await this.deck.audio.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') this.#emit('error', { message: 'Press play to start audio on this device.' });
      else if (err.name !== 'AbortError') this.#emit('error', { message: t('playbackFailed'), cause: err });
      this.isPlaying = false;
      this.#changed();
    }
  }

  #onPlaying() {
    const s = this.session;
    if (!s || s.latencyLogged) return;
    s.latencyLogged = true;
    s.started = true;
    const ms = Math.round(performance.now() - s.t0);
    this.metrics.latencies.push({ ms, prefetched: s.prefetched, at: Date.now(), title: this.track?.title });
    if (this.metrics.latencies.length > 50) this.metrics.latencies.shift();
    this.#log('latency', { track_id: s.trackId, data: { ms, prefetched: s.prefetched, quality: this.deck.manifest?.file.quality } });
    this.#emit('debug');
  }

  #onTime() {
    const s = this.session;
    const pos = this.deck.audio.currentTime * 1000;
    if (s) {
      const d = pos - s.lastPos;
      if (this.isPlaying && d > 0 && d < 2000) s.msPlayed += d;
      s.lastPos = pos;
    }
    const dur = (this.deck.audio.duration || 0) * 1000;
    // No prefetch while the spare deck is still fading out the last song.
    if (dur && dur - pos <= PREFETCH_WINDOW_MS && this.prefetch.state === 'idle' && !this.xfade) this.#prefetchNext();
    if (dur && !this.xfade && !this.pendingXfade) this.#maybeCrossfade(pos, dur);
    if (this.isPlaying && Date.now() - this.lastReport > 10_000) this.reportState();
    if ('mediaSession' in navigator && dur && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: dur / 1000, position: Math.min(pos, dur) / 1000, playbackRate: 1 }); } catch { /* ignore */ }
    }
  }

  async #prefetchNext() {
    const next = this.peekNext();
    if (!next || next.id === this.track?.id) { this.prefetch = { trackId: null, state: 'none' }; return; }
    const prefetch = { trackId: next.id, state: 'loading' };
    this.prefetch = prefetch;
    const deck = this.spare;
    this.#emit('debug');
    try {
      // Stale if invalidated, superseded or if the decks swapped meanwhile: never touch the active deck.
      if (await this.#load(deck, next, () => this.prefetch === prefetch && deck === this.spare)) this.#log('prefetch', { track_id: next.id });
    } catch {
      if (this.prefetch === prefetch) this.prefetch = { trackId: null, state: 'failed' };
    }
    this.#emit('debug');
  }

  #invalidatePrefetch() {
    if (this.prefetch.trackId && this.peekNext()?.id === this.prefetch.trackId) return;
    if (this.spare.trackId && this.spare !== this.xfade?.outgoing) this.#unload(this.spare);
    this.prefetch = { trackId: null, state: 'idle' };
    this.#emit('debug');
  }

  #onEnded() {
    this.next('trackdone');
  }

  // ------------------------------------------------------------- crossfade
  /** Near the end of a song that is playing to its end, start the next one early. */
  #maybeCrossfade(posMs, durMs) {
    const next = this.peekNext();
    const spare = this.spare;
    if (!next || next.id === this.track?.id || this.isRemote) return;
    const ms = crossfadeMs(this.settings.crossfade, durMs, (spare.audio.duration * 1000) || next.duration_ms);
    // HAVE_FUTURE_DATA: the next song can start without a gap.
    const nextReady = spare.trackId === next.id && spare.audio.readyState >= 3 && !spare.audio.error;
    if (!shouldStartCrossfade({ fadeMs: ms, positionMs: posMs, durationMs: durMs, isPlaying: this.isPlaying, nextReady })) return;
    this.pendingXfade = { outgoing: this.deck, ms: Math.max(250, durMs - posMs) };
    this.next('trackdone'); // startTrack takes pendingXfade before its first await
    this.pendingXfade = null;
  }

  #beginCrossfade(outgoing, incoming, ms) {
    this.xfade = { outgoing, ms, timers: [] };
    this.#rampFade(incoming, 'in', ms);
    this.#rampFade(outgoing, 'out', ms);
    this.xfade.timers.push(setTimeout(() => this.#endCrossfade(), ms + 100));
    this.#emit('debug');
  }

  /** Finish (or cut short) a crossfade: stop the outgoing deck, the current one at full level. */
  #endCrossfade() {
    const x = this.xfade;
    if (!x) return;
    this.xfade = null;
    for (const id of x.timers) { clearTimeout(id); clearInterval(id); }
    if (x.outgoing !== this.deck) this.#unload(x.outgoing);
    this.#setFade(x.outgoing, 1);
    this.#setFade(this.deck, 1);
    this.#emit('debug');
  }

  #setFade(deck, value) {
    deck.fade = value;
    if (deck.fadeNode && this.ctx) {
      deck.fadeNode.gain.cancelScheduledValues(0); // also drops a curve already under way
      deck.fadeNode.gain.value = value;
    }
    this.#applyGain(deck);
  }

  #rampFade(deck, direction, ms) {
    if (deck.fadeNode && this.ctx) {
      const g = deck.fadeNode.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(0);
      try {
        g.setValueCurveAtTime(fadeCurve(direction), now, ms / 1000);
      } catch {
        g.setValueAtTime(direction === 'in' ? 0 : 1, now);
        g.linearRampToValueAtTime(direction === 'in' ? 1 : 0, now + ms / 1000);
      }
      deck.fade = direction === 'in' ? 1 : 0; // where it ends up
      return;
    }
    // No Web Audio: step the element volume instead.
    const t0 = performance.now();
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      deck.fade = equalPowerGains(p)[direction];
      this.#applyGain(deck);
      if (p >= 1) clearInterval(id);
    }, 50);
    this.xfade?.timers.push(id);
  }

  #onError(err) {
    this.#emit('error', { message: t('playbackSkipping'), cause: err });
    this.#endSession('trackerror');
    this.manifests.delete(this.track?.id);
    const token = this.loadToken;
    // Skip only if the user hasn't already started something else in the meantime.
    setTimeout(() => { if (token === this.loadToken) this.next('trackerror'); }, 600);
  }

  #endSession(reasonEnd) {
    const s = this.session;
    if (!s) return;
    const pos = this.deck.audio.currentTime * 1000;
    const d = pos - s.lastPos;
    if (this.isPlaying && d > 0 && d < 2000) s.msPlayed += d;
    this.#log('play_end', {
      track_id: s.trackId, reason: reasonEnd, ms_played: Math.round(s.msPlayed), position_ms: Math.round(pos), context_uri: s.contextUri,
      data: { reason_start: s.reasonStart, stutters: s.stutters, prefetched: s.prefetched, quality: this.deck.manifest?.file.quality },
    });
    if (reasonEnd === 'trackdone' && this.settings.autocache && this.deck.manifest) this.#swMessage({ type: 'cache', url: this.deck.manifest.file.url });
    this.session = null;
  }

  peekNext() {
    if (this.userQueue.length) return this.userQueue[0];
    if (!this.context) return null;
    if (this.repeat === 'track') return this.track;
    if (this.index + 1 < this.order.length) return this.trackAt(this.index + 1);
    if (this.repeat === 'context' && this.order.length) return this.trackAt(0);
    return null;
  }

  upNext(limit = 30) {
    const out = [];
    if (!this.context) return out;
    for (let i = this.index + 1; i < this.order.length && out.length < limit; i++) out.push({ track: this.trackAt(i), orderIndex: i });
    return out;
  }

  async next(reason = 'fwdbtn') {
    if (this.isRemote) return this.connect.command({ type: 'next' });
    if (this.userQueue.length) {
      this.#endSession(reason);
      return this.startTrack(this.userQueue.shift(), { reason });
    }
    if (!this.context) return;
    if (this.repeat === 'track' && reason === 'trackdone') {
      this.#endSession(reason);
      return this.startTrack(this.track, { reason });
    }
    let i = this.index + 1;
    if (i >= this.order.length) {
      if (this.repeat === 'context' && this.order.length) i = 0;
      else {
        this.#endSession(reason);
        this.deck.audio.pause();
        this.deck.audio.currentTime = 0;
        this.reportState(true);
        return this.#changed();
      }
    }
    this.#endSession(reason);
    this.index = i;
    return this.startTrack(this.trackAt(i), { reason });
  }

  async previous() {
    if (this.isRemote) return this.connect.command({ type: 'previous' });
    if (this.positionMs > 3000 || this.index <= 0) return this.seek(0);
    this.#endSession('backbtn');
    this.index--;
    return this.startTrack(this.trackAt(this.index), { reason: 'backbtn' });
  }

  async toggle() {
    if (this.isRemote) return this.connect.command({ type: this.view().isPlaying ? 'pause' : 'resume' });
    if (!this.track) {
      if (this.resumeState) return this.restoreState(this.resumeState, { play: true, reason: 'playbtn' });
      return;
    }
    if (this.deck.audio.paused) {
      if (!this.session) {
        // track finished or was stopped: start a fresh play of it
        return this.startTrack(this.track, { reason: 'playbtn', positionMs: this.deck.audio.currentTime * 1000 });
      }
      await this.#doPlay();
      this.#log('resume', { track_id: this.track.id, position_ms: Math.round(this.positionMs) });
    } else {
      this.#endCrossfade();
      this.deck.audio.pause();
      this.#log('pause', { track_id: this.track.id, position_ms: Math.round(this.positionMs) });
    }
    this.reportState(true);
  }

  pause() {
    this.#endCrossfade();
    if (!this.deck.audio.paused) this.deck.audio.pause();
  }

  seek(ms) {
    if (this.isRemote) return this.connect.command({ type: 'seek', position_ms: Math.round(ms) });
    if (!this.track) return;
    this.#endCrossfade();
    const audio = this.deck.audio;
    audio.currentTime = Math.max(0, ms / 1000);
    if (this.session) this.session.lastPos = ms;
    this.#log('seek', { track_id: this.track.id, position_ms: Math.round(ms) });
    this.reportState(true);
    this.#changed();
  }

  /** Play a list of tracks ("context": album, playlist, mix, radio...). */
  async playContext(ctx, startIndex = 0, { reason = 'clickrow', shuffle } = {}) {
    if (!ctx?.tracks?.length) return;
    if (this.isRemote) {
      return this.connect.command({ type: 'play', context: { uri: ctx.uri, title: ctx.title, track_ids: ctx.tracks.map((t) => t.id) }, index: startIndex });
    }
    rememberTracks(ctx.tracks);
    if (shuffle !== undefined) this.shuffle = shuffle;
    this.#endSession('endplay');
    this.context = { uri: ctx.uri, title: ctx.title, tracks: ctx.tracks };
    const n = ctx.tracks.length;
    if (this.shuffle) {
      const first = startIndex >= 0 ? startIndex : Math.floor(Math.random() * n);
      this.order = shuffleRest(n, first);
      this.index = 0;
    } else {
      this.order = [...Array(n).keys()];
      this.index = Math.max(0, startIndex);
    }
    return this.startTrack(this.trackAt(this.index), { reason });
  }

  jumpTo(orderIndex) {
    if (orderIndex < 0 || orderIndex >= this.order.length) return;
    this.#endSession('clickrow');
    this.index = orderIndex;
    this.startTrack(this.trackAt(orderIndex), { reason: 'clickrow' });
  }

  playFromQueue(i) {
    const [t] = this.userQueue.splice(i, 1);
    if (!t) return;
    this.#endSession('clickrow');
    this.startTrack(t, { reason: 'clickrow' });
  }

  addToQueue(track) {
    if (this.isRemote) return this.connect.command({ type: 'queue', track_id: track.id });
    rememberTracks([track]);
    this.userQueue.push(track);
    this.#invalidatePrefetch();
    this.#changed();
    this.reportState(true);
  }

  removeFromQueue(i) {
    this.userQueue.splice(i, 1);
    this.#invalidatePrefetch();
    this.#changed();
  }

  toggleShuffle() {
    if (this.isRemote) return this.connect.command({ type: 'shuffle', shuffle: !this.remote.shuffle });
    this.shuffle = !this.shuffle;
    if (this.context) {
      const current = this.order[this.index] ?? 0;
      if (this.shuffle) {
        this.order = shuffleRest(this.context.tracks.length, current);
        this.index = 0;
      } else {
        this.order = [...Array(this.context.tracks.length).keys()];
        this.index = current;
      }
    }
    this.#invalidatePrefetch();
    this.#changed();
    this.reportState(true);
  }

  cycleRepeat() {
    const nextMode = { off: 'context', context: 'track', track: 'off' };
    if (this.isRemote) return this.connect.command({ type: 'repeat', repeat: nextMode[this.remote.repeat || 'off'] });
    this.repeat = nextMode[this.repeat];
    this.#invalidatePrefetch();
    this.#changed();
    this.reportState(true);
  }

  setVolume(v) {
    if (this.isRemote) return this.connect.command({ type: 'volume', volume: v });
    this.settings.volume = Math.max(0, Math.min(1, v));
    this.settings.muted = false;
    this.saveSettings();
    this.decks.forEach((d) => this.#applyGain(d));
    this.#changed();
    clearTimeout(this.volTimer);
    this.volTimer = setTimeout(() => this.reportState(true), 300);
  }

  toggleMute() {
    this.settings.muted = !this.settings.muted;
    this.saveSettings();
    this.decks.forEach((d) => this.#applyGain(d));
    this.#changed();
  }

  updateSettings(patch) {
    const qualityChanged = patch.quality !== undefined && patch.quality !== this.settings.quality;
    Object.assign(this.settings, patch);
    this.saveSettings();
    if (qualityChanged) this.manifests.clear();
    this.decks.forEach((d) => this.#applyGain(d));
    this.#changed();
  }

  saveSettings() {
    store.set('ainos.settings', this.settings);
  }

  get positionMs() {
    return this.deck.audio.currentTime * 1000 || 0;
  }

  // ---------------------------------------------------------- view model
  get isRemote() {
    return !!(this.remote && this.remote.device_id && this.remote.device_id !== this.deviceId);
  }

  /** What the UI should show, whether playback is local or on another device. */
  view() {
    if (this.isRemote) {
      const r = this.remote;
      const pos = r.is_playing ? r.position_ms + (Date.now() - r.receivedAt) : r.position_ms;
      return {
        remote: true, deviceId: r.device_id, track: r.track || null, isPlaying: r.is_playing, positionMs: Math.min(pos, r.duration_ms || pos),
        durationMs: r.duration_ms, shuffle: r.shuffle, repeat: r.repeat, volume: r.volume, muted: false, contextUri: r.context?.uri, contextTitle: r.context?.title,
      };
    }
    const audio = this.deck.audio;
    return {
      remote: false, track: this.track, isPlaying: this.isPlaying, positionMs: this.positionMs,
      durationMs: (audio.duration && Number.isFinite(audio.duration) ? audio.duration * 1000 : this.track?.duration_ms) || 0,
      bufferedMs: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) * 1000 : 0,
      shuffle: this.shuffle, repeat: this.repeat, volume: this.settings.volume, muted: this.settings.muted,
      contextUri: this.context?.uri, contextTitle: this.context?.title,
    };
  }

  debug() {
    const deckInfo = (d) => ({
      trackId: d.trackId, title: d.track?.title || null,
      readyState: d.audio.readyState, networkState: d.audio.networkState,
      buffered: [...Array(d.audio.buffered.length).keys()].map((i) => [d.audio.buffered.start(i), d.audio.buffered.end(i)]),
      duration: d.audio.duration, currentTime: d.audio.currentTime, gainDb: d.gainDb,
      quality: d.manifest?.file.quality, kbps: d.manifest?.file.bitrate_kbps, bytes: d.manifest?.file.bytes, url: d.manifest?.file.url?.split('?')[0],
    });
    return {
      deviceId: this.deviceId, active: deckInfo(this.deck), spare: deckInfo(this.spare), prefetch: this.prefetch,
      session: this.session, metrics: this.metrics, pendingEvents: this.queue.length, audioGraph: this.ctx ? this.ctx.state : 'not started',
      normalization: this.deck.manifest?.normalization || null, settings: this.settings,
      crossfade: this.xfade ? { ms: this.xfade.ms, from: this.xfade.outgoing.track?.title || null } : null,
    };
  }

  // -------------------------------------------------------------- connect
  snapshot() {
    return {
      track_id: this.track?.id || null, position_ms: Math.round(this.positionMs), duration_ms: Math.round(this.view().durationMs),
      is_playing: this.isPlaying, shuffle: this.shuffle, repeat: this.repeat, volume: this.settings.volume,
      context: this.context ? { uri: this.context.uri, title: this.context.title, track_ids: this.context.tracks.map((t) => t.id) } : null,
      index: this.index, order: this.order, user_queue: this.userQueue.map((t) => t.id),
    };
  }

  reportState(force = false) {
    if (!this.connect || this.isRemote || !this.track) return;
    if (!force && Date.now() - this.lastReport < 1000) return;
    this.lastReport = Date.now();
    this.connect.report(this.snapshot());
  }

  async restoreState(state, { play = true, reason = 'transfer' } = {}) {
    const ids = state.context?.track_ids || (state.track_id ? [state.track_id] : []);
    if (!ids.length) return;
    const tracks = await tracksByIds(ids);
    if (!tracks.length) return;
    this.context = { uri: state.context?.uri || null, title: state.context?.title || '', tracks };
    const n = tracks.length;
    this.order = Array.isArray(state.order) && state.order.length === n ? state.order : [...Array(n).keys()];
    this.index = Math.min(Math.max(0, state.index || 0), n - 1);
    this.userQueue = state.user_queue?.length ? await tracksByIds(state.user_queue) : [];
    this.shuffle = !!state.shuffle;
    this.repeat = state.repeat || 'off';
    const current = state.track_id ? (await tracksByIds([state.track_id]))[0] : this.trackAt(this.index);
    this.resumeState = null;
    await this.startTrack(current || this.trackAt(this.index), { reason, positionMs: state.position_ms || 0, autoplay: play });
  }

  async onRemoteState(state) {
    if (!state) return;
    if (!state.device_id) {
      this.remoteSeq = (this.remoteSeq || 0) + 1; // drop any remote state still resolving
      // nobody is playing anymore; remember where we were so Play resumes here
      if (this.isRemote) this.resumeState = state;
      this.remote = null;
      this.#changed();
      return;
    }
    if (state.device_id === this.deviceId) { this.remoteSeq = (this.remoteSeq || 0) + 1; return; } // we're active: drop pending remote states
    if (this.session) { this.#endSession('remote'); this.pause(); }
    // States can resolve out of order (cached vs fetched track); only the latest may win.
    const seq = (this.remoteSeq = (this.remoteSeq || 0) + 1);
    const [track] = state.track_id ? await tracksByIds([state.track_id]) : [null];
    if (seq !== this.remoteSeq) return;
    this.remote = { ...state, track, receivedAt: Date.now() };
    this.#changed();
  }

  onRemoteCommand(cmd) {
    if (this.isRemote) return;
    switch (cmd.type) {
      case 'pause': this.pause(); break;
      case 'resume': if (this.track) this.toggle(); break;
      case 'next': this.next('fwdbtn'); break;
      case 'previous': this.previous(); break;
      case 'seek': this.seek(cmd.position_ms); break;
      case 'volume': this.setVolume(cmd.volume); break;
      case 'shuffle': if (cmd.shuffle !== this.shuffle) this.toggleShuffle(); break;
      case 'repeat': this.repeat = cmd.repeat; this.#invalidatePrefetch(); this.#changed(); this.reportState(true); break;
      case 'queue': if (cmd.track_id) tracksByIds([cmd.track_id]).then(([t]) => t && this.addToQueue(t)); break;
      case 'play':
        if (cmd.context?.track_ids?.length) {
          tracksByIds(cmd.context.track_ids).then((tracks) => this.playContext({ uri: cmd.context.uri, title: cmd.context.title, tracks }, cmd.index || 0, { reason: 'remote' }));
        }
        break;
    }
  }

  async onTakeOver({ state, play }) {
    this.remoteSeq = (this.remoteSeq || 0) + 1; // a remote state still resolving must not re-mark us as remote
    this.remote = null;
    if (state) await this.restoreState(state, { play, reason: 'transfer' });
    this.#changed();
  }

  onRelease() {
    this.#endSession('remote');
    this.pause();
    this.remote = { ...this.snapshot(), device_id: 'pending', track: this.track, receivedAt: Date.now() };
    this.track = null;
    this.session = null;
    this.isPlaying = false;
    this.#unload(this.deck);
    this.#unload(this.spare);
    this.#changed();
  }

  // --------------------------------------------------------------- events
  #log(type, fields) {
    this.queue.push({ type, ts: Date.now(), device_id: this.deviceId, ...fields });
    if (this.queue.length >= 25) this.flush();
  }

  async flush({ beacon = false } = {}) {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 200);
    const body = JSON.stringify({ events: batch });
    if (beacon && navigator.sendBeacon) {
      // sendBeacon refuses payloads over its quota (~64 KB); keep them for the next flush.
      if (!navigator.sendBeacon('/api/events', new Blob([body], { type: 'text/plain' }))) this.queue.unshift(...batch);
      return;
    }
    try {
      const res = await api.post('/api/events', { events: batch });
      if (res.streams_counted) this.#emit('streams', res);
    } catch {
      this.queue.unshift(...batch.slice(-300)); // keep for retry
    }
  }

  // ------------------------------------------------------------ downloads
  #swMessage(msg) {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return Promise.resolve(null);
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      const done = (data) => { clearTimeout(timer); ch.port1.close(); resolve(data); };
      const timer = setTimeout(() => done(null), 60_000);
      ch.port1.onmessage = (e) => done(e.data);
      sw.postMessage(msg, [ch.port2]);
    });
  }

  async download(tracks) {
    if (!navigator.serviceWorker?.controller) throw new Error('Offline storage needs the service worker (reload the page once)');
    let ok = 0;
    try {
      for (const t of tracks) {
        const m = await this.getManifest(t.id);
        const res = await this.#swMessage({ type: 'download', url: m.file.url });
        if (res?.ok) {
          this.downloads[t.id] = { track: t, manifest: m, bytes: res.bytes, savedAt: Date.now() };
          ok++;
        }
      }
    } finally {
      // persist what did get saved even if a later track failed (e.g. went offline mid-batch)
      store.set('ainos.downloads', this.downloads);
      this.#emit('downloads');
    }
    return ok;
  }

  async removeDownload(trackId) {
    const d = this.downloads[trackId];
    if (!d) return;
    await this.#swMessage({ type: 'remove', url: d.manifest.file.url });
    delete this.downloads[trackId];
    store.set('ainos.downloads', this.downloads);
    this.#emit('downloads');
  }

  async cacheStats() {
    return (await this.#swMessage({ type: 'stats' })) || { offline: { files: 0, bytes: 0 }, lru: { files: 0, bytes: 0, limit: 0 } };
  }

  async clearCache() {
    await this.#swMessage({ type: 'clear-lru' });
  }

  async isCached(manifest) {
    if (!manifest || !('caches' in window)) return null;
    const path = manifest.file.url.split('?')[0];
    for (const name of ['ainos-offline', 'ainos-lru']) {
      try {
        const c = await caches.open(name);
        if (await c.match(path)) return name === 'ainos-offline' ? 'downloaded' : 'cached';
      } catch { /* ignore */ }
    }
    return null;
  }

  // ------------------------------------------------------------ plumbing
  #mediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
    set('play', () => this.toggle());
    set('pause', () => this.toggle());
    set('nexttrack', () => this.next('fwdbtn'));
    set('previoustrack', () => this.previous());
    set('seekto', (d) => this.seek(d.seekTime * 1000));
  }

  #updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.track || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.track.title, artist: this.track.artist.name, album: this.track.album.title,
      artwork: [{ src: this.track.album.cover, sizes: '300x300', type: 'image/svg+xml' }],
    });
  }

  #changed() {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = this.view().isPlaying ? 'playing' : 'paused';
    this.#emit('change');
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
