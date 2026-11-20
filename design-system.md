# EventFlow design system

EventFlow uses an original, calm, high-contrast visual language: a quiet neutral
workspace, clear typographic hierarchy, and indigo as the primary action color.
The dashboard is the first implemented surface; tokens are shared through CSS
custom properties in `src/app/globals.css`.

## Foundations

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | `#f7f8fb` | `#12131a` | Application canvas |
| `--surface` | `#ffffff` | `#191a23` | Cards, dialogs, navigation |
| `--surface-subtle` | `#fafbfc` | `#1d1e28` | Quiet fills and table headers |
| `--foreground` | `#20212b` | `#f1f1f5` | Primary text |
| `--muted` | `#707382` | `#a1a3b2` | Secondary labels |
| `--muted-strong` | `#585b6a` | `#b3b4c0` | Secondary actions |
| `--border` | `#ececf1` | `#2b2c37` | Dividers and outlines |
| `--accent` | `#5549df` | `#9c93ff` | Primary actions and focus |
| `--success` | `#18764d` | `#74d6a4` | Positive state |
| `--warning` | `#92500a` | `#f2b66d` | Capacity and attention state |

Use the CSS variables rather than hard-coding theme colors. The theme is selected
by `data-theme` on the root element and stored in `localStorage` as
`eventflow-theme`. Respect operating-system reduced-motion preferences.

### Type

- System sans-serif stack for fast rendering and predictable fallbacks.
- Page title: 24–29 px, semibold; section title: 13–19 px, semibold.
- Body copy: 12–14 px; helper and metadata text: 9–11 px.
- Use tabular numerals for future dense financial and ticket data.
- Keep line-height comfortable and avoid relying on color alone for status.

### Spacing, shape, elevation

- Base spacing unit: 4 px. Common gaps: 8, 12, 16, 20, 24, 32, 48 px.
- Radius scale: 8 px controls, 12 px cards, 16 px prominent surfaces,
  20 px overlays.
- Surfaces use a subtle 1 px border and restrained `--shadow-sm`; dialogs use
  `--shadow-dialog`. Reserve stronger elevation for temporary overlays.

## Components and interaction

- **Buttons:** 39 px primary action, 8 px radius, high-contrast indigo fill.
  Quiet actions use a visible border. Disabled actions must remain legible.
- **Inputs:** explicit labels, 38 px minimum height, inline validation, visible
  keyboard focus. Never rely on placeholder text as the label.
- **Cards:** white/dark surface, neutral border, consistent 12 px radius.
- **Tables:** semantic headers, persistent textual status, progress paired with
  sold/total counts; switch to stacked cards on narrow screens.
- **Badges:** icon/dot and text together; color is supplementary, not the only
  status signal.
- **Dialogs:** labelled modal with close and cancel actions, validation feedback,
  and a clear primary action.
- **Toasts:** brief, dismissible status announcement using `role="status"`.
- **Icons:** Lucide, generally 16–18 px in controls; icon-only controls need an
  accessible name.

## Motion

Use short, purposeful transitions (about 120–200 ms) for feedback and dialog
entry/exit. Do not animate essential data into view. Honor
`prefers-reduced-motion: reduce`.

## Accessibility and responsive behavior

- Use semantic headings, table markup, labels, `aria-current`, and named controls.
- All interactive controls are keyboard reachable and show a visible focus ring.
- Keep error messages adjacent to the relevant form and announce them with
  `role="alert"`.
- Layout breakpoints: 1220 px, 920 px, and 650 px. At tablet widths the sidebar
  compacts; on mobile it becomes a bottom navigation and the event table becomes
  readable event cards.
- Validate all color pairs and all flows against WCAG 2.1 AA as screens expand.
  This initial dashboard is not a completed accessibility audit.
