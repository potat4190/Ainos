// Slide splitter (AINOS-SPEC.md 4.3), pure: used by the setlist slides route
// and mirrored in the browser for previews. Owner: Phase 6.

/**
 * toSlides(sections, arrangement, { maxLines = 4, timings = null })
 *   sections: [{ label: 'V1', lines: ['…', '…'] }]   arrangement: ['V1', 'C', 'V2', 'C']
 *   timings: [{ label, line, ms }] for ONE recording, or null
 * → [{ id: `${label}-${repeatIndex}-${n}`, label, lines: [...], sectionIndex, repeatIndex, startMs? }]
 *
 * - Labels are walked in arrangement order; a label with no section (or no lines, like an
 *   intro `I`) gives no slides but still counts as an occurrence for repeatIndex.
 * - A section is split into ceil(lines / maxLines) slides, never mid-line, balanced so the
 *   sizes differ by at most one, larger first (5 lines, max 4 → 3 + 2).
 * - repeatIndex is the 0-based occurrence of the label in the arrangement; n is the 0-based
 *   slide within that occurrence.
 * - timings: `line` is the 0-based line index within the section. The timings list the
 *   recorded passes in order, so for each label they form groups (a new group starts when
 *   the line index does not increase); the k-th occurrence of a label uses its k-th group.
 *   A slide's startMs is the ms of its first line in that group (or of its earliest timed
 *   line, if the first line is missing). No timings → no startMs.
 */
export function toSlides(sections, arrangement, { maxLines = 4, timings = null } = {}) {
  const max = Math.max(1, Math.floor(Number(maxLines)) || 4);
  const byLabel = new Map();
  (Array.isArray(sections) ? sections : []).forEach((s, i) => {
    if (s && typeof s.label === 'string' && !byLabel.has(s.label)) byLabel.set(s.label, { section: s, index: i });
  });
  const groups = timingGroups(timings);
  const seen = new Map();
  const out = [];
  for (const label of Array.isArray(arrangement) ? arrangement : []) {
    const repeatIndex = seen.get(label) || 0;
    seen.set(label, repeatIndex + 1);
    const entry = byLabel.get(label);
    if (!entry) continue;
    const lines = normalizeLines(entry.section.lines);
    if (!lines.length) continue;
    const group = groups?.get(label)?.[repeatIndex] || null;
    let first = 0;
    splitSizes(lines.length, max).forEach((size, n) => {
      const slide = { id: `${label}-${repeatIndex}-${n}`, label, lines: lines.slice(first, first + size), sectionIndex: entry.index, repeatIndex };
      if (group) {
        const ms = startFor(group, first, first + size);
        if (ms != null) slide.startMs = ms;
      }
      out.push(slide);
      first += size;
    });
  }
  return out;
}

/** Balanced chunk sizes: n lines into ceil(n / max) slides, sizes differing by at most one. */
export function splitSizes(n, max) {
  if (n <= 0) return [];
  const k = Math.ceil(n / max);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

function normalizeLines(lines) {
  const list = Array.isArray(lines) ? lines : typeof lines === 'string' ? lines.split(/\r?\n/) : [];
  return list.map((l) => String(l ?? '').trim()).filter(Boolean);
}

/** label → [Map(line → ms), ...] one map per recorded pass, in order. */
function timingGroups(timings) {
  if (!Array.isArray(timings) || !timings.length) return null;
  const groups = new Map();
  const lastLine = new Map();
  for (const t of timings) {
    if (!t || typeof t.label !== 'string') continue;
    const line = Number(t.line);
    const ms = Number(t.ms);
    if (!Number.isInteger(line) || line < 0 || !Number.isFinite(ms) || ms < 0) continue;
    if (!groups.has(t.label)) groups.set(t.label, []);
    const list = groups.get(t.label);
    const prev = lastLine.get(t.label);
    if (prev === undefined || line <= prev) list.push(new Map());
    lastLine.set(t.label, line);
    const cur = list[list.length - 1];
    if (!cur.has(line)) cur.set(line, ms);
  }
  return groups;
}

function startFor(group, from, to) {
  if (group.has(from)) return group.get(from);
  let best = null;
  for (let l = from + 1; l < to; l++) if (group.has(l)) { best = group.get(l); break; }
  return best;
}
