/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the pre-push hook's verification tree: node_modules must be LINKED (never copied), the candidate must be resolved through a link before it is used, and a link that cannot be read through must be refused rather than typechecked. Both original defects were silent - a deep copy only looked slow, and linking a link only looked like a type error in a file nobody touched - and the first attempt at the fix trusted an exit code that lies, so this spec runs the hook's own function against real directories and decides copy-versus-link by WRITING INTO THE TARGET and reading it back through the destination.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOOK = resolve('.githooks/pre-push');
const hook = readFileSync(HOOK, 'utf8');

/**
 * @description Run the hook's own linking function against a real target and report its verdict.
 * @param verifyDir - Stand-in for the hook's verification tree.
 * @param target - What node_modules should resolve to.
 * @returns 'LINKED' or 'FAILED', as the function itself decides.
 */
function runLinker(verifyDir: string, target: string): string {
  // MSYS bash reads a backslash as an escape, so a Windows path must reach it with forward
  // slashes or every test here silently exercises a path that does not exist.
  const sh = (w: string) => w.split('\\').join('/');
  const fn = hook.slice(hook.indexOf('link_node_modules() {'), hook.indexOf('\nif ! link_node_modules;'));
  expect(fn).toContain('mklink /J');
  const script = [
    'set -u',
    `VERIFY_DIR=${JSON.stringify(sh(verifyDir))}`,
    `NODE_MODULES=${JSON.stringify(sh(target))}`,
    fn,
    'link_node_modules && echo LINKED || echo FAILED',
  ].join('\n');
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

let root = '';
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'oshal-prepush-')); });
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('pre-push verification tree — the link is proven, never trusted', () => {
  it('links the target rather than copying it: a file added to the target afterwards is visible through the link', () => {
    const target = join(root, 'real-modules');
    mkdirSync(join(target, 'pkg'), { recursive: true });
    writeFileSync(join(target, 'pkg', 'package.json'), '{"name":"pkg"}\n');
    const verify = join(root, 'verify-a');
    mkdirSync(verify, { recursive: true });

    expect(runLinker(verify, target)).toBe('LINKED');
    expect(existsSync(join(verify, 'node_modules', 'pkg', 'package.json'))).toBe(true);

    // The decisive test, and the only one that survives a junction reporting as a plain directory:
    // write into the TARGET after linking. A copy cannot show it; a link must.
    writeFileSync(join(target, 'added-after-linking.txt'), 'proves this is not a copy\n');
    expect(existsSync(join(verify, 'node_modules', 'added-after-linking.txt'))).toBe(true);
  });

  it('refuses a destination it cannot read through, so a silent no-op never reaches the typecheck', () => {
    const verify = join(root, 'verify-b');
    mkdirSync(verify, { recursive: true });
    // A target that does not exist: `mklink /J` creates a junction to a missing directory and exits
    // 0, so trusting the exit code would leave the tree unable to resolve a single import.
    expect(runLinker(verify, join(root, 'does-not-exist'))).toBe('FAILED');
    expect(existsSync(join(verify, 'node_modules'))).toBe(false);
    expect(hook).toContain('✗ pre-push BLOCKED — could not link node_modules into the verification tree.');
  });

  it('refuses an empty target as unreadable rather than calling it linked', () => {
    const target = join(root, 'empty-modules');
    mkdirSync(target, { recursive: true });
    const verify = join(root, 'verify-c');
    mkdirSync(verify, { recursive: true });
    expect(runLinker(verify, target)).toBe('FAILED');
  });

  it('resolves the candidate through a link before using it, so the tree is never linked to a link', () => {
    expect(hook).toContain('REAL_NODE_MODULES="$(realpath "$NODE_MODULES" 2>/dev/null || true)"');
    const guarded = hook.slice(hook.indexOf('REAL_NODE_MODULES='), hook.indexOf('link_node_modules() {'));
    expect(guarded).toContain('NODE_MODULES="$REAL_NODE_MODULES"');
    expect(hook.indexOf('REAL_NODE_MODULES=')).toBeLessThan(hook.indexOf('link_node_modules() {'));
  });

  it('never accepts a copy: the symlink path is taken only when the result is genuinely a link', () => {
    const fn = hook.slice(hook.indexOf('link_node_modules() {'), hook.indexOf('\nif ! link_node_modules;'));
    expect(fn).toContain('[ -L "$VERIFY_DIR/node_modules" ] && _nm_reads');
    expect(fn).toContain('_nm_reset');
  });
});
