# Configurable homebases — verification

Date: 2026-09-25. These checks exercise standalone local design prototypes, not deployed applications.

## New prototypes

`node docs/assets/experience-shells/check-homebase.cjs` passed **202 assertions**. Three presets, four example people per preset, six viewport widths (1440, 1024, 768, 600, 390, 320). No browser runtime errors or external HTTP requests.

Verified:

- All navigation destinations and app preview panels open.
- Shared calendar edits are visible after switching example people.
- Family shopping edits are shared across role previews; location opt-in remains per person. Opt-out removes that person's displayed whereabouts. One child starts opted out.
- Parents have their own labeled Finance view; children do not render Finance and receive independent learning views. A non-admin parent cannot edit shared configuration.
- Teacher-published requirements appear for students. Students cannot edit those requirements or classwide calendar events, and do not render the teacher progress panel. Student checklists are independent; submitted work is visible in the teacher's example roster.
- The company's separately granted operations user sees Finance. The engineering lead and ordinary members do not. A lead can record an example review; a member cannot.
- Skin, density, activity visibility and calendar-strip configuration publish, survive reload, and restore. The role/capability configuration is independent of those presentation changes.
- Learning progress refreshes after closing its panel. Modal Escape and ordinary keyboard forms work; entered markup is rendered as text.
- Primary pages, alternate role views, configuration dialogs and the expanded gallery fit checked viewport widths without horizontal page overflow or checked heading/control bounds escaping the viewport.
- All three gallery thumbnails load.

Desktop and mobile screenshots are in `previews/homebase-*.png`, including child/student/member variants. All three primary desktop views and the classroom mobile view were visually inspected. A decorative illustration overflow at tablet width was corrected and the full new suite rerun. The browser harness was also corrected to target visible configuration controls at mobile widths; the top-level control remains available when desktop navigation is hidden.

## Regression of earlier designs

`node docs/assets/experience-shells/check-full-swarm.cjs` rerun: **373 assertions passed**, no runtime errors or external requests. Studio, Jarvis, Orbit and Commons retain all 62 catalog entries and six-width responsive checks.

## Existing platform baseline (read-only assessment)

The four-file theme/navigation/Home command recorded in `RESKIN-IMPACT-STUDY.md` produced **90 passed / 1 failed**. The Home manifest fixture omits the concierge required by the current loader. No core source or fixture was edited, and no green baseline is claimed.

## Important limits

All fixtures are bundled client-side and all changes stay in this preview session. Role switching demonstrates intended UX; it is **not** secure authentication, record isolation or a multi-session concurrency test. No real finance, school, device, location, message, provider or production setting is used. The source-grounded impact study identifies server authorization, consent, data adapters, persistence, Test Lab registration and installed acceptance still required for a production implementation.

The skin/configuration examples are not registered as production feature acceptance. The existing Little Monsters mascot was copied unchanged from its package; other illustration elements are local CSS. No remote assets are required.
