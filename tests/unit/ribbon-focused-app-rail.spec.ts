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

const RIBBON = 'src/pages/cockpit/js/components/RibbonNav.js';
const HUB = 'src/pages/cockpit/tools/platform.html';
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

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

    // Withheld from the RAIL only. If they were dropped from this.views instead, deep links and
    // the iframe navigate bridge would silently break, and the hub could not reach them at all.
    expect(src).toMatch(/bottomViews\s*=\s*bottomViews\.filter\(v => !v\.platformTool/);
    expect(src).not.toMatch(/this\.views\s*=\s*this\.views\.filter\(v => !v\.platformTool/);
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
