/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — assembles the twenty layouts into one lookup. Typed as Record<SlideLayoutId, LayoutDef>, so adding an id to the union without registering a layout is a compile error rather than a runtime blank slide (same guard as HARNESS_FACTORIES).
 */

import type { SlideLayoutId } from '@/shared/types';
import type { LayoutDef } from './layout-types';
import { TEXT_LAYOUTS } from './layouts/text-layouts';
import { DATA_LAYOUTS } from './layouts/data-layouts';
import { VISUAL_LAYOUTS } from './layouts/visual-layouts';

/** Build the id → definition map from the three layout modules. */
function index(defs: LayoutDef[]): Record<SlideLayoutId, LayoutDef> {
  const out = {} as Record<SlideLayoutId, LayoutDef>;
  for (const d of defs) out[d.id] = d;
  return out;
}

/**
 * @description All twenty slide layouts, keyed by id. The `Record<SlideLayoutId, LayoutDef>`
 * annotation is the point: extend `SlideLayoutId` without shipping a layout and the build
 * fails here, instead of the renderer silently emitting an empty slide.
 */
export const LAYOUTS: Record<SlideLayoutId, LayoutDef> = index([
  ...TEXT_LAYOUTS, ...DATA_LAYOUTS, ...VISUAL_LAYOUTS,
]);

/** Layout ids in catalog order — text/structure, then data, then visual. */
export const LAYOUT_ORDER: SlideLayoutId[] = [
  ...TEXT_LAYOUTS, ...DATA_LAYOUTS, ...VISUAL_LAYOUTS,
].map((d) => d.id);

/**
 * @description Resolve a layout, falling back to `bullets`. Never throws: an unknown layout
 * is not a reason to fail a deck the user is waiting on, and `bullets` renders any content.
 * @param id - candidate layout id.
 * @returns the layout definition to render with.
 */
export function resolveLayout(id?: string | null): LayoutDef {
  return LAYOUTS[(id ?? '') as SlideLayoutId] ?? LAYOUTS.bullets;
}

/**
 * @description The layout catalog for the Studio's reference panel and `GET /themes`.
 * @returns id, name, blurb, and the content shape each layout expects.
 */
export function layoutCatalog(): Array<{ id: SlideLayoutId; name: string; blurb: string; needs: string }> {
  return LAYOUT_ORDER.map((id) => {
    const d = LAYOUTS[id];
    return { id: d.id, name: d.name, blurb: d.blurb, needs: d.needs };
  });
}
