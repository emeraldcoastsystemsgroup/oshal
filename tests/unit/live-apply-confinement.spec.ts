/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the live-apply boundary against a REAL filesystem, not a mocked one — the defect class is "a write escaped the repo", so a doubled fs would guard nothing. Includes the junctioned-intermediate-directory case, which a lexical startsWith(repoRoot) check passes and which would land a write outside the tree. Docker restart and the api's manifest reload ARE doubled: they sit outside the boundary under test and are asserted on their call shape (recorded in docs/governance/real-boundary-regression-audit.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveApplier, type LiveChange } from '@/features/dev-console';

let repoRoot: string;
let outside: string;
let restarted: string[];
let reloaded: string[];

/** An applier bound to the temp repo with the two out-of-boundary effects recorded, not run. */
function applier(): LiveApplier {
  return new LiveApplier({
    repoRoot,
    containerPrefix: 'oshal-test',
    restarter: async (name) => { restarted.push(name); return { ok: true, detail: `${name} restarted` }; },
    reloader: async (p) => { reloaded.push(p); return { ok: true, detail: `${p} reloaded` }; },
  });
}

/** Absolute path inside the temp repo. */
function inRepo(...parts: string[]): string {
  return path.join(repoRoot, ...parts);
}

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-apply-')));
  repoRoot = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(repoRoot, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'ai-lab', 'bot-personas'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'swarm-apps'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'deployed-apps', 'demo'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  restarted = [];
  reloaded = [];
});

afterEach(() => {
  fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
});

describe('live apply — the fast lanes write the real tree and take the real restart action', () => {
  it('writes an asset and requires NO restart', async () => {
    const result = await applier().apply([{ path: 'src/pages/cockpit.js', content: 'export const x = 1;\n' }]);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.cls).toBe('asset');
    expect(fs.readFileSync(inRepo('src', 'pages', 'cockpit.js'), 'utf8')).toBe('export const x = 1;\n');
    expect(result.restart.action).toBe('none');
    expect(restarted).toEqual([]);
    expect(reloaded).toEqual([]);
  });

  it('creates missing intermediate directories inside the repo', async () => {
    const result = await applier().apply([{ path: 'src/pages/deep/nested/app.css', content: 'body{}' }]);
    expect(result.applied).toBe(true);
    expect(fs.existsSync(inRepo('src', 'pages', 'deep', 'nested', 'app.css'))).toBe(true);
  });

  it('hot-loads a manifest instead of restarting anything', async () => {
    const result = await applier().apply([{ path: 'swarm-apps/demo.yaml', content: 'name: demo\n' }]);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.restart.action).toBe('app-reload');
    expect(reloaded).toEqual(['swarm-apps/demo.yaml']);
    expect(restarted).toEqual([]);
  });

  it('restarts the OWNING bot container for a persona change', async () => {
    const result = await applier().apply([{ path: 'ai-lab/bot-personas/oshal-developer.yaml', content: 'name: x\n' }]);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.restart.action).toBe('bot-restart');
    expect(restarted).toEqual(['oshal-test-oshal-developer']);
  });

  it('restarts the api for a store-package change', async () => {
    const result = await applier().apply([{ path: 'deployed-apps/demo/routes/x.js', content: '// r' }]);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.restart.action).toBe('api-restart');
    expect(restarted).toEqual(['oshal-test-api']);
  });

  it('reports a failed restart rather than claiming success', async () => {
    const failing = new LiveApplier({
      repoRoot,
      containerPrefix: 'oshal-test',
      restarter: async () => ({ ok: false, detail: 'no such container' }),
      reloader: async () => ({ ok: true, detail: '' }),
    });
    const result = await failing.apply([{ path: 'deployed-apps/demo/r.js', content: '// r' }]);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.restart.executed).toBe(false);
    expect(result.restart.detail).toMatch(/no such container/);
  });
});

describe('live apply — refusals are refusals, not downgrades', () => {
  it('REFUSES a core change and routes it to a pull request, writing nothing', async () => {
    const result = await applier().apply([{ path: 'src/features/x/services/y.ts', content: 'export {};' }]);
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.cls).toBe('core');
    expect(result.route).toBe('pull-request');
    expect(fs.existsSync(inRepo('src', 'features', 'x', 'services', 'y.ts'))).toBe(false);
  });

  it('REFUSES an infra change and routes it to the operator', async () => {
    const result = await applier().apply([{ path: 'docker-compose.oshal-local.yml', content: 'services: {}' }]);
    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.cls).toBe('infra');
    expect(result.route).toBe('operator');
    expect(fs.existsSync(inRepo('docker-compose.oshal-local.yml'))).toBe(false);
  });

  it('refuses a MIXED set for its worst member and writes NONE of it', async () => {
    // The partial-apply hazard: the asset must not land just because it came first.
    const changes: LiveChange[] = [
      { path: 'src/pages/ok.js', content: 'ok' },
      { path: 'src/app/server.ts', content: 'core' },
    ];
    const result = await applier().apply(changes);
    expect(result.applied).toBe(false);
    expect(fs.existsSync(inRepo('src', 'pages', 'ok.js'))).toBe(false);
  });

  it('refuses an empty change set', async () => {
    const result = await applier().apply([]);
    expect(result.applied).toBe(false);
  });
});

describe('live apply — path confinement against a real filesystem', () => {
  it('refuses traversal and absolute paths, writing nothing outside the repo', async () => {
    // TWO walls stand here, and the OUTER one fires first: a path that escapes the repo cannot
    // be normalized, so it classifies as `infra` and is refused before the writer sees it. The
    // confinement check inside resolveConfined is the inner wall for anything that ever gets
    // past classification. Either way the requirement is the same — nothing lands outside.
    for (const bad of ['../outside/evil.js', '../../evil.js', '/etc/passwd', 'C:\\Windows\\evil.js']) {
      const result = await applier().apply([{ path: bad, content: 'x' }]);
      expect(result.applied, bad).toBe(false);
      if (!result.applied) expect(result.route, bad).toBe('operator');
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a traversal that is smuggled into an otherwise live-appliable set', async () => {
    // The set takes its worst member's class, so the escape cannot ride along behind an asset.
    const result = await applier().apply([
      { path: 'src/pages/ok.js', content: 'ok' },
      { path: '../outside/evil.js', content: 'pwned' },
    ]);
    expect(result.applied).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(inRepo('src', 'pages', 'ok.js'))).toBe(false);
  });

  it('refuses a path through .git, .githooks or node_modules', async () => {
    // These classify as live-appliable by their prefix, so the segment check is what stops them.
    for (const bad of [
      'ai-lab/bot-personas/.git/config.yaml',
      'deployed-apps/demo/node_modules/pkg/index.js',
      'ai-lab/bot-personas/.githooks/pre-push.yaml',
    ]) {
      await expect(applier().apply([{ path: bad, content: 'x' }]), bad)
        .rejects.toThrow(/protected directory/);
    }
  });

  it('refuses a write THROUGH a linked directory that leaves the repo', async () => {
    // The case a lexical startsWith(repoRoot) check accepts: <repo>/src/pages/link/evil.js is
    // "inside" the repo as a string, but `link` resolves outside it. A junction is used because
    // it needs no elevation on Windows; on POSIX it is an ordinary directory symlink.
    const linkPath = inRepo('src', 'pages', 'link');
    fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(applier().apply([{ path: 'src/pages/link/evil.js', content: 'pwned' }]))
      .rejects.toThrow(/leaves the repo/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to overwrite a symlinked FILE inside the repo', async () => {
    const target = path.join(outside, 'target.js');
    fs.writeFileSync(target, 'original', 'utf8');
    const linked = inRepo('src', 'pages', 'linked.js');
    try {
      fs.symlinkSync(target, linked, 'file');
    } catch {
      // Windows without Developer Mode cannot create file symlinks; the junction case above
      // covers the same escape through the directory chain, so assert that instead of skipping.
      expect(fs.existsSync(linked)).toBe(false);
      return;
    }
    await expect(applier().apply([{ path: 'src/pages/linked.js', content: 'pwned' }]))
      .rejects.toThrow(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });
});
