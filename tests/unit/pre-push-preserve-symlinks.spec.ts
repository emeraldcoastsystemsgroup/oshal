/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the pre-push gate against the false RED that had three lanes pushing with OSHAL_SKIP_PREPUSH_VERIFY=1 in one night: node_modules is LINKED into the verification tree by design, and declaration-emit checking then named a type by a path climbing out of that tree, raising TS2742 against code that is fine. The fix is --preserveSymlinks on the verification tsc, so this guard has to prove BOTH directions or it is worthless - that the flag removes the link artifact, and that it has not stopped the gate looking. It crosses the real boundary rather than asserting on the hook text: a real link, the real tsc reached through node's own resolver, and a real project on each side.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const HOOK_PATH = join(REPO_ROOT, '.githooks/pre-push');
const hook = readFileSync(HOOK_PATH, 'utf8');
// The real resolver, not a hand-built path: this suite is evidence only if it drives the same tsc
// the hook drives.
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const TSC_TIMEOUT_MS = 120_000;

/** tsconfig with `declaration: true` - the setting that makes tsc check declaration-emit
 *  portability even under `--noEmit`, which is what raises TS2742 at all. */
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16',
    strict: true, declaration: true, noEmit: true, types: [],
  },
  include: ['src/**/*.ts'],
}, null, 2);

/** An inferred return type that surfaces a type owned by a SECOND package - the express-to-qs shape
 *  that trips the real repo, reduced to two files so the guard stays hermetic and fast. */
const CLEAN_SOURCE = [
  'import type { Req } from "web-framework";',
  'export function makeWiring() {',
  '  return { resolveActor: (req: Req) => req.query };',
  '}',
].join('\n');

/** The same, plus an unmistakable type error: what the gate exists to catch. */
const BROKEN_SOURCE = `${CLEAN_SOURCE}\nconst count: number = "not a number";\nexport const leak = count;\n`;

/**
 * @description Build a node_modules whose second package can only be named through the first,
 * mirroring how the express request type surfaces qs.ParsedQs.
 * @param dir - Directory to populate as a node_modules root.
 */
function writeModules(dir: string): void {
  mkdirSync(join(dir, 'query-types'), { recursive: true });
  writeFileSync(join(dir, 'query-types/package.json'), '{"name":"query-types","version":"1.0.0","types":"index.d.ts"}');
  writeFileSync(join(dir, 'query-types/index.d.ts'), 'export interface ParsedQuery { [k: string]: string | undefined }\n');
  mkdirSync(join(dir, 'web-framework'), { recursive: true });
  writeFileSync(join(dir, 'web-framework/package.json'), '{"name":"web-framework","version":"1.0.0","types":"index.d.ts"}');
  writeFileSync(join(dir, 'web-framework/index.d.ts'),
    'import type { ParsedQuery } from "query-types";\nexport interface Req { query: ParsedQuery }\n');
}

/**
 * @description Lay down a project whose only variable is where node_modules comes from.
 * @param dir - Project root to create.
 * @param source - Contents of src/index.ts.
 */
function writeProject(dir: string, source: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  writeFileSync(join(dir, 'src/index.ts'), source);
}

/**
 * @description Run the real tsc exactly as the hook runs it and report the diagnostics.
 * @param dir - Project to compile.
 * @param flags - Extra compiler flags, for example --preserveSymlinks.
 * @returns Exit status and the `error TS####` lines, if any.
 */
function typecheck(dir: string, ...flags: string[]): { status: number; errors: string[] } {
  const args = [TSC, '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false', ...flags];
  let status = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: TSC_TIMEOUT_MS });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    status = failure.status ?? 1;
    out = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  return { status, errors: out.split('\n').filter(line => /error TS\d+/.test(line)) };
}

let root = '';
let realTree = '';
let linkedTree = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oshal-prepush-symlinks-'));
  // The control: node_modules is a genuine directory, as it is in a normal checkout.
  realTree = join(root, 'real-tree');
  writeProject(realTree, CLEAN_SOURCE);
  writeModules(join(realTree, 'node_modules'));
  // The verification tree the hook actually builds: sources here, node_modules linked in from
  // elsewhere. 'junction' is what Windows needs and is ignored on other platforms, so this runs
  // everywhere rather than skipping - a guard that skips is not a guard.
  linkedTree = join(root, 'linked-tree');
  writeProject(linkedTree, CLEAN_SOURCE);
  symlinkSync(join(realTree, 'node_modules'), join(linkedTree, 'node_modules'), 'junction');
  // Prove the link by reading THROUGH it before trusting any verdict that depends on it.
  expect(readFileSync(join(linkedTree, 'node_modules/web-framework/package.json'), 'utf8')).toContain('web-framework');
}, TSC_TIMEOUT_MS);

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('pre-push verification tsc - the link must not manufacture a type error', () => {
  it('reproduces the false RED: a linked node_modules alone raises TS2742 against clean code', () => {
    expect(typecheck(linkedTree).errors.join('\n')).toContain('error TS2742');
    // Same sources, same packages, real directory: nothing is wrong with the code itself.
    expect(typecheck(realTree)).toEqual({ status: 0, errors: [] });
  }, TSC_TIMEOUT_MS);

  it('--preserveSymlinks clears the artifact, so the gate agrees with a normal checkout', () => {
    expect(typecheck(linkedTree, '--preserveSymlinks')).toEqual({ status: 0, errors: [] });
  }, TSC_TIMEOUT_MS);

  it('is a no-op where node_modules is a real directory, so it changes no normal answer', () => {
    expect(typecheck(realTree, '--preserveSymlinks')).toEqual(typecheck(realTree));
  }, TSC_TIMEOUT_MS);

  it('still catches an ordinary type error through the link - the gate has not stopped looking', () => {
    const broken = join(root, 'broken-linked');
    writeProject(broken, BROKEN_SOURCE);
    symlinkSync(join(realTree, 'node_modules'), join(broken, 'node_modules'), 'junction');
    const result = typecheck(broken, '--preserveSymlinks');
    expect(result.status).not.toBe(0);
    expect(result.errors.join('\n')).toContain('error TS2322');
  }, TSC_TIMEOUT_MS);

  it('still reports a GENUINE TS2742 that no link caused, so the class is not switched off', () => {
    // A type reachable only through a transitively NESTED real package is genuinely not nameable.
    // Every directory here is real, so if --preserveSymlinks suppressed the diagnostic rather than
    // the link indirection, this is where it would show.
    const nested = join(root, 'nested-real');
    writeProject(nested, 'import { make } from "outer";\nexport function mkNested() { return make(); }\n');
    const inner = join(nested, 'node_modules/outer/node_modules/inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(nested, 'node_modules/outer/package.json'), '{"name":"outer","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(nested, 'node_modules/outer/index.d.ts'),
      'import type { Inner } from "inner";\nexport declare function make(): Inner;\n');
    writeFileSync(join(inner, 'package.json'), '{"name":"inner","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(inner, 'index.d.ts'), 'export interface Inner { tag: "inner" }\n');
    expect(typecheck(nested).errors.join('\n')).toContain('error TS2742');
    expect(typecheck(nested, '--preserveSymlinks').errors.join('\n')).toContain('error TS2742');
  }, TSC_TIMEOUT_MS);
});

describe('pre-push hook - the fix is wired where the gate runs', () => {
  /** The one line that decides what the gate actually asks tsc. */
  const invocation = hook.split('\n').find(line => line.includes('npx tsc -p tsconfig.json --noEmit'));

  it('passes --preserveSymlinks on the verification typecheck', () => {
    expect(invocation).toBeDefined();
    expect(invocation).toContain('--preserveSymlinks');
  });

  it('never disables declaration checking instead, which would drop a real diagnostic class', () => {
    // Scoped to the invocation on purpose: the Change Log weighs the rejected alternatives, and a
    // guard that reads prose as configuration is a guard that breaks when a comment is edited.
    expect(invocation).not.toContain('--declaration false');
    expect(invocation).not.toContain('--declaration=false');
    expect(invocation).not.toContain('--skipDefaultLibCheck');
  });

  it('says what the skip variable did NOT check, and that the publish gate still ran', () => {
    const skip = hook.slice(hook.indexOf('OSHAL_SKIP_PREPUSH_VERIFY:-0'), hook.indexOf('RANGE_FILES='));
    expect(skip).toContain('COMMITTED HEAD WAS NOT TYPECHECKED');
    expect(skip).toContain('STILL RAN');
    expect(skip).toContain('publish gate');
  });
});
