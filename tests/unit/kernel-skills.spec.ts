/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 D8: lock the kernel-skill contract. The kernel's skills are its package-facing API — every declared module must exist AND be re-exported by the build anchor (the re-export is the only thing that carries a feature into dist/, since tsconfig.server.json excludes src/features/**). Also proves the manifest `uses:` validator fails CLOSED on an unknown skill id, so a typo dies at load instead of crashing an installed app at mount.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #5 (finance): the contract grows to eleven — 'payments' is pinned as a declared skill because the finance rip removed its last core importer and BOTH the finance and payments store packages resolve @/features/payments from dist. The spec list is the guard that a future "cleanup" of the anchor can't silently unpin it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { KERNEL_SKILLS, KERNEL_SKILL_IDS, isKernelSkillId } from '../../src/shared/kernel-skills';
import { readManifest } from '../../src/features/swarm-apps/services/swarm-app-loader';

const REPO_ROOT = resolve(__dirname, '../..');
const ANCHOR = 'src/app/composition/kernel-skills.ts';

/**
 * @description Resolve a package-facing `@/…` specifier to its source file, mirroring how the
 * mounter's runtime alias resolves it against the framework's dist.
 * @param specifier - The specifier a package imports.
 * @returns Absolute source path, or null when neither a barrel nor a single file exists.
 */
function resolveSource(specifier: string): string | null {
  const rel = specifier.replace(/^@\//, 'src/');
  for (const candidate of [`${rel}.ts`, `${rel}/index.ts`]) {
    const abs = join(REPO_ROOT, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * @description Write a throwaway manifest YAML and read it back through the real readManifest.
 * @param yaml - Manifest body.
 * @returns The parsed manifest.
 */
function readTempManifest(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-skills-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, yaml, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('kernel-skill contract (ADR-085 Tier-0b / ADR-090 D8)', () => {
  const anchorSrc = readFileSync(join(REPO_ROOT, ANCHOR), 'utf8');
  const allModules = KERNEL_SKILLS.flatMap((s) => s.modules.map((m) => ({ ...m, skill: s.id })));

  it('declares the twelve contracted skills (ten signed off + two carve pins), with no duplicate ids', () => {
    expect(KERNEL_SKILLS.length).toBe(12);
    expect(KERNEL_SKILL_IDS.size).toBe(KERNEL_SKILLS.length);
    // The signed-off Tier-0b list (swarm-store-migration-plan §2) + 'payments', pinned at the
    // finance carve (ADR-085 Wave 1 #5): both its importers live in the store, so only this
    // contract keeps @/features/payments in dist.
    expect([...KERNEL_SKILL_IDS].sort()).toEqual(
      [
        'deck-generation',
        'graph',
        'media-generation',
        'memory',
        'notifications',
        'payments',
        'rag',
        'scheduling',
        'spatial-mapping',
        'storage',
        'tool-registry',
        'voice',
      ].sort(),
    );
  });

  it.each(allModules)('skill $skill: $specifier has a source file', ({ specifier }) => {
    expect(resolveSource(specifier)).not.toBeNull();
  });

  // THE regression this whole contract exists for. Without the re-export, tsc prunes the feature
  // from dist/ and the first installed package that imports it fails at mount — nowhere near here.
  it.each(allModules)('skill $skill: $specifier is pinned into the build by the anchor', ({ specifier }) => {
    expect(anchorSrc).toContain(`from '${specifier}'`);
  });

  it('the anchor pins nothing that is not declared (no orphan re-exports)', () => {
    const declared = new Set(allModules.map((m) => m.specifier));
    const anchored = [...anchorSrc.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(anchored.filter((a) => !declared.has(a))).toEqual([]);
  });

  it('narrows known ids and rejects unknown ones', () => {
    expect(isKernelSkillId('deck-generation')).toBe(true);
    expect(isKernelSkillId('presentations')).toBe(false); // the app, not the skill
  });
});

describe('manifest `uses:` validation (fail-closed)', () => {
  const base = 'name: t\ndisplayName: T\n';

  it('accepts a manifest that uses declared kernel skills', () => {
    const m = readTempManifest(`${base}uses:\n  - deck-generation\n  - rag\n`);
    expect(m.uses).toEqual(['deck-generation', 'rag']);
  });

  it('accepts a manifest with no uses at all', () => {
    expect(readTempManifest(base).uses).toBeUndefined();
  });

  // A typo'd skill would otherwise surface as a missing module at MOUNT time, inside the
  // installed app, with no obvious link back to the manifest. Fail at load instead.
  it('rejects an unknown skill id', () => {
    expect(() => readTempManifest(`${base}uses:\n  - deck-generaton\n`)).toThrow(
      /unknown kernel skill\(s\): deck-generaton/,
    );
  });

  // little-monsters' actual mis-declaration: `presentations` is an APP; the thing it needs is the
  // always-present deck-generation SKILL. Naming the app under `uses:` must not quietly pass.
  it('rejects an app name used as a skill', () => {
    expect(() => readTempManifest(`${base}uses:\n  - presentations\n`)).toThrow(/unknown kernel skill/);
  });

  it('rejects a non-array uses', () => {
    expect(() => readTempManifest(`${base}uses: deck-generation\n`)).toThrow(/must be an array/);
  });
});
