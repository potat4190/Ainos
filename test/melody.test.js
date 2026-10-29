// The hymn renderer plays a written melody exactly: the right pitches, at the
// right times, in 3/4 or 4/4, with pickups and repeated verses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { melodyTimeline, renderMelody } from '../scripts/synth.js';

const SR = 22050;
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);

/** Energy of one frequency in a stretch of samples (Goertzel). */
function energyAt(samples, sr, from, to, freq) {
  const k = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0, s2 = 0;
  for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) {
    const s0 = samples[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

test('timeline: notes start where the written beats put them, with a pickup in 3/4', () => {
  // Pickup quarter, then half + quarter bars (like "A-ma-zing grace").
  const melody = [[62, 1], [67, 2], [71, 1], [67, 2], [null, 1], [71, 1]];
  const { events, seconds } = melodyTimeline(melody, { bpm: 60, beatsPerBar: 3, pickupBeats: 1, leadIn: 0.5 });
  assert.deepEqual(events.map((e) => e.index), [0, 1, 2, 3, 4, 5]);
  [0.5, 1.5, 3.5, 4.5, 6.5, 7.5].forEach((t, i) => close(events[i].t, t, `onset ${i}`));
  [1, 2, 1, 2, 1, 1].forEach((d, i) => close(events[i].dur, d, `length ${i}`));
  // Beats 0 (pickup), 1, 3, 4, 6 (rest), 7: bars start on beats 1, 4 and 7.
  assert.deepEqual(events.map((e) => e.downbeat), [false, true, false, true, false, true], 'downbeats fall after the pickup, every 3 beats');
  assert.equal(events[4].midi, null, 'rests keep their place in the timeline');
  close(seconds, 8.5, 'length');
});

test('timeline: each verse follows the last; tempo scales everything', () => {
  const melody = [[60, 1], [62, 1], [64, 2]];
  const { events, seconds } = melodyTimeline(melody, { bpm: 120, passes: 3, leadIn: 0 });
  assert.equal(events.length, 9);
  assert.deepEqual(events.map((e) => e.pass), [0, 0, 0, 1, 1, 1, 2, 2, 2]);
  [0, 0.5, 1, 2, 2.5, 3, 4, 4.5, 5].forEach((t, i) => close(events[i].t, t, `onset ${i}`));
  close(seconds, 6, 'three passes of 4 beats at 120 bpm');
  assert.deepEqual(events.filter((e) => e.downbeat).map((e) => e.t), [0, 2, 4], '4/4 with no pickup: every first note of a bar');
});

test('timeline: refuses empty melodies, notes without length and a missing tempo', () => {
  assert.throws(() => melodyTimeline([], { bpm: 80 }));
  assert.throws(() => melodyTimeline([[60, 0]], { bpm: 80 }), /no length/);
  assert.throws(() => melodyTimeline([[60, 1]], {}));
  assert.throws(() => melodyTimeline([[60, 1]], { bpm: 80, passes: 0 }));
});

test('render: plays the written pitches in order', () => {
  // G4 then B4 then D5, a second each.
  const { samples } = renderMelody({ melody: [[67, 1], [71, 1], [74, 1]], bpm: 60, leadIn: 0.5, seed: 7 }, SR);
  const notes = [[67, 0.6, 1.3], [71, 1.6, 2.3], [74, 2.6, 3.3]];
  for (const [midi, from, to] of notes) {
    const own = energyAt(samples, SR, from, to, hz(midi));
    for (const [other] of notes.filter(([m]) => m !== midi)) {
      assert.ok(own > 20 * energyAt(samples, SR, from, to, hz(other)), `while ${midi} sounds, ${other} is far quieter`);
    }
    assert.ok(own > 20 * energyAt(samples, SR, from, to, hz(midi + 1)), `${midi} is in tune (a semitone up is far quieter)`);
  }
  assert.ok(energyAt(samples, SR, 0.6, 1.3, hz(55)) > 0, 'the octave-below doubling is there');
});

test('render: deterministic, finite, the right length, and cut short when asked', () => {
  const spec = { melody: [[62, 1], [67, 2], [71, 1]], bpm: 90, passes: 2, beatsPerBar: 3, pickupBeats: 1, seed: 3 };
  const a = renderMelody(spec, SR), b = renderMelody(spec, SR);
  assert.deepEqual(a.samples, b.samples);
  assert.ok(a.samples.every(Number.isFinite));
  const expected = 0.5 + (2 * 4 * 60) / 90 + 3; // lead-in, two passes, reverb tail
  assert.equal(a.samples.length, Math.ceil(expected * SR));
  assert.ok(a.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.05, 'audible');
  assert.equal(renderMelody({ ...spec, maxSeconds: 2 }, SR).samples.length, 2 * SR);
});
