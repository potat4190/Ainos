// The languages Ainos songs come in (owner, 2026-11-19: English and Nepali
// only). The interface is English only, so this list is about songs: what a
// song, its lyrics and its timings are sung in, which songs a listener is
// recommended (users.language), and a church's default for songs it adds
// (orgs.default_language). One list for the whole server; the client has the
// same codes in SONG_LANGUAGES (public/js/i18n.js).
export const SONG_LANGUAGES = ['en', 'ne'];

/** `value` when it is a song language, else `fallback`. */
export const songLanguage = (value, fallback = 'en') => (SONG_LANGUAGES.includes(value) ? value : fallback);

/** The interface's language: Scripture shown without a chosen version uses its fallback text. */
export const UI_LANGUAGE = 'en';
