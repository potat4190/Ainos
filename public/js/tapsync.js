// Tap-to-sync (spec 4.4): a leader plays a recording and taps (button or
// Space) as each lyric line begins; each time can be nudged by 100 ms and the
// whole list shifted, then it is saved for that one recording (never the
// song). A church leader saves for their church; a catalog admin for everyone.
// The server checks the role and every line again.
import { h, icon, clear, toast, safely } from './ui.js';
import { api } from './api.js';
import { t, sectionName } from './i18n.js';

const SYNC_ROLES = ['admin', 'leader'];
const NUDGE_MS = 100;
let targets = null;

/** Where this user may save timings: their churches as admin or leader, and "everyone" for catalog admins. Cached for a minute. */
export function syncTargets() {
  if (targets && Date.now() - targets.at < 60_000) return targets.promise;
  const promise = Promise.all([api.get('/api/me'), api.get('/api/me/orgs')])
    .then(([me, orgs]) => [
      ...orgs.filter((o) => SYNC_ROLES.includes(o.role)).map((o) => ({ orgId: o.id, name: o.name })),
      ...(me.is_admin ? [{ orgId: null, name: t('syncEveryone') }] : []),
    ])
    .catch(() => []);
  targets = { at: Date.now(), promise };
  return promise;
}

const fmtMs = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Open the sync dialog for `track` (what the player is playing, native or
 * YouTube). `lines`: [{ label, line, text }] in the order they are sung;
 * `existing`: [{ label, line, ms }] from an earlier sync to start from.
 */
export function openTapSync(app, { track, sourceId, language, lines, existing = [], offsetMs = 0, targetList, onSaved }) {
  const times = lines.map((ln, i) => {
    const hit = existing[i];
    return hit && hit.label === ln.label && hit.line === ln.line ? hit.ms : NaN;
  });
  let cursor = times.findIndex((x) => !Number.isFinite(x));
  if (cursor < 0) cursor = lines.length;

  const playingThis = () => app.player.view().track?.id === track.id;
  const clock = h('span', { class: 'sync-clock' });
  const status = h('p', { class: 'dim small', role: 'status' });
  const offset = h('input', { class: 'ch-input sync-offset', type: 'number', step: '50', min: '-60000', max: '60000', value: String(offsetMs), 'aria-label': t('syncOffset') });
  const target = h('select', { class: 'ch-switch', 'aria-label': t('syncFor') },
    targetList.map((x, i) => h('option', { value: String(i) }, x.name)));
  const rows = lines.map((ln, i) => {
    const time = h('span', { class: 'sync-time' });
    const nudge = (d, label, ic) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${label}: ${ln.text}`, title: label,
      onclick: () => { if (Number.isFinite(times[i])) { times[i] = Math.max(0, times[i] + d); render(); } } }, ic);
    const row = h('li', { class: 'sync-row' },
      h('span', { class: 'sync-label dim small' }, sectionName(ln.label)),
      h('span', { class: 'sync-text' }, ln.text),
      time,
      nudge(-NUDGE_MS, t('syncNudgeEarlier'), '−'),
      nudge(NUDGE_MS, t('syncNudgeLater'), '+'));
    row.addEventListener('click', (e) => { if (!e.target.closest('button')) { cursor = i; render(); } });
    return { row, time };
  });
  const list = h('ol', { class: 'sync-list' }, rows.map((r) => r.row));

  function render() {
    rows.forEach(({ row, time }, i) => {
      time.textContent = fmtMs(times[i]);
      row.classList.toggle('next', i === cursor);
      row.classList.toggle('done', Number.isFinite(times[i]));
    });
    const left = times.filter((x) => !Number.isFinite(x)).length;
    status.textContent = playingThis() ? (left ? t('syncLeft', { n: left }) : t('syncAllTapped')) : t('syncNotPlaying');
    rows[Math.min(cursor, rows.length - 1)]?.row.scrollIntoView({ block: 'nearest' });
  }

  function tap() {
    if (!playingThis() || cursor >= lines.length) return;
    times[cursor] = Math.round(app.player.view().positionMs);
    cursor = times.findIndex((x, i) => i > cursor && !Number.isFinite(x));
    if (cursor < 0) cursor = lines.length;
    render();
  }
  function undo() {
    const last = cursor > 0 ? cursor - 1 : lines.length - 1;
    times[last] = NaN;
    cursor = last;
    render();
  }

  const tapBtn = h('button', { type: 'button', class: 'btn btn-primary sync-tap' }, t('syncTap'));
  tapBtn.addEventListener('click', tap);
  const fromStart = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('play'), t('syncStart'));
  fromStart.addEventListener('click', () => {
    app.player.seek(0);
    if (!app.player.view().isPlaying) app.player.toggle();
    cursor = 0;
    render();
  });
  const undoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, t('syncUndo'));
  undoBtn.addEventListener('click', undo);
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, t('syncSave'));
  save.addEventListener('click', safely(async () => {
    const left = times.filter((x) => !Number.isFinite(x)).length;
    if (left) { toast(t('syncIncomplete', { n: left }), { error: true }); return; }
    if (times.some((x, i) => i > 0 && x <= times[i - 1])) { toast(t('syncOrder'), { error: true }); return; }
    const where = targetList[Number(target.value)] || targetList[0];
    await api.put(`/api/sources/${encodeURIComponent(sourceId)}/timings`, {
      org_id: where.orgId, language, offset_ms: Math.round(Number(offset.value) || 0),
      timings: lines.map((ln, i) => ({ label: ln.label, line: ln.line, ms: times[i] })),
    });
    toast(t('syncSaved'));
    dlg.close();
    onSaved?.();
  }));
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => dlg.close() }, t('cancel'));

  const dlg = h('dialog', { class: 'ch-dialog ch-dialog-wide sync-dialog', 'aria-label': t('syncTitle') },
    h('div', { class: 'ch-dlg-head' }, h('h2', {}, t('syncTitle')), h('button', { type: 'button', class: 'icon-btn ch-dlg-close', 'aria-label': t('cancel'), onclick: () => dlg.close() }, icon('close'))),
    h('div', { class: 'ch-dlg-body' },
      h('p', { class: 'muted small' }, t('syncHelp')),
      h('div', { class: 'sync-controls' }, fromStart, tapBtn, undoBtn, clock),
      status,
      list,
      h('div', { class: 'sync-options' },
        h('label', { class: 'ch-preview-label' }, t('syncOffset'), offset),
        targetList.length > 1 ? h('label', { class: 'ch-preview-label' }, t('syncFor'), target) : null)),
    h('div', { class: 'dialog-actions' }, cancel, save));

  // Space taps, unless typing in a field; the YouTube player itself keeps its own keys.
  dlg.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Spacebar') && !e.target.closest('input, select, textarea')) { e.preventDefault(); tap(); }
  });
  // The time shown, four times a second while the dialog is open.
  const timer = setInterval(() => { clock.textContent = playingThis() ? fmtMs(app.player.view().positionMs) : '—'; }, 250);
  dlg.addEventListener('close', () => { clearInterval(timer); dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
  render();
  tapBtn.focus();
  return dlg;
}

/** The "Sync lyrics" button for the lyrics view, added once the user turns out to be allowed to sync. */
export function syncButton(app, opts, host) {
  syncTargets().then((list) => {
    if (!list.length) return;
    clear(host).append(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openTapSync(app, { ...opts, targetList: list }) },
      icon('clock'), t('syncLyrics')));
  });
}
