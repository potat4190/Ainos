// PLACEHOLDER (listener agent replaces): login screen.
import { h } from '../ui.js';
import { t } from '../i18n.js';
import { signIn } from '../main.js';
export function render(el) {
  el.append(h('div', { class: 'login' }, h('h1', {}, t('loginTitle')),
    h('button', { class: 'btn btn-accent', onclick: () => signIn('listener') }, t('listenerDemo')),
    h('button', { class: 'btn', onclick: () => signIn('church') }, t('churchDemo'))));
}
