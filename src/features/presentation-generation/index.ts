/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for presentation generation feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-export the theme + layout catalogs and the content parser (real template selection).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-103 AI Office: re-export renderDocx/renderXlsx + office themes.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Brand looks: re-export brandTheme, its input types, OFFICE_SAFE_FONTS and the BrandLookError refusal (with isBrandLookError) for packages that draw in a brand kit's colors and faces.
 */

export {
  PresentationEngine, renderPptx, type RenderableSlide,
  DECK_THEMES, DEFAULT_THEME_ID, THEME_IDS, resolveTheme, isThemeId, themeCatalog,
  OFFICE_SAFE_FONTS, BrandLookError, isBrandLookError, brandTheme,
  type BrandLookInput, type BrandRoleColors, type BrandLookId,
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
