// YouTube's official IFrame Player API (https://www.youtube.com/iframe_api),
// loaded once on first use. The player is the standard www.youtube.com embed,
// always visible (spec 3.4): nothing here hides it, shrinks it or takes its
// audio. When YouTube can't play a video here, the caller offers a link to
// the watch page instead; nothing works around YouTube's own checks.

let apiPromise = null;

/** Resolves with window.YT once the IFrame Player API is ready. */
export function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.addEventListener('error', () => { apiPromise = null; script.remove(); reject(new Error('The YouTube player API could not be loaded')); });
      document.head.append(script);
    });
  }
  return apiPromise;
}

/** The official watch page for a video. */
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** Human-readable reasons for the IFrame API's onError codes (for the console). */
export const ERROR_CODES = {
  2: 'invalid parameter',
  5: 'HTML5 player error',
  100: 'video not found or private',
  101: 'embedding not allowed by the owner',
  150: 'embedding not allowed by the owner',
  153: 'missing referrer / client identity',
};

// YT.PlayerState values, so callers need not wait for the API to know them.
export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/**
 * Mount a player in `host` (an element the API replaces with its iframe).
 * onProblem(reason) is called once: on an onError event, or when the video
 * hasn't reached PLAYING within `timeoutMs`. onState(state) reports every
 * YT.PlayerState change.
 * Returns a controller right away; commands made before onReady are applied then.
 */
export function mountYouTube(host, { videoId, title, timeoutMs = 8000, volume = 1, muted = false, onProblem, onState } = {}) {
  let player = null;
  let ready = false;
  let wanted = 'play';
  let done = false;
  let reported = false;
  let pendingSeek = null;
  let level = { volume, muted };
  const report = (reason) => { if (!reported && !done) { reported = true; onProblem?.(reason); } };
  const timer = setTimeout(() => report(`not playing after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
  const applyLevel = () => {
    player.setVolume(Math.round(Math.max(0, Math.min(1, level.volume)) * 100));
    if (level.muted) player.mute(); else player.unMute();
  };

  loadYouTubeApi().then((YT) => {
    if (done) return;
    player = new YT.Player(host, {
      host: 'https://www.youtube.com',
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: (e) => {
          if (done) return;
          ready = true;
          const frame = e.target.getIframe();
          if (title) frame.title = title;
          frame.classList.add('yt-frame');
          applyLevel();
          if (pendingSeek !== null) { e.target.seekTo(pendingSeek / 1000, true); pendingSeek = null; }
          if (wanted === 'play') e.target.playVideo(); else e.target.pauseVideo();
        },
        onStateChange: (e) => {
          if (done) return;
          if (e.data === STATE.PLAYING) clearTimeout(timer);
          onState?.(e.data);
        },
        onError: (e) => {
          clearTimeout(timer);
          report(`error ${e.data}${ERROR_CODES[e.data] ? ` (${ERROR_CODES[e.data]})` : ''}`);
        },
      },
    });
  }).catch((err) => { clearTimeout(timer); report(err.message); });

  const call = (fn) => { if (ready && !done) { try { fn(player); } catch { /* player gone */ } } };
  return {
    play() { wanted = 'play'; call((p) => p.playVideo()); },
    pause() { wanted = 'pause'; call((p) => p.pauseVideo()); },
    seekTo(ms) { if (ready) call((p) => p.seekTo(Math.max(0, ms) / 1000, true)); else pendingSeek = ms; },
    setLevel(next) { level = { ...level, ...next }; call(applyLevel); },
    currentMs() { let ms = 0; call((p) => { ms = (p.getCurrentTime() || 0) * 1000; }); return ms; },
    durationMs() { let ms = 0; call((p) => { ms = (p.getDuration() || 0) * 1000; }); return ms; },
    get ready() { return ready; },
    destroy() { done = true; clearTimeout(timer); try { player?.destroy(); } catch { /* already gone */ } },
  };
}
