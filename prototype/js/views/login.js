// Login: a full-screen welcome with the two demo entry points.
import { h, icon } from '../ui.js';
import { t } from '../i18n.js';
import { signIn } from '../main.js';
import { langPicker } from '../components/sidebar.js';

export function render(el) {
  const demo = (role, ic, key, subKey, accent) => h('button', {
    class: `login-demo${accent ? ' login-demo-accent' : ''}`, onclick: () => signIn(role),
  },
  h('span', { class: 'login-demo-icon' }, icon(ic)),
  h('span', { class: 'login-demo-text' }, h('span', { class: 'login-demo-title' }, t(key)), h('span', { class: 'login-demo-sub' }, t(subKey))),
  icon('chevron-right', 'icon login-demo-arrow'));

  el.className = 'login';
  el.append(
    h('div', { class: 'login-glow', 'aria-hidden': 'true' }),
    h('div', { class: 'login-top' }, langPicker('lang-down')),
    h('div', { class: 'login-card' },
      h('div', { class: 'login-brand' },
        h('img', { src: 'img/icon.svg', alt: '', width: '56', height: '56' }),
        h('div', {}, h('div', { class: 'login-name' }, 'Ainos'), h('div', { class: 'login-brandsub' }, t('brandSub')))),
      h('h1', { class: 'login-title' }, t('loginTitle')),
      h('p', { class: 'login-sub' }, t('loginSub')),
      h('div', { class: 'login-demos' },
        demo('listener', 'play', 'listenerDemo', 'listenerDemoSub', true),
        demo('church', 'church', 'churchDemo', 'churchDemoSub', false)),
      h('p', { class: 'login-note dim small' }, t('loginNote'))));
}
