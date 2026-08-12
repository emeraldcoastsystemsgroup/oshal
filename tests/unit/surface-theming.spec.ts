/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-12 prevention gate. A cockpit surface must take its colours from the operator's chosen theme, not from a palette it hardcodes. This went wrong twice: `surface-themes.css` was built to fix it, ~24 surfaces were converted, the rollout stopped, and nothing failed when the remainder (and every surface added afterwards) shipped painting its own dark palette — because the nearest copy-paste neighbour was always an unconverted file. This spec is the thing that fails instead. It asserts three properties per surface: a theme SOURCE is linked, a default `data-theme` exists (theme tokens are scoped to that attribute — without it a surface gets no tokens at all), and no bare hex colour is declared in a `:root` block. The allowlist is deliberately tiny and each entry carries its reason; growing it is the wrong fix for a red run.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/**
 * Surfaces that legitimately do not consume the cockpit theme. Every entry needs a reason;
 * "it was easier" is not one. A new surface belongs in the themed set, not here.
 */
const NOT_THEMED_BY_DESIGN: Record<string, string> = {
  'src/pages/cockpit/index.html': 'the cockpit shell itself — it OWNS the theme and links css/themes/* directly',
  'src/api/index.html': 'public landing page served outside the cockpit, with its own brand styling',
  'src/api/privacy.html': 'public legal page, standalone by design',
  'src/api/terms.html': 'public legal page, standalone by design',
  'src/pages/welcome/index.html': 'first-run provider wizard shown before a theme preference exists',
  'src/pages/pumpkin/index.html': 'physical prop display surface, not a cockpit pane',
};

/** Collect the surface HTML files this gate governs. */
function surfaceFiles(): string[] {
  const out: string[] = [];
  const pagesDir = resolve(ROOT, 'src/pages');
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(pagesDir, entry.name, 'index.html');
    if (existsSync(file)) out.push(`src/pages/${entry.name}/index.html`);
  }
  const apiDir = resolve(ROOT, 'src/api');
  for (const f of readdirSync(apiDir)) if (f.endsWith('.html')) out.push(`src/api/${f}`);
  return out.filter((f) => !(f in NOT_THEMED_BY_DESIGN)).sort();
}

/** The stylesheets that carry framework theme tokens. */
function hasThemeSource(html: string): boolean {
  return html.includes('surface-themes.css') || /cockpit\/css\/themes\//.test(html);
}

/** Extract `:root { ... }` bodies (a surface's own alias block). */
function rootBlocks(css: string): string[] {
  return [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]);
}

/** Bare hex colours, ignoring pure white/black which are contrast values on coloured chips. */
function bareHex(block: string): string[] {
  return (block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])
    .filter((h) => !/^#(fff|000|ffffff|000000)$/i.test(h));
}

describe('cockpit surfaces follow the operator theme (BUG-12)', () => {
  const files = surfaceFiles();

  it('governs a real set of surfaces', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every surface links a theme source', () => {
    const missing = files.filter((f) => !hasThemeSource(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(missing, `these surfaces link no theme source, so they paint their own palette:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every surface sets a default data-theme (tokens are scoped to it)', () => {
    const missing = files.filter((f) => !/<html[^>]*\bdata-theme=/.test(readFileSync(resolve(ROOT, f), 'utf8')));
    expect(missing, `theme tokens are scoped to [data-theme]; without it these get NO tokens:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no surface declares a hardcoded palette in :root', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const block of rootBlocks(readFileSync(resolve(ROOT, f), 'utf8'))) {
        const hex = bareHex(block);
        if (hex.length) offenders.push(`${f}: ${hex.slice(0, 5).join(' ')}`);
      }
    }
    expect(offenders, `derive these from framework tokens instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the sibling stylesheets of themed surfaces declare no hardcoded palette in :root', () => {
    const offenders: string[] = [];
    const pagesDir = resolve(ROOT, 'src/pages');
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (`src/pages/${entry.name}/index.html` in NOT_THEMED_BY_DESIGN) continue;
      const css = join(pagesDir, entry.name, `${entry.name}.css`);
      if (!existsSync(css)) continue;
      for (const block of rootBlocks(readFileSync(css, 'utf8'))) {
        const hex = bareHex(block);
        if (hex.length) offenders.push(`${entry.name}.css: ${hex.slice(0, 5).join(' ')}`);
      }
    }
    expect(offenders, `derive these from framework tokens instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps the by-design exemption list small and justified', () => {
    for (const reason of Object.values(NOT_THEMED_BY_DESIGN)) expect(reason.length).toBeGreaterThan(20);
    expect(Object.keys(NOT_THEMED_BY_DESIGN).length).toBeLessThanOrEqual(8);
  });
});
