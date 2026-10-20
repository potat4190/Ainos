// Minimal, safe Markdown renderer (builds DOM nodes; never uses innerHTML).
// Supports headings, paragraphs, lists, blockquotes, fenced code, tables,
// horizontal rules, links, bold, italics and inline code.
import { h } from './ui.js';

const slug = (s) => s.toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(h('code', {}, tok.slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, inline(tok.slice(2, -2))));
    else if (m[3]) out.push(h('em', {}, inline(tok.slice(1, -1))));
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = lm[2];
      const safe = /^(https?:\/\/|#|\/)/.test(href);
      const external = /^https?:/.test(href);
      out.push(safe ? h('a', { href, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null }, inline(lm[1])) : lm[1]);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src) {
  const root = h('div', { class: 'doc' });
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|>\s?|\s*[-*]\s|\s*\d+\.\s|\|.*\||---\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const level = m[1].length;
      root.append(h(`h${level}`, { id: slug(m[2]) }, inline(m[2])));
      i++;
    } else if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
    } else if (/^---\s*$/.test(line)) {
      root.append(h('hr'));
      i++;
    } else if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      const bq = h('blockquote');
      q.join('\n').split(/\n{2,}/).forEach((p) => bq.append(h('p', {}, inline(p.replace(/\n/g, ' ')))));
      root.append(bq);
    } else if (/^\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const table = h('table');
      const head = cells(rows[0]);
      table.append(h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))));
      const body = h('tbody');
      rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] || '') ? 2 : 1).forEach((r) => body.append(h('tr', {}, cells(r).map((c) => h('td', {}, inline(c))))));
      table.append(body);
      root.append(table);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      let li = null;
      while (i < lines.length && lines[i].trim() && (/^\s*([-*]|\d+\.)\s/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const l = lines[i];
        const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(l);
        if (item && !/^\s{2,}/.test(l)) {
          li = h('li', {}, inline(item[2]));
          list.append(li);
        } else if (item && li) {
          let sub = li.querySelector(':scope > ul, :scope > ol');
          if (!sub) { sub = h(/\d/.test(item[1]) ? 'ol' : 'ul'); li.append(sub); }
          sub.append(h('li', {}, inline(item[2])));
        } else if (li) {
          li.append(' ', ...inline(l.trim()));
        }
        i++;
      }
      root.append(list);
    } else {
      const p = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) p.push(lines[i++]);
      if (!p.length) p.push(lines[i++]);
      root.append(h('p', {}, inline(p.join(' '))));
    }
  }
  return root;
}
