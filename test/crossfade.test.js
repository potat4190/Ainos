import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROSSFADE_CHOICES, crossfadeMs, shouldStartCrossfade, equalPowerGains, fadeCurve } from '../public/js/crossfade.js';

test('crossfade length follows the setting, off by default, at most 12 s', () => {
  assert.equal(CROSSFADE_CHOICES[0], 0, 'the first choice is off');
  assert.equal(crossfadeMs(0, 180_000, 200_000), 0);
  assert.equal(crossfadeMs(6, 180_000, 200_000), 6000);
  assert.equal(crossfadeMs(30, 180_000, 200_000), 12_000, 'capped at 12 s');
  assert.equal(crossfadeMs('8', 180_000, 200_000), 8000, 'a stored string still works');
  assert.equal(crossfadeMs(-3, 180_000, 200_000), 0);
});

test('short songs keep a clean middle: the fade is at most a third of either song', () => {
  assert.equal(crossfadeMs(12, 15_000, 200_000), 5000);
  assert.equal(crossfadeMs(12, 200_000, 9000), 3000);
  assert.equal(crossfadeMs(12, 0, 200_000), 0, 'unknown length: no fade');
  assert.equal(crossfadeMs(12, 200_000, NaN), 0);
});

test('the fade starts only in the last seconds of a playing song whose successor is ready', () => {
  const base = { fadeMs: 6000, durationMs: 180_000, isPlaying: true, nextReady: true };
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 170_000 }), false, 'too early');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 174_000 }), true, 'exactly at the window');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 177_500 }), true);
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 179_900 }), false, 'at the very end a plain hand-off is used');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 177_500, isPlaying: false }), false, 'paused');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 177_500, nextReady: false }), false, 'next song still loading');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 177_500, fadeMs: 0 }), false, 'crossfade off');
  assert.equal(shouldStartCrossfade({ ...base, positionMs: 0, durationMs: 0 }), false, 'duration not known yet');
});

test('equal-power gains keep loudness steady through the fade', () => {
  assert.deepEqual(equalPowerGains(0), { out: 1, in: 0 });
  const end = equalPowerGains(1);
  assert.ok(Math.abs(end.out) < 1e-12 && end.in === 1);
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const g = equalPowerGains(p);
    assert.ok(Math.abs(g.out ** 2 + g.in ** 2 - 1) < 1e-12, `power at ${p}`);
  }
  // A straight-line fade dips to half power in the middle; this one does not.
  assert.ok(equalPowerGains(0.5).in > 0.7);
  assert.deepEqual(equalPowerGains(-1), equalPowerGains(0), 'progress is clamped');
  assert.deepEqual(equalPowerGains(2), equalPowerGains(1));
});

test('fade curves run from silent to full (in) and full to silent (out), without steps back', () => {
  const up = fadeCurve('in', 32), down = fadeCurve('out', 32);
  assert.equal(up.length, 32);
  assert.equal(up[0], 0);
  assert.equal(up[31], 1);
  assert.equal(down[0], 1);
  assert.ok(down[31] < 1e-6);
  for (let i = 1; i < 32; i++) {
    assert.ok(up[i] >= up[i - 1] && down[i] <= down[i - 1], `monotonic at ${i}`);
    assert.ok(Math.abs(up[i] - down[31 - i]) < 1e-6, 'the two curves mirror each other');
  }
});
