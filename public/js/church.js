// Church views (Phase 5): the dashboard ("This Sunday" header, setlist editor,
// paste-lyrics dialog, slide preview strip) and one setlist. Everything is
// saved on the server; the server checks every permission again, so the
// buttons shown here are only a convenience.
import { h, icon, clear, toast, promptDialog, safely } from './ui.js';
import { api } from './api.js';
import { t, getLang, errorText } from './i18n.js';
import { parseLyrics } from './lyrics-parse.js';
import { openPresentDialog } from './present/present.js';

const CHURCH_DEMO = 'church-demo';
const isChurchDemo = (app) => app?.me?.username?.toLowerCase() === CHURCH_DEMO;
const READINGS = ['PSA.100.4-5', 'PSA.23', 'PSA.95.1-7', 'ISA.40.28-31', 'MAT.5.3-12', 'JHN.3.16-17', 'ROM.12.1-2', 'PHP.4.6-7'];

// "Blessed Assurance", Fanny Crosby, 1873: public domain.
const SAMPLE = `Verse 1
Blessed assurance, Jesus is mine!
O what a foretaste of glory divine!
Heir of salvation, purchase of God,
Born of His Spirit, washed in His blood.

Chorus
This is my story, this is my song,
Praising my Savior all the day long;
This is my story, this is my song,
Praising my Savior all the day long.

Verse 2
Perfect submission, perfect delight,
Visions of rapture now burst on my sight;
Angels descending bring from above
Echoes of mercy, whispers of love.

Chorus`;

const num = (n) => new Intl.NumberFormat(getLang()).format(n);
const plural = (base, n) => t(n === 1 ? `${base}1` : `${base}N`, { n: num(n) });
const enc = encodeURIComponent;
const orgUrl = (orgId, rest = '') => `/api/orgs/${enc(orgId)}${rest}`;

/** "Verse 2", "Chorus"… for a section label. */
export function sectionName(label) {
  if (/^V\d$/.test(label)) return t('chSecV', { n: num(Number(label.slice(1))) });
  return ['C', 'C2', 'PC', 'B', 'T', 'I', 'E'].includes(label) ? t(`chSec${label}`) : label;
}

function nextSundayUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(getLang(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  } catch { return iso; }
}

// The church shown last, so the dashboard opens where the user left it.
const CHURCH_KEY = 'ainos.church';
const rememberedChurch = () => { try { return localStorage.getItem(CHURCH_KEY); } catch { return null; } };
const rememberChurch = (id) => { try { localStorage.setItem(CHURCH_KEY, id); } catch { /* storage blocked */ } };

// ---------------------------------------------------------------- start

/** Called once when the app starts, with the signed-in user in app.me. */
export async function onStart(app) {
  const demo = isChurchDemo(app);
  let orgs = [];
  try { orgs = await api.get('/api/me/orgs'); } catch { /* the nav link just stays hidden */ }
  const nav = document.getElementById('nav-church');
  // Everyone but the listener demo sees it: a member goes to their church, anyone else can create one.
  if (nav) nav.hidden = !(orgs.length || demo || !app.me?.is_demo);
  // The shared-demo banner (app.js) is up by now; for the church demo it says what this demo shares.
  if (demo) {
    const text = document.querySelector('#demo-banner .demo-banner-text > span');
    if (text) text.textContent = t('chDemoBanner');
  }
}

// ---------------------------------------------------------------- dialogs

/** A modal <dialog> built with h(); resolves when it closes. */
function openDialog({ title, body, actions = [], wide = false }) {
  const closeBtn = h('button', { type: 'button', class: 'icon-btn ch-dlg-close', 'aria-label': t('cancel') }, icon('close'));
  const dlg = h('dialog', { class: `ch-dialog${wide ? ' ch-dialog-wide' : ''}` },
    h('div', { class: 'ch-dlg-head' }, h('h2', {}, title), closeBtn),
    h('div', { class: 'ch-dlg-body' }, body),
    actions.length ? h('div', { class: 'dialog-actions' }, actions) : null);
  closeBtn.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function field(label, control) {
  return h('label', { class: 'ch-field' }, h('span', { class: 'ch-field-label' }, label), control);
}

/** A 16:9 slide thumbnail. */
function slideThumb(slide, n, { kind = 'song', caption = '' } = {}) {
  const lines = slide.lines || [];
  const chars = lines.join(' ').length;
  const size = chars < 70 ? 'fs-l' : chars < 150 ? 'fs-m' : 'fs-s';
  return h('figure', { class: `ch-slide kind-${kind}` },
    h('div', { class: `ch-screen ${size}` },
      lines.length ? h('div', { class: 'st-lines' }, lines.map((l) => h('div', {}, l))) : null,
      slide.attribution ? h('div', { class: 'st-sub' }, slide.attribution) : null),
    h('figcaption', {}, h('span', { class: 'ch-slide-label' }, caption), h('span', { class: 'ch-slide-no' }, num(n))));
}

/** Pick a song (global hymns + this church's songs). */
async function pickSong(orgId, onPick) {
  const songs = await api.get(orgUrl(orgId, '/songs'));
  const filter = h('input', { class: 'ch-input', type: 'search', placeholder: t('chSearchSongs'), 'aria-label': t('chSearchSongs') });
  const list = h('ul', { class: 'ch-picklist' });
  let dlg;
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = songs.filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));
    clear(list);
    if (!shown.length) list.append(h('li', { class: 'dim small' }, t('chNoSongs')));
    for (const s of shown) {
      list.append(h('li', {}, h('button', { type: 'button', class: 'ch-pick', onclick: () => { dlg.close(); onPick(s); } },
        h('div', { class: `ch-art ch-art-${s.org_song ? 'pasted' : 'song'}` }, icon('play')),
        h('span', { class: 'ch-pick-main' }, h('span', { class: 'ch-row-title' }, s.title), h('span', { class: 'ch-row-sub' }, s.artist || '')),
        h('span', { class: 'ch-pick-add' }, icon('plus'), t('chAdd')))));
    }
  };
  filter.addEventListener('input', render);
  render();
  dlg = openDialog({ title: t('chAddSong'), body: [h('p', { class: 'muted small ch-modal-intro' }, t('chPickSongSub')), filter, list] });
  filter.focus();
}

/** A Scripture reading by USFM reference (the server validates it). */
function pickScripture(onPick) {
  const input = h('input', { class: 'ch-input', type: 'text', maxlength: '20', placeholder: t('chScriptureRefPh'), autocomplete: 'off', spellcheck: 'false' });
  const ok = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, t('chAddToSetlist'));
  let dlg;
  const done = (ref) => { if (!ref.trim()) return; dlg.close(); onPick(ref.trim().toUpperCase()); };
  ok.addEventListener('click', () => done(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
  const suggestions = h('ul', { class: 'ch-chips' }, READINGS.map((ref) => h('li', {},
    h('button', { type: 'button', class: 'ch-chip', onclick: () => done(ref) }, ref))));
  dlg = openDialog({
    title: t('chAddScripture'),
    body: h('div', { class: 'ch-form' }, field(t('chScriptureRef'), input), h('p', { class: 'dim small' }, t('chScriptureHelp')),
      h('h3', { class: 'ch-modal-h' }, t('chReadings')), suggestions),
    actions: [h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, t('cancel')), ok],
  });
  input.focus();
}

/** A text slide: a welcome, an announcement. */
function addTextSlide(onAdd) {
  const text = h('textarea', { class: 'ch-input', rows: '5', maxlength: '500', placeholder: t('chTextBodyPh') });
  const preview = h('div', { class: 'ch-text-preview' });
  const ok = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, t('chAddToSetlist'));
  const lines = () => text.value.split('\n').map((l) => l.trim()).filter(Boolean);
  text.addEventListener('input', () => {
    ok.disabled = !lines().length;
    clear(preview);
    if (lines().length) preview.append(slideThumb({ lines: lines() }, 1, { kind: 'text', caption: t('chKindText') }));
  });
  const dlg = openDialog({
    title: t('chAddText'),
    body: h('div', { class: 'ch-form' }, field(t('chTextBody'), text), preview),
    actions: [h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, t('cancel')), ok],
  });
  ok.addEventListener('click', () => { if (!lines().length) return; dlg.close(); onAdd(lines().join('\n')); });
  text.focus();
}

/** Split a section into slides of at most 4 lines, for the preview (the server makes the real ones). */
function previewSlides({ sections, arrangement }) {
  const byLabel = new Map(sections.map((s) => [s.label, s]));
  const out = [];
  for (const label of arrangement) {
    const s = byLabel.get(label);
    if (!s) continue;
    const n = Math.ceil(s.lines.length / 4) || 1;
    const per = Math.ceil(s.lines.length / n);
    for (let i = 0; i < s.lines.length; i += per) out.push({ label, lines: s.lines.slice(i, i + per) });
  }
  return out;
}

/** Paste lyrics → live preview → save as this church's song → onSaved(song). */
function pasteLyrics(orgId, onSaved) {
  const title = h('input', { class: 'ch-input', type: 'text', maxlength: '120', placeholder: t('chSongTitlePh') });
  const artist = h('input', { class: 'ch-input', type: 'text', maxlength: '120' });
  const text = h('textarea', { class: 'ch-input ch-lyrics', rows: '14', spellcheck: 'false', maxlength: '20000', placeholder: t('chLyricsPh') });
  const note = h('p', { class: 'dim small ch-sample-note', hidden: true }, t('chSampleNote'));
  const sectionsEl = h('div', { class: 'ch-sections' });
  const slidesEl = h('div', { class: 'ch-thumbs ch-thumbs-sm' });
  const slideCount = h('span', { class: 'ch-count' });
  const ok = h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: true }, icon('plus'), t('chAddToSetlist'));
  let parsed = { sections: [], arrangement: [] };

  const update = () => {
    parsed = parseLyrics(text.value);
    ok.disabled = !parsed.sections.length || !title.value.trim();
    clear(sectionsEl);
    clear(slidesEl);
    if (!parsed.sections.length) {
      sectionsEl.append(h('p', { class: 'dim small' }, t('chPasteEmpty')));
      slideCount.textContent = '';
      return;
    }
    for (const s of parsed.sections) {
      sectionsEl.append(h('div', { class: `ch-sec sec-${s.label[0]}` },
        h('span', { class: 'ch-sec-label' }, sectionName(s.label)),
        h('span', { class: 'ch-sec-first' }, s.lines[0]),
        s.needsReview ? h('span', { class: 'ch-tag', title: t('chNeedsReview') }, '?') : null,
        h('span', { class: 'ch-sec-n' }, num(s.lines.length))));
    }
    const slides = previewSlides(parsed);
    slideCount.textContent = num(slides.length);
    slides.forEach((s, i) => slidesEl.append(slideThumb(s, i + 1, { caption: sectionName(s.label) })));
  };
  title.addEventListener('input', update);
  text.addEventListener('input', update);
  const sample = h('button', { type: 'button', class: 'ch-link', onclick: () => {
    if (!title.value.trim()) { title.value = 'Blessed Assurance'; artist.value = 'Fanny Crosby'; }
    text.value = SAMPLE;
    note.hidden = false;
    update();
    text.focus();
  } }, t('chTrySample'));

  const left = h('div', { class: 'ch-paste-left' },
    field(t('chSongTitle'), title), field(t('chArtist'), artist),
    h('div', { class: 'ch-field' }, h('div', { class: 'ch-field-row' }, h('span', { class: 'ch-field-label' }, t('chLyrics')), sample), text),
    note,
    h('ul', { class: 'ch-help small muted' }, ['chHelp1', 'chHelp2', 'chHelp3'].map((k) => h('li', {}, t(k)))));
  const right = h('div', { class: 'ch-paste-right' },
    h('h3', { class: 'ch-modal-h' }, t('chSections')), sectionsEl,
    h('h3', { class: 'ch-modal-h' }, t('chSlidesTitle'), ' ', slideCount), slidesEl);
  const dlg = openDialog({
    title: t('chPasteLyrics'), wide: true,
    body: h('div', { class: 'ch-paste' }, left, right),
    actions: [h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, t('cancel')), ok],
  });
  ok.addEventListener('click', safely(async () => {
    const song = await api.post(orgUrl(orgId, '/songs'), { title: title.value.trim(), artist: artist.value.trim() || null, text: text.value });
    dlg.close();
    await onSaved(song);
  }));
  update();
  title.focus();
}

// ---------------------------------------------------------------- editor

const KIND_ICON = { song: 'play', scripture: 'library', text: 'queue', blank: 'nowplaying' };
const KIND_LABEL = { song: 'chKindSong', scripture: 'chKindScripture', text: 'chKindText', blank: 'chKindBlank' };
const itemTitle = (it) => it.title || t(KIND_LABEL[it.kind]);
/** What the server takes back for an item. */
const itemBody = ({ kind, song_id, arrangement_id, source_id, usfm_ref, text }) => ({ kind, song_id, arrangement_id, source_id, usfm_ref, text });

/** The dashboard for one setlist of one church: header, editor, slide strip. */
async function renderEditor(el, { org, orgs, setlistId, setlists, app, onChurchChange }) {
  const can = (p) => org.permissions.includes(p);
  let setlist = await api.get(orgUrl(org.id, `/setlists/${enc(setlistId)}`));
  let slides = null;

  const summary = h('p', { class: 'ch-summary' });
  const presentBtn = can('projection.run') ? h('button', { type: 'button', class: 'btn btn-primary ch-present' }, icon('play'), t('chPresent')) : null;
  presentBtn?.addEventListener('click', safely(async () => {
    if (!setlist.items.length) { toast(t('chNothingToPresent')); return; }
    const deck = await api.get(orgUrl(org.id, `/setlists/${enc(setlist.id)}/slides`));
    openPresentDialog({ title: deck.setlist.name, items: deck.items });
  }));
  const nameEl = h('strong', {});
  const dateEl = h('span', {});
  const sundayEl = h('span', { class: 'ch-pill', hidden: true }, t('chThisSunday'));
  const switcher = orgs.length > 1
    ? h('select', { class: 'ch-switch', 'aria-label': t('navChurch'), onchange: (e) => onChurchChange(e.target.value) },
      orgs.map((o) => h('option', { value: o.id, selected: o.id === org.id }, o.name)))
    : null;
  const header = h('header', { class: 'ch-head' },
    h('div', { class: 'ch-badge' }, icon('library')),
    h('div', { class: 'ch-head-text' },
      h('div', { class: 'ch-eyebrow' }, t(`chRole_${org.role}`), switcher),
      h('h1', { class: 'ch-name' }, org.name),
      h('div', { class: 'ch-date' }, sundayEl, nameEl, h('span', { class: 'ch-dot' }, '·'), dateEl),
      summary),
    presentBtn);

  const list = h('ol', { class: 'ch-list' });
  const strip = h('div', { class: 'ch-strip' });
  const stripCount = h('span', { class: 'ch-count' });

  // Every change replaces the whole item list on the server, which answers with the saved setlist.
  const save = async (items) => {
    setlist = await api.put(orgUrl(org.id, `/setlists/${enc(setlist.id)}/items`), { items: items.map(itemBody) });
    await refresh();
  };
  const add = async (item, label) => {
    await save([...setlist.items, item]);
    toast(t('chAdded', { title: label || itemTitle(setlist.items.at(-1)) }));
  };
  const move = (i, d) => safely(async () => {
    const next = [...setlist.items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    await save(next);
    list.children[i + d]?.querySelector(`[data-btn="${d < 0 ? 'up' : 'down'}"]:not([disabled])`)?.focus();
  });

  function row(item, i, count) {
    const sub = [t(KIND_LABEL[item.kind]), item.kind === 'song' ? item.artist : null, count ? plural('chSlides', count) : null].filter(Boolean).join(' · ');
    const actions = can('setlist.edit') ? h('div', { class: 'ch-row-actions' },
      h('button', { type: 'button', class: 'icon-btn ch-up', 'data-btn': 'up', 'aria-label': t('chMoveUp'), title: t('chMoveUp'), disabled: i === 0, onclick: move(i, -1) }, icon('chevron-left')),
      h('button', { type: 'button', class: 'icon-btn ch-down', 'data-btn': 'down', 'aria-label': t('chMoveDown'), title: t('chMoveDown'), disabled: i === setlist.items.length - 1, onclick: move(i, 1) }, icon('chevron-left')),
      h('button', { type: 'button', class: 'icon-btn ch-del', 'aria-label': t('chRemove'), title: t('chRemove'), onclick: safely(async () => {
        await save(setlist.items.filter((_, j) => j !== i));
        toast(t('chRemoved', { title: itemTitle(item) }));
      }) }, icon('close'))) : null;
    return h('li', { class: 'ch-row' },
      h('span', { class: 'ch-num' }, num(i + 1)),
      h('div', { class: `ch-art ch-art-${item.kind === 'song' && item.org_song ? 'pasted' : item.kind}` }, icon(KIND_ICON[item.kind])),
      h('div', { class: 'ch-row-main' }, h('span', { class: 'ch-row-title' }, itemTitle(item)), h('span', { class: 'ch-row-sub' }, sub)),
      actions);
  }

  async function refresh() {
    if (can('projection.run')) {
      try { slides = await api.get(orgUrl(org.id, `/setlists/${enc(setlist.id)}/slides`)); } catch (err) { slides = null; toast(errorText(err), { error: true }); }
    }
    const counts = new Map((slides?.items || []).map((x) => [x.id, x.slides.length]));
    const songs = setlist.items.filter((x) => x.kind === 'song').length;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    summary.textContent = [plural('chItems', setlist.items.length), plural('chSongs', songs), slides ? plural('chSlides', total) : null].filter(Boolean).join(' · ');
    nameEl.textContent = setlist.name;
    dateEl.textContent = fmtDate(setlist.service_date);
    // The pill, unless the setlist is already called that (the demo's "This Sunday").
    sundayEl.hidden = setlist.service_date !== nextSundayUtc() || [t('chThisSunday'), 'This Sunday'].includes(setlist.name);
    if (presentBtn) presentBtn.disabled = !setlist.items.length;

    clear(list);
    if (!setlist.items.length) {
      list.append(h('li', { class: 'ch-empty' }, icon('library', 'icon ch-empty-ic'), h('strong', {}, t('chEmptyTitle')), h('span', { class: 'muted' }, t('chEmptySub'))));
    }
    setlist.items.forEach((item, i) => list.append(row(item, i, counts.get(item.id) || 0)));

    clear(strip);
    let n = 0;
    (slides?.items || []).forEach((item, i) => {
      if (!item.slides.length) return;
      strip.append(h('div', { class: 'ch-group' },
        h('div', { class: 'ch-group-head' }, h('span', { class: 'ch-num' }, num(i + 1)), item.title || t(KIND_LABEL[item.kind])),
        h('div', { class: 'ch-thumbs' }, item.slides.map((s) => slideThumb(s, ++n, {
          kind: item.kind, caption: item.kind === 'song' ? sectionName(s.label) : t(KIND_LABEL[item.kind]),
        })))));
    });
    stripCount.textContent = n ? num(n) : '';
  }

  const addBar = can('setlist.edit') ? h('div', { class: 'ch-addbar' },
    h('button', { type: 'button', class: 'ch-add', onclick: safely(() => pickSong(org.id, (s) => safely(() => add({ kind: 'song', song_id: s.id }, s.title))())) }, icon('play', 'icon ch-add-ic'), t('chAddSong')),
    h('button', { type: 'button', class: 'ch-add', onclick: () => pickScripture((ref) => safely(() => add({ kind: 'scripture', usfm_ref: ref }))()) }, icon('library', 'icon ch-add-ic'), t('chAddScripture')),
    h('button', { type: 'button', class: 'ch-add', onclick: () => addTextSlide((text) => safely(() => add({ kind: 'text', text }))()) }, icon('queue', 'icon ch-add-ic'), t('chAddText')),
    h('button', { type: 'button', class: 'ch-add', onclick: safely(() => add({ kind: 'blank' }, t('chKindBlank'))) }, icon('nowplaying', 'icon ch-add-ic'), t('chAddBlank')),
    can('song.edit') ? h('button', { type: 'button', class: 'ch-add ch-add-strong', onclick: () => pasteLyrics(org.id, (song) => add({ kind: 'song', song_id: song.id }, song.title)) }, icon('plus', 'icon ch-add-ic'), t('chPasteLyrics')) : null)
    : h('p', { class: 'dim small ch-readonly' }, t('chReadOnly'));

  const editBtn = can('setlist.edit') ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: safely(async () => {
    const res = await promptDialog({ title: t('chEdit'), fields: [
      { name: 'name', label: t('chSetlistName'), value: setlist.name, max: 100, required: true },
      { name: 'service_date', label: t('chServiceDate'), value: setlist.service_date || '', max: 10, placeholder: nextSundayUtc() },
    ] });
    if (!res || !res.name) return;
    await api.patch(orgUrl(org.id, `/setlists/${enc(setlist.id)}`), { name: res.name, service_date: res.service_date || null });
    setlist = await api.get(orgUrl(org.id, `/setlists/${enc(setlist.id)}`));
    await refresh();
  }) }, t('chEdit')) : null;

  const setlistCard = h('section', { class: 'ch-card' },
    h('div', { class: 'ch-card-head' },
      h('div', {}, h('h2', {}, t('chSetlistTitle')), h('p', { class: 'muted small' }, can('setlist.edit') ? t('chSetlistSub') : '')),
      editBtn),
    list, addBar);
  const slidesCard = can('projection.run') ? h('section', { class: 'ch-card' },
    h('div', { class: 'ch-card-head' }, h('div', {}, h('h2', {}, t('chSlidesTitle'), ' ', stripCount), h('p', { class: 'muted small' }, t('chSlidesSub')))),
    strip) : null;

  el.append(h('div', { class: 'church' }, header, setlistCard, slidesCard, setlistsCard({ org, setlists, current: setlist.id, app })));
  await refresh();
}

/** The church's other setlists, with "New setlist" for leaders. */
function setlistsCard({ org, setlists, current }) {
  const can = (p) => org.permissions.includes(p);
  const newBtn = can('setlist.edit') ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: safely(async () => {
    const res = await promptDialog({ title: t('chNewSetlist'), submitLabel: t('chNewSetlist'), fields: [
      { name: 'name', label: t('chSetlistName'), max: 100, required: true },
      { name: 'service_date', label: t('chServiceDate'), value: nextSundayUtc(), max: 10 },
    ] });
    if (!res || !res.name) return;
    const s = await api.post(orgUrl(org.id, '/setlists'), { name: res.name, service_date: res.service_date || null });
    location.hash = `#/setlist/${enc(s.id)}?org=${enc(org.id)}`;
  }) }, icon('plus'), t('chNewSetlist')) : null;
  const rows = setlists.map((s) => h('li', { class: `ch-setlist${s.id === current ? ' current' : ''}` },
    h('a', { href: `#/setlist/${enc(s.id)}?org=${enc(org.id)}`, 'aria-current': s.id === current ? 'page' : null },
      h('span', { class: 'ch-row-title' }, s.name),
      h('span', { class: 'ch-row-sub' }, [fmtDate(s.service_date), plural('chItems', s.item_count)].filter(Boolean).join(' · '))),
    can('setlist.edit') && s.id !== current ? h('button', { type: 'button', class: 'icon-btn ch-del', 'aria-label': t('chDelete'), title: t('chDelete'), onclick: safely(async (e) => {
      if (!confirm(t('chDeleteConfirm', { name: s.name }))) return;
      await api.del(orgUrl(org.id, `/setlists/${enc(s.id)}`));
      e.target.closest('li')?.remove();
    }) }, icon('close')) : null));
  return h('section', { class: 'ch-card' },
    h('div', { class: 'ch-card-head' }, h('div', {}, h('h2', {}, t('chSetlists'))), newBtn),
    rows.length ? h('ul', { class: 'ch-setlists' }, rows) : h('p', { class: 'dim small' }, t('chNoSetlists')));
}

/** No church yet: say what churches are for, and offer to create one (not for the shared demos). */
function noChurch(el, app) {
  const body = [h('h1', { class: 'page-title' }, t('chNoChurchTitle')), h('p', { class: 'muted' }, t('chNoChurchSub'))];
  if (app.me?.is_demo) {
    body.push(h('p', { class: 'dim' }, t('chDemoNoChurch')));
  } else {
    const name = h('input', { class: 'ch-input', type: 'text', name: 'name', maxlength: '80', required: true, placeholder: t('chChurchNamePh') });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, t('chCreate'));
    const form = h('form', { class: 'ch-form ch-create' }, field(t('chChurchName'), name), h('div', {}, submit));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      safely(async () => {
        if (!name.value.trim()) return;
        const org = await api.post('/api/orgs', { name: name.value.trim(), language: getLang() });
        rememberChurch(org.id);
        const nav = document.getElementById('nav-church');
        if (nav) nav.hidden = false;
        await app.refresh();
      })({ currentTarget: submit });
    });
    body.push(form);
  }
  el.append(h('section', { class: 'ch-card ch-nochurch' }, body));
}

/** The church to show: the one asked for, else the one last shown, else the first. */
async function loadChurch(app, wanted) {
  const orgs = await api.get('/api/me/orgs');
  if (!orgs.length) return { orgs };
  const id = [wanted, rememberedChurch()].find((x) => x && orgs.some((o) => o.id === x)) || orgs[0].id;
  rememberChurch(id);
  const [org, setlists] = await Promise.all([api.get(orgUrl(id)), api.get(orgUrl(id, '/setlists'))]);
  return { orgs, org, setlists };
}

/** The setlist the dashboard opens on: the next service on or after today, else the latest. */
function upcoming(setlists) {
  const today = new Date().toISOString().slice(0, 10);
  const dated = setlists.filter((s) => s.service_date && s.service_date >= today).sort((a, b) => a.service_date.localeCompare(b.service_date));
  return dated[0] || setlists[0] || null;
}

// ---------------------------------------------------------------- views

/** #/church: the church dashboard. */
export async function church(el, params, app) {
  const { orgs, org, setlists } = await loadChurch(app, params.org);
  if (!org) return noChurch(el, app);
  const onChurchChange = (id) => { rememberChurch(id); app.refresh(); };
  const s = upcoming(setlists);
  if (!s) {
    el.append(h('div', { class: 'church' },
      h('header', { class: 'ch-head' }, h('div', { class: 'ch-badge' }, icon('library')),
        h('div', { class: 'ch-head-text' }, h('div', { class: 'ch-eyebrow' }, t(`chRole_${org.role}`)), h('h1', { class: 'ch-name' }, org.name))),
      setlistsCard({ org, setlists, current: null })));
    return;
  }
  await renderEditor(el, { org, orgs, setlistId: s.id, setlists, app, onChurchChange });
}

/** #/setlist/<id>?org=<orgId>: one setlist. */
export async function setlist(el, params, app) {
  const { orgs, org, setlists } = await loadChurch(app, params.org);
  if (!org) return noChurch(el, app);
  if (!setlists.some((s) => s.id === params.id)) throw Object.assign(new Error(t('pageNotFound')), { status: 404 });
  const onChurchChange = (id) => { rememberChurch(id); location.hash = '#/church'; };
  await renderEditor(el, { org, orgs, setlistId: params.id, setlists, app, onChurchChange });
}
