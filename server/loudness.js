// Integrated loudness per ITU-R BS.1770-4 (the standard Spotify cites for its
// loudness normalization). K-weighting = high-shelf pre-filter + RLB high-pass,
// then 400 ms blocks with 75% overlap, an absolute gate at -70 LKFS and a
// relative gate 10 LU below the ungated level. Mono input.

// Filter design after Brecht De Man's derivation of the BS.1770 filters, which
// reproduces the standard's published 48 kHz coefficients at any sample rate.
function kShelf(fs) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
}

function kHighPass(fs) {
  const f0 = 38.13547087602444, Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / fs);
  const d = 1 + K / Q + K * K;
  return { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / d, (1 - K / Q + K * K) / d] };
}

function applyBiquad({ b, a }, x) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const v = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

export function kWeight(samples, fs) {
  return applyBiquad(kHighPass(fs), applyBiquad(kShelf(fs), samples));
}

/** Returns integrated loudness in LUFS (LKFS), or -Infinity for silence. */
export function integratedLoudness(samples, fs) {
  const y = kWeight(samples, fs);
  const n = y.length;
  if (n === 0) return -Infinity;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + y[i] * y[i];

  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  const z = [];
  if (n < block) {
    z.push(prefix[n] / n);
  } else {
    for (let start = 0; start + block <= n; start += step) {
      z.push((prefix[start + block] - prefix[start]) / block);
    }
  }
  const lk = (ms) => -0.691 + 10 * Math.log10(ms);
  const abs = z.filter((ms) => ms > 0 && lk(ms) > -70);
  if (abs.length === 0) return -Infinity;
  const ungated = abs.reduce((s, v) => s + v, 0) / abs.length;
  const relGate = lk(ungated) - 10;
  const rel = abs.filter((ms) => lk(ms) > relGate);
  const mean = rel.reduce((s, v) => s + v, 0) / rel.length;
  return lk(mean);
}

export function samplePeakDb(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

/**
 * Spotify-style normalization gain: move the track to the target (-14 LUFS by
 * default), but never boost so far that the peak would exceed -1 dBFS.
 */
export function normalizationGainDb(loudnessLufs, peakDb, targetLufs = -14) {
  if (!Number.isFinite(loudnessLufs)) return 0;
  const wanted = targetLufs - loudnessLufs;
  const headroom = -1 - peakDb;
  return Math.min(wanted, headroom);
}
