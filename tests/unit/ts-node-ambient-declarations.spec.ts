/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the ts-node config that keeps the Playwright webServer bootable. Without it the ENTIRE local e2e suite is unrunnable while every typecheck gate stays green — the worst shape of failure this repo has, because it silently removes the thing guard-per-fix depends on.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

/**
 * @description Parse tsconfig.json from disk rather than importing it, so the test reads exactly
 * what ts-node and tsc read — an import would be cached and JSON-module resolution could differ.
 * @returns The parsed tsconfig object.
 */
function readTsconfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'));
}

describe('ts-node must load ambient declarations, or the whole e2e suite dies', () => {
  /**
   * The failure this pins (observed 2026-08-02): playwright.config.ts starts the webServer through
   * ts-node. ts-node defaults to `files: false`, which makes it IGNORE tsconfig `include` and
   * compile only what is reachable from the entry point. Ambient declarations in src/types are
   * reachable from nothing, so they never load, and the boot died on:
   *
   *   src/features/doc-extract/services/doc-extract-service.ts(27,22): error TS7016:
   *   Could not find a declaration file for module 'pdf-parse/lib/pdf-parse.js'
   *
   * `tsc -p tsconfig.json` DOES honour `include`, so the pre-push hook and CI were green the entire
   * time. Every Playwright spec in the repo failed before it ran, on an unrelated spec too — this
   * was not one broken test, it was zero runnable e2e guards.
   */
  it('sets ts-node.files so tsconfig `include` (and therefore src/types/*.d.ts) is honoured', () => {
    const cfg = readTsconfig();
    expect(cfg['ts-node'], 'tsconfig.json needs a ts-node block').toBeDefined();
    expect(cfg['ts-node'].files).toBe(true);
  });

  /**
   * `files: true` alone fixes the declaration lookup but makes ts-node typecheck all of src/** at
   * boot, which pushed the webServer past Playwright's 60s startup timeout — trading "cannot boot"
   * for "times out". transpileOnly keeps the boot fast; typechecking is not this process's job and
   * is already enforced twice, by the pre-push hook (tsconfig.json) and the image build
   * (tsconfig.server.json), both of which honour `include`.
   */
  it('sets ts-node.transpileOnly so the webServer boots inside Playwright\'s startup timeout', () => {
    const cfg = readTsconfig();
    expect(cfg['ts-node'].transpileOnly).toBe(true);
  });

  /**
   * The mechanism, not just the flag: every ambient declaration lives under src/types, and the
   * `include` globs must actually cover it. If someone moves declarations out of src/** this goes
   * red before the e2e suite mysteriously stops booting again.
   */
  it('keeps every ambient declaration inside a directory tsconfig `include` covers', () => {
    const cfg = readTsconfig();
    const include: string[] = cfg.include ?? [];
    expect(include.some((g) => g.startsWith('src/') && g.endsWith('.ts'))).toBe(true);

    const declarations = readdirSync(join(ROOT, 'src', 'types')).filter((f) => f.endsWith('.d.ts'));
    expect(declarations.length, 'src/types should hold the ambient declarations').toBeGreaterThan(0);
    for (const d of declarations) {
      const body = readFileSync(join(ROOT, 'src', 'types', d), 'utf8');
      expect(body, `${d} should declare a module`).toMatch(/declare\s+module/);
    }
  });
});
