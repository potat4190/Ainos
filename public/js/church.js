// Church views (Phase 5): dashboard, setlists, paste lyrics. Owner: Phase 5.
import { h } from './ui.js';
import { t } from './i18n.js';

/** Called once when the app starts, with the signed-in user in app.me. */
export function onStart(app) { // eslint-disable-line no-unused-vars
}

/** #/church: the church dashboard. */
export async function church(el, params, app) { // eslint-disable-line no-unused-vars
  el.append(h('h1', { class: 'page-title' }, t('navChurch')));
}

/** #/setlist/<id>: one setlist. */
export async function setlist(el, params, app) { // eslint-disable-line no-unused-vars
  el.append(h('h1', { class: 'page-title' }, t('navChurch')));
}
