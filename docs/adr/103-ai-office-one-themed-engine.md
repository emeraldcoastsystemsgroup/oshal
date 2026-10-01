# ADR-103: AI Office — one themed engine across .pptx, .docx and .xlsx

**Status:** Accepted (2026-07-17); amended 2026-10-01 (brand looks, see the addendum)
**Relates to:** ADR-036 (bot-owned apps), ADR-043 (Presentation Studio), ADR-097 (suites)

## Context

The Presentation Studio renders a real, desktop-editable .pptx from a structured outline:
ten themes, twenty layouts, real slide masters/placeholders/number fields, native charts
with embedded workbooks (shipped 2026-07-16). The same structured outline — title +
sections whose bodies carry the parsing micro-syntax (`##` groups, `|` tables, `>` quotes,
`label :: value` pairs, `Label: 42` series) — contains everything a Word document or an
Excel workbook needs. The operator's goal is an **Office engine**: everyone gets the
integrated experience, not a deck toy.

Meanwhile two legacy presentation paths linger: the `/api/presentations` mount proxies to a
**Presentron** container that no longer exists, and the `presentron` chat tool calls the
same dead endpoint (the any-bot `PresentationService.js` sibling returns mock data on
failure — a standing no-mock violation).

## Decision

1. **One input, three projections.** `renderPptx`, `renderDocx` and `renderXlsx` all take
   `(title, RenderableSlide[], DeckRenderOptions)` and reuse `parseSlideContent` — the
   outline is the product; the format is a view. No format gets its own authoring model.
2. **One theme system.** The ten deck themes are the single source of truth.
   `office-themes.ts` projects them onto Word (`docxTheme`) and Excel (`xlsxTheme`).
   Dark-canvas themes project to dark-on-white pages/sheets — inverting a Word page is a
   novelty, not a document. Fonts stay restricted to faces shipping with Office on Windows
   **and** macOS.
3. **Editability is the contract, per format.** pptx: masters/placeholders/fields/native
   charts. docx: real paragraph styles + `HeadingLevel` (navigation pane and TOC work),
   real tables, page-number fields. xlsx: real typed cells, live formulas, frozen headers,
   styled native tables. If a projection would rasterize or flatten, it is wrong.
4. **Same rails.** The formats ship on the existing presentations router + deck-builder bot
   store (ADR-043 paths), auth-gated identically, recorded in `oshal_presentations` with a
   `format` column. Interactive = same sync route; cost/ownership unchanged (ADR-036).
5. **Slice naming.** The renderers live in `src/features/presentation-generation/` because
   FSD bans sibling-slice imports and the themes live there. When the slice next gets real
   structural work, it renames to `office-generation` in one move. Do not split the themes
   across slices to force the name early.

## Consequences

- A bot (or the AI-draft path) that can write one outline can emit a deck, a document and a
  workbook that visibly belong to the same brand — the "AI Office" demo is one POST per
  format, no new authoring surface.
- The micro-syntax is now a three-format contract: parser changes must be checked against
  all three renderers' tests, not just the deck's.
- **Deferred (BACKLOG):** re-pointing the `presentron` chat tool at the real renderer.
  Its handler runs in the features layer, so the clean path is HTTP-to-self with
  service-secret auth accepted by the presentations router — an authz-middleware change
  that must not ride a feature commit. Done-when: `presentron` tool calls produce a real
  saved .pptx under the calling user's store, the dead-endpoint integration + the any-bot
  mock fallback are deleted, and the legacy `/api/presentations` Presentron mount is
  removed.
- Graph/OneDrive delivery (save the artifact into the user's real Microsoft 365 via the
  operator's Graph engine) is the intended next seam and is out of scope here.

## Addendum (2026-10-01): brand looks

Approved by the operator as a core change on 2026-09-22. Decision 2 is extended: the ten
looks are still the only built-in looks, and a caller may also hand the renderers a **brand
look** built from a brand kit.

- `brandTheme({ base, colors, fonts })` builds a complete look. `base` is one of the ten look
  ids; `colors` is the kit's five roles (`primary`, `secondary`, `accent`, `dark`, `light`,
  six-digit hex each); `fonts` is a heading and a body face from `OFFICE_SAFE_FONTS`. `light`
  becomes the page, `dark` the text and the cover surface, `primary` and `secondary` the two
  accents, and the chart series run primary, secondary, accent and then eased variants. A brand
  color is used as text only where it reads at 4.5:1; otherwise the text is black or white. The
  cover, decoration, corner radius, title casing and mono face come from the base look. The
  look's id is `brand:<base>`.
- `resolveTheme`, `docxTheme`, `xlsxTheme` and the three renderers accept a look id or such a
  look (`DeckRenderOptions.theme` is `DeckThemeId | DeckTheme`). An id resolves as before: an
  unknown id falls back to the default, and only the ten ids count (an inherited name such as
  `constructor` is unknown).
- A look object is checked field by field before anything is drawn. An invalid one throws
  `BrandLookError` (code `invalid_brand_look`) with a readable reason and is never replaced by
  the default look, so a refused look produces no file.
- `tests/unit/brand-look-render.spec.ts` opens a generated .pptx, .docx and .xlsx and reads the
  brand colors and faces back. `tests/unit/deck-looks-unchanged.spec.ts` compares every OOXML part
  of the ten looks in all three formats, and the picker catalog, with digests generated from the
  renderer before this change. Only the package timestamps and pptxgenjs's process-wide chart
  numbering are normalised.
- The engine reads no package storage and no route was added: the caller supplies the kit.
