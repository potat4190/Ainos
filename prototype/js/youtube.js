// YouTube's official IFrame Player API (https://www.youtube.com/iframe_api),
// loaded once on first use. The player is the standard www.youtube.com embed,
// so a viewer signed in to YouTube is recognised. Nothing here works around
// YouTube's own checks: when it can't play, the caller offers a link instead.

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
      script.onerror = () => { apiPromise = null; reject(new Error('The YouTube player API could not be loaded')); };
      document.head.append(script);
    });
  }
  return apiPromise;
}

/** The official watch page for a video. */
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** Human-readable reasons for the IFrame API's onError codes. */
export const ERROR_CODES = {
  2: 'invalid parameter',
  5: 'HTML5 player error',
  100: 'video not found or private',
  101: 'embedding not allowed by the owner',
  150: 'embedding not allowed by the owner',
  153: 'missing referrer / client identity',
};

/**
 * Mount a player in `host` (an element that the API replaces with its iframe).
 * onProblem(reason) is called once, on an onError event or when the video
 * hasn't reached PLAYING within `timeoutMs`.
 * Returns { play(), pause(), destroy() } right away; commands wait for onReady.
 */
export function mountYouTube(host, { videoId, title, timeoutMs = 8000, onProblem, onPlaying } = {}) {
  let player = null;
  let ready = false;
  let wanted = 'play';
  let done = false;
  let reported = false;
  const report = (reason) => { if (!reported && !done) { reported = true; onProblem?.(reason); } };
  const timer = setTimeout(() => report('not playing after ' + Math.round(timeoutMs / 1000) + ' s'), timeoutMs);

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
          ready = true;
          const frame = e.target.getIframe();
          frame.title = title || frame.title;
          frame.classList.add('np-frame');
          if (wanted === 'play') e.target.playVideo(); else e.target.pauseVideo();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) { clearTimeout(timer); onPlaying?.(); }
        },
        onError: (e) => {
          clearTimeout(timer);
          report(`error ${e.data}${ERROR_CODES[e.data] ? ` (${ERROR_CODES[e.data]})` : ''}`);
        },
      },
    });
  }).catch((err) => { clearTimeout(timer); report(err.message); });

  return {
    play() { wanted = 'play'; if (ready) player.playVideo(); },
    pause() { wanted = 'pause'; if (ready) player.pauseVideo(); },
    destroy() { done = true; clearTimeout(timer); try { player?.destroy(); } catch { /* already gone */ } },
  };
}
