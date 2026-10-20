// Generated SVG artwork for albums, artists and playlists.
import { mulberry32 } from '../server/util.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function hsl(h, s, l) {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${s}% ${l}%)`;
}

/** Hex color for a hue, used for page header gradients. */
export function hexFromHsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function patternFor(style, rnd, hue) {
  const parts = [];
  const c1 = hsl(hue + 40, 80, 70), c2 = hsl(hue - 30, 70, 55), c3 = hsl(hue + 180, 60, 65);
  switch (style) {
    case 'ambient':
      for (let i = 0; i < 6; i++) parts.push(`<circle cx="${60 + rnd() * 180}" cy="${50 + rnd() * 160}" r="${30 + rnd() * 90}" fill="${i % 2 ? c1 : c3}" opacity="${0.12 + rnd() * 0.18}"/>`);
      break;
    case 'synthwave': {
      parts.push(`<circle cx="150" cy="150" r="78" fill="url(#sun)"/>`);
      for (let i = 0; i < 7; i++) parts.push(`<rect x="60" y="${152 + i * 11}" width="180" height="${3 + i * 0.6}" fill="${hsl(hue - 40, 60, 12)}"/>`);
      for (let i = 0; i < 9; i++) parts.push(`<line x1="${150 + (i - 4) * 12}" y1="230" x2="${150 + (i - 4) * 60}" y2="300" stroke="${c1}" stroke-width="1.5" opacity=".7"/>`);
      for (let i = 0; i < 5; i++) parts.push(`<line x1="0" y1="${232 + i * i * 3.5}" x2="300" y2="${232 + i * i * 3.5}" stroke="${c1}" stroke-width="1.2" opacity=".6"/>`);
      break;
    }
    case 'lofi':
      parts.push(`<rect x="70" y="60" width="160" height="130" rx="8" fill="${hsl(hue, 30, 22)}" stroke="${c1}" stroke-width="4"/>`);
      parts.push(`<line x1="150" y1="60" x2="150" y2="190" stroke="${c1}" stroke-width="3"/><line x1="70" y1="125" x2="230" y2="125" stroke="${c1}" stroke-width="3"/>`);
      for (let i = 0; i < 40; i++) parts.push(`<line x1="${rnd() * 300}" y1="${rnd() * 200}" x2="${rnd() * 300 - 6}" y2="${rnd() * 200 + 14}" stroke="${c3}" stroke-width="1" opacity=".35"/>`);
      break;
    case 'house':
      for (let i = 7; i > 0; i--) parts.push(`<rect x="${150 - i * 18}" y="${150 - i * 18}" width="${i * 36}" height="${i * 36}" fill="none" stroke="${i % 2 ? c1 : c2}" stroke-width="5" transform="rotate(${i * 6} 150 150)" opacity=".85"/>`);
      break;
    case 'acoustic':
      for (let i = 0; i < 9; i++) {
        const y = 60 + i * 22;
        parts.push(`<path d="M0 ${y} Q 75 ${y - 25 - rnd() * 20} 150 ${y} T 300 ${y}" fill="none" stroke="${i % 2 ? c1 : c2}" stroke-width="3" opacity=".7"/>`);
      }
      break;
    case 'chiptune':
      for (let x = 0; x < 10; x++) for (let y = 0; y < 8; y++) if (rnd() < 0.45) parts.push(`<rect x="${x * 30}" y="${y * 30}" width="30" height="30" fill="${[c1, c2, c3][Math.floor(rnd() * 3)]}" opacity=".85"/>`);
      break;
    case 'dub':
      for (let i = 0; i < 12; i++) parts.push(`<circle cx="150" cy="140" r="${10 + i * 14}" fill="none" stroke="${i % 3 ? c2 : c1}" stroke-width="${2 + (i % 3)}" opacity="${0.9 - i * 0.06}"/>`);
      break;
    case 'dnb':
      for (let i = 0; i < 14; i++) {
        const x = rnd() * 300, y = rnd() * 220, s = 20 + rnd() * 60;
        parts.push(`<polygon points="${x},${y} ${x + s},${y + s * 0.3} ${x + s * 0.2},${y + s}" fill="${i % 2 ? c1 : c3}" opacity="${0.25 + rnd() * 0.5}"/>`);
      }
      break;
    default:
      for (let i = 0; i < 8; i++) parts.push(`<circle cx="${rnd() * 300}" cy="${rnd() * 300}" r="${20 + rnd() * 60}" fill="${c1}" opacity=".2"/>`);
  }
  return parts.join('');
}

export function albumCover({ title, artist, style, hue, seed }) {
  const rnd = mulberry32(seed);
  const bgA = hsl(hue, 55, 26), bgB = hsl(hue + 50, 60, 12);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hsl(hue + 60, 95, 70)}"/><stop offset="1" stop-color="${hsl(hue - 20, 90, 55)}"/></linearGradient>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".65"/></linearGradient>
</defs>
<rect width="300" height="300" fill="url(#bg)"/>
${patternFor(style, rnd, hue)}
<rect width="300" height="300" fill="url(#fade)"/>
<text x="18" y="262" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#fff">${esc(title)}</text>
<text x="18" y="284" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13" fill="#fff" opacity=".8">${esc(artist)}</text>
</svg>`;
}

export function artistImage({ name, hue, seed }) {
  const rnd = mulberry32(seed);
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const blobs = Array.from({ length: 5 }, () => `<circle cx="${rnd() * 300}" cy="${rnd() * 300}" r="${60 + rnd() * 90}" fill="${hsl(hue + rnd() * 80 - 40, 70, 50 + rnd() * 15)}" opacity=".55"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
<defs><filter id="b"><feGaussianBlur stdDeviation="28"/></filter></defs>
<rect width="300" height="300" fill="${hsl(hue, 40, 18)}"/>
<g filter="url(#b)">${blobs}</g>
<text x="150" y="172" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="84" font-weight="800" fill="#fff" opacity=".92">${esc(initials)}</text>
</svg>`;
}
