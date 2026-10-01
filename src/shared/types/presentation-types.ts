/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial presentation domain types for presentation-bot
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Real template system: DeckThemeId (10 look-and-feel themes) + SlideLayoutId (20 layouts) + SlideData (the structured payload a layout renders). Previously `templateId` was decorative — nothing downstream read it and every deck rendered identically.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Brand looks (backlog 2026-09-14, approved as a core change 2026-09-22): the look shape (DeckTheme, ThemeFonts, ThemePalette, CoverStyle, DecorStyle) moves here unchanged from the presentation-generation slice, so DeckRenderOptions.theme can name either a built-in look id or a validated brand look; BrandLookId (`brand:<base look>`) is the id such a look carries. The ten built-in looks and their ids are unchanged.
 */

/**
 * @description The ten deck themes — a theme is the whole look and feel (palette,
 * typography, cover treatment, slide decoration), not a color swap. Each renders to real
 * PowerPoint slide masters so the deck stays editable on the desktop.
 */
export type DeckThemeId =
  | 'midnight'    // OSHAL house dark — indigo canvas, violet/teal accents, geometric sans
  | 'aurora'      // dark slate, teal→violet gradient wash, soft humanist sans
  | 'monochrome'  // Swiss editorial — white, massive black type, one red hairline
  | 'executive'   // boardroom — white + navy + gold, serif headings
  | 'sunrise'     // warm cream + coral/amber, friendly and rounded
  | 'forest'      // deep green + sand, organic, serif headings
  | 'blueprint'   // technical — dark blue, dot grid, monospace labels, cyan
  | 'paper'       // academic — off-white, ink, generous margins, Garamond
  | 'neon'        // cyber — near-black, magenta/cyan glow bars
  | 'sandstone';  // warm neutral + terracotta, editorial serif

/**
 * @description The id a brand look carries (built by `brandTheme` in presentation-generation):
 * `brand:` plus the built-in look whose structure it keeps. It is never a picker id, so a
 * generated file's record names the look as a brand look and still says which layout drew it.
 */
export type BrandLookId = `brand:${DeckThemeId}`;

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
 * @description A complete deck theme — one of the ten built-in looks, or a brand look.
 */
export interface DeckTheme {
  /** Stable id: a built-in look id (the value callers pass as `theme`), or `brand:<base>`. */
  id: DeckThemeId | BrandLookId;
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
 * @description The twenty slide layouts. A layout decides how a slide's parsed content is
 * composed; `layout-autoselect` infers one from the content's shape when none is declared,
 * which is what turns a plain outline into a varied deck instead of N identical bullet slides.
 */
export type SlideLayoutId =
  // Text + structure
  | 'cover'        // deck opener: title, subtitle, byline
  | 'section'      // section divider: number + heading
  | 'agenda'       // numbered contents list
  | 'bullets'      // classic title + bullets
  | 'two-column'   // two headed columns of text
  | 'comparison'   // A-vs-B panels, accent-differentiated
  | 'quote'        // oversized pull quote + attribution
  | 'statement'    // one bold full-bleed statement
  | 'closing'      // thank-you / call to action / contact
  // Data (native, double-click-editable in PowerPoint)
  | 'big-number'   // one hero metric + supporting context
  | 'kpi-grid'     // 2–4 stat tiles
  | 'table'        // native PowerPoint table
  | 'bar-chart'    // native bar chart
  | 'line-chart'   // native line chart
  | 'pie-chart'    // native doughnut chart
  // Visual / diagram
  | 'timeline'     // horizontal milestone track
  | 'process'      // numbered chevron steps
  | 'quadrant'     // 2×2 matrix
  | 'image-full'   // full-bleed image + overlay caption
  | 'image-right'; // text left, image right

/**
 * @description Structured content parsed out of a slide body by `slide-content-parser`.
 * Every layout renders from this one shape, so any content can fall back to any layout.
 */
export interface SlideData {
  /** Plain bullet lines (the default body). */
  bullets: string[];
  /** `## Heading` groups — feeds two-column / comparison / quadrant. */
  groups: Array<{ heading: string; items: string[] }>;
  /** `label :: detail` pairs — feeds timeline / process / kpi / big-number. */
  pairs: Array<{ label: string; value: string }>;
  /** `Label: 42` numeric pairs — feeds the chart layouts. `display` keeps the authored
   *  formatting ("$1.2M") for tiles; `value` is the parsed number for charts. */
  series: Array<{ label: string; value: number; display: string }>;
  /** Markdown-style pipe table — feeds the table layout. */
  table: { head: string[]; rows: string[][] } | null;
  /** `> quoted text` + `— attribution` — feeds the quote layout. */
  quote: { text: string; attribution?: string } | null;
  /** `#image: <url|data-uri>` — feeds the image layouts. */
  image?: string;
  /** Raw `#key: value` directives (`#layout`, `#image`, `#subtitle`). */
  directives: Record<string, string>;
}

/**
 * @description A slide ready to render. `content` is the authored body (parsed into `data`);
 * `layout` is optional — omit it and the deck composer picks the best fit for the content.
 */
export interface RenderableSlide {
  /** Slide heading. */
  title: string;
  /** Authored body — bullets, or the layout micro-syntax (see `slide-content-parser`). */
  content?: string;
  /** Speaker notes (carried into the .pptx notes pane). */
  notes?: string;
  /** Explicit layout. Omitted → auto-selected from the content's shape. */
  layout?: SlideLayoutId;
  /** Coarse slide-type hint carried over from `PresentationSection`. Prefer `layout`; this
   *  stays so callers built against the older section shape keep working. */
  type?: 'intro' | 'content' | 'summary' | 'divider';
  /** Deck/section subtitle or kicker line. */
  subtitle?: string;
  /** Image URL or data URI for the image layouts. */
  image?: string;
}

/**
 * @description Deck-level render options — the "template selection" that was missing.
 */
export interface DeckRenderOptions {
  /**
   * Look and feel: a built-in look id, or a brand look built by `brandTheme`. Defaults to
   * `midnight`, and an unknown id falls back to it; a look object that fails validation is
   * refused (the render throws) and is never replaced by the default.
   */
  theme?: DeckThemeId | DeckTheme;
  /** Cover subtitle — the one line under the deck title. */
  subtitle?: string;
  /** Cover byline / presenter / date line. */
  byline?: string;
  /** Draw slide numbers + footer on content slides. Defaults to true. */
  slideNumbers?: boolean;
  /** Let the composer vary layouts across the deck. Defaults to true. */
  autoLayout?: boolean;
}

/**
 * @description Request payload for generating a presentation from structured sections.
 */
export interface PresentationRequest {
  /** Presentation title */
  title: string;
  /** Optional template identifier (defaults to 'default') */
  templateId?: string;
  /** Deck theme — the look and feel applied to every slide. */
  theme?: DeckThemeId;
  /** Output format */
  format?: 'pptx' | 'pdf' | 'html';
  /** Ordered sections to convert into slides */
  sections: PresentationSection[];
  /** Optional metadata attached to the presentation */
  metadata?: Record<string, unknown>;
}

/**
 * @description A single section in the presentation request.
 */
export interface PresentationSection {
  /** Section heading */
  title: string;
  /** Section body content */
  content: string;
  /** Coarse slide-type hint. Prefer `layout` — this stays for older callers. */
  type?: 'intro' | 'content' | 'summary' | 'divider';
  /** Explicit slide layout. Omitted → auto-selected from the content's shape. */
  layout?: SlideLayoutId;
  /** Subtitle / kicker line. */
  subtitle?: string;
  /** Image URL or data URI for the image layouts. */
  image?: string;
  /** Speaker notes for this section */
  notes?: string;
}

/**
 * @description Result of a presentation generation operation.
 */
export interface PresentationResult {
  /** Unique presentation identifier */
  id: string;
  /** Presentation title */
  title: string;
  /** Generated slide array */
  slides: GeneratedSlide[];
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Output format used */
  format: string;
}

/**
 * @description A single generated slide in the output deck.
 */
export interface GeneratedSlide {
  /** 1-based slide index */
  index: number;
  /** Slide title */
  title: string;
  /** Slide body content */
  content: string;
  /** Slide layout type */
  type: string;
  /** Optional speaker notes */
  notes?: string;
}

/**
 * @description A reusable slide template definition.
 */
export interface SlideTemplate {
  /** Template identifier */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Layout descriptor */
  layout: string;
}