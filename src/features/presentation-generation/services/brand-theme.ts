/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — brandTheme builds a complete look from a brand kit's five role colors and its heading and body faces, on a named built-in look's structure, so a deck, a document and a workbook can carry a brand's exact colors and faces instead of the nearest of the ten looks (backlog 2026-09-14, approved as a core change 2026-09-22). Every input is bounded (six-digit hex, Office-safe faces, exactly the expected fields) and an invalid one is refused with a readable BrandLookError, never defaulted.
 */

import type { DeckTheme, DeckThemeId, ThemePalette } from '@/shared/types';
import { builtInLook, checkedLook } from './deck-themes';
import { luminance } from './layout-kit';
import { BrandLookError, lookFace, lookHex, lookRecord } from './look-rules';

/** The five roles a brand kit colors — the roles Create's brand kit stores. */
export interface BrandRoleColors {
  /** Headlines and the shapes people remember: the look's first accent and chart series. */
  primary: string;
  /** Supporting shapes and panels: the look's second accent and chart series. */
  secondary: string;
  /** Small pops of contrast: the third chart series. */
  accent: string;
  /** Body text and dark backgrounds: the text on the page and the cover surface. */
  dark: string;
  /** Pages and light backgrounds: the canvas. */
  light: string;
}

/** What a brand look is built from. */
export interface BrandLookInput {
  /** The built-in look whose cover, decoration, corner radius, title casing and mono face it keeps. */
  base: DeckThemeId;
  /** Six-digit hex per role, with or without a leading '#'. */
  colors: BrandRoleColors;
  /** The heading and body faces, each one of OFFICE_SAFE_FONTS. */
  fonts: { heading: string; body: string };
}

const ROLES = ['primary', 'secondary', 'accent', 'dark', 'light'] as const;
type Role = (typeof ROLES)[number];

/** Text reads at 4.5:1 (WCAG AA); secondary text at 3:1. */
const READABLE = 4.5;
const SOFT_READABLE = 3;

/**
 * @description WCAG contrast ratio between two bare hex colors.
 * @param a - one color.
 * @param b - the other.
 * @returns 1 to 21.
 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @description Move one color toward another, channel by channel.
 * @param a - the starting color.
 * @param b - the color moved toward.
 * @param t - how far, 0 (a) to 1 (b).
 * @returns bare uppercase hex.
 */
function mix(a: string, b: string, t: number): string {
  return [0, 2, 4].map((i) => {
    const from = parseInt(a.slice(i, i + 2), 16);
    const to = parseInt(b.slice(i, i + 2), 16);
    return Math.round(from + (to - from) * t).toString(16).padStart(2, '0');
  }).join('').toUpperCase();
}

/**
 * @description Text for a surface: the brand's own color when one reaches 4.5:1 on it, else
 * black or white, whichever reads better — never an unreadable brand color.
 * @param surface - the background the text sits on.
 * @param own - the brand colors to try, in preference order.
 * @returns the text color.
 */
function readableInk(surface: string, own: string[]): string {
  const best = (options: string[]) => [...options].sort((p, q) => contrast(q, surface) - contrast(p, surface))[0];
  const brand = best(own);
  return contrast(brand, surface) >= READABLE ? brand : best(['000000', 'FFFFFF']);
}

/**
 * @description Secondary text: the ink eased toward its surface as far as it still reads at 3:1.
 * @param ink - the primary text color.
 * @param surface - the background.
 * @returns the secondary text color (the ink itself when no easing still reads).
 */
function softInk(ink: string, surface: string): string {
  for (let step = 9; step > 0; step -= 1) {
    const eased = mix(ink, surface, step * 0.05);
    if (contrast(eased, surface) >= SOFT_READABLE) return eased;
  }
  return ink;
}

/**
 * @description Six distinct chart series colors from the brand: primary, secondary and accent,
 * then each eased toward the text color, then toward the page — skipping repeats, so a kit whose
 * three colors coincide still gets six series a reader can tell apart. Text and page differ by
 * at least 4.5:1, so one of the two passes always moves far enough to yield six.
 * @param roles - primary, secondary and accent, in that order.
 * @param ink - the text color on the canvas.
 * @param canvas - the canvas color.
 * @returns six bare hex colors.
 */
function chartColorsFor(roles: string[], ink: string, canvas: string): string[] {
  const out: string[] = [];
  const passes: Array<[string, number[]]> = [[ink, [0, 0.4, 0.7, 0.2, 0.55, 0.85]], [canvas, [0.2, 0.35, 0.5, 0.65, 0.8]]];
  for (const [toward, steps] of passes) {
    for (const t of steps) {
      for (const color of roles) {
        const series = mix(color, toward, t);
        if (!out.includes(series)) out.push(series);
        if (out.length === 6) return out;
      }
    }
  }
  return out;
}

/**
 * @description Map the five brand roles onto a look's palette by what each is for: `light` is
 * the page, `dark` the text and the cover surface, `primary` and `secondary` the two accents.
 * Panels, hairlines and secondary text are eased from those, never invented.
 * @param role - the five role colors as bare hex.
 * @returns the palette, whether the canvas is dark, and the chart series.
 */
function brandPalette(role: Record<Role, string>): { colors: ThemePalette; darkCanvas: boolean; chartColors: string[] } {
  const canvas = role.light;
  const ink = readableInk(canvas, [role.dark, role.light]);
  const deep = role.dark;
  const deepInk = readableInk(deep, [role.light, role.dark]);
  const colors: ThemePalette = {
    canvas, canvasAlt: mix(canvas, ink, 0.06), ink, inkSoft: softInk(ink, canvas),
    accent: role.primary, accent2: role.secondary, line: mix(canvas, ink, 0.16),
    deep, deepInk, deepInkSoft: softInk(deepInk, deep),
  };
  return {
    colors,
    darkCanvas: luminance(ink) > luminance(canvas),
    chartColors: chartColorsFor([role.primary, role.secondary, role.accent], ink, canvas),
  };
}

/**
 * @description Build a complete look from a brand kit: its five role colors and its heading and
 * body faces, drawn on a named built-in look's structure. Text colors come from the brand when
 * they read at 4.5:1 and fall back to black or white only when neither brand color does. The
 * cover, decoration, corner radius, title casing and mono face are the base look's.
 * @param input - `{ base, colors: { primary, secondary, accent, dark, light }, fonts: { heading, body } }`.
 * @returns a frozen look, id `brand:<base>`, that resolveTheme, docxTheme, xlsxTheme and the
 *   three renderers draw exactly.
 * @throws BrandLookError naming the field that is wrong; nothing is ever defaulted.
 */
export function brandTheme(input: unknown): DeckTheme {
  const raw = lookRecord(input, ['base', 'colors', 'fonts'], 'The brand look');
  const base = builtInLook(raw.base);
  if (!base) throw new BrandLookError('the base must be one of the ten built-in looks');
  const given = lookRecord(raw.colors, ROLES, 'The brand colors');
  const role = Object.fromEntries(ROLES.map((r) => [r, lookHex(given[r], `The ${r} color`, true)])) as Record<Role, string>;
  const faces = lookRecord(raw.fonts, ['heading', 'body'], 'The brand fonts');
  const { colors, darkCanvas, chartColors } = brandPalette(role);
  return checkedLook({
    id: `brand:${base.id}`,
    name: 'Your brand',
    blurb: `Your colors and faces on the ${base.name} layout.`,
    mood: 'Your brand kit',
    fonts: { heading: lookFace(faces.heading, 'The heading font'), body: lookFace(faces.body, 'The body font'), mono: base.fonts.mono },
    colors,
    chartColors,
    cover: base.cover, decor: base.decor, radius: base.radius, headingCase: base.headingCase,
    darkCanvas,
  });
}
