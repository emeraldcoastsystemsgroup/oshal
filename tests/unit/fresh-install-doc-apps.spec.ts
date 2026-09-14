/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-11 guard: the pages that describe a fresh clone may only point a reader at an app a fresh clone has — a kernel manifest in swarm-apps/. INSTALL.md offered `?app=eats` and the zero-keys quick start offered `?app=little-monsters`, both carved to the app store long ago, so the first link a new user tried opened an app that is not installed.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..');

/** The pages a reader follows straight after cloning and running the installer. */
const FRESH_INSTALL_PAGES = ['INSTALL.md', 'docs/deployment-models.md'];

/**
 * @description The `name:` of every kernel-resident manifest — the apps a fresh clone boots with.
 * The key is the manifest's name, not its filename (security.yaml is `security-center`).
 * @returns The set of kernel app names.
 */
function kernelAppNames(): Set<string> {
  const dir = join(REPO, 'swarm-apps');
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
    const name = /^name:\s*['"]?([\w.-]+)/m.exec(readFileSync(join(dir, f), 'utf8'));
    return name ? name[1] : f.replace(/\.yaml$/, '');
  }));
}

/**
 * @description Every `?app=<name>` a page links or tells the reader to open.
 * @param text - The page source.
 * @returns The app names, in order of appearance.
 */
function appLinks(text: string): string[] {
  return [...text.matchAll(/[?&]app=([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]);
}

describe('fresh-install pages only point at apps a fresh clone has (BUG-11)', () => {
  const kernel = kernelAppNames();

  it('reads the kernel manifests, so the check below is not vacuous', () => {
    expect(kernel.has('intelligent-operations')).toBe(true);
    expect(kernel.has('security-center')).toBe(true);
    expect(appLinks('open /cockpit/?app=little-monsters or …?profile=x&app=jarvis')).toEqual(['little-monsters', 'jarvis']);
  });

  it.each(FRESH_INSTALL_PAGES)('%s links no app that ships only from the store', (page) => {
    const strays = appLinks(readFileSync(join(REPO, page), 'utf8')).filter((name) => !kernel.has(name));
    expect(strays).toEqual([]);
  });
});
