// Church dashboard: "This Sunday" header, setlist editor, paste-lyrics dialog
// and a slide preview strip. Everything is in memory (state.setlist).
import { h, icon, modal, toast, cover, clear } from '../ui.js';
import { state, set } from '../state.js';
import { t } from '../i18n.js';
import { parseLyrics, buildSlides, sectionName, sampleSetlist } from '../slides.js';
import { HYMNS, READINGS } from '../data/hymns.js';
import { openPresentDialog } from '../present/present.js';

// "Blessed Assurance", Fanny Crosby, 1873: public domain.
const SAMPLE_LABELLED = `Verse 1
Blessed assurance, Jesus is mine!
O what a foretaste of glory divine!
Heir of salvation, purchase of God,
Born of His Spirit, washed in His blood.

Chorus
This is my story, this is my song,
Praising my Savior all the day long;
This is my story, this is my song,
Praising my Savior all the day long.`;

const CHORUS = `This is my story, this is my song,
Praising my Savior all the day long;
This is my story, this is my song,
Praising my Savior all the day long.`;

const SAMPLE_UNLABELLED = `Blessed assurance, Jesus is mine!
O what a foretaste of glory divine!
Heir of salvation, purchase of God,
Born of His Spirit, washed in His blood.

${CHORUS}

Perfect submission, perfect delight,
Visions of rapture now burst on my sight;
Angels descending bring from above
Echoes of mercy, whispers of love.

${CHORUS}`;

const locale = () => (state.lang === 'ne' ? 'ne-NP' : 'en');
const num = (n) => new Intl.NumberFormat(locale()).format(n);
const plural = (base, n) => t(n === 1 ? `${base}1` : `${base}N`, { n: num(n) });
const uid = (p) => `${p}${Date.now()}${Math.floor(Math.random() * 1000)}`;
const hymnById = (id) => HYMNS.find((x) => x.id === id);
const hueFor = (s) => { let x = 7; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const firstWords = (s, n = 90) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

/** All Scripture passages that can be added: the readings plus the hymns' passages (deduplicated). */
function allPassages() {
  const seen = new Set();
  const readings = Object.values(READINGS).map((p) => { seen.add(p.ref); return { ...p }; });
  const fromHymns = [];
  for (const hymn of HYMNS) for (const p of hymn.scripture || []) if (!seen.has(p.ref)) { seen.add(p.ref); fromHymns.push({ ...p, hymn: hymn.title }); }
  return { readings, fromHymns };
}
const passageFor = (ref) => { const { readings, fromHymns } = allPassages(); return [...readings, ...fromHymns].find((p) => p.ref === ref); };

function nextSunday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}

/** Title, sub line and icon for a setlist row. */
function describe(item, slideCount) {
  const slides = plural('chSlides', slideCount);
  if (item.kind === 'song') {
    const hymn = hymnById(item.hymnId);
    return { title: hymn?.title ?? item.hymnId, sub: [t('chKindHymn'), hymn?.words, slides].filter(Boolean).join(' · '), kind: 'song' };
  }
  if (item.kind === 'pasted') return { title: item.title || t('chUntitled'), sub: `${t('chKindPasted')} · ${slides}`, kind: 'pasted' };
  if (item.kind === 'scripture') return { title: passageFor(item.ref)?.label ?? item.ref, sub: `${t('chKindScripture')} · WEB`, kind: 'scripture' };
  return { title: item.title || firstWords(String(item.text || ''), 40), sub: t('chKindText'), kind: 'text' };
}

const KIND_ICON = { scripture: 'book', text: 'text', pasted: 'paste', song: 'play' };

function rowArt(item) {
  if (item.kind === 'song') {
    const hymn = hymnById(item.hymnId);
    if (hymn) return cover(hueFor(hymn.id), '', 'cover ch-art');
  }
  return h('div', { class: `ch-art ch-art-${item.kind}` }, icon(KIND_ICON[item.kind] || 'text'));
}

/** A 16:9 slide thumbnail. */
export function slideThumb(slide, n) {
  const chars = slide.lines.join(' ').length;
  const size = slide.kind === 'title' ? 'fs-xl' : chars < 70 ? 'fs-l' : chars < 150 ? 'fs-m' : 'fs-s';
  const label = slide.kind === 'song' ? slide.label : slide.kind === 'title' ? t('chSlideTitle') : slide.kind === 'scripture' ? t('chSlideScripture') : t('chSlideText');
  let body;
  if (slide.kind === 'title') body = [h('div', { class: 'st-title' }, slide.title), slide.sub ? h('div', { class: 'st-sub' }, slide.sub) : null];
  else if (slide.kind === 'scripture') body = [h('div', { class: 'st-lines' }, slide.lines.map((l) => h('div', {}, l))), h('div', { class: 'st-sub' }, slide.title)];
  else body = h('div', { class: 'st-lines' }, slide.lines.map((l) => h('div', {}, l)));
  return h('figure', { class: `ch-slide kind-${slide.kind}`, dataset: { item: slide.itemId } },
    h('div', { class: `ch-screen ${size}` }, body),
    h('figcaption', {}, h('span', { class: 'ch-slide-label' }, label || ''), h('span', { class: 'ch-slide-no' }, num(n))));
}

export function render(el) {
  let items = (state.setlist ?? sampleSetlist()).map((x) => ({ ...x }));
  let dragId = null;

  const save = (next, focus) => {
    items = next;
    set({ setlist: items });
    refresh(focus);
  };
  const add = (item, title) => { save([...items, item]); toast(t('chAdded', { title })); };

  // ---- header ----
  const dateText = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(nextSunday());
  const summary = h('p', { class: 'ch-summary' });
  const presentBtn = h('button', {
    class: 'btn btn-accent ch-present',
    onclick: () => (items.length ? openPresentDialog(items) : toast(t('chNothingToPresent'))),
  }, icon('present'), t('chPresent'));
  const header = h('header', { class: 'ch-head' },
    h('div', { class: 'ch-badge' }, icon('church')),
    h('div', { class: 'ch-head-text' },
      h('div', { class: 'ch-eyebrow' }, t('chEyebrow')),
      h('h1', { class: 'ch-name' }, t('chName')),
      h('div', { class: 'ch-date' }, h('strong', {}, t('chThisSunday')), h('span', { class: 'ch-dot' }, '·'), h('span', {}, dateText)),
      summary),
    presentBtn);

  // ---- setlist ----
  const list = h('ol', { class: 'ch-list' });
  const addBar = h('div', { class: 'ch-addbar' },
    h('button', { class: 'ch-add', onclick: () => pickHymn(items, add) }, icon('play', 'icon ch-add-ic'), t('chAddHymn')),
    h('button', { class: 'ch-add', onclick: () => pickScripture(add) }, icon('book', 'icon ch-add-ic'), t('chAddScripture')),
    h('button', { class: 'ch-add', onclick: () => addTextSlide(add) }, icon('text', 'icon ch-add-ic'), t('chAddText')),
    h('button', { class: 'ch-add ch-add-strong', onclick: () => pasteLyrics(add) }, icon('paste', 'icon ch-add-ic'), t('chPasteLyrics')));
  const setlistCard = h('section', { class: 'ch-card' },
    h('div', { class: 'ch-card-head' },
      h('div', {}, h('h2', {}, t('chSetlistTitle')), h('p', { class: 'muted small' }, t('chSetlistSub'))),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { save(sampleSetlist()); toast(t('chResetDone')); } }, t('chReset'))),
    list, addBar);

  // ---- slide strip ----
  const strip = h('div', { class: 'ch-strip' });
  const stripCount = h('span', { class: 'ch-count' });
  const slidesCard = h('section', { class: 'ch-card' },
    h('div', { class: 'ch-card-head' },
      h('div', {}, h('h2', {}, t('chSlidesTitle'), ' ', stripCount), h('p', { class: 'muted small' }, t('chSlidesSub')))),
    strip);

  el.append(h('div', { class: 'church' }, header, setlistCard, slidesCard));

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    save(next, { id: items[i].id, btn: d < 0 ? 'up' : 'down' });
  }

  function highlight(id) {
    let first = null;
    for (const s of strip.querySelectorAll('.ch-slide')) {
      const on = s.dataset.item === id;
      s.classList.toggle('hl', on);
      if (on && !first) first = s;
    }
    first?.closest('.ch-group')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function row(item, i, count) {
    const d = describe(item, count);
    const li = h('li', { class: 'ch-row', draggable: 'true', dataset: { id: item.id } },
      h('span', { class: 'ch-grip', title: t('chDrag'), 'aria-hidden': 'true' }, '⋮⋮'),
      h('span', { class: 'ch-num' }, num(i + 1)),
      rowArt(item),
      h('button', { class: 'ch-row-main', onclick: () => highlight(item.id) },
        h('span', { class: 'ch-row-title' }, d.title),
        h('span', { class: 'ch-row-sub' }, d.sub)),
      h('div', { class: 'ch-row-actions' },
        h('button', { class: 'icon-btn', 'data-btn': 'up', 'aria-label': t('chMoveUp'), title: t('chMoveUp'), disabled: i === 0, onclick: () => move(i, -1) }, icon('up')),
        h('button', { class: 'icon-btn', 'data-btn': 'down', 'aria-label': t('chMoveDown'), title: t('chMoveDown'), disabled: i === items.length - 1, onclick: () => move(i, 1) }, icon('down')),
        h('button', { class: 'icon-btn ch-del', 'aria-label': t('chRemove'), title: t('chRemove'), onclick: () => { save(items.filter((x) => x.id !== item.id)); toast(t('chRemoved', { title: d.title })); } }, icon('trash'))));
    // HTML5 drag and drop: drop above or below the hovered row.
    li.addEventListener('dragstart', (e) => { dragId = item.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { dragId = null; for (const r of list.children) r.classList.remove('dragging', 'drop-before', 'drop-after'); });
    li.addEventListener('dragover', (e) => {
      if (!dragId || dragId === item.id) return;
      e.preventDefault();
      const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      if (!dragId || dragId === item.id) return;
      const moving = items.find((x) => x.id === dragId);
      const next = items.filter((x) => x.id !== dragId);
      const at = next.findIndex((x) => x.id === item.id) + (after ? 1 : 0);
      next.splice(at, 0, moving);
      dragId = null;
      save(next);
    });
    return li;
  }

  function refresh(focus) {
    const slides = buildSlides(items, t);
    const counts = new Map();
    for (const s of slides) counts.set(s.itemId, (counts.get(s.itemId) || 0) + 1);
    const songs = items.filter((x) => x.kind === 'song' || x.kind === 'pasted').length;
    summary.textContent = [plural('chItems', items.length), plural('chSongs', songs), plural('chSlides', slides.length)].join(' · ');
    presentBtn.disabled = !items.length;

    clear(list);
    if (!items.length) {
      list.append(h('li', { class: 'ch-empty' }, icon('church', 'icon ch-empty-ic'), h('strong', {}, t('chEmptyTitle')), h('span', { class: 'muted' }, t('chEmptySub'))));
    }
    items.forEach((item, i) => list.append(row(item, i, counts.get(item.id) || 0)));

    clear(strip);
    stripCount.textContent = num(slides.length);
    let n = 0;
    items.forEach((item, i) => {
      const own = slides.filter((s) => s.itemId === item.id);
      if (!own.length) return;
      strip.append(h('div', { class: 'ch-group' },
        h('div', { class: 'ch-group-head' }, h('span', { class: 'ch-num' }, num(i + 1)), describe(item, own.length).title),
        h('div', { class: 'ch-thumbs' }, own.map((s) => slideThumb(s, ++n)))));
    });

    if (focus) {
      const r = [...list.children].find((x) => x.dataset.id === focus.id);
      const b = r?.querySelector(`[data-btn="${focus.btn}"]`);
      (b && !b.disabled ? b : r?.querySelector('[data-btn]:not([disabled])'))?.focus();
    }
  }

  refresh();
}

// ---- dialogs ----

// Always pass at least one action: ui.js modal() appends a literal null otherwise.
const closeBtn = (getDlg) => h('button', { class: 'btn btn-ghost', onclick: () => getDlg().close() }, t('close'));

function pickHymn(items, add) {
  const inSet = new Set(items.filter((x) => x.kind === 'song').map((x) => x.hymnId));
  let dlg;
  const rows = HYMNS.map((hymn) => h('li', {},
    h('button', {
      class: 'ch-pick',
      onclick: () => { dlg.close(); add({ id: uid('h'), kind: 'song', hymnId: hymn.id }, hymn.title); },
    },
    cover(hueFor(hymn.id), '', 'cover ch-art'),
    h('span', { class: 'ch-pick-main' }, h('span', { class: 'ch-row-title' }, hymn.title), h('span', { class: 'ch-row-sub' }, hymn.words)),
    inSet.has(hymn.id) ? h('span', { class: 'ch-tag' }, t('chInSetlist')) : null,
    h('span', { class: 'ch-pick-add' }, icon('plus'), t('chAdd')))));
  dlg = modal({ title: t('chAddHymn'), content: [h('p', { class: 'muted small ch-modal-intro' }, t('chPickHymnSub')), h('ul', { class: 'ch-picklist' }, rows)], actions: [closeBtn(() => dlg)] });
}

function pickScripture(add) {
  const { readings, fromHymns } = allPassages();
  let dlg;
  const pick = (p) => h('li', {},
    h('button', { class: 'ch-pick', onclick: () => { dlg.close(); add({ id: uid('r'), kind: 'scripture', ref: p.ref }, p.label); } },
      h('div', { class: 'ch-art ch-art-scripture' }, icon('book')),
      h('span', { class: 'ch-pick-main' },
        h('span', { class: 'ch-row-title' }, p.label, p.hymn ? h('span', { class: 'ch-with' }, t('chWithHymn', { title: p.hymn })) : null),
        h('span', { class: 'ch-row-sub ch-quote' }, firstWords(p.text))),
      h('span', { class: 'ch-pick-add' }, icon('plus'), t('chAdd'))));
  dlg = modal({
    title: t('chAddScripture'),
    content: [
      h('h3', { class: 'ch-modal-h' }, t('chReadings')), h('ul', { class: 'ch-picklist' }, readings.map(pick)),
      h('h3', { class: 'ch-modal-h' }, t('chHymnPassages')), h('ul', { class: 'ch-picklist' }, fromHymns.map(pick)),
      h('p', { class: 'dim small ch-modal-foot' }, t('chScriptureNote')),
    ],
    actions: [closeBtn(() => dlg)],
  });
}

function field(label, control) {
  return h('label', { class: 'ch-field' }, h('span', { class: 'ch-field-label' }, label), control);
}

function addTextSlide(add) {
  const title = h('input', { class: 'ch-input', type: 'text', maxlength: '80', placeholder: t('chTextTitlePh') });
  const text = h('textarea', { class: 'ch-input', rows: '4', maxlength: '400', placeholder: t('chTextBodyPh') });
  const preview = h('div', { class: 'ch-text-preview' });
  const ok = h('button', { class: 'btn btn-accent', disabled: true }, t('chAddToSetlist'));
  const update = () => {
    const tt = title.value.trim();
    const body = text.value.trim() || tt;
    ok.disabled = !body;
    clear(preview);
    if (body) preview.append(slideThumb({ itemId: 'preview', kind: 'text', title: tt, lines: body.split('\n') }, 1));
  };
  title.addEventListener('input', update);
  text.addEventListener('input', update);
  const dlg = modal({
    title: t('chAddText'),
    content: h('div', { class: 'ch-form' }, field(t('chTextTitle'), title), field(t('chTextBody'), text), preview),
    actions: [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, t('cancel')), ok],
  });
  ok.addEventListener('click', () => {
    const tt = title.value.trim();
    const body = text.value.trim() || tt;
    if (!body) return;
    dlg.close();
    add({ id: uid('t'), kind: 'text', title: tt || firstWords(body.split('\n')[0], 40), text: body }, tt || firstWords(body.split('\n')[0], 40));
  });
  title.focus();
}

function pasteLyrics(add) {
  const title = h('input', { class: 'ch-input', type: 'text', maxlength: '100', placeholder: t('chSongTitlePh') });
  const text = h('textarea', { class: 'ch-input ch-lyrics', rows: '14', spellcheck: 'false', placeholder: t('chLyricsPh') });
  const note = h('p', { class: 'dim small ch-sample-note', hidden: true }, t('chSampleNote'));
  const sectionsEl = h('div', { class: 'ch-sections' });
  const slidesEl = h('div', { class: 'ch-thumbs ch-thumbs-sm' });
  const slideCount = h('span', { class: 'ch-count' });
  const ok = h('button', { class: 'btn btn-accent', disabled: true }, icon('plus'), t('chAddToSetlist'));
  let sections = [];

  const update = () => {
    sections = parseLyrics(text.value);
    ok.disabled = !sections.length;
    clear(sectionsEl);
    clear(slidesEl);
    if (!sections.length) {
      sectionsEl.append(h('p', { class: 'dim small' }, t('chPasteEmpty')));
      slideCount.textContent = '';
      return;
    }
    for (const s of sections) {
      sectionsEl.append(h('div', { class: `ch-sec sec-${s.label[0]}` },
        h('span', { class: 'ch-sec-label' }, sectionName(s.label, t)),
        h('span', { class: 'ch-sec-first' }, s.lines[0]),
        h('span', { class: 'ch-sec-n' }, num(s.lines.length))));
    }
    const slides = buildSlides([{ id: 'preview', kind: 'pasted', title: title.value.trim() || t('chUntitled'), sections }], t);
    slideCount.textContent = num(slides.length);
    slides.forEach((s, i) => slidesEl.append(slideThumb(s, i + 1)));
  };
  const fill = (lyrics) => { if (!title.value.trim()) title.value = 'Blessed Assurance'; text.value = lyrics; note.hidden = false; update(); text.focus(); };
  title.addEventListener('input', update);
  text.addEventListener('input', update);

  const left = h('div', { class: 'ch-paste-left' },
    field(t('chSongTitle'), title),
    h('div', { class: 'ch-field' },
      h('div', { class: 'ch-field-row' },
        h('span', { class: 'ch-field-label' }, t('chLyrics')),
        h('span', { class: 'ch-samples' },
          h('button', { class: 'ch-link', type: 'button', onclick: () => fill(SAMPLE_LABELLED) }, t('chTrySample')),
          h('button', { class: 'ch-link', type: 'button', onclick: () => fill(SAMPLE_UNLABELLED) }, t('chTrySampleAuto')))),
      text),
    note,
    h('ul', { class: 'ch-help small muted' }, ['chHelp1', 'chHelp2', 'chHelp3', 'chHelp4'].map((k) => h('li', {}, t(k)))));
  const right = h('div', { class: 'ch-paste-right' },
    h('h3', { class: 'ch-modal-h' }, t('chSections')), sectionsEl,
    h('h3', { class: 'ch-modal-h' }, t('chSlidesTitle'), ' ', slideCount), slidesEl);

  const dlg = modal({
    title: t('chPasteLyrics'),
    wide: true,
    content: h('div', { class: 'ch-paste' }, left, right),
    actions: [h('button', { class: 'btn btn-ghost', onclick: () => dlg.close() }, t('cancel')), ok],
  });
  ok.addEventListener('click', () => {
    if (!sections.length) return;
    const name = title.value.trim() || t('chUntitled');
    dlg.close();
    add({ id: `p${Date.now()}`, kind: 'pasted', title: name, sections }, name);
  });
  update();
  title.focus();
}
