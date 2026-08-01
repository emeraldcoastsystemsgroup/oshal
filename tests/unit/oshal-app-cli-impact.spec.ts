/**
 * Guard for ADR-085 D11 done-when 6: the `oshal-app uninstall` CLI impact scan mirrors the
 * SERVER's tool semantics (tool-ownership.ts) over its offline view (the deploy dir):
 *   - provided = the manifest's tools[].name ONLY — never ui.static[].toolName (ribbon
 *     surface ids are not registry tools; the server's providedToolNames draws the line);
 *   - another installed package naming a provided tool in dependencies.tools is a TOOL
 *     DEPENDENT and BLOCKS the uninstall exactly like an app-level dependent;
 *   - --force overrides (block, never retain — the tool goes with its owner).
 * Exercised by running the REAL CLI against a temp deploy dir — behavior, not substrings of
 * the source.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | D11 done-when 6 guard: CLI uninstall impact tool-dependent parity with the server (block, surface-id exclusion, force override).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = resolve(process.cwd(), 'scripts', 'oshal-app.js');

let dest: string;

/** Write a minimal installed package (dir + oshal-app.yaml) into the temp deploy dir. */
function installFixture(name: string, manifestYaml: string): void {
  const dir = join(dest, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'oshal-app.yaml'), manifestYaml, 'utf8');
}

/** Run the real CLI; returns exit code + ANSI-stripped combined output. */
function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
  const strip = (s: string | null) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  return { code: r.status ?? -1, out: `${strip(r.stdout)}\n${strip(r.stderr)}` };
}

beforeEach(() => {
  dest = mkdtempSync(join(tmpdir(), 'oshal-cli-impact-'));
});

afterEach(() => {
  rmSync(dest, { recursive: true, force: true });
});

describe('oshal-app uninstall — impact scan mirrors the server tool semantics (D11 done-when 6)', () => {
  it('BLOCKS when another installed package depends on a tool this one provides, naming app + tool', () => {
    installFixture('provider-pkg', [
      'name: provider-pkg',
      'displayName: Provider',
      'tools:',
      '  - name: shared-tool',
      '    description: a real registry tool',
      '',
    ].join('\n'));
    installFixture('consumer-pkg', [
      'name: consumer-pkg',
      'displayName: Consumer',
      'dependencies:',
      '  tools: [shared-tool]',
      '',
    ].join('\n'));

    const r = run('uninstall', 'provider-pkg', '--dest', dest, '--yes');

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/blocked/);
    expect(r.out).toMatch(/consumer-pkg needs tool\(s\) shared-tool/);
    // Blocked means NOTHING was removed.
    expect(existsSync(join(dest, 'provider-pkg', 'oshal-app.yaml'))).toBe(true);
  });

  it('does NOT count ui.static[].toolName as a provided tool (ribbon surface ids are not registry tools)', () => {
    installFixture('surface-pkg', [
      'name: surface-pkg',
      'displayName: Surface Only',
      'ui:',
      '  static:',
      '    - toolName: ribbon-only-tool',
      '      label: Ribbon',
      '      icon: codicon codicon-home',
      '      iframeUrl: /surface-pkg/index.html',
      '',
    ].join('\n'));
    installFixture('surface-consumer', [
      'name: surface-consumer',
      'displayName: Surface Consumer',
      'dependencies:',
      '  tools: [ribbon-only-tool]',
      '',
    ].join('\n'));

    // Without --yes: NOT blocked (no tool provided), so the CLI asks for --yes instead.
    const r = run('uninstall', 'surface-pkg', '--dest', dest);

    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/blocked/);
    expect(r.out).toMatch(/re-run with --yes/);
    expect(r.out).toMatch(/tools provided: none/);
  });

  it('--force overrides a tool-dependent block (block, never retain — the tool goes with its owner)', () => {
    installFixture('provider-pkg', [
      'name: provider-pkg',
      'displayName: Provider',
      'tools:',
      '  - name: shared-tool',
      '',
    ].join('\n'));
    installFixture('consumer-pkg', [
      'name: consumer-pkg',
      'displayName: Consumer',
      'dependencies:',
      '  tools: [shared-tool]',
      '',
    ].join('\n'));

    const r = run('uninstall', 'provider-pkg', '--dest', dest, '--yes', '--force');

    expect(r.code).toBe(0);
    expect(existsSync(join(dest, 'provider-pkg'))).toBe(false);
    // The dependent is NOT removed and its manifest untouched — nothing cascades.
    expect(existsSync(join(dest, 'consumer-pkg', 'oshal-app.yaml'))).toBe(true);
  });

  it('app-level dependents still block exactly as before (regression pin)', () => {
    installFixture('base-pkg', ['name: base-pkg', 'displayName: Base', ''].join('\n'));
    installFixture('app-consumer', [
      'name: app-consumer',
      'displayName: App Consumer',
      'dependencies:',
      '  apps: [base-pkg]',
      '',
    ].join('\n'));

    const r = run('uninstall', 'base-pkg', '--dest', dest, '--yes');

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/blocked/);
    expect(r.out).toMatch(/app-consumer depend\(s\) on base-pkg/);
  });
});
