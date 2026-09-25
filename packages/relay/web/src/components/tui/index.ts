/**
 * The TUI kit.
 *
 * Every screen in this client is built from these pieces, so the browser UI and
 * the `herdr-remote` configuration TUI look like two views of one program
 * rather than two products.
 *
 * The widget vocabulary is deliberately ratatui's — the toolkit Rust terminal
 * dashboards are written with (https://ratatui.rs): a `Block` is a frame whose
 * title is cut into its top rule and whose second title may sit right-aligned
 * on the same rule; a `Gauge` is a filled bar with its label centred *inside*
 * it; a `LineGauge` is one row of `━` with a figure at the end; a `Sparkline`
 * is a row of `▁▂▃▄▅▆▇█`; `Tabs` are separated by `│`. Borrowing the
 * vocabulary rather than inventing one means anyone who has seen a Rust TUI can
 * already read this dashboard.
 *
 * The rules they encode are the ones a terminal interface has no choice about:
 *
 *   - one monospace family, one type size, everything on the character grid,
 *     and never any letter-spacing: a cell is a fixed box, and tracking a CJK
 *     run out is the fastest way to stop looking like a terminal;
 *   - hierarchy is weight and colour, not size;
 *   - frames are box-drawing rules, never cards — no radius, no shadow, no fill
 *     gradient;
 *   - state is a glyph plus a colour (`●` up, `○` idle, `▸` here), never a pill;
 *   - a control is text in brackets: `[ save ]`, `[x] enabled`, `(•) chosen`;
 *   - colour appears only where it means something, on Herdr's own palette.
 *
 * Decorative glyphs are `aria-hidden`, so `[ ]` brackets and status dots never
 * reach an accessible name: a button called "Save" is still called "Save".
 */

export * from './tokens';
export * from './panel';
export * from './buttons';
export * from './fields';
export * from './settings';
export * from './meters';
export * from './table';
export * from './modal';
export * from './frame';
