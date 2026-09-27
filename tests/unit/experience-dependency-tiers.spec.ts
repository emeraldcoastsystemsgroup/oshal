/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Parity between the experience shell's browser dependency reader (live-data.js dependencyTiers) and the installer's contract (scripts/oshal-app-dependencies.js) over the same tiered, legacy flat, empty and mixed manifests, so the Required / Optional labels an app panel shows cannot drift from what the installer enforces.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Both readers are CommonJS-loadable shipped files; the spec runs the files themselves, not copies.
const LIVE = require('../../src/experience/live-data.js') as Record<string, any>;
const CONTRACT = require('../../scripts/oshal-app-dependencies.js') as { inspectAppDependencies: (m: unknown) => any; readAppDependencies: (m: unknown) => any };

const TIERED = { name: 'synthetic-tiered', uses: ['app-dependencies'], dependencies: { required: { apps: ['synthetic-core'], connectors: ['synthetic-mail'] }, optional: { apps: ['synthetic-extra', 'synthetic-more'], tools: ['synthetic_tool'] } } };
const TIERED_GROUP = { name: 'synthetic-group', kind: 'group', dependencies: { required: { apps: ['synthetic-a', 'synthetic-b'] }, optional: { apps: ['synthetic-c'] } } };
const FLAT = { name: 'synthetic-flat', dependencies: { apps: ['synthetic-core', 'synthetic-extra'], tools: ['synthetic_tool'], connectors: [] } };
const EMPTY = { name: 'synthetic-empty' };
const EMPTY_BLOCK = { name: 'synthetic-empty-block', dependencies: {} };
const MIXED = { name: 'synthetic-mixed', uses: ['app-dependencies'], dependencies: { apps: ['synthetic-core'], optional: { apps: ['synthetic-extra'] } } };

/** @description The tier lists both readers must agree on. @param r A reader result. @returns The comparable lists. */
const tiersOf = (r: any) => ({ required: r.required, optional: r.optional });

describe('dependency tiers: the shell reader matches the installer contract', () => {
  it.each([['tiered app', TIERED, 'tiered'], ['tiered group', TIERED_GROUP, 'tiered'], ['legacy flat block', FLAT, 'flat'], ['no dependencies', EMPTY, 'none'], ['empty block', EMPTY_BLOCK, 'flat']])('%s gives identical tiers', (_label, manifest, form) => {
    const contract = CONTRACT.readAppDependencies(manifest);
    const shell = LIVE.dependencyTiers(manifest);
    expect(shell.form).toBe(form);
    expect(tiersOf(shell)).toEqual(tiersOf(contract));
    expect(CONTRACT.inspectAppDependencies(manifest).problems).toEqual([]);
  });

  it('a legacy flat block is all required on both sides', () => {
    expect(LIVE.dependencyTiers(FLAT).required.apps).toEqual(['synthetic-core', 'synthetic-extra']);
    expect(LIVE.dependencyTiers(FLAT).optional.apps).toEqual([]);
    expect(CONTRACT.readAppDependencies(FLAT).optional.apps).toEqual([]);
  });

  it('a block mixing both forms is refused by the installer and yields no tiers in the shell', () => {
    expect(() => CONTRACT.readAppDependencies(MIXED)).toThrow(/mixes the flat/);
    expect(CONTRACT.inspectAppDependencies(MIXED).problems.join(' ')).toContain('mixes the flat apps/tools/connectors form with required/optional');
    const shell = LIVE.dependencyTiers(MIXED);
    expect(shell.form).toBe('mixed');
    expect(tiersOf(shell)).toEqual({ required: { apps: [], tools: [], connectors: [] }, optional: { apps: [], tools: [], connectors: [] } });
  });

  it('a non-mapping block is refused by the installer and yields no tiers in the shell', () => {
    const manifest = { name: 'synthetic-list', dependencies: ['synthetic-core'] };
    expect(() => CONTRACT.readAppDependencies(manifest)).toThrow(/must be a mapping/);
    expect(LIVE.dependencyTiers(manifest)).toMatchObject({ form: 'invalid', required: { apps: [] }, optional: { apps: [] } });
  });
});
