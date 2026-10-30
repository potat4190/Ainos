// Pure slide logic, shared by the church view and the presentation.
//
// A setlist item is one of:
//   { id, kind: 'song', hymnId }                         a hymn from data/hymns.js
//   { id, kind: 'pasted', title, sections: [{label, lines}] }  lyrics pasted by the church (no audio)
//   { id, kind: 'scripture', ref }                        a key of READINGS in data/hymns.js
//   { id, kind: 'text', title, text }                     e.g. a welcome slide
//
// A slide: { itemId, kind: 'song'|'scripture'|'text'|'title', title, lines: [..], label?, start?, end?, hymnId?, attribution? }
// Song slides from recorded hymns carry start/end (seconds into the hymn's audio)
// so the automatic mode can advance them from the lyric timings.
import { HYMNS, READINGS, WEB_ATTRIBUTION } from './data/hymns.js';

const MAX_LINES = 4; // lines per lyric slide

/** Split pasted lyrics into sections: blank lines separate blocks; a first line like "Verse 2", "Chorus", "[Bridge]" labels its block. */
export function parseLyrics(text) {
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  const labelRe = /^\[?\s*(verse|v|chorus|refrain|bridge|pre-?chorus|tag|ending|intro)\s*(\d*)\s*\]?:?$/i;
  let verseNo = 0;
  const sections = [];
  for (const block of blocks) {
    let label = null;
    const m = labelRe.exec(block[0]);
    if (m) {
      block.shift();
      const kind = m[1].toLowerCase();
      if (kind === 'chorus' || kind === 'refrain') label = 'C';
      else if (kind === 'bridge') label = 'B';
      else if (kind.startsWith('pre')) label = 'PC';
      else if (kind === 'verse' || kind === 'v') label = `V${m[2] || ++verseNo}`;
      else label = kind.toUpperCase().slice(0, 3);
      if (label.startsWith('V')) verseNo = Number(label.slice(1)) || verseNo;
    }
    if (!block.length) continue;
    // Unlabelled: a block that repeats an earlier one is the chorus; otherwise the next verse.
    if (!label) {
      const same = sections.find((s) => s.lines.join('\n') === block.join('\n'));
      label = same ? same.label : `V${++verseNo}`;
      if (same && same.label.startsWith('V')) { same.label = 'C'; label = 'C'; }
    }
    sections.push({ label, lines: block });
  }
  return sections;
}

export const sectionName = (label, t) => (label === 'C' ? t('chorus') : label === 'B' ? t('bridge') : label === 'PC' ? t('preChorus') : label.startsWith('V') ? t('verseN', { n: label.slice(1) }) : label);

function chunk(lines, n = MAX_LINES) {
  const out = [];
  for (let i = 0; i < lines.length; i += n) out.push(lines.slice(i, i + n));
  return out;
}

/** The slides for a setlist, in order. t is the translate function (for labels). */
export function buildSlides(items, t = (k) => k) {
  const slides = [];
  for (const item of items) {
    if (item.kind === 'song') {
      const hymn = HYMNS.find((x) => x.id === item.hymnId);
      if (!hymn) continue;
      slides.push({ itemId: item.id, kind: 'title', title: hymn.title, lines: [hymn.title], sub: hymn.words, hymnId: hymn.id, start: 0, end: hymn.lyrics[0].lines[0].t });
      hymn.lyrics.forEach((section, si) => {
        const nextSectionStart = hymn.lyrics[si + 1]?.lines[0].t ?? hymn.duration;
        chunk(section.lines).forEach((group, gi, groups) => {
          const end = groups[gi + 1]?.[0].t ?? nextSectionStart;
          slides.push({ itemId: item.id, kind: 'song', title: hymn.title, label: sectionName(section.label, t), lines: group.map((l) => l.text), hymnId: hymn.id, start: group[0].t, end });
        });
      });
    } else if (item.kind === 'pasted') {
      slides.push({ itemId: item.id, kind: 'title', title: item.title, lines: [item.title] });
      for (const section of item.sections) {
        for (const group of chunk(section.lines)) slides.push({ itemId: item.id, kind: 'song', title: item.title, label: sectionName(section.label, t), lines: group });
      }
    } else if (item.kind === 'scripture') {
      const p = READINGS[item.ref] || HYMNS.flatMap((x) => x.scripture).find((s) => s.ref === item.ref);
      if (p) slides.push({ itemId: item.id, kind: 'scripture', title: p.label, lines: [p.text], attribution: `${p.label} · ${WEB_ATTRIBUTION}` });
    } else if (item.kind === 'text') {
      slides.push({ itemId: item.id, kind: 'text', title: item.title, lines: String(item.text).split('\n') });
    }
  }
  return slides;
}

/** The sample "This Sunday" setlist. */
export function sampleSetlist() {
  return [
    { id: 's1', kind: 'text', title: 'Welcome', text: 'Welcome to Grace Fellowship\nPlease silence your phones' },
    { id: 's2', kind: 'song', hymnId: 'holy-holy-holy' },
    { id: 's3', kind: 'scripture', ref: 'PSA.100.4-5' },
    { id: 's4', kind: 'song', hymnId: 'amazing-grace' },
    { id: 's5', kind: 'song', hymnId: 'it-is-well' },
  ];
}
