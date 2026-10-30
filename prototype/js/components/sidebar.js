// Sidebar: brand, nav, "Your hymns" library, language menu and sign out.
import { h, icon } from '../ui.js';
import { t, setLang, LANGUAGES } from '../i18n.js';
import { state, on } from '../state.js';
import { player } from '../player.js';
import { signIn } from '../main.js';
import { HYMNS } from '../data/hymns.js';
import { artFor } from '../views/home.js';

/** A language picker (<details> popover). en and ne are selectable; the rest are "coming soon". */
export function langPicker(cls = '') {
  const cur = LANGUAGES.find((l) => l.code === state.lang) || LANGUAGES[0];
  const details = h('details', { class: `lang-picker ${cls}` });
  details.append(
    h('summary', { class: 'lang-summary', 'aria-label': t('language') }, icon('globe'), h('span', { class: 'lang-current' }, cur.native)),
    h('div', { class: 'lang-pop', role: 'menu' },
      h('div', { class: 'lang-pop-title' }, t('language')),
      LANGUAGES.map((l) => h('button', {
        class: `lang-opt${l.code === state.lang ? ' active' : ''}`, role: 'menuitemradio',
        'aria-checked': String(l.code === state.lang), disabled: !l.ready,
        onclick: () => { details.open = false; if (l.code !== state.lang) setLang(l.code); },
      },
      h('span', {}, l.native),
      l.ready ? (l.code === state.lang ? icon('check') : null) : h('span', { class: 'soon' }, t('comingSoon'))))));
  return details;
}

// Close open language menus on an outside click or Escape (registered once).
addEventListener('click', (e) => {
  document.querySelectorAll('details.lang-picker[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('details.lang-picker[open]').forEach((d) => { d.open = false; });
});

let offs = [];

export function mountSidebar(el) {
  offs.forEach((f) => f()); offs = [];
  const navLink = (path, ic, key) => h('a', { class: 'nav-link', href: `#${path}`, dataset: { nav: path } }, icon(ic), h('span', {}, t(key)));
  const lib = h('ul', { class: 'lib-list' }, HYMNS.map((x) => h('li', {},
    h('button', { class: 'lib-item', dataset: { id: x.id }, title: x.title, onclick: () => player.play(x.id, HYMNS.map((y) => y.id)) },
      artFor(x, 'cover lib-cover'),
      h('span', { class: 'lib-text' }, h('span', { class: 'lib-title' }, x.title), h('span', { class: 'lib-sub' }, x.artist))))));
  const mark = () => {
    const cur = player.current?.id;
    lib.querySelectorAll('.lib-item').forEach((b) => b.classList.toggle('playing', b.dataset.id === cur));
  };
  el.append(
    h('a', { class: 'brand', href: '#/' },
      h('img', { src: 'img/icon.svg', alt: '', width: '32', height: '32' }),
      h('span', {}, 'Ainos', h('small', {}, t('brandSub')))),
    h('div', { class: 'nav' },
      navLink('/home', 'home', 'navHome'),
      navLink('/search', 'search', 'navSearch'),
      state.role === 'church' ? navLink('/church', 'church', 'navChurch') : null),
    h('section', { class: 'lib' },
      h('h2', { class: 'lib-head' }, icon('library'), h('span', {}, t('yourHymns'))),
      lib),
    h('div', { class: 'side-foot' },
      langPicker('lang-up'),
      h('button', { class: 'nav-link signout', onclick: () => signIn(null), title: t('signOut') }, icon('logout'), h('span', {}, t('signOut')))));
  mark();
  offs.push(on('player', () => { if (lib.isConnected) mark(); }));
}
