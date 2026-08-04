/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the shared reading-comfort rail. A user reported being unable to read an assistant answer; the product had no text-size control, the root font-size was absolute px (which discards the reader's own browser preference), and the answer column was capped in px so widening the panel made the line length worse rather than the text bigger. These cases pin all three, plus the JS/CSS level-id contract whose silent drift would leave the control apparently working and visually inert.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

const READING_JS = 'src/shared/ui/js/surface-reading.js';
const READING_CSS = 'src/shared/ui/css/surface-reading.css';
const DESIGN_CSS = 'src/shared/ui/css/design-system.css';
const JARVIS = 'src/api/jarvis.html';

describe('shared reading-comfort rail', () => {
  it('agrees on the level ids across the JS and the CSS', () => {
    const js = read(READING_JS);
    const css = read(READING_CSS);

    // Parse the ids OUT of each file rather than asserting a hardcoded list in two places — that
    // is the whole point. The classic silent failure is the JS writing data-reading="large" while
    // the CSS still styles [data-reading="big"]: the control responds, the attribute changes, and
    // nothing on screen moves. A substring check for either spelling would not catch it.
    const jsLevels = /var LEVELS\s*=\s*\[([^\]]+)\]/.exec(js);
    expect(jsLevels, 'surface-reading.js must declare a LEVELS array').not.toBeNull();
    const declared = [...jsLevels![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const styled = [...css.matchAll(/html\[data-reading='([^']+)'\]/g)].map((m) => m[1]);

    expect(declared.length).toBeGreaterThanOrEqual(4);
    expect([...declared].sort()).toEqual([...styled].sort());
  });

  it('exposes both tokens, and expresses the measure in ch so expanding stays readable', () => {
    const css = read(READING_CSS);

    expect(css).toMatch(/--reading-scale:\s*1\s*;/);
    // `ch` is load-bearing: the column then grows with the type and holds its ~68-character line
    // at every scale and panel width. A px measure is what let a maximised panel run small text to
    // ~112 characters per line — wider, and harder to read, not easier.
    expect(css).toMatch(/--reading-measure:\s*\d+ch/);
    expect(css).not.toMatch(/--reading-measure:\s*\d+px/);

    // Palette belongs to surface-themes.css. A literal hex here would also fail
    // surface-theme-inheritance.spec.ts, but fail it locally with a clearer message.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('DEFAULTS to a level that is actually larger than the size that was complained about', () => {
    const js = read(READING_JS);
    const css = read(READING_CSS);

    // The original fix shipped the stepper with FALLBACK='cozy' — scale 1, the historical
    // rendering. Every surface therefore looked completely unchanged, and the reader who reported
    // "I can't read the outcome" saw exactly what they reported, because the remedy was hidden
    // behind a control they had to discover. Landing a control is not the same as landing the fix.
    //
    // Resolved through the CSS rather than asserted as a string: pinning the literal 'comfortable'
    // would stay green if that level's scale were later edited down to 1, which is the same bug
    // wearing a different name.
    const fallback = /var FALLBACK\s*=\s*'([^']+)'/.exec(js)?.[1];
    expect(fallback, 'surface-reading.js must declare a FALLBACK level').toBeTruthy();

    const rule = new RegExp(`html\\[data-reading='${fallback}'\\]\\s*\\{[^}]*\\}`).exec(css)?.[0];
    expect(rule, `the CSS must style the default level '${fallback}'`).toBeTruthy();

    const scale = Number(/--reading-scale:\s*([\d.]+)/.exec(rule!)?.[1]);
    expect(scale).toBeGreaterThan(1);
  });

  it('applies the saved level at load and live-follows changes on both listeners', () => {
    const js = read(READING_JS);

    // Mirrors the proven surface-theme.js mechanism. Registering only `storage` leaves a surface
    // stale when the event is missed (opened standalone, changed in another tab); registering only
    // `focus` means an open panel does not re-scale until it is clicked.
    expect(js).toMatch(/addEventListener\(\s*'storage'/);
    expect(js).toMatch(/addEventListener\(\s*'focus'/);
    expect(js).toMatch(/apply\(saved\(\)\)/);

    // The key must appear in the storage handler, or the listener fires and ignores the change.
    const handler = /addEventListener\(\s*'storage'[\s\S]{0,240}/.exec(js)?.[0] ?? '';
    expect(handler).toContain('KEY');

    // Mounted before the OIDC middleware: a fetch would 302 to /login and the browser would
    // reject the HTML as a script, breaking every surface that loads this file.
    expect(js).not.toMatch(/\bfetch\s*\(/);

    // Storage is unavailable in private mode and sandboxed frames; a throw here would take the
    // whole surface down before first paint.
    expect(js).toMatch(/catch\s*\(_\)/);
  });

  it('keeps the root font-size relative so a reader preference is not discarded', () => {
    const css = read(DESIGN_CSS);
    const root = /html\s*\{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(root).toContain('font-size');
    // An absolute root size silently overrides a reader who set 20px in their browser — the exact
    // failure that was reported. Relative units multiply their preference instead.
    expect(root).not.toMatch(/font-size:\s*\d+px/);
    expect(root).toMatch(/font-size:\s*calc\([^)]*%/);
  });
});

describe('the assistant surface consumes the rail', () => {
  it('loads the rail alongside the theme bootstrap', () => {
    const html = read(JARVIS);
    expect(html).toContain('/shared/ui/css/surface-reading.css');
    expect(html).toContain('/shared/ui/js/surface-reading.js');
  });

  it('scales every answer container, not merely the prose', () => {
    const html = read(JARVIS);

    // Each of these renders answer content. A reader who asks for larger text means the whole
    // answer — an unscaled table or code block leaves the densest part of it unreadable, which
    // is the half-fix this case exists to prevent.
    const containers = [
      /\.result-panel \.bx \{[^}]*font-size:\s*calc\([^)]*--reading-scale/,
      /\.result-panel \.bx table\.md \{[^}]*font-size:\s*calc\([^)]*--reading-scale/,
      /\.bx table\.md \{[^}]*font-size:\s*calc\([^)]*--reading-scale/,
      /\.bx pre\.code \{[^}]*font-size:\s*calc\([^)]*--reading-scale/,
      /\.bubble \.ai \{[^}]*font-size:\s*calc\([^)]*--reading-scale/,
    ];
    for (const re of containers) expect(html).toMatch(re);
  });

  it('caps the answer column by the measure rather than a fixed width', () => {
    const html = read(JARVIS);
    // The previous `width:min(860px,100%)` is precisely what made expanding counter-productive.
    expect(html).toMatch(/\.result-panel \{[^}]*width:\s*min\(var\(--reading-measure/);
    expect(html).not.toMatch(/\.result-panel \{[^}]*width:\s*min\(860px/);
  });

  it('lets the reserved caption slot scroll instead of truncating', () => {
    const html = read(JARVIS);
    // The slot is reserved to stop the controls jumping, which is right. Pinning it to a fixed
    // height with no overflow made anything longer unreachable — and this rule fires inside the
    // 400px embedded panel, so on a desktop and not only on a phone.
    const rule = /\.bubble \{\s*height:[^}]*\}/.exec(html)?.[0] ?? '';
    expect(rule).toContain('overflow-y:auto');
    expect(rule).toMatch(/--reading-scale/);
  });

  it('offers the text-size and print controls on the answer itself', () => {
    const html = read(JARVIS);
    // A reader who cannot read the answer must not have to find a settings screen to fix it.
    expect(html).toContain('id="readingSizeBtn"');
    expect(html).toContain('id="resultPrintBtn"');
    expect(html).toContain('window.OshalReading?.step()');

    // Print opens a top-level window: printing from inside a same-origin iframe is inconsistent
    // across browsers, and this surface's dark dashboard chrome would print unreadably.
    expect(html).toMatch(/function printConversation\(\)[\s\S]{0,1600}window\.open\('',\s*'_blank'\)/);
    expect(html).toMatch(/printConversation[\s\S]*background:#fff/);
  });
});
