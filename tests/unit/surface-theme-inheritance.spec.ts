/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: a standalone surface must INHERIT the framework theme, not hardcode a dark palette. 28 of 37 surfaces declared their own :root palette in literal hex and consumed ZERO framework tokens — they only "worked" in dark by accident and broke in the other ten themes. Several even read the saved theme and set data-theme, then overrode every token with hex, so the attribute did nothing. This test makes that a failing build.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Carve-residue guard: an ADR-085 carve that deletes a surface .html but leaves its docker-compose bind mount makes the api recreate re-materialize src/api/<name>.html as an EMPTY DIRECTORY, which crashed the readFileSync below with a cryptic EISDIR. Now a directory-shaped .html entry fails LOUD with the fix ("remove the stale bind"), and directories are excluded from the theme scan.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SURFACE_DIR = 'src/api';

/**
 * @description Every direct .html entry under src/api that is actually a FILE. A carve that
 * removes a surface but leaves its docker-compose bind mount lets Docker recreate the path as
 * an empty directory on the next api recreate — this partitions those out and the guard below
 * fails loudly on any that appear.
 */
const htmlEntries = readdirSync(SURFACE_DIR).filter((f) => f.endsWith('.html'));
const htmlDirs = htmlEntries.filter((f) => statSync(join(SURFACE_DIR, f)).isDirectory());

/** Framework theme tokens a surface is expected to consume (see any /cockpit/css/themes/*.css). */
const FRAMEWORK_TOKENS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-card',
  '--bg-card-hover',
  '--border-color',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent-primary',
];

/**
 * Pages that legitimately carry no themed chrome: legal/static pages and shells whose styling comes
 * entirely from elsewhere. They declare no palette, so there is nothing to inherit.
 */
const EXEMPT = new Set(['privacy.html', 'terms.html', 'index.html', 'chat.html', 'chat-standalone.html']);

/**
 * @description Does this surface declare its own colour palette (CSS custom properties with literal
 * colour values)?
 * @param src - Surface HTML.
 * @returns True when the surface defines at least one custom property with a literal colour.
 */
function declaresPalette(src: string): boolean {
  return /--[a-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\()/.test(src);
}

/**
 * @description Count how many framework theme tokens the surface actually consumes.
 * @param src - Surface HTML.
 * @returns Number of `var(--<framework token>)` reads.
 */
function tokenReads(src: string): number {
  return FRAMEWORK_TOKENS.reduce((n, t) => {
    const m = src.match(new RegExp(`var\\(\\s*${t}\\b`, 'g'));
    return n + (m ? m.length : 0);
  }, 0);
}

const surfaces = htmlEntries
  .filter((f) => !EXEMPT.has(f))
  .filter((f) => !statSync(join(SURFACE_DIR, f)).isDirectory())
  .map((f) => ({ file: f, src: readFileSync(join(SURFACE_DIR, f), 'utf8') }))
  // Only surfaces that actually paint chrome are subject to the contract.
  .filter(({ src }) => declaresPalette(src) || /<style/.test(src));

describe('src/api surface hygiene (ADR-085 carve residue)', () => {
  it('has no directory masquerading as a surface .html (stale compose bind mount)', () => {
    expect(
      htmlDirs,
      `src/api/${htmlDirs.join(', ')} is a DIRECTORY, not a file — a carved surface's docker-compose ` +
        `bind mount was left behind and the api recreate re-created it as an empty dir. Remove the ` +
        `stale "- ./src/api/<name>.html:..." bind from docker-compose.oshal-local.yml, then rmdir the path.`,
    ).toEqual([]);
  });
});

describe('standalone surfaces inherit the framework theme', () => {
  it('finds surfaces to check', () => {
    expect(surfaces.length).toBeGreaterThan(10);
  });

  // THE BUG THIS EXISTS FOR. A surface that declares a palette in literal hex and reads no framework
  // token renders the same colours whatever theme the operator picked — i.e. it only looks right in
  // one of them. There are eleven.
  it.each(surfaces.map((s) => s.file))(
    '%s derives its palette from the framework theme (not hardcoded hex)',
    (file) => {
      const src = surfaces.find((s) => s.file === file)!.src;
      if (!declaresPalette(src)) return; // no palette of its own — nothing to inherit

      expect(
        tokenReads(src),
        `${file} declares its own colour palette but reads ZERO framework theme tokens, so it ` +
          `cannot follow the operator's theme — it will only look right in the one theme its hex ` +
          `happens to match. Map your aliases onto the tokens instead:\n` +
          `  :root { --bg: var(--bg-primary); --text: var(--text-primary); --line: var(--border-color); … }`,
      ).toBeGreaterThan(0);
    },
  );

  it.each(surfaces.map((s) => s.file))('%s loads the framework theme tokens', (file) => {
    const src = surfaces.find((s) => s.file === file)!.src;
    if (!declaresPalette(src)) return;

    const hasTokens =
      src.includes('/shared/ui/css/surface-themes.css') || /css\/themes\/[a-z-]+\.css/.test(src);
    expect(
      hasTokens,
      `${file} consumes framework tokens but never LOADS them. Add:\n` +
        `  <link rel="stylesheet" href="/shared/ui/css/surface-themes.css" />`,
    ).toBe(true);
  });

  // Theme files scope to [data-theme="…"] with NO bare :root fallback, so a surface with no
  // data-theme gets no tokens at all — every colour would fall back to the (missing) default.
  it.each(surfaces.map((s) => s.file))('%s sets a default data-theme on <html>', (file) => {
    const src = surfaces.find((s) => s.file === file)!.src;
    if (!declaresPalette(src)) return;

    expect(
      /<html[^>]*\sdata-theme=/.test(src),
      `${file} must set a default theme on <html> (e.g. <html lang="en" data-theme="midnight">). ` +
        `Theme files scope to [data-theme="…"] with no :root fallback, so without it the surface ` +
        `renders with NO tokens defined at all.`,
    ).toBe(true);
  });
});
