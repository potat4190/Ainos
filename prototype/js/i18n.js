// UI strings. English and Nepali are complete; the other four languages are
// listed as "coming soon". Each feature module owns a strings file in
// js/strings/ ({ en: {...}, ne: {...} }); they are merged here.
import { state, set, emit } from './state.js';
import common from './strings/common.js';
import listener from './strings/listener.js';
import nowplaying from './strings/nowplaying.js';
import church from './strings/church.js';
import present from './strings/present.js';

export const LANGUAGES = [
  { code: 'en', native: 'English', ready: true },
  { code: 'ne', native: 'नेपाली', ready: true },
  { code: 'hi', native: 'हिन्दी', ready: false },
  { code: 'zh', native: '中文', ready: false },
  { code: 'ja', native: '日本語', ready: false },
  { code: 'es', native: 'Español', ready: false },
];

const DICT = { en: {}, ne: {} };
for (const part of [common, listener, nowplaying, church, present]) {
  for (const lang of ['en', 'ne']) Object.assign(DICT[lang], part[lang] || {});
}

/** t('key', { n: 3 }) → the string in the current language (English if missing), with {n} filled in. */
export function t(key, vars = {}) {
  const s = DICT[state.lang]?.[key] ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function setLang(code) {
  if (!LANGUAGES.find((l) => l.code === code)?.ready) return;
  set({ lang: code });
  document.documentElement.lang = code;
  emit('lang', code);
}

/** For tests: keys missing a Nepali translation. */
export const missingNepali = () => Object.keys(DICT.en).filter((k) => !DICT.ne[k]);
