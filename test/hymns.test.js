// The public-domain hymns (scripts/hymns.js): every one provably public
// domain, sourced, and internally consistent, so the generator can render it
// and lyric timings line up with the melody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HYMNS, HYMN_ARTIST, HYMN_ALBUM } from '../scripts/hymns.js';
import { THEMES, SECTION_LABEL } from '../server/songs.js';
import { str } from '../server/validate.js';
import { melodyTimeline } from '../scripts/synth.js';

const PUBLIC_DOMAIN_BEFORE = 1929;
// Hymns whose public-domain status is disputed or still claimed (spec 1.1).
const EXCLUDED = ['great is thy faithfulness', 'how great thou art', 'in christ alone', 'because he lives'];

test('the owner-approved hymns, each once, in album order', () => {
  assert.deepEqual(HYMNS.map((h) => h.slug), ['amazing-grace', 'be-thou-my-vision', 'it-is-well', 'holy-holy-holy', 'come-thou-fount', 'all-hail-the-power', 'rock-of-ages', 'abide-with-me']);
  for (const h of HYMNS) assert.ok(!EXCLUDED.includes(h.title.toLowerCase()), h.title);
  assert.equal(HYMN_ARTIST.genre, 'Hymn');
  assert.equal(HYMN_ALBUM.released, Date.UTC(2026, 9, 29), 'a fixed release date, so deploys never rewrite it');
});

test('words and tune were both published before 1929, with a cited source for melody and lyrics', () => {
  const https = /^https:\/\/\S+$/;
  for (const h of HYMNS) {
    assert.ok(h.words.year < PUBLIC_DOMAIN_BEFORE && h.tune.year < PUBLIC_DOMAIN_BEFORE, `${h.slug}: years`);
    assert.ok(h.words.author && h.tune.name && h.tune.composer, `${h.slug}: authors`);
    for (const [what, src] of [['melody', h.melodySource], ['lyrics', h.lyricsSource]]) {
      assert.ok(src.year < PUBLIC_DOMAIN_BEFORE, `${h.slug}: ${what} source year`);
      assert.match(src.url, https, `${h.slug}: ${what} source url`);
      assert.ok(src.hymnal, `${h.slug}: ${what} source named`);
    }
    assert.ok(h.melodySource.checkedAgainst?.length >= 1, `${h.slug}: melody cross-checked`);
  }
});

test('melodies are playable and fill whole bars', () => {
  for (const h of HYMNS) {
    const [beatsPerBar, unit] = h.timeSignature;
    assert.ok([2, 3, 4, 6].includes(beatsPerBar) && [2, 4, 8].includes(unit), `${h.slug}: time signature`);
    assert.ok(h.melody.length >= 20, `${h.slug}: a real tune`);
    for (const [i, [pitch, beats]] of h.melody.entries()) {
      assert.ok(pitch === null || (Number.isInteger(pitch) && pitch >= 48 && pitch <= 84), `${h.slug} note ${i}: pitch in a singing range`);
      assert.ok(beats > 0 && beats <= 8 && Number.isInteger(beats * 4), `${h.slug} note ${i}: length in sixteenths`);
    }
    const total = h.melody.reduce((s, [, b]) => s + b, 0);
    assert.equal(total % beatsPerBar, 0, `${h.slug}: one pass is whole bars (pickup taken from the last bar)`);
    assert.ok(h.bpm >= 50 && h.bpm <= 120, `${h.slug}: a congregational tempo`);
    assert.ok(Number.isInteger(h.tonic) && ['major', 'minor'].includes(h.mode));
    const { seconds } = melodyTimeline(h.melody, { bpm: h.bpm, passes: h.audioVerses, beatsPerBar, pickupBeats: h.pickupBeats });
    assert.ok(seconds > 45 && seconds < 150, `${h.slug}: ${h.audioVerses} recorded verses last ${seconds.toFixed(0)} s`);
  }
});

test('lyrics: every stanza fits the tune line for line, within the app’s limits', () => {
  for (const h of HYMNS) {
    const verses = h.sections.filter((s) => s.label.startsWith('V'));
    const refrain = h.sections.find((s) => s.label === 'C');
    assert.deepEqual(verses.map((v) => v.label), verses.map((_, i) => `V${i + 1}`), `${h.slug}: stanzas numbered in order`);
    assert.equal(Boolean(refrain), h.cycle.includes('C'), `${h.slug}: refrain present exactly when the tune has one`);
    assert.deepEqual(h.cycle, refrain ? ['V', 'C'] : ['V']);
    const perPass = verses[0].lines.length + (refrain ? refrain.lines.length : 0);
    for (const v of verses) assert.equal(v.lines.length, verses[0].lines.length, `${h.slug} ${v.label}: same number of lines`);
    assert.equal(h.lineStarts.length, perPass, `${h.slug}: one line start per sung line`);
    assert.equal(h.lineStarts[0], 0);
    h.lineStarts.forEach((n, i) => {
      assert.ok(Number.isInteger(n) && n < h.melody.length && (i === 0 || n > h.lineStarts[i - 1]), `${h.slug}: line start ${i}`);
      assert.notEqual(h.melody[n][0], null, `${h.slug}: line ${i} starts on a sung note`);
    });
    assert.ok(Number.isInteger(h.audioVerses) && h.audioVerses >= 1 && h.audioVerses <= verses.length, `${h.slug}: recorded verses exist`);
    assert.ok(h.sections.length <= 30);
    for (const s of h.sections) {
      assert.match(s.label, SECTION_LABEL);
      assert.ok(s.lines.length >= 1 && s.lines.length <= 12, `${h.slug} ${s.label}: 1-12 lines`);
      for (const line of s.lines) assert.equal(str(line, { min: 1, max: 120 }), line, `${h.slug} ${s.label}: clean line "${line}"`);
    }
    assert.ok(h.themes.length >= 1 && h.themes.length <= 3 && h.themes.every((t) => THEMES.includes(t)), `${h.slug}: themes`);
  }
});
