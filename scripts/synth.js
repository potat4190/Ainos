// Procedural music synthesizer. Renders full instrumental tracks (mono PCM)
// from a small spec: style, tempo, key, mode, duration and a seed. Everything
// is deterministic for a given seed, so the catalog is reproducible.

import { mulberry32 } from '../server/util.js';

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};
const PROGRESSIONS = {
  major: [[0, 4, 5, 3], [0, 5, 3, 4], [3, 0, 4, 5], [0, 3, 4, 3], [5, 3, 0, 4]],
  minor: [[0, 5, 2, 6], [0, 3, 6, 5], [0, 6, 5, 6], [0, 3, 4, 0], [5, 6, 0, 0]],
};
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function osc(wave, phase, dt, pw = 0.5) {
  switch (wave) {
    case 'sine': return Math.sin(TAU * phase);
    case 'tri': return 4 * Math.abs(phase - 0.5) - 1;
    case 'saw': return 2 * phase - 1 - polyblep(phase, dt);
    case 'square': {
      let v = phase < pw ? 1 : -1;
      v += polyblep(phase, dt);
      v -= polyblep((phase + 1 - pw) % 1, dt);
      return v;
    }
    case 'organ':
      return 0.6 * Math.sin(TAU * phase) + 0.3 * Math.sin(TAU * 2 * phase) + 0.1 * Math.sin(TAU * 3 * phase);
    default: return 0;
  }
}

class Engine {
  constructor(sr, seconds, seed) {
    this.sr = sr;
    this.n = Math.ceil(seconds * sr);
    this.rnd = mulberry32(seed);
    this.buses = {};
    for (const b of ['pad', 'bass', 'lead', 'drums', 'fx']) this.buses[b] = new Float32Array(this.n);
    this.kicks = [];
  }
  noise() { return this.rnd() * 2 - 1; }

  /** Subtractive-style voice with ADSR, optional unison, vibrato and filter envelope. */
  note(bus, t, dur, freq, amp, o = {}) {
    const { sr } = this;
    const buf = this.buses[bus];
    const wave = o.wave || 'sine';
    const a = o.a ?? 0.005, d = o.d ?? 0.1, s = o.s ?? 0.7, r = o.r ?? 0.1;
    const detune = o.detune || [0];
    const start = Math.round(t * sr);
    const len = Math.round((dur + r) * sr);
    const phases = detune.map(() => this.rnd());
    const ratios = detune.map((c) => Math.pow(2, c / 1200));
    const cutoff = o.cutoff || 0;
    const fEnvAmt = o.filterEnv || 0, fEnvDecay = o.filterDecay || 0.2;
    const vibRate = o.vibRate || 0, vibDepth = o.vibDepth || 0;
    const trem = o.trem || 0, tremRate = o.tremRate || 5;
    const pw = o.pw ?? 0.5;
    const pre = (tau) => (tau < a ? tau / a : tau < a + d ? 1 - ((1 - s) * (tau - a)) / d : s);
    const atRelease = pre(dur);
    let lp = 0, alpha = 1;
    const norm = 1 / Math.sqrt(detune.length);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      if (idx < 0) continue;
      const tau = i / sr;
      const env = tau < dur ? pre(tau) : atRelease * Math.max(0, 1 - (tau - dur) / r);
      if (env <= 0 && tau > dur) break;
      const vib = vibRate ? Math.pow(2, (vibDepth * Math.sin(TAU * vibRate * tau)) / 1200) : 1;
      let v = 0;
      for (let k = 0; k < phases.length; k++) {
        const f = freq * ratios[k] * vib;
        const dt = f / sr;
        v += osc(wave, phases[k], dt, pw);
        phases[k] += dt;
        if (phases[k] >= 1) phases[k] -= 1;
      }
      v *= norm;
      if (cutoff) {
        if ((i & 31) === 0) {
          const fc = Math.min(sr * 0.45, cutoff * (1 + fEnvAmt * Math.exp(-tau / fEnvDecay)));
          alpha = 1 - Math.exp((-TAU * fc) / sr);
        }
        lp += alpha * (v - lp);
        v = lp;
      }
      if (trem) v *= 1 - trem * (0.5 + 0.5 * Math.sin(TAU * tremRate * tau));
      buf[idx] += v * env * amp;
    }
  }

  /** Karplus-Strong plucked string (guitar / harp-like). */
  pluck(bus, t, freq, amp, o = {}) {
    const { sr } = this;
    const buf = this.buses[bus];
    const N = Math.max(2, Math.round(sr / freq));
    const line = new Float32Array(N);
    const bright = o.bright ?? 0.5;
    let prev = 0;
    for (let i = 0; i < N; i++) {
      const x = this.noise();
      prev = prev + bright * (x - prev);
      line[i] = prev;
    }
    const decay = o.decay ?? 0.996;
    const len = Math.round((o.len ?? 2.5) * sr);
    const start = Math.round(t * sr);
    let p = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const next = (p + 1) % N;
      const v = line[p];
      line[p] = decay * 0.5 * (line[p] + line[next]);
      p = next;
      if (idx >= 0) buf[idx] += v * amp;
    }
  }

  kick(t, amp = 1, o = {}) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const len = Math.round((o.len ?? 0.45) * sr);
    const f0 = o.f0 ?? 48, f1 = o.f1 ?? 110;
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const tau = i / sr;
      const f = f0 + f1 * Math.exp(-tau / 0.03);
      ph += f / sr;
      let v = Math.sin(TAU * ph) * Math.exp(-tau / (o.decay ?? 0.16));
      if (i < sr * 0.002) v += this.noise() * 0.4 * (1 - i / (sr * 0.002));
      buf[idx] += v * amp;
    }
    this.kicks.push(t);
  }

  snare(t, amp = 1, o = {}) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const len = Math.round(0.3 * sr);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const tau = i / sr;
      const x = this.noise();
      const hp = x - prev; prev = x;
      const v = hp * 0.55 * Math.exp(-tau / (o.decay ?? 0.07)) + Math.sin(TAU * (o.tone ?? 185) * tau) * 0.5 * Math.exp(-tau / 0.035);
      buf[idx] += v * amp;
    }
  }

  clap(t, amp = 1) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const len = Math.round(0.25 * sr);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const tau = i / sr;
      const burst = tau < 0.03 ? (Math.floor(tau / 0.01) % 2 === 0 ? 1 : 0.4) : Math.exp(-(tau - 0.03) / 0.08);
      const x = this.noise();
      const hp = x - prev; prev = x;
      buf[idx] += hp * burst * 0.6 * amp;
    }
  }

  hat(t, amp = 1, open = false) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const dec = open ? 0.12 : 0.025;
    const len = Math.round(dec * 5 * sr);
    let prev = 0, prev2 = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const x = this.noise();
      const hp = x - 2 * prev + prev2; prev2 = prev; prev = x;
      buf[idx] += hp * 0.25 * Math.exp(-(i / sr) / dec) * amp;
    }
  }

  shaker(t, amp = 1) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const len = Math.round(0.12 * sr);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const tau = i / sr;
      const x = this.noise();
      const hp = x - prev; prev = x;
      const env = Math.min(1, tau / 0.015) * Math.exp(-tau / 0.04);
      buf[idx] += hp * env * 0.3 * amp;
    }
  }

  rim(t, amp = 1) {
    const { sr } = this;
    const buf = this.buses.drums;
    const start = Math.round(t * sr);
    const len = Math.round(0.06 * sr);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx >= this.n) break;
      const tau = i / sr;
      buf[idx] += (Math.sin(TAU * 820 * tau) * 0.6 + this.noise() * 0.3) * Math.exp(-tau / 0.012) * amp;
    }
  }

  crackle(amount = 1) {
    const buf = this.buses.fx;
    let lp = 0;
    for (let i = 0; i < this.n; i++) {
      lp += 0.05 * (this.noise() - lp);
      let v = lp * 0.04;
      if (this.rnd() < 0.0004) v += this.noise() * 0.5;
      buf[i] += v * amount;
    }
  }
}

// ---------- effects ----------
function delayFx(buf, sr, time, feedback, mix, damp = 0.4) {
  const D = Math.max(1, Math.round(time * sr));
  const w = new Float32Array(buf.length);
  let lp = 0;
  for (let i = D; i < buf.length; i++) {
    lp += (1 - damp) * (buf[i - D] + feedback * w[i - D] - lp);
    w[i] = lp;
  }
  for (let i = 0; i < buf.length; i++) buf[i] += mix * w[i];
}

function reverbFx(buf, sr, mix, size = 1, damp = 0.3) {
  const combs = [29.7, 37.1, 41.1, 43.7, 47.9].map((ms) => Math.round((ms * size * sr) / 1000));
  const g = 0.78 + 0.08 * Math.min(1, size / 2);
  const wet = new Float32Array(buf.length);
  for (const D of combs) {
    const line = new Float32Array(D);
    let p = 0, lp = 0;
    for (let i = 0; i < buf.length; i++) {
      const out = line[p];
      lp = out * (1 - damp) + lp * damp;
      line[p] = buf[i] + lp * g;
      p = (p + 1) % D;
      wet[i] += out / combs.length;
    }
  }
  for (const ms of [5.0, 1.7]) {
    const D = Math.round((ms * sr) / 1000);
    const line = new Float32Array(D);
    let p = 0;
    for (let i = 0; i < wet.length; i++) {
      const bufout = line[p];
      const x = wet[i];
      const y = -x * 0.7 + bufout;
      line[p] = x + bufout * 0.7;
      p = (p + 1) % D;
      wet[i] = y;
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] += mix * wet[i];
}

function lowpassFx(buf, sr, fc) {
  const a = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; }
}

function sidechain(buf, sr, kicks, depth, release) {
  if (!kicks.length) return;
  const ks = kicks.slice().sort((x, y) => x - y);
  let k = -1;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    while (k + 1 < ks.length && ks[k + 1] <= t) k++;
    if (k < 0) continue;
    buf[i] *= 1 - depth * Math.exp(-(t - ks[k]) / release);
  }
}

// ---------- composition ----------
function makeContext(spec, sr) {
  const rnd = mulberry32(spec.seed ^ 0x9e3779b9);
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const bars = Math.max(8, Math.round(spec.duration / bar / 4) * 4);
  const scale = SCALES[spec.mode];
  const progs = PROGRESSIONS[spec.mode];
  const prog = progs[Math.floor(rnd() * progs.length)];
  const root = 48 + spec.key; // C3 + key
  const phrases = bars / 4;
  const breakdown = phrases >= 5 ? Math.floor(phrases / 2) : -1;
  const section = (barIdx) => {
    const ph = Math.floor(barIdx / 4);
    if (ph === 0) return { name: 'intro', energy: 0.4 };
    if (ph === phrases - 1) return { name: 'outro', energy: 0.6 };
    if (ph === breakdown) return { name: 'breakdown', energy: 0.45 };
    return { name: 'main', energy: ph > breakdown && breakdown > 0 ? 1 : 0.85, lead: ph !== 1 || phrases <= 4 };
  };
  const degreeNote = (deg, octave = 0) => {
    const o = Math.floor(deg / 7);
    const d = ((deg % 7) + 7) % 7;
    return root + scale[d] + 12 * (o + octave);
  };
  const chord = (deg, octave = 0, size = 3) => {
    const out = [];
    for (let i = 0; i < size; i++) out.push(degreeNote(deg + i * 2, octave));
    return out;
  };
  const chordAt = (barIdx) => prog[barIdx % prog.length];

  // A 2-bar motif reused through the track gives melodies a recognizable hook.
  const motif = (cells, range = 7) => {
    const notes = [];
    let pos = 0, deg = Math.floor(rnd() * 3) * 2;
    while (pos < 8) {
      const len = cells[Math.floor(rnd() * cells.length)];
      if (pos + len > 8) break;
      const rest = rnd() < 0.18;
      deg += Math.round((rnd() - 0.5) * 4);
      deg = Math.max(-2, Math.min(range, deg));
      if (!rest) notes.push({ beat: pos, len, deg, strong: pos % 1 === 0 && pos % 2 === 0 });
      pos += len;
    }
    return notes;
  };
  return { spec, sr, rnd, beat, bar, bars, scale, prog, root, section, degreeNote, chord, chordAt, motif };
}

function playMotif(e, c, bus, mot, barIdx, octave, opts, instrument = 'note') {
  const chordDeg = c.chordAt(barIdx);
  const t0 = barIdx * c.bar - (barIdx % 2) * c.bar;
  for (const n of mot) {
    const t = t0 + n.beat * c.beat;
    if (t < barIdx * c.bar || t >= (barIdx + 1) * c.bar) continue;
    let deg = n.deg;
    if (n.strong) {
      // snap to nearest chord tone on strong beats
      const tones = [chordDeg, chordDeg + 2, chordDeg + 4, chordDeg + 7];
      deg = tones.reduce((best, x) => (Math.abs(x - deg) < Math.abs(best - deg) ? x : best), tones[0]);
    }
    const f = mtof(c.degreeNote(deg, octave));
    if (instrument === 'pluck') e.pluck(bus, t, f, opts.amp, opts);
    else e.note(bus, t, n.len * c.beat * (opts.legato ?? 0.9), f, opts.amp, opts);
  }
}

const STYLES = {
  ambient(e, c) {
    const bell = c.motif([2, 3, 4], 9);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      for (const m of c.chord(deg, 0, 4)) e.note('pad', t, c.bar * 1.05, mtof(m), 0.16, { wave: 'saw', detune: [-9, 0, 8], a: 1.6, d: 0.5, s: 0.9, r: 2.2, cutoff: 900 });
      e.note('bass', t, c.bar, mtof(c.degreeNote(deg, -1)), 0.22, { wave: 'sine', a: 0.8, r: 1.5 });
      if (s.name !== 'intro' && s.name !== 'outro') playMotif(e, c, 'lead', bell, b, 2, { wave: 'sine', amp: 0.12, a: 0.003, d: 1.2, s: 0, r: 1.5 });
    }
    return { gains: { pad: 1, bass: 0.9, lead: 1, drums: 0, fx: 1 }, reverb: { pad: [0.9, 2.2], lead: [1, 2.4] }, delay: { lead: [0.75, 0.5, 0.45] } };
  },

  synthwave(e, c) {
    const lead = c.motif([0.5, 1, 1, 1.5, 2]);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      for (const m of c.chord(deg, 0, 3)) e.note('pad', t, c.bar, mtof(m), 0.12, { wave: 'saw', detune: [-12, 0, 12], a: 0.3, s: 0.8, r: 0.6, cutoff: 1400 });
      if (s.name !== 'intro') {
        for (let k = 0; k < 8; k++) e.note('bass', t + k * c.beat / 2, c.beat * 0.4, mtof(c.degreeNote(deg, -1)), 0.32, { wave: 'saw', cutoff: 380, filterEnv: 3, filterDecay: 0.08, r: 0.04 });
        const arp = c.chord(deg, 1, 3);
        for (let k = 0; k < 16; k++) e.note('fx', t + k * c.beat / 4, c.beat / 4 * 0.6, mtof(arp[k % 3] + (k % 6 >= 3 ? 12 : 0)), 0.05 * s.energy, { wave: 'square', pw: 0.3, cutoff: 2500, r: 0.03 });
      }
      if (s.name === 'main' || s.name === 'outro') {
        for (let k = 0; k < 4; k++) {
          if (k % 2 === 0) e.kick(t + k * c.beat, 0.95);
          else e.snare(t + k * c.beat, 0.55);
          e.hat(t + k * c.beat + c.beat / 2, 0.5);
        }
      }
      if (s.lead) playMotif(e, c, 'lead', lead, b, 1, { wave: 'saw', detune: [-6, 6], amp: 0.13, a: 0.01, s: 0.8, r: 0.15, cutoff: 2200, vibRate: 5, vibDepth: 15 });
    }
    return { gains: { pad: 1, bass: 1, lead: 1, drums: 1, fx: 1 }, reverb: { pad: [0.5, 1.6], drums: [0.25, 1.4], lead: [0.4, 1.6] }, delay: { lead: [0.75, 0.35, 0.3] }, sidechain: { pad: 0.5, bass: 0.4 } };
  },

  lofi(e, c) {
    const keys = c.motif([0.5, 1, 1.5, 2]);
    const swing = c.beat * 0.08;
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      const ch = c.chord(deg, 0, 4);
      ch.forEach((m, i) => e.note('pad', t + i * 0.02, c.beat * 2.6, mtof(m), 0.11, { wave: 'organ', a: 0.01, d: 1.4, s: 0.35, r: 0.5, trem: 0.25, tremRate: 4.5 }));
      ch.forEach((m, i) => e.note('pad', t + c.beat * 2.5 + i * 0.02, c.beat * 1.3, mtof(m), 0.08, { wave: 'organ', a: 0.01, d: 1, s: 0.3, r: 0.4, trem: 0.25, tremRate: 4.5 }));
      if (s.name !== 'intro') {
        e.note('bass', t, c.beat * 1.5, mtof(c.degreeNote(deg, -1)), 0.4, { wave: 'sine', a: 0.01, r: 0.2 });
        e.note('bass', t + c.beat * 2.5, c.beat, mtof(c.degreeNote(deg + 4, -2)), 0.32, { wave: 'sine', a: 0.01, r: 0.2 });
      }
      if (s.name === 'main' || s.name === 'outro') {
        e.kick(t, 0.8, { decay: 0.12 });
        e.kick(t + c.beat * 2.5 + swing, 0.6, { decay: 0.12 });
        e.snare(t + c.beat, 0.4, { decay: 0.05 });
        e.snare(t + c.beat * 3, 0.4, { decay: 0.05 });
        for (let k = 0; k < 8; k++) e.hat(t + k * c.beat / 2 + (k % 2 ? swing : 0), k % 2 ? 0.25 : 0.4);
      }
      if (s.lead) playMotif(e, c, 'lead', keys, b, 1, { wave: 'tri', amp: 0.1, a: 0.01, d: 0.4, s: 0.3, r: 0.3, cutoff: 1800 });
    }
    e.crackle(1);
    return { gains: { pad: 1, bass: 1, lead: 1, drums: 0.9, fx: 1 }, reverb: { pad: [0.3, 1.2], lead: [0.3, 1.3] }, master: { lowpass: 5200 } };
  },

  house(e, c) {
    const stab = c.motif([0.5, 0.5, 1, 1.5]);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      const drums = s.name !== 'breakdown';
      for (let k = 0; k < 4; k++) {
        const bt = t + k * c.beat;
        if (drums) e.kick(bt, 1, { decay: 0.14 });
        if (s.name !== 'intro' && drums) e.hat(bt + c.beat / 2, 0.6, true);
        if (s.name === 'main' && k % 2 === 1) e.clap(bt, 0.6);
        if (s.name !== 'intro' && drums) e.hat(bt + c.beat * 0.75, 0.25);
      }
      if (s.name !== 'intro') {
        for (let k = 0; k < 4; k++) e.note('bass', t + k * c.beat + c.beat / 2, c.beat * 0.4, mtof(c.degreeNote(deg, -1)), 0.38, { wave: 'saw', cutoff: 300, filterEnv: 2.5, filterDecay: 0.06, r: 0.03 });
      }
      const ch = c.chord(deg, 0, 4);
      if (s.name === 'breakdown') ch.forEach((m) => e.note('pad', t, c.bar, mtof(m), 0.12, { wave: 'saw', detune: [-10, 10], a: 0.6, r: 1, cutoff: 1200 }));
      else for (const k of [0.5, 1.5, 2.5, 3.25]) ch.forEach((m) => e.note('pad', t + k * c.beat, c.beat * 0.25, mtof(m), 0.09, { wave: 'saw', cutoff: 1100 + 1200 * s.energy, filterEnv: 1.5, filterDecay: 0.05, r: 0.05 }));
      if (s.lead && s.name === 'main') playMotif(e, c, 'lead', stab, b, 1, { wave: 'organ', amp: 0.12, a: 0.005, d: 0.2, s: 0.4, r: 0.1 });
    }
    return { gains: { pad: 1, bass: 1, lead: 1, drums: 1, fx: 1 }, reverb: { pad: [0.35, 1.3], lead: [0.3, 1.2] }, delay: { pad: [0.75, 0.3, 0.2] }, sidechain: { pad: 0.6, bass: 0.5, lead: 0.4 } };
  },

  acoustic(e, c) {
    const melody = c.motif([1, 1, 2, 0.5]);
    const pattern = [0, 2, 1, 2, 0, 2, 1, 2];
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      const ch = c.chord(deg, 0, 3);
      const low = c.degreeNote(deg, -1);
      e.pluck('bass', t, mtof(low), 0.5, { bright: 0.35, decay: 0.997, len: 2.5 });
      e.pluck('bass', t + c.beat * 2, mtof(low + 7), 0.35, { bright: 0.35, decay: 0.997, len: 2 });
      pattern.forEach((p, k) => e.pluck('pad', t + k * c.beat / 2, mtof(ch[p] + 12), 0.24, { bright: 0.55, decay: 0.995, len: 1.8 }));
      if (s.name === 'main') for (let k = 0; k < 8; k++) e.shaker(t + k * c.beat / 2, k % 2 ? 0.5 : 0.8);
      if (s.lead) playMotif(e, c, 'lead', melody, b, 1, { wave: 'sine', amp: 0.13, a: 0.06, s: 0.8, r: 0.25, vibRate: 5.5, vibDepth: 18 });
    }
    return { gains: { pad: 1, bass: 1, lead: 0.9, drums: 0.8, fx: 1 }, reverb: { pad: [0.35, 1.5], lead: [0.45, 1.7] } };
  },

  chiptune(e, c) {
    const lead = c.motif([0.5, 0.5, 1, 0.25, 0.75]);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      const ch = c.chord(deg, 1, 3);
      // classic fast chip arpeggio (32nd notes cycling through the chord)
      for (let k = 0; k < 32; k++) e.note('pad', t + k * c.beat / 8, c.beat / 8, mtof(ch[k % 3]), 0.06, { wave: 'square', pw: 0.25, a: 0.001, r: 0.005 });
      for (let k = 0; k < 8; k++) e.note('bass', t + k * c.beat / 2, c.beat * 0.45, mtof(c.degreeNote(deg, -1) + (k % 2 ? 12 : 0)), 0.3, { wave: 'tri', a: 0.001, r: 0.01 });
      if (s.name !== 'intro' && s.name !== 'breakdown') {
        for (let k = 0; k < 4; k++) {
          if (k % 2 === 0) e.kick(t + k * c.beat, 0.8, { len: 0.2, decay: 0.06 });
          else e.snare(t + k * c.beat, 0.55, { decay: 0.04, tone: 240 });
          e.hat(t + k * c.beat + c.beat / 2, 0.5);
        }
      }
      if (s.lead || s.name === 'breakdown') playMotif(e, c, 'lead', lead, b, 1, { wave: 'square', pw: 0.5, amp: 0.1, a: 0.002, s: 0.9, r: 0.02, vibRate: 6, vibDepth: s.name === 'breakdown' ? 30 : 8 });
    }
    return { gains: { pad: 1, bass: 1, lead: 1, drums: 1, fx: 1 }, delay: { lead: [0.375, 0.25, 0.2] } };
  },

  dub(e, c) {
    const lead = c.motif([1, 1.5, 2, 3]);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      if (s.name !== 'intro') {
        e.note('bass', t, c.beat * 1.4, mtof(c.degreeNote(deg, -1)), 0.5, { wave: 'sine', a: 0.01, r: 0.15 });
        e.note('bass', t + c.beat * 1.5, c.beat * 0.4, mtof(c.degreeNote(deg + 2, -1)), 0.38, { wave: 'sine', a: 0.01, r: 0.1 });
        e.note('bass', t + c.beat * 2.5, c.beat, mtof(c.degreeNote(deg + 4, -2)), 0.45, { wave: 'sine', a: 0.01, r: 0.15 });
      }
      // offbeat "skank" chords drenched in delay
      for (const k of [1, 3]) c.chord(deg, 0, 3).forEach((m) => e.note('fx', t + k * c.beat, c.beat * 0.18, mtof(m + 12), 0.07, { wave: 'saw', cutoff: 1600, r: 0.03 }));
      if (s.name !== 'intro') {
        e.kick(t, 0.85, { decay: 0.2 });
        e.kick(t + c.beat * 2, 0.75, { decay: 0.2 });
        e.rim(t + c.beat * 3, 0.6);
        for (let k = 0; k < 8; k++) e.hat(t + k * c.beat / 2, k % 2 ? 0.35 : 0.15);
      }
      for (const m of c.chord(deg, 0, 3)) e.note('pad', t, c.bar, mtof(m), 0.05, { wave: 'saw', detune: [-8, 8], a: 1, r: 1.2, cutoff: 700 });
      if (s.lead) playMotif(e, c, 'lead', lead, b, 1, { wave: 'sine', amp: 0.1, a: 0.02, s: 0.6, r: 0.4, vibRate: 4, vibDepth: 12 });
    }
    return { gains: { pad: 1, bass: 1, lead: 1, drums: 0.9, fx: 1 }, delay: { fx: [0.75, 0.55, 0.6], lead: [1.5, 0.4, 0.4] }, reverb: { drums: [0.3, 1.8], fx: [0.3, 2] } };
  },

  dnb(e, c) {
    const lead = c.motif([1, 2, 2, 3]);
    for (let b = 0; b < c.bars; b++) {
      const t = b * c.bar, s = c.section(b), deg = c.chordAt(b);
      for (const m of c.chord(deg, 0, 3)) e.note('pad', t, c.bar, mtof(m), 0.08, { wave: 'saw', detune: [-10, 0, 10], a: 0.8, r: 1.2, cutoff: 1500 });
      if (s.name !== 'intro' && s.name !== 'breakdown') {
        // two-step break: kick 1 & 2.75 (in beats), snare on 2 & 4
        e.kick(t, 1, { decay: 0.12 });
        e.kick(t + c.beat * 2.5, 0.85, { decay: 0.12 });
        e.snare(t + c.beat, 0.7, { decay: 0.08, tone: 200 });
        e.snare(t + c.beat * 3, 0.7, { decay: 0.08, tone: 200 });
        for (let k = 0; k < 16; k++) e.hat(t + k * c.beat / 4, k % 4 === 2 ? 0.45 : 0.25);
        e.note('bass', t, c.bar * 0.95, mtof(c.degreeNote(deg, -2)), 0.4, { wave: 'saw', detune: [-14, 14], cutoff: 260, filterEnv: 1.5, filterDecay: 0.3, a: 0.01, r: 0.1 });
      }
      if (s.lead) playMotif(e, c, 'lead', lead, b, 1, { wave: 'saw', detune: [-5, 5], amp: 0.1, a: 0.02, s: 0.8, r: 0.3, cutoff: 2600 });
    }
    return { gains: { pad: 1, bass: 1, lead: 0.9, drums: 1, fx: 1 }, reverb: { pad: [0.5, 2], lead: [0.4, 1.8] }, delay: { lead: [0.75, 0.35, 0.3] }, sidechain: { pad: 0.35 } };
  },
};

export const STYLE_NAMES = Object.keys(STYLES);

/**
 * Render a track. Returns { samples: Float32Array (mono, -1..1), sr, durationMs }.
 * spec: { style, bpm, key, mode, duration, seed, masterLufs }
 */
export function renderTrack(spec, sr = 22050) {
  const c = makeContext(spec, sr);
  const seconds = c.bars * c.bar + 3;
  const e = new Engine(sr, seconds, spec.seed);
  const style = STYLES[spec.style];
  if (!style) throw new Error(`Unknown style ${spec.style}`);
  const mix = style(e, c);

  for (const [bus, [m, size]] of Object.entries(mix.reverb || {})) reverbFx(e.buses[bus], sr, m, size);
  for (const [bus, [beats, fb, m]] of Object.entries(mix.delay || {})) delayFx(e.buses[bus], sr, beats * c.beat, fb, m);
  for (const [bus, depth] of Object.entries(mix.sidechain || {})) sidechain(e.buses[bus], sr, e.kicks, depth, c.beat * 0.35);

  const out = new Float32Array(e.n);
  for (const [bus, buf] of Object.entries(e.buses)) {
    const g = mix.gains[bus] ?? 1;
    for (let i = 0; i < e.n; i++) out[i] += buf[i] * g;
  }
  if (mix.master?.lowpass) lowpassFx(out, sr, mix.master.lowpass);

  // DC blocker
  let x1 = 0, y1 = 0;
  for (let i = 0; i < out.length; i++) {
    const y = out[i] - x1 + 0.995 * y1;
    x1 = out[i]; y1 = y; out[i] = y;
  }
  // fades
  const fin = Math.round(0.05 * sr);
  for (let i = 0; i < fin; i++) out[i] *= i / fin;
  const fadeLen = Math.round(4 * sr);
  for (let i = 0; i < fadeLen; i++) out[out.length - 1 - i] *= Math.pow(i / fadeLen, 1.5);

  return { samples: out, sr, durationMs: Math.round((out.length / sr) * 1000) };
}

/** Gain to a mastering loudness, then soft-limit peaks like a mastering limiter. */
export function master(samples, gainLin, ceiling = 0.97) {
  const knee = ceiling * 0.85;
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] * gainLin;
    const a = Math.abs(v);
    if (a > knee) v = Math.sign(v) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
    samples[i] = v;
  }
  return samples;
}

/** 2:1 decimation with a windowed-sinc low-pass (for the "low" quality tier). */
export function downsample2(samples) {
  const taps = 31, mid = (taps - 1) / 2, fc = 0.22;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(TAU * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((TAU * i) / (taps - 1)) + 0.08 * Math.cos((2 * TAU * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float32Array(Math.floor(samples.length / 2));
  for (let j = 0; j < out.length; j++) {
    let acc = 0;
    const c = j * 2;
    for (let k = 0; k < taps; k++) {
      const idx = c + k - mid;
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * h[k];
    }
    out[j] = acc;
  }
  return out;
}

export function encodeWav16(samples, sr) {
  const header = 44;
  const buf = Buffer.alloc(header + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), header + i * 2);
  }
  return buf;
}

// ---------- hymns: a written melody, played as written ----------

/**
 * When each entry of a melody sounds. melody: [[midi | null, beats], ...] for
 * one pass of the tune (a quarter note is one beat, null is a rest), played
 * `passes` times in a row (one pass per verse). Pure, so lyric timings can be
 * derived from it without rendering audio.
 * Returns { events: [{ pass, index, t, dur, midi, downbeat }], seconds }.
 */
export function melodyTimeline(melody, { bpm, passes = 1, beatsPerBar = 4, pickupBeats = 0, leadIn = 0.5 }) {
  if (!melody.length || !(bpm > 0) || passes < 1) throw new Error('melodyTimeline: melody, bpm and passes required');
  const beat = 60 / bpm;
  const passBeats = melody.reduce((s, [, b]) => s + b, 0);
  const events = [];
  for (let pass = 0; pass < passes; pass++) {
    let pos = 0; // beats from the start of this pass
    for (const [index, [midi, beats]] of melody.entries()) {
      if (!(beats > 0)) throw new Error(`melodyTimeline: note ${index} has no length`);
      const bar = (pos - pickupBeats) / beatsPerBar;
      events.push({ pass, index, t: leadIn + (pass * passBeats + pos) * beat, dur: beats * beat, midi, downbeat: Math.abs(bar - Math.round(bar)) < 1e-9 });
      pos += beats;
    }
  }
  return { events, seconds: leadIn + passes * passBeats * beat };
}

/**
 * Render a melody alone, unharmonized: one organ-like voice, doubled softly an
 * octave below (like an organ's 16' stop), with a gentle room reverb. Bar
 * downbeats are slightly stronger. maxSeconds cuts it short (test catalogs).
 * spec: { melody, bpm, passes, beatsPerBar, pickupBeats, seed, maxSeconds }
 */
export function renderMelody(spec, sr = 22050) {
  const { events, seconds } = melodyTimeline(spec.melody, spec);
  const tail = 3;
  const total = Math.min(seconds + tail, spec.maxSeconds ?? Infinity);
  const e = new Engine(sr, total, spec.seed ?? 1);
  for (const ev of events) {
    if (ev.midi == null || ev.t >= total) continue;
    const amp = ev.downbeat ? 0.32 : 0.27;
    // Slightly detached, so repeated notes are heard as separate syllables.
    const dur = Math.max(0.08, ev.dur - Math.min(0.08, ev.dur * 0.12));
    const voice = { wave: 'organ', a: 0.035, d: 0.12, s: 0.88, r: 0.22, vibRate: 5, vibDepth: 6, cutoff: 3200 };
    e.note('lead', ev.t, dur, mtof(ev.midi), amp, voice);
    e.note('pad', ev.t, dur, mtof(ev.midi - 12), amp * 0.35, { ...voice, vibDepth: 0, cutoff: 1400 });
  }
  reverbFx(e.buses.lead, sr, 0.35, 2.0);
  reverbFx(e.buses.pad, sr, 0.3, 2.0);
  const out = new Float32Array(e.n);
  for (const b of ['lead', 'pad']) for (let i = 0; i < e.n; i++) out[i] += e.buses[b][i];
  const fin = Math.round(0.02 * sr);
  for (let i = 0; i < Math.min(fin, out.length); i++) out[i] *= i / fin;
  const fadeLen = Math.min(out.length, Math.round(1.5 * sr));
  for (let i = 0; i < fadeLen; i++) out[out.length - 1 - i] *= Math.pow(i / fadeLen, 1.5);
  return { samples: out, sr, durationMs: Math.round((out.length / sr) * 1000), events };
}
