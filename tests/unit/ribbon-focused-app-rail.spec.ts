/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the focused-app rail. The cockpit appended its whole platform tool set — Optimizer, Workflow Studio, Run Trace, Dead Letters, Budgets, Notifications — to EVERY cockpit including a focused app, and a manifest could not decline: `hideFrameworkItems` reaches only the hardcoded framework views, never the appended ones. A customer's staff opened the product they were sold and found a dozen operator tools, most of which answer 403 to them. It cost an account on 2026-08-03. These cases pin the inversion: platform chrome is opt-IN for a focused app, and the fallback path can never re-widen a customer's rail.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBottomTray, PLATFORM_HUB_ID } from '@/pages/cockpit/js/components/RibbonNav.js';

/** The tray as a focused app actually presents it: the app's own bottom items, the framework
 *  Settings entry, the appended platform tools, and the hub — all registered together. */
const VIEWS = [
  { id: 'sales-home', section: 'top' },
  { id: 'sales-admin', section: 'bottom' },
  { id: 'sales-import', section: 'bottom' },
  { id: 'settings', section: 'bottom' },
  { id: 'operations', section: 'bottom', platformTool: true },
  { id: 'tool-token-chase', section: 'bottom', platformTool: true },
  { id: 'tool-dlq', section: 'bottom', platformTool: true },
  { id: PLATFORM_HUB_ID, section: 'bottom' },
];

const RIBBON = 'src/pages/cockpit/js/components/RibbonNav.js';
const HUB = 'src/pages/cockpit/tools/platform.html';
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the settings tray, computed', () => {
  const ids = (v: Array<{ id: string }>): string[] => v.map((x) => x.id);

  it('renders each entry EXACTLY once', () => {
    const tray = computeBottomTray(VIEWS, { hidePlatformChrome: true });

    // The shipped bug: the hub is already a member of `views` (that is how it stays navigable
    // while withheld from the rail), so re-pushing it to force it last rendered a SECOND
    // identical button. A customer saw two "Settings" entries opening the same screen.
    expect(ids(tray)).toEqual([...new Set(ids(tray))]);
    expect(ids(tray).filter((id) => id === PLATFORM_HUB_ID)).toHaveLength(1);
  });

  it('keeps the app’s own items and drops platform chrome', () => {
    const tray = computeBottomTray(VIEWS, { hidePlatformChrome: true });

    expect(ids(tray)).toContain('sales-admin');
    expect(ids(tray)).toContain('sales-import');
    for (const gone of ['settings', 'operations', 'tool-token-chase', 'tool-dlq']) {
      expect(ids(tray)).not.toContain(gone);
    }
  });

  it('puts the one door last, below the app’s own entries', () => {
    const tray = computeBottomTray(VIEWS, { hidePlatformChrome: true });
    expect(tray[tray.length - 1].id).toBe(PLATFORM_HUB_ID);
  });

  it('leaves the operator cockpit’s dense tray untouched', () => {
    // No ?app= → hidePlatformChrome false → every bottom view survives, in declaration order.
    const tray = computeBottomTray(VIEWS, { hidePlatformChrome: false });
    expect(ids(tray)).toEqual([
      'sales-admin', 'sales-import', 'settings', 'operations',
      'tool-token-chase', 'tool-dlq', PLATFORM_HUB_ID,
    ]);
  });

  it('gives a kiosk rail no settings tray at all', () => {
    expect(computeBottomTray(VIEWS, { studentMode: true, hidePlatformChrome: true })).toEqual([]);
  });

  it('does not invent a hub that was never registered', () => {
    const withoutHub = VIEWS.filter((v) => v.id !== PLATFORM_HUB_ID);
    const tray = computeBottomTray(withoutHub, { hidePlatformChrome: true });
    expect(ids(tray)).toEqual(['sales-admin', 'sales-import']);
  });
});

describe('a focused app owns its rail', () => {
  it('makes platform chrome opt-IN, never something a manifest must fight off', () => {
    const src = read(RIBBON);

    // The flag is what inverts the default. It must depend on a REQUESTED profile (?app=), so the
    // plain operator cockpit is untouched, and on an explicit opt-in rather than an opt-out.
    expect(src).toMatch(/hidePlatformChrome\s*=\s*!!resolveRequestedProfileName\(\)/);
    expect(src).toMatch(/showPlatformTools\s*!==\s*true/);
  });

  it('tags every appended platform tool, by diff rather than at each push site', () => {
    const src = read(RIBBON);

    // A dozen push sites; one missed tag is a tool that leaks back onto a customer rail. Tagging
    // by diffing the list before/after is what makes that structurally impossible.
    expect(src).toMatch(/const before = this\.views\.length;[\s\S]{0,200}_appendPlatformToolsInner\(\)/);
    expect(src).toMatch(/for \(let i = before; i < this\.views\.length; i\+\+\) this\.views\[i\]\.platformTool = true/);
  });

  it('withholds tagged tools from the rail but keeps them registered', () => {
    const src = read(RIBBON);

    // Withheld from the RAIL only — the tray is a computed view of this.views, never a mutation
    // of it. If the tools were dropped from this.views instead, deep links and the iframe
    // navigate bridge would silently break, and the hub could not reach them at all.
    // (Which tools the tray drops is asserted behaviourally above, against real view shapes.)
    expect(src).not.toMatch(/this\.views\s*=\s*this\.views\.filter\(v => !v\.platformTool/);
    expect(src).toMatch(/const bottomViews = computeBottomTray\(this\.views/);
  });

  it('offers exactly one door in place of the tool set', () => {
    const src = read(RIBBON);
    expect(src).toContain("const PLATFORM_HUB_ID = 'tool-platform-hub'");
    // The hub replaces the framework Settings entry too, so the rail gains one gear, not two.
    expect(src).toMatch(/v\.id !== 'settings'/);
    expect(src).toMatch(/_appendPlatformHub\(\)/);
  });

  it('lets the hub reach a registered-but-unrailed view without widening what is reachable', () => {
    const src = read(RIBBON);

    // `app-navigate` by tool id resolves against RENDERED BUTTONS, so a withheld tool would be
    // unreachable from the hub. The view form resolves against this.views — the admitted set —
    // which is what keeps this from becoming a way to reach a surface the profile withheld.
    expect(src).toMatch(/d\.type === 'app-navigate' && d\.view/);
    expect(src).toMatch(/if \(this\.views\.find\(v => v\.id === want\)\)/);
  });

  it('sends the hub only tools the ribbon actually admitted', () => {
    const src = read(RIBBON);
    const hub = read(HUB);

    // The list is answered from this.views, so an operator-gated tool the caller never received
    // can never be offered as a card. A hardcoded list in the page would drift into doing exactly
    // that the first time a tool was gated.
    expect(src).toMatch(/d\.type === 'platform-hub-ready'/);
    expect(src).toMatch(/tools: this\.views[\s\S]{0,200}filter\(v => v\.platformTool/);
    expect(hub).toContain("type: 'platform-hub-ready'");
    expect(hub).toMatch(/type: 'app-navigate', view: b\.dataset\.view/);
  });

  it('keeps the hub page same-origin and theme-derived', () => {
    const hub = read(HUB);

    // An external stylesheet would be blocked and would leak a request off a customer's box.
    expect(hub).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(hub).toContain('/fonts/codicon.css');
    // Palette from framework tokens, so the page is correct in all eleven themes.
    expect(hub).toContain('/shared/ui/css/surface-themes.css');
    expect(hub).toMatch(/var\(--bg-primary/);
  });

  it('never lets the settings tray crowd out the application', () => {
    const src = read(RIBBON);
    const css = readFileSync(resolve(process.cwd(), 'src/pages/cockpit/css/ribbon.css'), 'utf8');

    // The settings tray renders INSIDE the scrollable area. Pinned as a sibling it carried
    // `flex-shrink: 0` and never yielded, so every icon it held came straight out of the app's
    // tray — a customer's laptop showed four icons of application above a dozen of settings.
    expect(src).toMatch(/<div class="ribbon-scroll">[\s\S]{0,300}ribbon-bottom/);
    // ...and NOT as a sibling after the scroll container closes.
    expect(src).not.toMatch(/<\/div>\s*<div class="ribbon-bottom">/);

    // The app's own screens are rendered before it, so they are what the user sees first.
    expect(src).toMatch(/_renderGroups\(topViews\)[\s\S]{0,200}bottomViews/);

    // The scroll tray must keep the properties that let it actually own the height.
    expect(css).toMatch(/\.ribbon-scroll \{[^}]*flex: 1 1 auto/);
    expect(css).toMatch(/\.ribbon-scroll \{[^}]*min-height: 0/);
  });

  it('does not strand the user on a silent failure', () => {
    const hub = read(HUB);
    // If the shell never answers the ready message, say so rather than showing "Loading…" forever.
    expect(hub).toMatch(/Settings could not be loaded/);
  });
});
