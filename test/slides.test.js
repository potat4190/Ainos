// Slide splitter (AINOS-SPEC.md 4.3): balanced splitting, deterministic ids,
// repeats, and startMs from one recording's timings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlides, splitSizes } from '../server/slides.js';

const L = (n, p = 'l') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

test('balanced splitting never splits mid-line and evens out the slides', () => {
  assert.deepEqual(splitSizes(5, 4), [3, 2]);
  assert.deepEqual(splitSizes(4, 4), [4]);
  assert.deepEqual(splitSizes(9, 4), [3, 3, 3]);
  assert.deepEqual(splitSizes(6, 4), [3, 3]);
  assert.deepEqual(splitSizes(7, 2), [2, 2, 2, 1]);
  assert.deepEqual(splitSizes(1, 3), [1]);
  assert.deepEqual(splitSizes(0, 4), []);
  const slides = toSlides([{ label: 'V1', lines: L(5) }], ['V1']);
  assert.deepEqual(slides.map((s) => s.lines), [['l1', 'l2', 'l3'], ['l4', 'l5']]);
  assert.deepEqual(toSlides([{ label: 'V1', lines: L(5) }], ['V1'], { maxLines: 2 }).map((s) => s.lines.length), [2, 2, 1]);
});

test('ids are deterministic: label-repeatIndex-n', () => {
  const sections = [{ label: 'V1', lines: L(5, 'v') }, { label: 'C', lines: L(2, 'c') }, { label: 'V2', lines: L(3, 'w') }];
  const a = toSlides(sections, ['V1', 'C', 'V2', 'C']);
  assert.deepEqual(a.map((s) => s.id), ['V1-0-0', 'V1-0-1', 'C-0-0', 'V2-0-0', 'C-1-0']);
  assert.deepEqual(a.map((s) => s.sectionIndex), [0, 0, 1, 2, 1]);
  assert.deepEqual(a.map((s) => s.repeatIndex), [0, 0, 0, 0, 1]);
  assert.deepEqual(toSlides(sections, ['V1', 'C', 'V2', 'C']), a, 'same input, same output');
  assert.ok(a.every((s) => !('startMs' in s)), 'no timings → no startMs');
});

test('repeats reuse the section text; unknown and empty labels give no slides', () => {
  const sections = [{ label: 'I', lines: [] }, { label: 'C', lines: 'c1\n\n c2 \r\nc3' }];
  const s = toSlides(sections, ['I', 'C', 'X', 'C', 'C']);
  assert.deepEqual(s.map((x) => x.id), ['C-0-0', 'C-1-0', 'C-2-0']);
  assert.deepEqual(s[2].lines, ['c1', 'c2', 'c3']);
  assert.deepEqual(toSlides(null, null), []);
  assert.deepEqual(toSlides([{ label: 'V1', lines: L(2) }], []), []);
});

test('startMs comes from the first line of the matching recorded pass', () => {
  const sections = [{ label: 'V1', lines: L(5) }, { label: 'C', lines: L(2) }];
  const timings = [
    ...L(5).map((_, i) => ({ label: 'V1', line: i, ms: 1000 + i * 1000 })), // 1000..5000
    { label: 'C', line: 0, ms: 6000 }, { label: 'C', line: 1, ms: 7000 },
    { label: 'C', line: 0, ms: 20000 }, { label: 'C', line: 1, ms: 21000 },
  ];
  const s = toSlides(sections, ['V1', 'C', 'C'], { timings });
  assert.deepEqual(s.map((x) => [x.id, x.startMs]), [['V1-0-0', 1000], ['V1-0-1', 4000], ['C-0-0', 6000], ['C-1-0', 20000]]);
});

test('missing timings: the earliest timed line of the slide, else no startMs', () => {
  const sections = [{ label: 'V1', lines: L(4) }, { label: 'C', lines: L(1) }];
  const timings = [{ label: 'V1', line: 1, ms: 1500 }, { label: 'V1', line: 3, ms: 3500 }, { label: 'C', line: 0, ms: 5000 }, { label: 'bogus', line: 'x', ms: 1 }];
  const s = toSlides(sections, ['V1', 'C', 'C'], { maxLines: 2, timings });
  assert.deepEqual(s.map((x) => x.startMs), [1500, 3500, 5000, undefined], 'the second chorus pass was not recorded');
});
