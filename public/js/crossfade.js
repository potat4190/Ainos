// Crossfade timing and curves, kept free of the DOM so node:test can check them.
// The player (player.js) uses these to blend the end of one song into the next
// on its two audio decks, like Spotify's Crossfade setting (0-12 s).

export const CROSSFADE_CHOICES = [0, 2, 4, 6, 8, 10, 12]; // seconds; 0 = off

/**
 * Fade length in ms for a transition, or 0 for none. Never more than a third
 * of either song, so short songs still have a clean middle.
 */
export function crossfadeMs(seconds, currentMs, nextMs) {
  const wanted = Math.max(0, Math.min(12, Number(seconds) || 0)) * 1000;
  if (!wanted || !(currentMs > 0) || !(nextMs > 0)) return 0;
  return Math.floor(Math.min(wanted, currentMs / 3, nextMs / 3));
}

/**
 * Whether to start fading into the next song now: playing, the fade is on,
 * we are inside the last fadeMs of the song (but not at its very end, where a
 * plain hand-off is just as good), and the next song can play without waiting.
 */
export function shouldStartCrossfade({ fadeMs, positionMs, durationMs, isPlaying, nextReady }) {
  if (!isPlaying || !nextReady || !(fadeMs > 0) || !(durationMs > 0)) return false;
  const remaining = durationMs - positionMs;
  return remaining <= fadeMs && remaining > 250;
}

/**
 * Equal-power gains at progress p (0..1): the outgoing song follows cos, the
 * incoming one sin, so their combined power stays constant and the middle of
 * the fade does not dip in loudness the way a straight line does.
 */
export function equalPowerGains(p) {
  const x = Math.max(0, Math.min(1, p)) * (Math.PI / 2);
  return { out: Math.cos(x), in: Math.sin(x) };
}

/** Gain values for AudioParam.setValueCurveAtTime: 'in' rises 0 -> 1, 'out' falls 1 -> 0. */
export function fadeCurve(direction, points = 64) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) curve[i] = equalPowerGains(i / (points - 1))[direction === 'in' ? 'in' : 'out'];
  return curve;
}
