/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the kernel-import seed inventory (R2.1 / CKR-9). The clean-kernel docs carried "924 package files import 124 kernel internals at roughly 1,500 sites" in four cells and nobody could reproduce it — the measurement had walked a tree containing the store's generated `output/` snapshot, so the build's own copy of every package counted as packages importing the kernel. The generator replaces the number; this pins the properties that make it reproducible. It runs against a SYNTHETIC git repository built in a temp directory, so it needs no store checkout and cannot skip in CI: the idempotence property is proven by adding an untracked importing file and asserting the triple does not move, which is exactly what the replaced figure got wrong.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { inventory, classify } = require('../../scripts/kernel-import-inventory.js');

const REPO_ROOT = join(__dirname, '..', '..');

/** A throwaway git repo whose tracked files import the kernel in the shapes the matcher supports. */
function syntheticStore(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kernel-inventory-'));
  mkdirSync(join(repo, 'pkg', 'src'), { recursive: true });
  writeFileSync(join(repo, 'pkg', 'src', 'a.ts'), [
    "import { createChildLogger } from '@/shared/logger';",
    "import { AppContext } from '@/app/composition/app-context';",
    "const r = require('@/app/routes/connectors-routes');",
    "// a comment mentioning @/shared/logger is NOT an import site",
    "const msg = 'see @/features/agent-management for details';",
  ].join('\n'));
  writeFileSync(join(repo, 'pkg', 'src', 'b.ts'), [
    "import { createChildLogger } from '@/shared/logger';",
    "const m = await import('@/shared/services/database');",
  ].join('\n'));
  writeFileSync(join(repo, 'README.md'), 'not code\n');
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed']);
  return repo;
}

describe('the seed inventory is generated, and reproducible', () => {
  it('counts import SITES, not every mention of a kernel path', () => {
    const repo = syntheticStore();
    try {
      const data = inventory(repo);
      // a.ts: 3 imports. b.ts: 2. The comment and the string literal are not import sites.
      expect(data.sites, 'a comment or a string naming a kernel path is not an import').toBe(5);
      expect(data.files).toBe(2);
      expect(data.modules).toBe(4);
      const specifiers = data.rows.map((r: { specifier: string }) => r.specifier);
      expect(specifiers, 'a path named only in a string literal must not become a module')
        .not.toContain('@/features/agent-management');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is IDEMPOTENT across a built tree — the property the replaced figure lacked', () => {
    const repo = syntheticStore();
    try {
      const before = inventory(repo);
      // build-store-public.sh writes a second copy of every package under output/. Walking disk
      // after a build double-counts the whole tree; `git ls-files` does not see it at all.
      mkdirSync(join(repo, 'output', 'pkg', 'src'), { recursive: true });
      writeFileSync(join(repo, 'output', 'pkg', 'src', 'a.ts'), "import { x } from '@/shared/logger';\n");
      writeFileSync(join(repo, 'output', 'pkg', 'src', 'c.ts'), "import { y } from '@/app/routes/connectors-routes';\n");
      const after = inventory(repo);
      expect(
        { sites: after.sites, files: after.files, modules: after.modules },
        'an untracked build output moved the triple — the generator is walking disk, not git',
      ).toEqual({ sites: before.sites, files: before.files, modules: before.modules });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('gives every module exactly one row and exactly one of the two verdicts', () => {
    const repo = syntheticStore();
    try {
      const data = inventory(repo);
      expect(data.rows.length, 'the row count must equal the modules figure').toBe(data.modules);
      const specifiers = data.rows.map((r: { specifier: string }) => r.specifier);
      expect(new Set(specifiers).size, 'a module appeared on more than one row').toBe(specifiers.length);
      for (const row of data.rows) {
        expect(['promote to SDK', 'move to package'], `${row.specifier} carries no verdict`)
          .toContain(row.verdict);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('classifies by the R2.2 surface, and fails closed outside it', () => {
    // R2.2: "the scoped store, logging, the bot invocation, intents, notifications, storage, and
    // the declaration types. Nothing in it reaches into a route module."
    expect(classify('@/shared/logger').verdict).toBe('promote to SDK');
    expect(classify('@/shared/services/database').verdict).toBe('promote to SDK');
    expect(classify('@/app/routes/inline-bot-execution').verdict).toBe('move to package');
    // A module nobody has decided about is not yet allowed — the generator is not the place to
    // invent that decision, only to make the list of decisions visible.
    expect(classify('@/features/something-nobody-classified').verdict).toBe('move to package');
    expect(classify('@/features/something-nobody-classified').why).toMatch(/fail-closed/);
  });

  it('the clean-kernel docs cite the generator instead of a hand-typed figure', () => {
    // The anti-drift tie. Four cells carried an unreproducible number; the only place the old
    // figure may still appear is the correcting banner that quotes it in order to retract it.
    const files = [
      'docs/architecture/clean-kernel/01-high-level-spec.md',
      'docs/architecture/clean-kernel/11-repair-spec.md',
    ];
    let bannerHits = 0;
    for (const rel of files) {
      const lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/\b924\b|1,500/.test(line)) return;
        const isCorrectingBanner = line.trimStart().startsWith('>');
        expect(
          isCorrectingBanner,
          `${rel}:${index + 1} states the retired figure outside a correcting banner`,
        ).toBe(true);
        bannerHits += 1;
      });
    }
    expect(bannerHits, 'the correction of record went missing').toBeGreaterThan(0);

    const spec = readFileSync(join(REPO_ROOT, files[0]), 'utf8');
    expect(spec, 'the high-level spec must name the generator as the source')
      .toContain('scripts/kernel-import-inventory.js');
  });
});
