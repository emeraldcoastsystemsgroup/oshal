/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ten deck themes. Replaces the hardcoded navy-cover/black-bullets look that every generated deck shared. A theme is the whole look and feel (palette + typography + cover treatment + slide decoration), consumed by slide-masters + every layout so the deck is coherent end to end.
 */

import type { DeckThemeId } from '@/shared/types';

/**
 * @description Typography for a theme. Fonts are restricted to the faces that ship with
 * Microsoft Office on BOTH Windows and macOS (Calibri, Cambria, Candara, Century Gothic,
 * Consolas, Constantia, Corbel, Garamond, Georgia, Trebuchet MS, Arial, Courier New).
 * This is deliberate: a webfont would silently substitute when the user opens the .pptx on
 * their desktop, which wrecks every line break the renderer laid out. No exceptions.
 */
export interface ThemeFonts {
  /** Slide titles, cover title, big numbers. */
  heading: string;
  /** Bullets, body copy, captions. */
  body: string;
  /** Labels, kickers, eyebrow text, code. */
  mono: string;
}

/**
 * @description A theme's colors. Hex WITHOUT the leading '#' — pptxgenjs wants bare hex.
 * `deep*` are the inverted feature surfaces (cover / section / statement slides); `canvas*`
 * and `ink*` are the normal content slides.
 */
export interface ThemePalette {
  /** Content-slide background. */
  canvas: string;
  /** Panels, tiles, table banding — one step off `canvas`. */
  canvasAlt: string;
  /** Primary text on `canvas`. */
  ink: string;
  /** Secondary text on `canvas`. */
  inkSoft: string;
  /** Primary accent — rules, chips, chart series 1. */
  accent: string;
  /** Secondary accent — contrast panel, chart series 2. */
  accent2: string;
  /** Hairlines and borders. */
  line: string;
  /** Feature-surface background (cover / section / statement). */
  deep: string;
  /** Primary text on `deep`. */
  deepInk: string;
  /** Secondary text on `deep`. */
  deepInkSoft: string;
}

/** How the cover slide is composed. */
export type CoverStyle =
  | 'wash'   // translucent accent blooms over the deep surface
  | 'block'  // hard color block, oversized type
  | 'rule'   // restrained: hairline rule above the title
  | 'grid'   // technical dot-grid field
  | 'band'   // horizontal accent band behind the title
  | 'split'; // vertical split: deep panel + canvas panel

/** How content slides are decorated. */
export type DecorStyle =
  | 'bar'     // accent bar under the slide title
  | 'rule'    // full-width hairline under the title band
  | 'chip'    // rounded accent chip beside the title
  | 'grid'    // dot grid + mono eyebrow
  | 'sidebar' // narrow accent spine down the left edge
  | 'none';

/**
 * @description A complete deck theme.
 */
export interface DeckTheme {
  /** Stable id (the value callers pass as `theme`). */
  id: DeckThemeId;
  /** Display name for the picker. */
  name: string;
  /** One-line pitch shown under the name in the picker. */
  blurb: string;
  /** Short "when to use this" cue. */
  mood: string;
  fonts: ThemeFonts;
  colors: ThemePalette;
  /** Six chart series colors, ordered. */
  chartColors: string[];
  cover: CoverStyle;
  decor: DecorStyle;
  /** Corner rounding in inches for tiles/panels. 0 = sharp. */
  radius: number;
  /** Uppercase slide titles (Swiss / cyber voices). */
  headingCase: 'none' | 'upper';
  /** True when content slides sit on a dark canvas. */
  darkCanvas: boolean;
}

/**
 * @description All ten themes, in picker order. Four dark-canvas (midnight, aurora,
 * blueprint, neon) and six light-canvas, so the set spans real use: a boardroom read-out and
 * a conference keynote should not look like the same deck recolored.
 */
export const DECK_THEMES: Record<DeckThemeId, DeckTheme> = {
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    blurb: 'Indigo canvas, violet and teal accents, geometric type.',
    mood: 'Product keynote · the OSHAL house look',
    fonts: { heading: 'Century Gothic', body: 'Calibri', mono: 'Consolas' },
    colors: {
      canvas: '141A2E', canvasAlt: '1D2440', ink: 'F4F6FF', inkSoft: '9AA3C7',
      accent: '7C6CFF', accent2: '00D3A7', line: '2B3358',
      deep: '0A0E1C', deepInk: 'FFFFFF', deepInkSoft: '8B8BA3',
    },
    chartColors: ['7C6CFF', '00D3A7', '4C9AFF', 'FFB020', 'FF6B8A', '9B8CFF'],
    cover: 'wash', decor: 'bar', radius: 0.12, headingCase: 'none', darkCanvas: true,
  },
  aurora: {
    id: 'aurora',
    name: 'Aurora',
    blurb: 'Slate dark with a teal-to-violet wash and soft humanist type.',
    mood: 'Vision decks · anything future-facing',
    fonts: { heading: 'Corbel', body: 'Corbel', mono: 'Consolas' },
    colors: {
      canvas: '0E141B', canvasAlt: '18212C', ink: 'EAF2F7', inkSoft: '8FA3B3',
      accent: '2DD4BF', accent2: 'A78BFA', line: '27333F',
      deep: '070B10', deepInk: 'FFFFFF', deepInkSoft: '93A7B8',
    },
    chartColors: ['2DD4BF', 'A78BFA', '38BDF8', 'FBBF24', 'F472B6', '34D399'],
    cover: 'wash', decor: 'chip', radius: 0.16, headingCase: 'none', darkCanvas: true,
  },
  monochrome: {
    id: 'monochrome',
    name: 'Monochrome',
    blurb: 'Swiss editorial. White, oversized black type, one red hairline.',
    mood: 'High-confidence narrative · design-literate rooms',
    fonts: { heading: 'Arial', body: 'Arial', mono: 'Courier New' },
    colors: {
      canvas: 'FFFFFF', canvasAlt: 'F4F4F4', ink: '0A0A0A', inkSoft: '6B6B6B',
      accent: 'E5251E', accent2: '0A0A0A', line: 'DCDCDC',
      deep: '0A0A0A', deepInk: 'FFFFFF', deepInkSoft: 'A8A8A8',
    },
    chartColors: ['0A0A0A', 'E5251E', '6B6B6B', 'B0B0B0', '3D3D3D', '8A8A8A'],
    cover: 'block', decor: 'rule', radius: 0, headingCase: 'upper', darkCanvas: false,
  },
  executive: {
    id: 'executive',
    name: 'Executive',
    blurb: 'Boardroom navy and gold with serif headings.',
    mood: 'Board readouts · investors · steering committees',
    fonts: { heading: 'Cambria', body: 'Calibri', mono: 'Consolas' },
    colors: {
      canvas: 'FFFFFF', canvasAlt: 'F5F7FA', ink: '12233F', inkSoft: '5A6B85',
      accent: 'C9A227', accent2: '12233F', line: 'DCE3ED',
      deep: '12233F', deepInk: 'FFFFFF', deepInkSoft: 'AFC0D8',
    },
    chartColors: ['12233F', 'C9A227', '4A7AB5', '9BB4D0', '7A6A3A', '2E4A6E'],
    cover: 'band', decor: 'rule', radius: 0.04, headingCase: 'none', darkCanvas: false,
  },
  sunrise: {
    id: 'sunrise',
    name: 'Sunrise',
    blurb: 'Warm cream with coral and amber. Friendly and rounded.',
    mood: 'Workshops · all-hands · customer stories',
    fonts: { heading: 'Trebuchet MS', body: 'Calibri', mono: 'Consolas' },
    colors: {
      canvas: 'FFF9F2', canvasAlt: 'FFEFE0', ink: '3B2A20', inkSoft: '8A6E5D',
      accent: 'FF6B4A', accent2: 'F2A93B', line: 'F0DCC8',
      deep: '2E1D14', deepInk: 'FFF9F2', deepInkSoft: 'D9BBA6',
    },
    chartColors: ['FF6B4A', 'F2A93B', '6BBFA0', '5B8DEF', 'C77DFF', 'FF9F7A'],
    cover: 'wash', decor: 'chip', radius: 0.2, headingCase: 'none', darkCanvas: false,
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    blurb: 'Deep green on sand, brass accents, an organic serif.',
    mood: 'Sustainability · research · long-form',
    fonts: { heading: 'Constantia', body: 'Corbel', mono: 'Consolas' },
    colors: {
      canvas: 'FBF9F3', canvasAlt: 'EFEADC', ink: '1C3329', inkSoft: '5E7468',
      accent: '2F6B4F', accent2: 'B08A46', line: 'DDD6C3',
      deep: '12251C', deepInk: 'F3F7F4', deepInkSoft: 'A9BFB2',
    },
    chartColors: ['2F6B4F', 'B08A46', '6E9B7B', '3E7C9B', 'C4703F', '8FAE84'],
    cover: 'split', decor: 'sidebar', radius: 0.1, headingCase: 'none', darkCanvas: false,
  },
  blueprint: {
    id: 'blueprint',
    name: 'Blueprint',
    blurb: 'Technical dark blue, dot grid, monospace labels, cyan.',
    mood: 'Architecture reviews · engineering deep-dives',
    fonts: { heading: 'Consolas', body: 'Calibri', mono: 'Consolas' },
    colors: {
      canvas: '0B1E33', canvasAlt: '122B47', ink: 'DCEBFA', inkSoft: '7FA3C4',
      accent: '22D3EE', accent2: '60A5FA', line: '1E3A5C',
      deep: '07182A', deepInk: 'E8F4FF', deepInkSoft: '7FA3C4',
    },
    chartColors: ['22D3EE', '60A5FA', '34D399', 'FBBF24', 'F87171', 'A78BFA'],
    cover: 'grid', decor: 'grid', radius: 0, headingCase: 'none', darkCanvas: true,
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    blurb: 'Academic off-white and ink. Garamond, generous margins.',
    mood: 'Lectures · policy · anything read closely',
    fonts: { heading: 'Garamond', body: 'Garamond', mono: 'Courier New' },
    colors: {
      canvas: 'FCFCF9', canvasAlt: 'F2F2EC', ink: '1A1A18', inkSoft: '6E6E66',
      accent: '8C2F2F', accent2: '2F4858', line: 'E2E2D8',
      deep: '1A1A18', deepInk: 'FCFCF9', deepInkSoft: 'A8A89E',
    },
    chartColors: ['2F4858', '8C2F2F', '7A8B6F', 'C08A3E', '4E6E81', '9A7B6B'],
    cover: 'rule', decor: 'rule', radius: 0, headingCase: 'none', darkCanvas: false,
  },
  neon: {
    id: 'neon',
    name: 'Neon',
    blurb: 'Near-black with magenta and cyan glow bars.',
    mood: 'Launches · demos · developer conferences',
    fonts: { heading: 'Century Gothic', body: 'Calibri', mono: 'Consolas' },
    colors: {
      canvas: '0A0A12', canvasAlt: '15152A', ink: 'F0F0FF', inkSoft: '8C8CB8',
      accent: 'FF2D9B', accent2: '22E5FF', line: '262646',
      deep: '050509', deepInk: 'FFFFFF', deepInkSoft: '8C8CB8',
    },
    chartColors: ['FF2D9B', '22E5FF', 'A855F7', 'FACC15', '34D399', 'FF7AC6'],
    cover: 'wash', decor: 'bar', radius: 0.14, headingCase: 'upper', darkCanvas: true,
  },
  sandstone: {
    id: 'sandstone',
    name: 'Sandstone',
    blurb: 'Warm neutral with terracotta and an editorial serif.',
    mood: 'Brand · marketing · storytelling',
    fonts: { heading: 'Georgia', body: 'Corbel', mono: 'Consolas' },
    colors: {
      canvas: 'FAF6F1', canvasAlt: 'F0E7DC', ink: '2E2620', inkSoft: '7D6E60',
      accent: 'C05621', accent2: '5B7B7A', line: 'E4D8C9',
      deep: '2E2620', deepInk: 'FAF6F1', deepInkSoft: 'BFAE9C',
    },
    chartColors: ['C05621', '5B7B7A', '9C6644', '7A8B99', 'D9A05B', '4A5D52'],
    cover: 'split', decor: 'rule', radius: 0.06, headingCase: 'none', darkCanvas: false,
  },
};

/** Theme applied when a caller names none — the OSHAL house look. */
export const DEFAULT_THEME_ID: DeckThemeId = 'midnight';

/** Every theme id, in picker order. */
export const THEME_IDS = Object.keys(DECK_THEMES) as DeckThemeId[];

/**
 * @description Resolve a caller-supplied theme name to a real theme. Never throws — an
 * unknown or missing name falls back to the default, because a bad theme string is not a
 * reason to fail a deck the user is waiting on.
 * @param id - candidate theme id from a request body, directive, or persona.
 * @returns the matching theme, or the default theme.
 */
export function resolveTheme(id?: string | null): DeckTheme {
  const key = String(id ?? '').trim().toLowerCase();
  return DECK_THEMES[key as DeckThemeId] ?? DECK_THEMES[DEFAULT_THEME_ID];
}

/**
 * @description Whether a string names a real theme — used to validate request input before
 * it reaches the renderer.
 * @param id - candidate theme id.
 * @returns true when `id` is a known theme.
 */
export function isThemeId(id: unknown): id is DeckThemeId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DECK_THEMES, id);
}

/**
 * @description The theme catalog for the Studio's picker and `GET /themes`, stripped of the
 * render-only internals the surface has no use for.
 * @returns one entry per theme: id, name, blurb, mood, the swatches to preview, and the
 * structural cues the SVG preview needs to draw a faithful thumbnail.
 */
export function themeCatalog(): Array<{
  id: DeckThemeId; name: string; blurb: string; mood: string; darkCanvas: boolean;
  cover: CoverStyle; decor: DecorStyle; radius: number; headingCase: 'none' | 'upper';
  fonts: ThemeFonts; colors: ThemePalette;
}> {
  return THEME_IDS.map((id) => {
    const t = DECK_THEMES[id];
    return {
      id: t.id, name: t.name, blurb: t.blurb, mood: t.mood, darkCanvas: t.darkCanvas,
      cover: t.cover, decor: t.decor, radius: t.radius, headingCase: t.headingCase,
      fonts: t.fonts, colors: t.colors,
    };
  });
}
