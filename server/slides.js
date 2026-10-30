// Slide splitter (AINOS-SPEC.md 4.3), pure: used by the setlist slides route
// and mirrored in the browser for previews. Owner: Phase 6.

/**
 * toSlides(sections, arrangement, { maxLines = 4, timings = null })
 *   sections: [{ label: 'V1', lines: ['…', '…'] }]   arrangement: ['V1', 'C', 'V2', 'C']
 *   timings: [{ label, line, ms }] for ONE recording, or null
 * → [{ id: `${label}-${repeatIndex}-${n}`, label, lines: [...], sectionIndex, repeatIndex, startMs? }]
 */
export function toSlides(sections, arrangement, { maxLines = 4, timings = null } = {}) { // eslint-disable-line no-unused-vars
  return [];
}
