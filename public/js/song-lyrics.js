// A church's own lyrics for a song already in the catalog (spec 4.1): a leader
// or admin pastes the words their church sings for a YouTube song (or its own
// words for a hymn), and tap-to-sync can then time them. Only that church sees
// them; the server parses and checks the text again.
import { h, icon, clear, toast, safely } from './ui.js';
import { api } from './api.js';
import { t, sectionName } from './i18n.js';
import { parseLyrics, lyricsText } from './lyrics-parse.js';
import { syncTargets } from './tapsync.js';

/** The churches where this user may add lyrics (admin or leader; the same as tap-to-sync's church targets). */
export async function lyricsChurches() {
  return (await syncTargets()).filter((x) => x.orgId);
}

/** What a church already saved for this song and language, as paste text ('' if nothing). */
function savedText(detail, orgId, language) {
  const sections = detail.sections.filter((s) => s.org_id === orgId && s.language === language);
  if (!sections.length) return '';
  const order = detail.arrangements.find((a) => a.org_id === orgId && a.name === 'Default')?.section_order || [];
  return lyricsText(sections, order);
}

/**
 * Open the lyrics editor for one song. `song`: { id, title, language };
 * `detail`: GET /api/songs/:id (for the church's saved lyrics); `churches`
 * from lyricsChurches(); onSaved() runs after a save.
 */
export function openLyricsEditor({ song, detail, churches, onSaved }) {
  const language = song.language;
  const church = h('select', { class: 'ch-switch', 'aria-label': t('lyricsFor') },
    churches.map((x, i) => h('option', { value: String(i) }, x.name)));
  const text = h('textarea', { class: 'ch-input ch-lyrics', rows: '14', spellcheck: 'false', maxlength: '20000', placeholder: t('chLyricsPh'), 'aria-label': t('chLyrics') });
  const sectionsEl = h('div', { class: 'ch-sections' });
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, t('save'));
  const current = () => churches[Number(church.value)] || churches[0];

  const update = () => {
    const parsed = parseLyrics(text.value);
    save.disabled = !parsed.sections.length;
    clear(sectionsEl);
    if (!parsed.sections.length) { sectionsEl.append(h('p', { class: 'dim small' }, t('lyricsEditEmpty'))); return; }
    for (const s of parsed.sections) {
      sectionsEl.append(h('div', { class: `ch-sec sec-${s.label[0]}` },
        h('span', { class: 'ch-sec-label' }, sectionName(s.label)),
        h('span', { class: 'ch-sec-first' }, s.lines[0]),
        s.needsReview ? h('span', { class: 'ch-tag', title: t('chNeedsReview') }, '?') : null,
        h('span', { class: 'ch-sec-n' }, String(s.lines.length))));
    }
  };
  const load = () => { text.value = savedText(detail, current().orgId, language); update(); };
  church.addEventListener('change', load);
  text.addEventListener('input', update);

  save.addEventListener('click', safely(async () => {
    save.disabled = true; // one save at a time
    try {
      const r = await api.put(`/api/orgs/${encodeURIComponent(current().orgId)}/songs/${encodeURIComponent(song.id)}/lyrics`, { text: text.value, language });
      toast(r.timings_removed ? t('lyricsSavedResync') : t('lyricsSaved'));
    } finally {
      save.disabled = false;
    }
    dlg.close();
    onSaved?.();
  }));
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, t('cancel'));

  const dlg = h('dialog', { class: 'ch-dialog ch-dialog-wide', 'aria-label': t('lyricsEditTitle', { title: song.title }) },
    h('div', { class: 'ch-dlg-head' }, h('h2', {}, t('lyricsEditTitle', { title: song.title })),
      h('button', { type: 'button', class: 'icon-btn ch-dlg-close', 'aria-label': t('cancel'), onclick: () => dlg.close() }, icon('close'))),
    h('div', { class: 'ch-dlg-body' },
      h('p', { class: 'muted small' }, t('lyricsEditHelp')),
      churches.length > 1 ? h('label', { class: 'ch-preview-label' }, t('lyricsFor'), church) : null,
      h('div', { class: 'ch-paste' },
        h('div', { class: 'ch-paste-left' }, text),
        h('div', { class: 'ch-paste-right' }, h('h3', { class: 'ch-modal-h' }, t('chSections')), sectionsEl))),
    h('div', { class: 'dialog-actions' }, cancel, save));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  load();
  text.focus();
  return dlg;
}

/**
 * "Add lyrics" (or "Edit your church's lyrics" when it has some) for a song,
 * shown in `host` once the user turns out to lead a church.
 */
export function lyricsButton({ song, detail, onSaved }, host) {
  lyricsChurches().then((churches) => {
    if (!churches.length) return;
    const has = detail.sections.some((s) => s.org_id && churches.some((c) => c.orgId === s.org_id) && s.language === song.language);
    clear(host).append(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openLyricsEditor({ song, detail, churches, onSaved }) },
      has ? null : icon('plus'), has ? t('lyricsEditChurch') : t('lyricsAdd')));
  });
}
