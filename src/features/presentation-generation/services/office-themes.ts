/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — projects the ten deck themes onto Word and Excel (ADR-103 AI Office). One palette + type system governs .pptx, .docx and .xlsx, so "the executive look" means the same thing in every format the engine emits. Deliberately a THIN projection: deck themes stay the single source of truth; this file only reshapes them into what the docx/exceljs renderers consume.
 */

import type { DeckThemeId } from '@/shared/types';
import { DECK_THEMES, type DeckTheme } from './deck-themes';

/**
 * @description A theme reshaped for the Word renderer. Sizes are in half-points (docx's
 * native unit) so the renderer never does unit math inline.
 */
export interface DocxTheme {
  /** Theme id — same vocabulary as the deck. */
  id: DeckThemeId;
  /** Heading font family. */
  headingFont: string;
  /** Body font family. */
  bodyFont: string;
  /** Mono font family (code, captions, metadata lines). */
  monoFont: string;
  /** Body text color (hex, no '#'). */
  ink: string;
  /** Secondary text color. */
  inkSoft: string;
  /** Accent — heading underlines, links, callout borders. */
  accent: string;
  /** Secondary accent. */
  accent2: string;
  /** Hairline/border color. */
  line: string;
  /** Callout/table-band background. */
  panel: string;
  /** Title size (half-points). */
  titleSize: number;
  /** Heading-1 size (half-points). */
  h1Size: number;
  /** Heading-2 size (half-points). */
  h2Size: number;
  /** Body size (half-points). */
  bodySize: number;
  /** True when headings are uppercased (Swiss/cyber voices). */
  headingCaps: boolean;
  /** True when the heading face reads as serif (drives bold-vs-regular heading weight). */
  serifHeadings: boolean;
}

/**
 * @description A theme reshaped for the Excel renderer (ARGB hex, exceljs's format).
 */
export interface XlsxTheme {
  /** Theme id — same vocabulary as the deck. */
  id: DeckThemeId;
  /** Font family for all cells. */
  font: string;
  /** Header-row fill (ARGB). */
  headerFill: string;
  /** Header-row text (ARGB). */
  headerInk: string;
  /** Banded-row fill (ARGB). */
  bandFill: string;
  /** Body text (ARGB). */
  ink: string;
  /** Secondary text (ARGB). */
  inkSoft: string;
  /** Accent (ARGB) — title bar, KPI figures, chart-ish emphasis. */
  accent: string;
  /** Border hairline (ARGB). */
  line: string;
}

/** docx colors are plain hex; exceljs wants ARGB. */
const argb = (hex: string): string => `FF${hex}`;

/** Word documents read on white; a dark-canvas deck theme must not produce a dark page. */
function pageInk(t: DeckTheme): { ink: string; inkSoft: string; line: string; panel: string } {
  if (!t.darkCanvas) {
    return { ink: t.colors.ink, inkSoft: t.colors.inkSoft, line: t.colors.line, panel: t.colors.canvasAlt };
  }
  // Dark themes: keep the theme's accent identity but set type in near-black on white —
  // inverting a whole Word page is a novelty, not a document.
  return { ink: '1A1D29', inkSoft: '6A7086', line: 'DCDFE8', panel: 'F2F3F8' };
}

/**
 * @description Project a deck theme onto Word.
 * @param id - deck theme id (unknown ids fall back like the deck renderer does).
 * @returns the docx-shaped theme.
 */
export function docxTheme(id?: string | null): DocxTheme {
  const t = DECK_THEMES[(id ?? '') as DeckThemeId] ?? DECK_THEMES.midnight;
  const page = pageInk(t);
  const serif = ['Cambria', 'Constantia', 'Garamond', 'Georgia'].includes(t.fonts.heading);
  return {
    id: t.id,
    headingFont: t.fonts.heading,
    bodyFont: t.fonts.body,
    monoFont: t.fonts.mono,
    ink: page.ink,
    inkSoft: page.inkSoft,
    accent: t.colors.accent,
    accent2: t.colors.accent2,
    line: page.line,
    panel: page.panel,
    titleSize: 64,  // 32pt
    h1Size: 36,     // 18pt
    h2Size: 28,     // 14pt
    bodySize: 22,   // 11pt
    headingCaps: t.headingCase === 'upper',
    serifHeadings: serif,
  };
}

/**
 * @description Project a deck theme onto Excel.
 * @param id - deck theme id (unknown ids fall back like the deck renderer does).
 * @returns the exceljs-shaped theme.
 */
export function xlsxTheme(id?: string | null): XlsxTheme {
  const t = DECK_THEMES[(id ?? '') as DeckThemeId] ?? DECK_THEMES.midnight;
  const page = pageInk(t);
  // The header row carries the theme: deep surface + its ink, exactly like the deck's cover.
  return {
    id: t.id,
    font: t.fonts.body,
    headerFill: argb(t.colors.deep),
    headerInk: argb(t.colors.deepInk),
    bandFill: argb(page.panel),
    ink: argb(page.ink),
    inkSoft: argb(page.inkSoft),
    accent: argb(t.colors.accent),
    line: argb(page.line),
  };
}
