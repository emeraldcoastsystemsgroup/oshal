/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for presentation generation feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-export the theme + layout catalogs and the content parser (real template selection).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-103 AI Office: re-export renderDocx/renderXlsx + office themes.
 */

export {
  PresentationEngine, renderPptx, type RenderableSlide,
  DECK_THEMES, DEFAULT_THEME_ID, THEME_IDS, resolveTheme, isThemeId, themeCatalog,
  type DeckTheme, type ThemeFonts, type ThemePalette, type CoverStyle, type DecorStyle,
  LAYOUTS, LAYOUT_ORDER, resolveLayout, layoutCatalog,
  autoSelectLayout, applyDeckRhythm, isLayoutId,
  parseSlideContent, parseMetric, isEmptyData,
  resolveImage, resolveSlideImages, sniffImageMime, fetchCapped,
  docxTheme, xlsxTheme, type DocxTheme, type XlsxTheme,
  renderDocx, renderXlsx,
  importOffice, importDocx, importXlsx, importPptx, type ImportedOutline,
  type LayoutDef, type LayoutFn, type SlideSpec,
} from './services';
