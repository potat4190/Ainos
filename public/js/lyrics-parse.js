// Lyrics paste parser (AINOS-SPEC.md 4.2), pure, shared by the browser and the
// server (which never trusts the client's parse). Owner: Phase 5.
//
// Blank lines separate blocks. A block whose first line is a label ("Verse 2",
// "[Chorus]", "v1", "Refrain:", "कोरस", "Coro x2") is that section; a label on
// its own names the next block, or repeats a section already given. Unlabelled
// blocks become V1, V2… (marked needsReview); a block that repeats an earlier
// one is sung again, and an unlabelled verse that comes back is the chorus.

// Label words per section kind: English plus common Nepali, Hindi and Spanish ones.
const WORDS = {
  V: ['verse', 'v', 'vs', 'stanza', 'पद', 'अन्तरा', 'अंतरा', 'verso', 'estrofa'],
  C: ['chorus', 'refrain', 'ch', 'कोरस', 'टेक', 'मुखड़ा', 'मुखडा', 'coro', 'estribillo'],
  PC: ['pre-chorus', 'pre-coro'],
  B: ['bridge', 'ब्रिज', 'puente'],
  T: ['tag', 'coda'],
  E: ['ending', 'outro', 'end', 'final'],
  I: ['intro', 'introduction', 'introducción', 'introduccion'],
};
// Keyed without hyphens and spaces, so "pre-chorus", "pre chorus" and "prechorus" are one word.
const squash = (w) => w.toLowerCase().replace(/[-\s]/g, '');
const KIND_OF = new Map(Object.entries(WORDS).flatMap(([kind, words]) => words.map((w) => [squash(w), kind])));
// Longest first, so "pre-chorus" wins over "chorus".
const WORD_RE = Object.values(WORDS).flat().sort((a, b) => b.length - a.length).map((w) => w.replace(/-/g, '[-\\s]?')).join('|');
// [word][number][x2], optionally in brackets or parentheses, optionally ending in a colon.
const LABEL = new RegExp(`^[\\[(]?\\s*(${WORD_RE})\\s*[.#]?\\s*([0-9०-९０-９]{0,2})\\s*[\\])]?\\s*(?:[(\\[]?\\s*[x×]\\s*([0-9])\\s*[\\])]?)?\\s*:?$`, 'iu');
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;

const toAscii = (d) => d.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966)).replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));

/** The section a label line names, or null: { kind, n, repeat }. */
function readLabel(line) {
  const m = LABEL.exec(line.normalize('NFC'));
  const kind = m && KIND_OF.get(squash(m[1]));
  if (!kind) return null;
  return { kind, n: m[2] ? Number(toAscii(m[2])) : null, repeat: m[3] ? Math.min(4, Math.max(1, Number(m[3]))) : 1 };
}

/** parseLyrics(text) → { sections: [{ label, lines, needsReview? }], arrangement: ['V1', 'C', ...] } */
export function parseLyrics(text) {
  const blocks = String(text ?? '')
    .replace(LINE_BREAKS, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean))
    .filter((b) => b.length);

  const sections = []; // { label, lines, auto }
  const order = []; // section objects in sung order, repeats included
  const byLabel = (label) => sections.find((s) => s.label === label);
  const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);
  let verseNo = 0;
  let pending = null; // a label given on its own line, for the next block

  const nextVerse = () => {
    let n = verseNo + 1;
    while (byLabel(`V${n}`)) n++;
    return n;
  };
  const labelFor = (lab) => {
    if (lab.kind === 'V') return `V${lab.n || nextVerse()}`;
    if (lab.kind === 'C') return lab.n > 1 ? 'C2' : 'C';
    return lab.kind;
  };

  for (const block of blocks) {
    let lab = readLabel(block[0]);
    const lines = lab ? block.slice(1) : block;
    if (lab && !lines.length) {
      // A label on its own: sing that section again if it exists, else it names the next block.
      const existing = (lab.kind !== 'V' || lab.n) && byLabel(labelFor(lab));
      if (existing) { for (let i = 0; i < lab.repeat; i++) order.push(existing); pending = null; } else pending = lab;
      continue;
    }
    if (!lab && pending) lab = pending;
    pending = null;

    const dupe = sections.find((s) => same(s.lines, lines));
    let section = dupe;
    if (dupe) {
      // An unlabelled verse that comes back was the chorus all along (unless there is one already).
      if (!lab && dupe.auto && dupe.label.startsWith('V') && !byLabel('C')) {
        const n = Number(dupe.label.slice(1));
        dupe.label = 'C';
        dupe.auto = false;
        for (const s of sections) if (s.auto && s.label.startsWith('V') && Number(s.label.slice(1)) > n) s.label = `V${Number(s.label.slice(1)) - 1}`;
        verseNo = Math.max(0, verseNo - 1);
      }
    } else {
      let label = lab ? labelFor(lab) : null;
      // A label already used for different words: C becomes C2, anything else the next verse.
      if (label && byLabel(label)) label = label === 'C' && !byLabel('C2') ? 'C2' : null;
      const auto = !label;
      if (!label) label = `V${nextVerse()}`;
      if (label.startsWith('V')) verseNo = Math.max(verseNo, Number(label.slice(1)));
      section = { label, lines, auto };
      sections.push(section);
    }
    for (let i = 0; i < (lab?.repeat ?? 1); i++) order.push(section);
  }

  return {
    sections: sections.map((s) => (s.auto ? { label: s.label, lines: s.lines, needsReview: true } : { label: s.label, lines: s.lines })),
    arrangement: order.map((s) => s.label),
  };
}
