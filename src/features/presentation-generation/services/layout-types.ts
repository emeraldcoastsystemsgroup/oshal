/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the contract every slide layout implements. Split from the registry so layout modules and the registry don't import each other in a cycle.
 */

import type { SlideData, SlideLayoutId } from '@/shared/types';
import type { DeckCtx, Slide } from './layout-kit';

/**
 * @description Everything a layout is given about the slide it is drawing. Layouts are pure
 * draw functions over this — they never re-parse content or reach for deck state.
 */
export interface SlideSpec {
  /** Slide heading. */
  title: string;
  /** Kicker / subtitle line, when the author supplied one. */
  subtitle?: string;
  /** Parsed body content. Every field is always present (arrays may be empty). */
  data: SlideData;
  /** 1-based position in the finished deck. */
  index: number;
  /** Total slide count. */
  total: number;
  /** The deck's title (used by cover/closing). */
  deckTitle: string;
  /** Nearest preceding section name — drawn as the eyebrow on content slides. */
  sectionName?: string;
  /** 1-based ordinal among SECTION slides. The section divider prints this, not `index` —
   *  a divider labelled with its deck position ("07") reads as a page number, not a part. */
  sectionOrdinal?: number;
  /** Speaker notes, already attached by the renderer; layouts may read but needn't. */
  notes?: string;
}

/** A layout's draw function. */
export type LayoutFn = (slide: Slide, ctx: DeckCtx, spec: SlideSpec) => void;

/**
 * @description A registered layout: its identity, the master it sits on, the content shape it
 * wants, and how to draw it.
 */
export interface LayoutDef {
  /** Stable id — the value authors put in `#layout:`. */
  id: SlideLayoutId;
  /** Display name for the Studio's layout reference. */
  name: string;
  /** One-line description of what the layout is for. */
  blurb: string;
  /** The content shape it expects, in the authoring micro-syntax. Shown in the UI reference. */
  needs: string;
  /** Master name from `MASTER` — determines the surface and which placeholders exist. */
  master: string;
  /** Draw it. */
  render: LayoutFn;
}
