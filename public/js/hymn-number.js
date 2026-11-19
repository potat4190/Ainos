// Reading a hymn number out of what someone typed in the song search, so a
// church can find "Hymn 123" by typing 123, #123, "hymn 123" or, in Nepali
// digits, १२३ or "भजन १२३" (spec 5.8). Shared by the server and the church app.

const DEVANAGARI_ZERO = 0x0966; // ०

/** Devanagari digits ०–९ to 0–9; everything else is left as it is. */
export function westernDigits(text) {
  return String(text ?? '').replace(/[०-९]/g, (d) => String(d.codePointAt(0) - DEVANAGARI_ZERO));
}

/** The hymn number in a search query, or null when the query isn't one. */
export function parseHymnNumber(query) {
  const q = westernDigits(query).trim().toLowerCase();
  const m = /^(?:(?:hymn|no\.?|number|भजन|भजन\s*नं\.?)\s*)?#?\s*(\d{1,4})$/u.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** A hymn number in Nepali digits, e.g. 123 → १२३. */
export function devanagariDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => String.fromCodePoint(DEVANAGARI_ZERO + Number(d)));
}
