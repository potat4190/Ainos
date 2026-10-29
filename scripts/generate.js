// Builds the Ainos catalog: synthesizes every track, encodes two quality
// tiers, measures loudness (BS.1770), derives audio features, draws artwork,
// and seeds the database with editorial playlists, a demo account and
// simulated listeners (so collaborative filtering has data to learn from).
//
//   node scripts/generate.js            full catalog (~33 tracks, ~1 min each)
//   node scripts/generate.js --quick    short tracks, for tests

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from '../server/db.js';
import { hashPasswordSync as hashPassword } from '../server/auth.js';
import { integratedLoudness, samplePeakDb } from '../server/loudness.js';
import { mulberry32, seededId, hashSeed, clamp, searchText } from '../server/util.js';
import { renderTrack, master, downsample2, encodeWav16 } from './synth.js';
import { albumCover, artistImage, hexFromHsl } from './art.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CATALOG = [
  { name: 'Lumen Drift', genre: 'Ambient', style: 'ambient', language: 'en', bpm: [60, 72], modes: ['major', 'minor'], hue: 200,
    bio: 'Contemplative Christian ambient worship built from long prayer pads and glassy sanctuary bells. Made for Scripture meditation, quiet devotion and rest in God’s presence.',
    albums: [{ title: 'Slow Light', year: 2024, tracks: ['First Glow', 'Glass Horizon', 'Tidal Memory', 'Afterlight'] }] },
  { name: 'Neon Harbor', genre: 'Synthwave', style: 'synthwave', language: 'en', bpm: [96, 110], modes: ['minor'], hue: 300,
    bio: 'Faith-inspired synth praise duo. Warm analog pads, gated drums and uplifting arpeggios celebrating light overcoming darkness.',
    albums: [
      { title: 'Night Transit', year: 2023, tracks: ['Midnight Arcade', 'Chrome Avenue', 'Lost Signal', 'Sunset Protocol'] },
      { title: 'Overdrive', year: 2026, type: 'single', tracks: ['Overdrive'] },
    ] },
  { name: 'Copper Fox', genre: 'Lo-fi', style: 'lofi', language: 'hi', bpm: [74, 88], modes: ['major', 'minor'], hue: 28,
    bio: 'Hindi Christian devotional lo-fi (मसीही आराधना). Warm keys, gentle rhythms and peaceful melodies for Bible study, prayer and fellowship.',
    albums: [
      { title: 'Rainy Window Tapes', year: 2025, tracks: ['Steam & Paper', 'Corner Café', 'Sunday Static', 'Late Bus Home'] },
      { title: 'Paper Moon', year: 2026, type: 'single', tracks: ['Paper Moon'] },
    ] },
  { name: 'Velvet Static', genre: 'House', style: 'house', language: 'zh', bpm: [120, 124], modes: ['minor', 'major'], hue: 330,
    bio: 'Chinese Christian contemporary praise (华语赞美敬拜) with joyful four-on-the-floor rhythms and radiant chord progressions for youth worship.',
    albums: [
      { title: 'Floor Theory', year: 2024, tracks: ['Pulse Garden', 'Mirrorball Heart', 'Deep Current', 'Open Air'] },
      { title: 'Sunrise Set', year: 2026, type: 'single', tracks: ['Sunrise Set'] },
    ] },
  { name: 'Juniper Lane', genre: 'Acoustic', style: 'acoustic', language: 'en', bpm: [84, 100], modes: ['major'], hue: 95,
    bio: 'Intimate acoustic hymns and finger-picked Christian folk melodies crafted for morning devotionals and small-group worship.',
    albums: [{ title: 'Wooden Rooms', year: 2022, tracks: ['Porch Song', 'Willow & Wire', 'Little Lantern', 'Field Notes'] }] },
  { name: 'Kite Theory', genre: 'Chiptune', style: 'chiptune', language: 'ja', bpm: [132, 150], modes: ['major', 'minor'], hue: 170,
    bio: 'Japanese Christian praise melodies (日本語ゴスペル・賛美) arranged with bright retro synth voices and joyful harmonic progressions.',
    albums: [{ title: 'Pixel Weather', year: 2025, tracks: ['Cloud Runner', 'Save Point', 'Boss Rush', 'Credits Roll'] }] },
  { name: 'Ossa', genre: 'Dub', style: 'dub', language: 'ne', bpm: [70, 80], modes: ['minor'], hue: 150,
    bio: 'Nepali Christian worship and meditative Psalms (नेपाली ख्रीष्टियन भजन) with deep warm bass and spacious sanctuary echoes.',
    albums: [{ title: 'Low Tide', year: 2023, tracks: ['Salt Lines', 'Undertow', 'Harbor Lights'] }] },
  { name: 'Polar Bloom', genre: 'Drum & Bass', style: 'dnb', language: 'es', bpm: [170, 176], modes: ['minor'], hue: 215,
    bio: 'Spanish Christian youth praise (Alabanza y Adoración) blending energetic rhythms with soaring atmospheric worship pads.',
    albums: [{ title: 'Ice Engine', year: 2026, tracks: ['Frostbite', 'Aurora Rush', 'Glacier Run'] }] },
];

// How close styles are to each other (used to simulate realistic listeners).
const ADJACENT = {
  ambient: ['lofi', 'acoustic', 'dub'],
  synthwave: ['chiptune', 'house', 'dnb'],
  lofi: ['ambient', 'dub', 'acoustic'],
  house: ['synthwave', 'dnb'],
  acoustic: ['lofi', 'ambient'],
  chiptune: ['synthwave'],
  dub: ['lofi', 'ambient'],
  dnb: ['house', 'synthwave'],
};

const STYLE_FEATURES = {
  ambient: { energy: 0.15, dance: 0.2, acoustic: 0.55, valence: 0.4 },
  synthwave: { energy: 0.7, dance: 0.65, acoustic: 0.05, valence: 0.5 },
  lofi: { energy: 0.35, dance: 0.62, acoustic: 0.4, valence: 0.5 },
  house: { energy: 0.85, dance: 0.9, acoustic: 0.03, valence: 0.68 },
  acoustic: { energy: 0.35, dance: 0.45, acoustic: 0.92, valence: 0.68 },
  chiptune: { energy: 0.82, dance: 0.6, acoustic: 0.01, valence: 0.78 },
  dub: { energy: 0.45, dance: 0.66, acoustic: 0.15, valence: 0.35 },
  dnb: { energy: 0.95, dance: 0.55, acoustic: 0.02, valence: 0.42 },
};

const log = (...a) => console.log(...a);

/**
 * Everything a track's audio and features are drawn from, in the order the
 * generator has always drawn it from the track's own seed. Pure, so the
 * catalog snapshot test can check full-length values without rendering audio.
 * `seedKey` is "<artist>/<title>" as written in CATALOG.
 */
export function trackParams(artist, title, { quick = false } = {}) {
  const seed = hashSeed(`${artist.name}/${title}`);
  const tr = mulberry32(seed);
  const bpm = Math.round(artist.bpm[0] + tr() * (artist.bpm[1] - artist.bpm[0]));
  const mode = artist.modes[Math.floor(tr() * artist.modes.length)];
  const key = Math.floor(tr() * 12);
  const duration = quick ? 6 : 55 + tr() * 20;
  // Masters land at deliberately different loudness levels (like real
  // releases), so loudness normalization in the player is audible.
  const target = -8.5 - tr() * 10; // -8.5 .. -18.5 LUFS
  const jitter = [0, 1, 2, 3].map(() => (tr() - 0.5) * 0.16); // energy, valence, danceability, acousticness
  return { seedKey: `${artist.name}/${title}`, seed, bpm, mode, key, duration, target, jitter };
}

export const SAMPLE_RATE = 22050;

/** Render a track from its trackParams() and master it to its loudness target. */
export function renderMastered(artist, { seed, bpm, mode, key, duration, target }, sr = SAMPLE_RATE) {
  const { samples } = renderTrack({ style: artist.style, bpm, key, mode, duration, seed }, sr);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < samples.length; i++) samples[i] /= peak || 1;
  const raw = integratedLoudness(samples, sr);
  master(samples, Math.pow(10, (target - raw) / 20));
  return { samples, loud: integratedLoudness(samples, sr), peakDb: samplePeakDb(samples) };
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export async function generateCatalog({ dataDir = path.join(ROOT, 'data'), quick = false, simulatedUsers = quick ? 40 : 300, quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  const t0 = Date.now();
  fs.mkdirSync(dataDir, { recursive: true });
  for (const sub of ['media', 'art', 'events']) rmrf(path.join(dataDir, sub));
  for (const f of ['ainos.db', 'ainos.db-wal', 'ainos.db-shm']) rmrf(path.join(dataDir, f));
  for (const sub of ['media/high', 'media/low', 'art', 'events']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });

  const secretFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));

  const db = openDb(path.join(dataDir, 'ainos.db'));
  const rnd = mulberry32(20261020);
  const now = Date.now();
  const SR = SAMPLE_RATE;

  const insArtist = db.prepare('INSERT INTO artists (id, name, genre, language, bio, image, color) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insAlbum = db.prepare('INSERT INTO albums (id, artist_id, title, year, type, cover, color, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insTrack = db.prepare(`INSERT INTO tracks (id, album_id, artist_id, title, track_no, duration_ms, genre, language, loudness_lufs, peak_db,
    tempo, key, mode, energy, valence, danceability, acousticness, instrumentalness) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insFile = db.prepare('INSERT INTO track_files (track_id, quality, file, mime, bytes, sample_rate, bitrate_kbps, header_bytes) VALUES (?,?,?,?,?,?,?,?)');
  const insDoc = db.prepare('INSERT INTO search_index (kind, ref_id, title, subtitle, folded) VALUES (?, ?, ?, ?, ?)');
  const addSearchDoc = (kind, id, title, subtitle) => insDoc.run(kind, id, title, subtitle, searchText(title, subtitle));

  const tracks = [];
  let totalBytes = 0;
  for (const artist of CATALOG) {
    const artistId = seededId(rnd);
    const artistImg = `art/artist-${artistId}.svg`;
    fs.writeFileSync(path.join(dataDir, artistImg), artistImage({ name: artist.name, hue: artist.hue, seed: hashSeed(artist.name) }));
    insArtist.run(artistId, artist.name, artist.genre, artist.language || 'en', artist.bio, artistImg, hexFromHsl(artist.hue, 55, 32));
    addSearchDoc('artist', artistId, artist.name, artist.genre);

    for (const [ai, album] of artist.albums.entries()) {
      const albumId = seededId(rnd);
      const hue = artist.hue + ai * 35;
      const cover = `art/album-${albumId}.svg`;
      fs.writeFileSync(path.join(dataDir, cover), albumCover({ title: album.title, artist: artist.name, style: artist.style, hue, seed: hashSeed(album.title) }));
      const releasedAt = album.year === 2026 ? now - Math.floor(rnd() * 20) * 86400000 : Date.UTC(album.year, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27));
      insAlbum.run(albumId, artistId, album.title, album.year, album.type || 'album', cover, hexFromHsl(hue, 55, 32), releasedAt);
      addSearchDoc('album', albumId, album.title, `${artist.name} ${album.year}`);

      for (const [ti, title] of album.tracks.entries()) {
        const trackId = seededId(rnd);
        const params = trackParams(artist, title, { quick });
        const { bpm, mode, key, jitter } = params;
        const tStart = Date.now();
        const { samples, loud, peakDb } = renderMastered(artist, params, SR);

        const hiFile = `media/high/${trackId}.wav`;
        const loFile = `media/low/${trackId}.wav`;
        const hi = encodeWav16(samples, SR);
        const lo = encodeWav16(downsample2(samples), SR / 2);
        fs.writeFileSync(path.join(dataDir, hiFile), hi);
        fs.writeFileSync(path.join(dataDir, loFile), lo);
        totalBytes += hi.length + lo.length;
        const durationMs = Math.round((samples.length / SR) * 1000);

        const f = STYLE_FEATURES[artist.style];
        const features = {
          energy: clamp(f.energy + jitter[0] + (loud + 14) * 0.01, 0, 1),
          valence: clamp(f.valence + (mode === 'major' ? 0.12 : -0.12) + jitter[1], 0, 1),
          danceability: clamp(f.dance + jitter[2], 0, 1),
          acousticness: clamp(f.acoustic + jitter[3] * 0.5, 0, 1),
        };
        insTrack.run(trackId, albumId, artistId, title, ti + 1, durationMs, artist.genre, artist.language || 'en', loud, peakDb, bpm, key, mode === 'major' ? 1 : 0,
          features.energy, features.valence, features.danceability, features.acousticness, 0.95);
        insFile.run(trackId, 'high', hiFile, 'audio/wav', hi.length, SR, Math.round((SR * 16) / 1000), 44);
        insFile.run(trackId, 'low', loFile, 'audio/wav', lo.length, SR / 2, Math.round(((SR / 2) * 16) / 1000), 44);
        addSearchDoc('track', trackId, title, `${artist.name} ${album.title}`);
        tracks.push({ id: trackId, artistId, albumId, style: artist.style, language: artist.language || 'en', title, ...features, tempo: bpm, mode, loud, firstOnAlbum: ti === 0 });
        say(`  ♪ ${artist.name} – ${title}  (${artist.style}, ${bpm} BPM, ${(durationMs / 1000).toFixed(0)}s, ${loud.toFixed(1)} LUFS)  ${Date.now() - tStart} ms`);
      }
    }
  }

  // ---- editorial ("algotorial") playlists built from audio features ----
  const insPlaylist = db.prepare('INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  const insPT = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)');
  const editorial = [
    { name: 'Deep Focus', desc: 'Low-energy instrumentals that stay out of your way.', color: '#2d5a7b', pick: (t) => t.energy < 0.5, sort: (a, b) => a.energy - b.energy },
    { name: 'Energy Boost', desc: 'The highest-energy tracks in the catalog.', color: '#b23a48', pick: (t) => t.energy > 0.62, sort: (a, b) => b.energy - a.energy },
    { name: 'Dance Floor', desc: 'Sorted by danceability. No sitting down.', color: '#7b2d8b', pick: (t) => t.danceability > 0.6, sort: (a, b) => b.danceability - a.danceability },
    { name: 'Feel Good', desc: 'High-valence, major-key, sunny-side-up.', color: '#c27c0e', pick: (t) => t.valence > 0.6, sort: (a, b) => b.valence - a.valence },
    { name: 'Night Drive', desc: 'Minor keys and steady tempos for empty roads.', color: '#1f3b73', pick: (t) => t.mode === 'minor' && t.energy > 0.35, sort: (a, b) => a.tempo - b.tempo },
    { name: 'Acoustic Mornings', desc: 'The most acoustic sounds we have.', color: '#4f7a28', pick: (t) => t.acousticness > 0.4, sort: (a, b) => b.acousticness - a.acousticness },
  ];
  tx(db, () => {
    for (const p of editorial) {
      const id = seededId(rnd);
      insPlaylist.run(id, null, p.name, p.desc, p.color, now, now);
      tracks.filter(p.pick).sort(p.sort).slice(0, 12).forEach((t, i) => insPT.run(id, t.id, i, now));
      addSearchDoc('playlist', id, p.name, p.desc);
    }
  });

  // ---- users: demo account + simulated listeners ----
  const insUser = db.prepare('INSERT INTO users (username, display_name, password_hash, language, is_simulated, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insStream = db.prepare('INSERT INTO streams (user_id, track_id, ms_played, context_uri, ended_at) VALUES (?, ?, ?, ?, ?)');
  const insLike = db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id, added_at) VALUES (?, ?, ?)');
  const insFollow = db.prepare('INSERT OR IGNORE INTO followed_artists (user_id, artist_id, added_at) VALUES (?, ?, ?)');

  const popularity = new Map(tracks.map((t) => [t.id, Math.exp((rnd() - 0.5) * 1.8) * (t.firstOnAlbum ? 1.6 : 1)]));
  const styles = Object.keys(ADJACENT);
  // A simulated listener's app language is the language of their favourite style.
  const styleLanguage = Object.fromEntries(CATALOG.map((a) => [a.style, a.language || 'en']));
  let streamCount = 0;

  tx(db, () => {
    for (let u = 0; u < simulatedUsers; u++) {
      const fav = [styles[Math.floor(rnd() * styles.length)]];
      if (rnd() < 0.45) fav.push(ADJACENT[fav[0]][Math.floor(rnd() * ADJACENT[fav[0]].length)]);
      const taste = Object.fromEntries(styles.map((s) => [s, 0.03]));
      for (const s of fav) {
        taste[s] = 1;
        for (const a of ADJACENT[s]) taste[a] = Math.max(taste[a], 0.3);
      }
      rnd(); // was the free/premium coin flip; still drawn so the seeded catalog stays identical
      const { lastInsertRowid: uid } = insUser.run(`listener${u}`, `Listener ${u}`, null, styleLanguage[fav[0]], 1, now);
      const weights = tracks.map((t) => taste[t.style] * popularity.get(t.id));
      const total = weights.reduce((s, w) => s + w, 0);
      const n = 15 + Math.floor(rnd() * 75);
      const counts = new Map();
      for (let k = 0; k < n; k++) {
        let r = rnd() * total, i = 0;
        while (r > weights[i]) r -= weights[i++];
        const t = tracks[Math.min(i, tracks.length - 1)];
        counts.set(t.id, (counts.get(t.id) || 0) + 1);
        insStream.run(uid, t.id, 30000 + Math.floor(rnd() * 40000), null, now - Math.floor(rnd() * 45 * 86400000));
        streamCount++;
      }
      for (const [tid, c] of counts) if (c >= 3 && rnd() < 0.35) insLike.run(uid, tid, now);
    }

    // Demo account: a lo-fi / ambient / acoustic listener with some history.
    const { lastInsertRowid: demo } = insUser.run('demo', 'Demo Listener', hashPassword('ainos-demo'), 'en', 0, now);
    const demoTaste = tracks.filter((t) => ['lofi', 'ambient'].includes(t.style) || (t.style === 'acoustic' && rnd() < 0.5));
    for (let k = 0; k < 28; k++) {
      const t = demoTaste[Math.floor(rnd() * demoTaste.length)];
      insStream.run(demo, t.id, 35000 + Math.floor(rnd() * 30000), null, now - Math.floor(rnd() * 20 * 86400000) - 3600000);
    }
    demoTaste.slice(0, 5).forEach((t) => insLike.run(demo, t.id, now - 86400000));
    const followArtists = [...new Set(demoTaste.map((t) => t.artistId))].slice(0, 2);
    followArtists.forEach((a) => insFollow.run(demo, a, now));
    const pid = seededId(rnd);
    db.prepare('INSERT INTO playlists (id, owner_id, name, description, color, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(pid, demo, 'Study Session', 'My go-to focus tracks', '#3d5a80', now, now);
    demoTaste.slice(0, 6).forEach((t, i) => insPT.run(pid, t.id, i, now));
  });

  db.close();
  const ms = Date.now() - t0;
  say(`\n✓ ${tracks.length} tracks, ${editorial.length} editorial playlists, ${simulatedUsers} simulated listeners, ${streamCount} streams`);
  say(`✓ ${(totalBytes / 1e6).toFixed(1)} MB of audio in ${path.join(dataDir, 'media')}  (${(ms / 1000).toFixed(1)} s)`);
  say('✓ Demo login: demo / ainos-demo');
  return { tracks: tracks.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quick = process.argv.includes('--quick');
  console.log(`Generating Ainos catalog${quick ? ' (quick)' : ''}...\n`);
  generateCatalog({ quick }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
