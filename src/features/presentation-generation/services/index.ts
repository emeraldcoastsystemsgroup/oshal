/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for presentation generation services
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the theme + layout catalogs and the content parser so routes/UI can offer real template selection without deep-importing (FSD).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-103 AI Office: export the Word/Excel projections (renderDocx/renderXlsx + office themes).
 */

export { PresentationEngine } from './presentation-engine';
export { renderPptx, type RenderableSlide } from './pptx-renderer';
export {
  DECK_THEMES, DEFAULT_THEME_ID, THEME_IDS, resolveTheme, isThemeId, themeCatalog,
  type DeckTheme, type ThemeFonts, type ThemePalette, type CoverStyle, type DecorStyle,
} from './deck-themes';
export { LAYOUTS, LAYOUT_ORDER, resolveLayout, layoutCatalog } from './layout-registry';
export { autoSelectLayout, applyDeckRhythm, isLayoutId } from './layout-autoselect';
export { parseSlideContent, parseMetric, isEmptyData } from './slide-content-parser';
export { resolveImage, resolveSlideImages, sniffImageMime, fetchCapped } from './image-source';
export { docxTheme, xlsxTheme, type DocxTheme, type XlsxTheme } from './office-themes';
export { renderDocx } from './docx-renderer';
export { renderXlsx } from './xlsx-renderer';
export { importOffice, importDocx, importXlsx, importPptx, type ImportedOutline } from './office-import';
export type { LayoutDef, LayoutFn, SlideSpec } from './layout-types';
