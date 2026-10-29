// Songs: what is sung, separate from the recordings that play it (spec "Data
// model"). This module holds the fixed vocabularies the song tables use.

// Theme and season tags. A closed list, so search, browse pages and
// translations can rely on every value (song_themes.theme).
export const THEMES = [
  'advent', 'christmas', 'lent', 'easter', 'pentecost', 'grace', 'cross', 'praise', 'prayer', 'thanksgiving', 'communion', 'evening',
  'morning', 'trust', 'peace', 'comfort', 'heaven', 'holiness', 'trinity', 'majesty', 'guidance', 'repentance', 'salvation',
];

// Section labels (spec 4.1): verses V1–V9, pre-chorus, chorus (and a second
// chorus), bridge, tag, intro (no lines), ending.
export const SECTION_LABEL = /^(V[1-9]|PC|C2?|B|T|I|E)$/;

// How a song source plays.
export const SOURCES = ['ainos', 'youtube'];
export const SOURCE_KINDS = ['official', 'lyric', 'live', 'backing'];
