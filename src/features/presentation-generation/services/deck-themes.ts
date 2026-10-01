/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ten deck themes. Replaces the hardcoded navy-cover/black-bullets look that every generated deck shared. A theme is the whole look and feel (palette + typography + cover treatment + slide decoration), consumed by slide-masters + every layout so the deck is coherent end to end.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Brand looks (backlog 2026-09-14, approved as a core change 2026-09-22). resolveTheme accepts a built-in look id OR a custom look object: an id resolves exactly as before (an unknown id falls back to the default, now by own key so 'constructor' is unknown too), and an object is checked field by field by checkedLook and drawn exactly, or refused with a BrandLookError — never swapped for the default. The look shape types moved to @/shared/types (re-exported here unchanged) so DeckRenderOptions.theme can carry a look; the ten looks' data is unchanged.
 */

import type {
  BrandLookId, DeckTheme, DeckThemeId, ThemeFonts, ThemePalette, CoverStyle, DecorStyle,
} from '@/shared/types';
import { BrandLookError, lookFace, lookHex, lookRecord, lookText } from './look-rules';

export type { BrandLookId, DeckTheme, ThemeFonts, ThemePalette, CoverStyle, DecorStyle };
export { OFFICE_SAFE_FONTS, BrandLookError, isBrandLookError } from './look-rules';

/** One of the ten built-in looks: a DeckTheme whose id is a picker id. */
type BuiltInLook = DeckTheme & { id: DeckThemeId };

/**
 * @description All ten themes, in picker order. Four dark-canvas (midnight, aurora,
 * blueprint, neon) and six light-canvas, so the set spans real use: a boardroom read-out and
 * a conference keynote should not look like the same deck recolored.
 */
export const DECK_THEMES: Record<DeckThemeId, BuiltInLook> = {
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
 * @description Resolve a caller-supplied look to the one to draw. A string is a built-in look
 * id and never throws: an unknown or missing id falls back to the default, because a bad theme
 * string is not a reason to fail a deck the user is waiting on. An object is a custom look (from
 * `brandTheme`): it is checked by `checkedLook` and drawn exactly as given, or refused.
 * @param look - a built-in look id from a request body, directive or persona; or a brand look.
 * @returns the matching built-in look or the default for a string; the checked look for an object.
 * @throws BrandLookError when an object is not a complete, valid brand look — it never becomes
 * the default look.
 */
export function resolveTheme(look?: string | DeckTheme | null): DeckTheme {
  if (look !== null && typeof look === 'object') return checkedLook(look);
  return builtInLook(String(look ?? '').trim().toLowerCase()) ?? DECK_THEMES[DEFAULT_THEME_ID];
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
 * @description The built-in look an exact id names. Own keys only, so an inherited property
 * name such as 'constructor' names no look.
 * @param id - candidate id, compared exactly.
 * @returns the built-in look, or undefined.
 */
export function builtInLook(id: unknown): BuiltInLook | undefined {
  return isThemeId(id) ? DECK_THEMES[id] : undefined;
}

/** Every field a complete look carries. */
const LOOK_FIELDS = [
  'id', 'name', 'blurb', 'mood', 'fonts', 'colors', 'chartColors', 'cover', 'decor', 'radius', 'headingCase', 'darkCanvas',
] as const;
/** Every palette role a complete look colors. */
const PALETTE_FIELDS: ReadonlyArray<keyof ThemePalette> = [
  'canvas', 'canvasAlt', 'ink', 'inkSoft', 'accent', 'accent2', 'line', 'deep', 'deepInk', 'deepInkSoft',
];
/** The structure a brand look inherits from its base look, unchanged. */
const INHERITED = ['cover', 'decor', 'radius', 'headingCase'] as const;

/**
 * @description The built-in look a brand look's id names (`brand:<id>`).
 * @param id - the look's id.
 * @returns the base look.
 * @throws BrandLookError when the id is not `brand:` plus a built-in look id.
 */
function brandBase(id: unknown): BuiltInLook {
  const match = typeof id === 'string' ? /^brand:([a-z]+)$/.exec(id) : null;
  const base = match ? builtInLook(match[1]) : undefined;
  if (!base) throw new BrandLookError('the look id must be "brand:" followed by one of the ten built-in looks');
  return base;
}

/**
 * @description Check a custom look object and return a frozen copy to draw. A custom look is a
 * brand look: its id names the built-in look whose structure it keeps, so its cover,
 * decoration, corner radius and title casing must equal that look's; every color, chart color
 * included, is six-digit hex; every face is Office-safe; its text fields are bounded single
 * lines. A built-in look object is returned as itself.
 * @param look - the object a caller handed the renderer.
 * @returns the look to draw.
 * @throws BrandLookError naming the first field that is wrong.
 */
export function checkedLook(look: object): DeckTheme {
  const builtIn = Object.values(DECK_THEMES).find((t) => t === look);
  if (builtIn) return builtIn;
  const t = lookRecord(look, LOOK_FIELDS, 'The look');
  const base = brandBase(t.id);
  const fonts = lookRecord(t.fonts, ['heading', 'body', 'mono'], 'The look fonts');
  const colors = lookRecord(t.colors, PALETTE_FIELDS, 'The look colors');
  if (!Array.isArray(t.chartColors) || t.chartColors.length !== 6) throw new BrandLookError('the look needs exactly six chart colors');
  for (const key of INHERITED) {
    if (t[key] !== base[key]) throw new BrandLookError(`the look's ${key} must be the ${base.name} look's`);
  }
  if (typeof t.darkCanvas !== 'boolean') throw new BrandLookError('the look must say whether its canvas is dark');
  const palette = Object.fromEntries(PALETTE_FIELDS.map((k) => [k, lookHex(colors[k], `The look's ${k} color`, false)]));
  return Object.freeze({
    id: `brand:${base.id}` as BrandLookId,
    name: lookText(t.name, 80, 'The look name'),
    blurb: lookText(t.blurb, 200, 'The look blurb'),
    mood: lookText(t.mood, 120, 'The look mood'),
    fonts: Object.freeze({
      heading: lookFace(fonts.heading, 'The heading font'), body: lookFace(fonts.body, 'The body font'),
      mono: lookFace(fonts.mono, 'The mono font'),
    }),
    colors: Object.freeze(palette as unknown as ThemePalette),
    chartColors: Object.freeze(t.chartColors.map((c, i) => lookHex(c, `Chart color ${i + 1}`, false))) as string[],
    cover: base.cover, decor: base.decor, radius: base.radius, headingCase: base.headingCase,
    darkCanvas: t.darkCanvas,
  });
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
