# Shared portal appearance

The portal theme chooser controls the saved browser palette across Cockpit,
same-origin embedded applications and standalone shared pages. **Workspace** is
the initial palette only when no choice exists. Valid saved choices remain;
unknown saved IDs fall back to Midnight. Choosing a theme does not reload pages,
change permissions, navigate, submit forms or replace unsaved application content.

Settings → Global Settings → **Application colors** enables each focused profile's
declared `theme` and optional bundled `themeCssUrl`. These remain transient and
never overwrite `cockpit-theme`. Selecting any portal palette disables application
colors. The preference is browser-local, like the independent Navigation setting.
The current profile continues to determine application identity, tools and layout.

With top workspace navigation, **More → Settings** opens the full chooser and
**More → Switch theme** cycles the same saved palettes. Navigation layout, focus,
knowledge and assistant controls share this menu. In Sidebar layout they remain
under **Workspace options** beside Profile. These are the original controls, so
switching navigation layouts preserves their state and the open application.
Top workspaces include Federal CRM when the current user can open it. In the
default Home sidebar, explicit workspace metadata removes repeated Learning,
Career and Create pages while those top destinations are available. A focused
application keeps its own pages; Sidebar layout restores the full default rail.
The OSHAL Cockpit brand returns to all applications; it is not repeated as a tab.

## An application surface

Link the shared palette and bootstrap before page-owned styles. Give semantic
aliases to existing CSS rather than copying the parent's computed colors:

```html
<html lang="en" data-theme="midnight">
<head>
  <link rel="stylesheet" href="/shared/ui/css/surface-themes.css">
  <script src="/shared/ui/js/surface-theme.js"></script>
  <style>
    :root {
      --page: var(--bg-primary);
      --panel: var(--bg-card);
      --ink: var(--text-primary);
      --muted: var(--text-secondary);
      --line: var(--border-color);
    }
    body { color: var(--ink); background: var(--page); }
    button.primary {
      background: var(--accent-primary);
      color: var(--text-on-accent, #fff);
    }
  </style>
</head>
```

All twelve core palettes supply readable primary accent ink and a native control
color scheme. Pages should not force a different `color-scheme` or use the operating
system preference to override the selected palette. Keep print previews, image
canvases and document paper intentional; a white résumé is content, not portal chrome.
The Workspace finish of shared semantic cards uses opaque paper surfaces and soft
shadows. It does not alter editor geometry or broadly restyle arbitrary controls.

The bootstrap observes the same-origin parent and follows saved choices in other
tabs. Bundled skins are loaded through the existing authenticated stylesheet route.
It never writes user preferences. A standalone tool with a documented default can
set `data-theme-default="midnight"` on its script; `data-theme-query` additionally
accepts a supported `?theme=` URL. These exceptions never outrank an embedding
parent. Do not add a separate palette allowlist or another copy of the theme bridge.

## Verification and registration

New theme behavior needs real rendered-page checks: selected and live palettes,
readable text and controls, preserved inputs and document identity, and mobile
geometry. Avoid checking only a `data-theme` attribute while fixed-color panels
remain unreadable. Package tests belong in the manifest's versioned Test Lab
catalog with honest runner prerequisites and side effects.

`npm run test:workspace-theme` includes the actual portal chooser, shared surfaces,
chat and administration/operations renderers. `npm run test:workspace-navigation`
covers the separate header layout and existing permission contract. The core Lab
appearance card checks stylesheet readiness and links these regressions; clicking
that readiness card does not execute the browser suites. Installation reconciles
package-owned catalogs; unsupported browser harnesses remain pending in the Lab.
