/**
 * Guard for the kernel-skills PHASE 3 gate — a store package must DECLARE what it imports.
 *
 * `swarm-app-loader.readManifest` validates a `uses:` list when one is present but never requires
 * one (the check is guarded on `uses !== undefined`), while docs/apps/kernel-skills.md says "declare
 * what your code actually imports". So a package could import a kernel skill invisibly — and an
 * invisible import is exactly the one the next carve prunes, breaking the app at MOUNT time on a
 * customer's box with no gate having gone red. The requirement cannot live in `readManifest`
 * (that path runs at mount on live boxes; throwing there would fail-closed already-installed
 * packages), so it lives in scripts/check-kernel-skills.ts as Phase 3.
 *
 * These cases run the real gate against FIXTURE store checkouts — never this box's store — so they
 * prove the three behaviors that are easy to get wrong:
 *   1. an undeclared kernel import FAILS, and the message names the skill and the file;
 *   2. OVER-declaring PASSES — the rule is declaration ⊇ imports, not equality (dnd and game-show
 *      legitimately declare more than they import; requiring equality would turn healthy packages red);
 *   3. a type-only import in a .ts source is NOT a runtime dependency and must not be reported —
 *      TypeScript erases it, which is why the scan reads compiled .js and never .ts (this is the
 *      trading/`import type { ScheduleRecord }` false positive).
 * Plus: with no store checkout at all the gate SKIPS LOUDLY (a silent skip is not a gate).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — proves Phase 3 of check-kernel-skills goes RED on an undeclared kernel import, stays GREEN on over-declaration and on type-only .ts references, and announces its skip when no store checkout is present.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 2026-07-31 23:21:37 America/Chicago — Raises the subprocess-backed negative-case timeout because full-suite transform load can push the real gate past Vitest's 5s default before the assertion runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { KERNEL_SKILLS } from '@/shared/kernel-skills';

// CHANGE LOG ADDENDUM
// 3 | maintainer@emeraldcoastsystemsgroup.com | Mutation-test the Spaces non-skill runtime pins: a build missing drone or CLI-token issuance must fail before release.

const REPO_ROOT = resolve(__dirname, '../..');
const GUARD = 'scripts/check-kernel-skills.ts';
const PACKAGE_PIN_ARTIFACTS = [
  'dist/features/drone/index.js',
  'dist/app/routes/cli-token-routes.js',
] as const;

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

/** Create an empty fixture "store checkout" directory that is cleaned up after the test. */
function newStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-uses-'));
  fixtures.push(dir);
  return dir;
}

/**
 * Write one fixture package: a manifest with the given `uses:` list, plus arbitrary files.
 * @param store - fixture store root
 * @param name - package directory name
 * @param uses - the kernel-skill ids to declare (empty = no `uses:` key at all)
 * @param files - relative path → file contents
 */
function writePackage(
  store: string,
  name: string,
  uses: string[],
  files: Record<string, string>,
): void {
  const dir = join(store, name);
  mkdirSync(dir, { recursive: true });
  const usesBlock = uses.length ? `uses:\n${uses.map((u) => `  - ${u}`).join('\n')}\n` : '';
  writeFileSync(join(dir, 'oshal-app.yaml'), `name: ${name}\nversion: 1.0.0\n${usesBlock}`, 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
}

interface GateResult { code: number; out: string }

/**
 * Run the real gate against a fixture store; never throws, so a red run is inspectable.
 *
 * Invoked through `node -r ts-node/register/transpile-only` rather than `npx ts-node` so no shell is
 * involved (a shell would concatenate unescaped fixture paths, and `npx.cmd` resolution differs
 * between the Windows shells this repo is driven from).
 */
function runGate(store: string | null, extraArgs: string[] = []): GateResult {
  const args = [
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
    GUARD,
  ];
  if (store) args.push('--store', store);
  args.push(...extraArgs);
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // An absent OSHAL_STORE_DIR is part of the skip case — never inherit the operator's.
      env: { ...process.env, OSHAL_STORE_DIR: '' },
      timeout: 300_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Populate the complete artifact contract so one removed file is the only mutation under test. */
function writeCompleteArtifactFixture(root: string): void {
  const artifacts = [
    ...KERNEL_SKILLS.flatMap((skill) => skill.modules.map((module) => module.distFile)),
    ...PACKAGE_PIN_ARTIFACTS,
  ];
  for (const relative of artifacts) {
    const full = join(root, relative);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, '', 'utf8');
  }
}

describe('kernel-skills Phase 3 — a store package must declare the skills it imports', () => {
  it('FAILS on an undeclared kernel import, naming the skill and the file that proves it', () => {
    const store = newStore();
    writePackage(store, 'undeclaring-app', [], {
      'routes/thing-routes.js': [
        "const { createGraphConnector } = require('@/features/graph');",
        "module.exports = { createGraphConnector };",
      ].join('\n'),
    });

    const res = runGate(store);

    expect(res.code).toBe(1);
    expect(res.out).toContain("store package 'undeclaring-app'");
    expect(res.out).toContain('graph');
    expect(res.out).toContain('thing-routes.js');
  }, 30_000);

  it('PASSES when the declaration is a SUPERSET of the imports (over-declaring is legal)', () => {
    const store = newStore();
    writePackage(store, 'over-declaring-app', ['graph', 'voice', 'tool-registry'], {
      'routes/thing-routes.js': "const g = require('@/features/graph');\nmodule.exports = g;",
    });

    const res = runGate(store);

    expect(res.code).toBe(0);
    expect(res.out).toContain('scanned 1 store package');
  });

  it('does NOT report a type-only .ts import — the scan reads compiled js, which has erased it', () => {
    const store = newStore();
    writePackage(store, 'type-only-app', [], {
      // The TypeScript source references a kernel slice for TYPES only…
      'src-routes/thing-routes.ts': [
        "import type { ScheduleRecord } from '@/features/scheduling';",
        "export const noop = (r: ScheduleRecord): string => String(r);",
      ].join('\n'),
      // …and the compiled artifact that actually mounts requires nothing from the kernel.
      'routes/thing-routes.js': 'module.exports = { noop: (r) => String(r) };',
    });

    const res = runGate(store);

    expect(res.code).toBe(0);
    expect(res.out).not.toContain('type-only-app');
  });

  it('counts a DEEP import as an import of that skill (a prune breaks it identically)', () => {
    const store = newStore();
    writePackage(store, 'deep-importing-app', [], {
      'routes/thing-routes.js': "const k = require('@/features/graph/services/graph-keys');\nmodule.exports = k;",
    });

    const res = runGate(store);

    expect(res.code).toBe(1);
    expect(res.out).toContain("store package 'deep-importing-app'");
    expect(res.out).toContain('graph');
  });

  it('a package importing NO kernel skill and declaring nothing is fine', () => {
    const store = newStore();
    writePackage(store, 'self-contained-app', [], {
      'routes/thing-routes.js': "const express = require('express');\nmodule.exports = express;",
    });

    const res = runGate(store);

    expect(res.code).toBe(0);
    expect(res.out).not.toContain('self-contained-app');
  });

  it('FAILS when either non-skill Spaces dependency is pruned from the built framework', () => {
    const store = newStore();
    const build = newStore();
    writeCompleteArtifactFixture(build);

    rmSync(join(build, PACKAGE_PIN_ARTIFACTS[0]));
    const noDrone = runGate(store, ['--dist', build]);
    expect(noDrone.code).toBe(1);
    expect(noDrone.out).toContain("package runtime pin 'spaces'");
    expect(noDrone.out).toContain(PACKAGE_PIN_ARTIFACTS[0]);

    writeCompleteArtifactFixture(build);
    rmSync(join(build, PACKAGE_PIN_ARTIFACTS[1]));
    const noTokenIssuer = runGate(store, ['--dist', build]);
    expect(noTokenIssuer.code).toBe(1);
    expect(noTokenIssuer.out).toContain("package runtime pin 'spaces'");
    expect(noTokenIssuer.out).toContain(PACKAGE_PIN_ARTIFACTS[1]);
  }, 30_000);

  it('with NO store checkout the phase SKIPS LOUDLY — it never passes silently on an unchecked half', () => {
    const empty = newStore();
    // Point --store at a path that does not exist, so autodetect + env are both out of play.
    const res = runGate(join(empty, 'no-such-store'));

    expect(res.code).toBe(0);
    expect(res.out).toContain('PHASE 3 SKIPPED');
    expect(res.out).toContain('--store');
  });
});
