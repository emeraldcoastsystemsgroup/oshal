/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the live-acceptance directory probe (live-acceptance-common.js dirProbeListing) over a real temp workspace root: a build root with a node_modules of a thousand files lists its plan, deliverables and handovers with the dependency folder named as skipped and no truncation; a root with more loose files than the cap reports truncated; a link is listed, never followed; the id and probe name are validated. The live shape it guards: a tree with everything present was judged empty because the cap tripped inside node_modules (2026-10-02).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const common = requireModule('../../scripts/lib/live-acceptance-common.js') as {
  dirProbeListing: (name: string, id: string, root: string) => { path: string; exists: boolean; files: string[]; truncated: boolean; skipped: string[] };
};

const ROOT_ID = 'cccccccc-dddd-4eee-8fff-000000000000';
let root: string;

function file(rel: string, content = 'x'): void {
  mkdirSync(join(root, ROOT_ID, rel, '..'), { recursive: true });
  writeFileSync(join(root, ROOT_ID, rel), content);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'live-dir-probe-')); mkdirSync(join(root, ROOT_ID), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the build.root directory probe', () => {
  it('lists the judged files past a thousand-file node_modules, naming the skipped folder, without truncation', () => {
    file('IMPLEMENTATION-PLAN.md');
    file('deliverables/src/slugify.ts');
    file('developer-handovers/child--bot_PHASE_1_ROUND_1.md');
    for (let i = 0; i < 1000; i += 1) file(`node_modules/pkg-${i % 50}/lib/file-${i}.js`);
    file('deliverables/node_modules/vitest/vitest.mjs');
    file('.tokenchase/frame-0001.json');
    const listing = common.dirProbeListing('build.root', ROOT_ID, root);
    expect(listing.exists).toBe(true);
    expect(listing.truncated).toBe(false);
    expect(listing.files).toEqual(['IMPLEMENTATION-PLAN.md', 'deliverables/src/slugify.ts', 'developer-handovers/child--bot_PHASE_1_ROUND_1.md']);
    expect(listing.skipped).toEqual(['.tokenchase', 'deliverables/node_modules', 'node_modules']);
  });

  it('reports truncation when the loose files exceed the cap', () => {
    for (let i = 0; i < 450; i += 1) file(`deliverables/out/file-${i}.txt`);
    const listing = common.dirProbeListing('build.root', ROOT_ID, root);
    expect(listing.truncated).toBe(true);
    expect(listing.files.length).toBeLessThanOrEqual(400);
  });

  it('lists a link as an entry and never follows it', () => {
    file('deliverables/src/a.ts');
    mkdirSync(join(root, 'elsewhere', 'deep'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'deep', 'secret.txt'), 's');
    symlinkSync(join(root, 'elsewhere'), join(root, ROOT_ID, 'linked'), 'junction');
    const listing = common.dirProbeListing('build.root', ROOT_ID, root);
    expect(listing.files.some((f) => f.includes('secret.txt'))).toBe(false);
  });

  it('refuses an unknown probe or an id that is not a lower-case UUID, and reports a missing folder as absent', () => {
    expect(() => common.dirProbeListing('build.other', ROOT_ID, root)).toThrow(/unknown live-acceptance directory probe/);
    expect(() => common.dirProbeListing('build.root', '../etc', root)).toThrow(/invalid id/);
    expect(common.dirProbeListing('build.root', 'cccccccc-dddd-4eee-8fff-000000000001', root)).toMatchObject({ exists: false, files: [], truncated: false, skipped: [] });
  });
});
