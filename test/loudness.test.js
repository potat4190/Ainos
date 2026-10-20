import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integratedLoudness, samplePeakDb, normalizationGainDb } from '../server/loudness.js';
import { renderTrack, encodeWav16, downsample2 } from '../scripts/synth.js';

const sine = (fs, seconds, amp = 1, f = 997) => {
  const x = new Float32Array(fs * seconds);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / fs);
  return x;
};

test('BS.1770 reference: a 0 dBFS 997 Hz sine reads -3.01 LUFS', () => {
  assert.ok(Math.abs(integratedLoudness(sine(48000, 5), 48000) - -3.01) < 0.02);
});

test('loudness scales with level (-20 dB sine reads -23.01 LUFS)', () => {
  assert.ok(Math.abs(integratedLoudness(sine(48000, 5, 0.1), 48000) - -23.01) < 0.02);
});

test('loudness is consistent at the catalog sample rate', () => {
  assert.ok(Math.abs(integratedLoudness(sine(22050, 5), 22050) - -3.01) < 0.1);
});

test('silence is -Infinity and gating ignores it', () => {
  assert.equal(integratedLoudness(new Float32Array(48000 * 2), 48000), -Infinity);
  const half = new Float32Array(48000 * 6);
  half.set(sine(48000, 3), 0);
  // Silent blocks fall below the absolute gate. Only the few blocks straddling
  // the tone/silence edge pull the result slightly below the tone's -3.01.
  const l = integratedLoudness(half, 48000);
  assert.ok(l < -3.01 && l > -3.4, String(l));
  // ...whereas averaging without gating would read about 3 dB lower
  assert.ok(l > -3.01 - 3);
});

test('normalization gain: loud masters turn down, quiet masters limited by peak headroom', () => {
  assert.equal(normalizationGainDb(-8, -0.1), -6);          // -8 -> -14
  assert.equal(normalizationGainDb(-20, -10), 6);           // full +6 fits under -1 dBFS
  assert.equal(normalizationGainDb(-20, -3), 2);            // capped: peak may only reach -1 dBFS
  assert.equal(normalizationGainDb(-20, -10, -11), 9);      // "Loud" target
  assert.equal(normalizationGainDb(-Infinity, -Infinity), 0);
});

test('sample peak', () => {
  assert.ok(Math.abs(samplePeakDb(sine(48000, 1, 0.5)) - -6.02) < 0.01);
});

test('synth renders deterministic, finite audio for every style', () => {
  for (const style of ['ambient', 'synthwave', 'lofi', 'house', 'acoustic', 'chiptune', 'dub', 'dnb']) {
    const a = renderTrack({ style, bpm: 100, key: 0, mode: 'minor', duration: 4, seed: 7 }, 8000);
    const b = renderTrack({ style, bpm: 100, key: 0, mode: 'minor', duration: 4, seed: 7 }, 8000);
    assert.ok(a.samples.every(Number.isFinite), style);
    assert.deepEqual(a.samples.slice(0, 500), b.samples.slice(0, 500), `${style} is deterministic`);
    assert.ok(a.samples.some((v) => Math.abs(v) > 0.001), `${style} is not silent`);
  }
});

test('WAV encoder writes a valid 16-bit mono header', () => {
  const buf = encodeWav16(new Float32Array([0, 0.5, -0.5, 1]), 22050);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt16LE(22), 1);
  assert.equal(buf.readUInt32LE(24), 22050);
  assert.equal(buf.readUInt32LE(40), 8);
  assert.equal(buf.readInt16LE(44 + 6), 32767);
  assert.equal(downsample2(new Float32Array(100)).length, 50);
});
