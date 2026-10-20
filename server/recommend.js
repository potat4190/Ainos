// Recommendation engine, modelled on what Spotify has published:
//  * Collaborative filtering from implicit feedback (streams, likes): matrix
//    factorization with weighted ALS (Hu, Koren & Volinsky 2008), the method
//    Spotify engineers presented for Discover Weekly-style recommendations.
//  * Content-based similarity from audio features, which covers new or
//    rarely-played tracks that CF cannot place (the cold-start problem).
//  * Item-to-item similarity ("radio", "fans also like") from co-listening:
//    cosine between tracks' listener vectors. On this small catalog it tracks
//    taste far better than ALS item factors (measured: 2.76 vs 2.06 same-genre
//    tracks among the top 3 neighbours), so ALS is used for user->item scoring
//    and co-listening for item->item.
//  * Nearest-neighbour lookup (Spotify uses Annoy/Voyager at scale;
//    brute-force cosine is exact and fast enough for this catalog).

import { isoWeek, isoDay, mulberry32, hashSeed, shuffled } from './util.js';

// Defaults sized for a small catalog: few factors + strong regularization, so
// the model generalizes instead of memorizing (K must be well below #items).
// Picked by a sweep over K in {4,6,8,16} x lambda in {0.1,2,10,40}.
const DEFAULTS = { factors: 8, lambda: 10, alpha: 12, iterations: 15 };

function solve(A, b) {
  // Gaussian elimination with partial pivoting; A is k x k (array of Float64Array)
  const n = b.length;
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => Math.sqrt(dot(a, a)) || 1;
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b));

/** One weighted-ALS half step: solve each row's factors given the other side. */
function alsStep(rows, other, k, lambda) {
  // YtY precomputed once: X_u = (YtY + Yt(Cu - I)Y + λI)^-1 Yt Cu p(u)
  const YtY = Array.from({ length: k }, () => new Float64Array(k));
  for (const y of other) for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) YtY[a][b] += y[a] * y[b];
  return rows.map((entries) => {
    const A = YtY.map((r) => Float64Array.from(r));
    const rhs = new Float64Array(k);
    for (const [j, c] of entries) {
      const y = other[j];
      for (let a = 0; a < k; a++) {
        rhs[a] += c * y[a];
        for (let b = 0; b < k; b++) A[a][b] += (c - 1) * y[a] * y[b];
      }
    }
    for (let a = 0; a < k; a++) A[a][a] += lambda;
    return solve(A, rhs);
  });
}

export class Recommender {
  constructor(db, opts = {}) {
    this.db = db;
    this.opts = { ...DEFAULTS, ...opts };
    this.model = null;
    this.trainedAt = 0;
    this.pending = 0;
    this.timer = null;
  }

  /** Re-train after enough new streams, debounced. */
  noteNewStreams(n) {
    this.pending += n;
    if (this.pending >= 5 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pending = 0;
        this.train();
      }, 1500);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  train() {
    const t0 = Date.now();
    const db = this.db;
    const { factors: K, lambda: LAMBDA, alpha: ALPHA, iterations: ITERS } = this.opts;
    const tracks = db.prepare(`SELECT id, artist_id, genre, tempo, key, mode, energy, valence, danceability, acousticness FROM tracks ORDER BY id`).all();
    const itemIndex = new Map(tracks.map((t, i) => [t.id, i]));
    const interactions = db.prepare('SELECT user_id, track_id, COUNT(*) AS n FROM streams GROUP BY user_id, track_id').all();
    const likes = db.prepare('SELECT user_id, track_id FROM liked_tracks').all();

    const userIndex = new Map();
    const weights = new Map(); // "u:i" -> raw weight
    const add = (u, t, w) => {
      if (!itemIndex.has(t)) return;
      if (!userIndex.has(u)) userIndex.set(u, userIndex.size);
      const key = `${userIndex.get(u)}:${itemIndex.get(t)}`;
      weights.set(key, (weights.get(key) || 0) + w);
    };
    for (const r of interactions) add(r.user_id, r.track_id, r.n);
    for (const r of likes) add(r.user_id, r.track_id, 4);

    const U = userIndex.size, I = tracks.length;
    const userRows = Array.from({ length: U }, () => []);
    const itemRows = Array.from({ length: I }, () => []);
    for (const [key, w] of weights) {
      const [u, i] = key.split(':').map(Number);
      const c = 1 + ALPHA * Math.log1p(w);
      userRows[u].push([i, c]);
      itemRows[i].push([u, c]);
    }

    const rnd = mulberry32(42);
    const init = () => Float64Array.from({ length: K }, () => (rnd() - 0.5) * 0.1);
    let X = Array.from({ length: U }, init);
    let Y = Array.from({ length: I }, init);
    const losses = [];
    for (let it = 0; it < ITERS; it++) {
      X = alsStep(userRows, Y, K, LAMBDA);
      Y = alsStep(itemRows, X, K, LAMBDA);
      losses.push(this.#loss(X, Y, userRows));
    }

    // Content vectors: standardized audio features (+ key on the circle of fifths).
    const feats = tracks.map((t) => [
      t.tempo / 180, t.energy, t.valence, t.danceability, t.acousticness, t.mode,
      Math.cos((2 * Math.PI * ((t.key * 7) % 12)) / 12) * 0.3, Math.sin((2 * Math.PI * ((t.key * 7) % 12)) / 12) * 0.3,
    ]);
    const dims = feats[0].length;
    const mean = Array.from({ length: dims }, (_, d) => feats.reduce((s, f) => s + f[d], 0) / feats.length);
    const sd = Array.from({ length: dims }, (_, d) => Math.sqrt(feats.reduce((s, f) => s + (f[d] - mean[d]) ** 2, 0) / feats.length) || 1);
    const content = feats.map((f) => Float64Array.from(f.map((v, d) => (v - mean[d]) / sd[d])));

    const playCounts = new Float64Array(I);
    for (const [key, w] of weights) playCounts[Number(key.split(':')[1])] += w;

    // Co-listening similarity: cosine between items' (log-weighted) listener vectors.
    const norms = itemRows.map((rows) => Math.sqrt(rows.reduce((s, [, c]) => s + Math.log(c) ** 2, 0)) || 1);
    const coSim = Array.from({ length: I }, () => new Float64Array(I));
    for (const rows of userRows) {
      for (const [i, ci] of rows) for (const [j, cj] of rows) if (i !== j) coSim[i][j] += Math.log(ci) * Math.log(cj);
    }
    for (let i = 0; i < I; i++) for (let j = 0; j < I; j++) coSim[i][j] /= norms[i] * norms[j];

    this.model = { tracks, itemIndex, userIndex, X, Y, content, userRows, playCounts, losses, coSim };
    this.trainedAt = Date.now();
    this.stats = { users: U, items: I, interactions: weights.size, factors: K, iterations: ITERS, lambda: LAMBDA, alpha: ALPHA, ms: Date.now() - t0, loss_first: losses[0], loss_last: losses.at(-1) };
    return this.stats;
  }

  #loss(X, Y, userRows) {
    let l = 0;
    for (let u = 0; u < X.length; u++) {
      const seen = new Map(userRows[u]);
      for (let i = 0; i < Y.length; i++) {
        const c = seen.get(i) ?? 1;
        const p = seen.has(i) ? 1 : 0;
        l += c * (p - dot(X[u], Y[i])) ** 2;
      }
    }
    return l;
  }

  ensure() {
    if (!this.model) this.train();
    return this.model;
  }

  /** Item-item similarity: co-listening blended with audio content. */
  similarTracks(trackId, n = 20, { cfWeight = 0.7 } = {}) {
    const m = this.ensure();
    const i = m.itemIndex.get(trackId);
    if (i === undefined) return [];
    const cfConfidence = Math.min(1, m.playCounts[i] / 50); // little data -> lean on content
    const w = cfWeight * cfConfidence;
    return m.tracks
      .map((t, j) => ({ id: t.id, score: j === i ? -Infinity : w * m.coSim[i][j] + (1 - w) * cosine(m.content[i], m.content[j]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  /** Per-user scores for every track (hybrid CF + content profile). */
  scoresForUser(userId) {
    const m = this.ensure();
    const u = m.userIndex.get(userId);
    const heard = new Map();
    for (const r of this.db.prepare('SELECT track_id, COUNT(*) AS n FROM streams WHERE user_id = ? GROUP BY track_id').all(userId)) heard.set(r.track_id, r.n);
    for (const r of this.db.prepare('SELECT track_id FROM liked_tracks WHERE user_id = ?').all(userId)) heard.set(r.track_id, (heard.get(r.track_id) || 0) + 4);

    // Content taste profile = weighted mean of content vectors of what they played.
    const profile = new Float64Array(m.content[0].length);
    let tw = 0;
    for (const [tid, w] of heard) {
      const i = m.itemIndex.get(tid);
      if (i === undefined) continue;
      const lw = Math.log1p(w);
      m.content[i].forEach((v, d) => (profile[d] += v * lw));
      tw += lw;
    }
    const maxPop = Math.max(...m.playCounts) || 1;
    const scores = m.tracks.map((t, i) => {
      const cf = u !== undefined ? dot(m.X[u], m.Y[i]) : 0;
      const cb = tw > 0 ? cosine(profile, m.content[i]) : 0;
      const pop = m.playCounts[i] / maxPop;
      const score = u !== undefined ? 0.7 * cf + 0.22 * cb + 0.08 * pop : 0.5 * cb + 0.5 * pop;
      return { id: t.id, artist_id: t.artist_id, genre: t.genre, score, cf, cb, pop };
    });
    return { scores, heard, coldStart: u === undefined };
  }

  /** Discover Weekly: unheard tracks, ranked, max 2 per artist, frozen per ISO week. */
  discoverWeekly(userId, n = 12) {
    return this.#snapshot(userId, 'discover-weekly', isoWeek(), () => {
      const { scores, heard, coldStart } = this.scoresForUser(userId);
      const perArtist = new Map();
      const out = [];
      for (const s of scores.filter((s) => !heard.has(s.id)).sort((a, b) => b.score - a.score)) {
        const c = perArtist.get(s.artist_id) || 0;
        if (c >= 2) continue;
        perArtist.set(s.artist_id, c + 1);
        out.push(s.id);
        if (out.length >= n) break;
      }
      // New listeners get a popularity-based list that is not frozen, so it
      // personalizes as soon as they have played something.
      return { title: 'Discover Weekly', description: 'Your weekly mixtape of fresh music. Refreshes every Monday.', ids: out, persist: !coldStart };
    });
  }

  /** Daily Mixes: one per top genre, mixing favourites with close recommendations. */
  dailyMixes(userId, maxMixes = 3) {
    const day = isoDay();
    const { scores, heard } = this.scoresForUser(userId);
    if (heard.size === 0) return [];
    const byId = new Map(scores.map((s) => [s.id, s]));
    const genreWeight = new Map();
    for (const [tid, w] of heard) {
      const s = byId.get(tid);
      if (s) genreWeight.set(s.genre, (genreWeight.get(s.genre) || 0) + w);
    }
    const genres = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxMixes).map(([g]) => g);
    return genres.map((genre, gi) =>
      this.#snapshot(userId, `daily-mix-${gi + 1}`, day, () => {
        const rnd = mulberry32(hashSeed(`${userId}/${day}/${genre}`));
        const favourites = [...heard.keys()].filter((id) => byId.get(id)?.genre === genre);
        const recs = scores.filter((s) => !heard.has(s.id)).sort((a, b) => b.score - a.score);
        const sameGenre = recs.filter((s) => s.genre === genre).map((s) => s.id);
        const nearby = recs.filter((s) => s.genre !== genre).slice(0, 3).map((s) => s.id);
        const ids = shuffled([...shuffled(favourites, rnd).slice(0, 8), ...sameGenre.slice(0, 3), ...nearby.slice(0, 2)], rnd);
        return { title: `Daily Mix ${gi + 1}`, description: `${genre} and more, based on what you play.`, ids };
      }),
    );
  }

  /** Radio: seed track first, then its nearest neighbours. */
  radio(trackId, n = 20) {
    return [trackId, ...this.similarTracks(trackId, n - 1).map((s) => s.id)];
  }

  relatedArtists(artistId, n = 6) {
    const m = this.ensure();
    const mine = [], byArtist = new Map(), content = new Map();
    m.tracks.forEach((t, i) => {
      if (t.artist_id === artistId) mine.push(i);
      else byArtist.set(t.artist_id, [...(byArtist.get(t.artist_id) || []), i]);
      const cb = content.get(t.artist_id) || new Float64Array(m.content[0].length);
      m.content[i].forEach((x, d) => (cb[d] += x));
      content.set(t.artist_id, cb);
    });
    if (!mine.length) return [];
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
    return [...byArtist.entries()]
      .map(([id, items]) => ({ id, score: 0.7 * mean(mine.flatMap((i) => items.map((j) => m.coSim[i][j]))) + 0.3 * cosine(content.get(artistId), content.get(id)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  #snapshot(userId, kind, period, build) {
    const row = this.db.prepare('SELECT title, description, track_ids FROM generated_playlists WHERE user_id = ? AND kind = ? AND period = ?').get(userId, kind, period);
    if (row) return { kind, period, title: row.title, description: row.description, ids: JSON.parse(row.track_ids) };
    const { persist = true, ...built } = build();
    if (built.ids.length && persist) {
      this.db.prepare('INSERT OR REPLACE INTO generated_playlists (user_id, kind, period, title, description, track_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, kind, period, built.title, built.description, JSON.stringify(built.ids), Date.now());
    }
    return { kind, period, ...built };
  }
}
