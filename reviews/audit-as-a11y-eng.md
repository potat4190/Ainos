# Accessibility Audit: Ainos web app (week 4 UI pass)

**Perspective**: Accessibility Engineer
**Date**: 2026-10-28
**Plan**: `public/` (index.html, css/app.css, js/app.js, js/views.js, js/ui.js), checked in the browser at 1280×800 and 390×844

## Plan Summary
Vanilla-JS single-page app with a track table, context menus, custom sliders, a modal dialog and toasts. The main risks are hover-only controls, drag-only reordering and custom widgets without full keyboard support.

## Files Reviewed
| File | A11y Role | Risk |
|------|----------|------|
| public/index.html | Landmarks, player bar, sliders, nav | Medium |
| public/css/app.css | Focus styles, hover-only reveals, target sizes, motion | High |
| public/js/ui.js | Menus, dialog, sliders, toasts | High |
| public/js/views.js | Track list, settings controls, empty states | High |
| public/js/app.js | Routing, focus after navigation, login | Medium |

## Verdict: APPROVE WITH CHANGES

## Critical Issues (Must Fix)
| # | Issue | WCAG Criterion | File(s) | Impact | Fix |
|---|-------|---------------|---------|--------|-----|
| 1 | Track-row Like / More buttons and the row Play button are `opacity: 0` until mouse hover; shortcut Play buttons too. Keyboard users tab onto invisible controls. | 2.4.7 Focus Visible | app.css | Keyboard users can't see what they're on | Reveal on `:focus-within` as well as `:hover` |
| 2 | Playlist reordering is drag-and-drop only | 2.1.1 Keyboard, 2.5.7 Dragging | views.js | Keyboard and switch users can't reorder | "Move up" / "Move down" in the track menu |
| 3 | Context menu (`role="menu"`) has no arrow-key navigation and drops focus to `<body>` on close | 2.1.1 Keyboard, 2.4.3 Focus Order | ui.js | Menus are hard to use without a mouse | Arrow/Home/End navigation; return focus to the opener |
| 4 | Track list uses `role="grid"` / `role="row"` with no cells | 4.1.2 Name, Role, Value | views.js | Screen readers announce a broken grid | Use list semantics |
| 5 | Settings selects and toggles have no accessible name (the label is a separate div) | 4.1.2, 1.3.1 | views.js | "combo box, Automatic" with no idea what it sets | `aria-label` from the row title |

## Recommendations
| # | Issue | WCAG Criterion | Fix |
|---|-------|---------------|-----|
| 6 | No skip link past the sidebar | 2.4.1 Bypass Blocks | "Skip to content" link to `#main` |
| 7 | Page changes are silent: focus stays on the clicked link | 4.1.3 Status Messages, 2.4.3 | Move focus to `<main>` after user navigation |
| 8 | Seek slider announces "37" (percent), not a time | 4.1.2 | `aria-valuetext` "1:12 of 3:05"; Home/End keys |
| 9 | Phone: icon buttons 28–32 px | 2.5.8 Target Size (AA 24 px), 44 px platform guidance | 44 px targets under 680 px |
| 10 | Error toast white on #e91429 is about 4.4:1 | 1.4.3 Contrast | Darker red; errors stay 6 s instead of 2.8 s |
| 11 | Blank screen while the session check loads | 4.1.3 | Loading status in the page shell |

## Nice-to-Haves
| # | Suggestion | Rationale |
|---|------------|-----------|
| 12 | Equalizer animation's `aria-label` sits on a plain span | Ignored by screen readers; the row's playing state could be text |

## Keyboard Navigation Walkthrough
| Step | Action | Expected Focus | Expected Announcement | Plan Handles? |
|------|--------|---------------|----------------------|---------------|
| 1 | Tab from page start | Skip link | "Skip to content, link" | After fix |
| 2 | Enter on skip link | Main content | Page heading region | After fix |
| 3 | Tab into a track row | Row, then Play / Like / More | Each button named | After fix (were invisible) |
| 4 | Enter on More | First menu item | "Add to queue, menu item" | Yes |
| 5 | Arrow Down / Up in menu | Next / previous item | Item name | After fix |
| 6 | Escape | Back on More button | "More options for …, button" | After fix |
| 7 | Arrow keys on seek slider | Slider | "1:12 of 3:05" | After fix |
| 8 | Edit playlist details | Dialog field | Dialog title | Yes (native `showModal`) |

## ARIA Checklist
| Element | Role | Label | States | Keyboard | Notes |
|---------|------|-------|--------|----------|-------|
| Player buttons | button | Yes, translated | aria-pressed on toggles | Yes | OK |
| Seek / volume | slider | Yes | valuenow; valuetext after fix | Arrows, Home/End | |
| Context menu | menu / menuitem | Items labelled | — | After fix | |
| Track list | list / listitem | List labelled by context | — | Enter plays a row | After fix |
| Toasts | status / alert in a polite live region | — | — | — | OK |
| Edit dialog | dialog (native) | Heading | — | Esc closes, focus returns | OK |

## Verdict Details
- Screen Reader Compatibility: CONCERNS (grid roles, unnamed settings controls), fixed in this pass
- Keyboard Navigation: CONCERNS (hover-only buttons, drag-only reorder, menu), fixed in this pass
- Focus Management: CONCERNS (menu close, navigation), fixed in this pass
- Color Contrast: CONCERNS (error toast), fixed; the rest passes (secondary text #8f8f8f on #121212 is about 5.9:1)
- Motion Sensitivity: PASS (`prefers-reduced-motion` shortens all animations and transitions)
