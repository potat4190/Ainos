// App shell: hash routes, layout regions and re-render on language change.
//
// Layout (signed in):            Routes:
//   #sidebar | #main | #right      #/            → home (listener) or church (church role)
//   #playerbar (full width)        #/home        → listener home
//                                  #/search?q=…  → search
//                                  #/church      → church dashboard
// Signed out (state.role null): the login screen fills the page.
import { h, clear } from './ui.js';
import { state, on, set } from './state.js';
import { t } from './i18n.js';
import { render as renderLogin } from './views/login.js';
import { render as renderHome } from './views/home.js';
import { render as renderSearch } from './views/search.js';
import { render as renderChurch } from './views/church.js';
import { mountSidebar } from './components/sidebar.js';
import { mountPlayerBar } from './components/playerbar.js';
import { mountNowPlaying } from './components/nowplaying.js';

const root = document.getElementById('root');
let shell = null;

function parseRoute() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  return { path: path || '/', query: new URLSearchParams(qs || '') };
}

function buildShell() {
  const sidebar = h('nav', { id: 'sidebar', class: 'sidebar panel', 'aria-label': 'Main' });
  const main = h('main', { id: 'main', class: 'main panel', tabindex: '-1' });
  const right = h('aside', { id: 'right', class: 'right panel', 'aria-label': 'Now playing' });
  const bar = h('footer', { id: 'playerbar', class: 'playerbar' });
  const el = h('div', { class: 'app' }, sidebar, main, right, bar);
  mountSidebar(sidebar);
  mountPlayerBar(bar);
  mountNowPlaying(right);
  return { el, main };
}

export function route() {
  document.getElementById('proto-badge').textContent = t('prototypeBadge');
  if (!state.role) {
    shell = null;
    clear(root).append(h('div', { id: 'login' }));
    renderLogin(root.firstChild);
    return;
  }
  if (!shell) { shell = buildShell(); clear(root).append(shell.el); }
  const { path, query } = parseRoute();
  const main = clear(shell.main);
  main.scrollTop = 0;
  if (path === '/search') renderSearch(main, query.get('q') || '');
  else if (path === '/church' || (path === '/' && state.role === 'church')) renderChurch(main);
  else renderHome(main);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (path === '/' ? (state.role === 'church' ? '/church' : '/home') : path)));
}

/** Sign in to a demo ('listener' | 'church') or out (null). */
export function signIn(role) {
  set({ role });
  shell = null;
  location.hash = role === 'church' ? '#/church' : '#/home';
  route();
}

addEventListener('hashchange', route);
on('lang', () => { shell = null; route(); });
document.documentElement.lang = state.lang;
route();
