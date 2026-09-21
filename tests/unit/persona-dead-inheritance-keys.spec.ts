/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-14 / D7. `extends:` and `foundation.persona` were declared in seven core personas and five store manifests and read by NOTHING - not either persona parser, not either bot-node provider, not any script. A key nothing reads is a second, silent authority over a bot's persona, and the rules written under it had never reached a prompt. This guard is deliberately a CLOSED, NAMED list of exactly two keys. The entry forbids writing it as "any key the parser does not consume": measured, that phrasing fires on 50 of 103 files across 25 keys, most of them documentation or fields a different consumer reads, so it would be a red gate nobody could act on. The store half is covered too - otherwise this could be signed off with the dead key still shipping in ten installed packages - and the store scan fails loudly when the sibling checkout is missing rather than skipping, because a guard that skips is a guard that does not exist.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The closed list. Two keys, named. `extends` is a top-level persona key; `foundation` is a
 * top-level manifest key whose only child was `persona`.
 */
const DEAD_KEYS = ['extends', 'foundation'] as const;

const CORE = process.cwd();
const STORE = process.env.OSHAL_STORE_REPO ?? join(CORE, '..', 'oshal-applications');

/** A top-level YAML key assignment, i.e. column zero — not a nested one and not a comment. */
function declaresKey(text: string, key: string): boolean {
  return new RegExp(`^${key}:`, 'm').test(text);
}

/** Every file under `dir` whose name ends with one of `suffixes`, recursively. */
function filesUnder(dir: string, suffixes: string[], skip: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, suffixes, skip));
    else if (suffixes.some((s) => entry.name.endsWith(s)) && statSync(full).isFile()) out.push(full);
  }
  return out;
}

/** Files declaring any of the two dead keys, reported as `path: key`. */
function offenders(files: string[], root: string): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const key of DEAD_KEYS) {
      if (declaresKey(text, key)) found.push(`${relative(root, file).replace(/\\/g, '/')}: ${key}`);
    }
  }
  return found;
}

describe('the two dead inheritance keys are declared nowhere', () => {
  it('no core persona YAML declares extends: or foundation:', () => {
    const personas = filesUnder(join(CORE, 'ai-lab', 'bot-personas'), ['.yaml', '.yml'], new Set());
    expect(personas.length, 'no personas found — the scan is broken, not the tree').toBeGreaterThan(20);
    expect(offenders(personas, CORE), 'a persona declares a key nothing reads').toEqual([]);
  });

  it('no core swarm-app manifest declares extends: or foundation:', () => {
    const manifests = filesUnder(join(CORE, 'swarm-apps'), ['.yaml', '.yml'], new Set());
    expect(manifests.length, 'no manifests found — the scan is broken, not the tree').toBeGreaterThan(5);
    expect(offenders(manifests, CORE), 'a manifest declares a key nothing reads').toEqual([]);
  });

  it('no core foundation persona file is left behind', () => {
    const left = readdirSync(join(CORE, 'ai-lab', 'bot-personas'))
      .filter((name) => /foundation.*\.ya?ml$/.test(name));
    expect(left, 'a foundation persona nothing can load is still in the tree').toEqual([]);
  });

  it('the manifest type no longer declares the field, and the CLI no longer validates it', () => {
    // The declaration is the thing that invited the key. Leaving the type while deleting the
    // manifests would let it come back, and a package author reading types.ts would be told to.
    const types = readFileSync(join(CORE, 'src/features/swarm-apps/types.ts'), 'utf8');
    expect(types).not.toMatch(/^\s*foundation\?:/m);
    const cli = readFileSync(join(CORE, 'scripts/oshal-app.js'), 'utf8');
    expect(cli).not.toContain('foundation.persona');
  });

  it('the store packages do not ship the keys either', () => {
    // Loudly, not skipped: "the dead key still shipping in ten installed packages" is exactly the
    // way this entry could be signed off while remaining half done. Point OSHAL_STORE_REPO at a
    // checkout if the sibling directory is elsewhere.
    expect(existsSync(STORE), `store checkout not found at ${STORE} — set OSHAL_STORE_REPO`).toBe(true);
    const skip = new Set(['node_modules', '.git', 'output', '.github']);
    const packages = readdirSync(STORE, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !skip.has(e.name))
      .flatMap((e) => {
        const personas = join(STORE, e.name, 'personas');
        const manifest = join(STORE, e.name, 'oshal-app.yaml');
        return [
          ...(existsSync(personas) ? filesUnder(personas, ['.yaml', '.yml'], skip) : []),
          ...(existsSync(manifest) ? [manifest] : []),
        ];
      });
    expect(packages.length, 'no store package files found — the scan is broken, not the store').toBeGreaterThan(20);
    expect(offenders(packages, STORE), 'a store package ships a key nothing reads').toEqual([]);
  });
});
