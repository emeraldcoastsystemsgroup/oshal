/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real Git installs prove source collisions, stale approval, same-source updates, and dependency preservation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../fixtures/multi-store';
import { replacementFor } from '@/app/routes/app-install-source';

const { canonicalRepo, assertInstallSource, withInstallSourceLock } = require('../../scripts/oshal-install-source');
let root: string, repo: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oshal-multi-store-cli-'));
  repo = createStore(join(root, 'store'), [{ name: 'sample-app', deps: ['helper-app'] }, { name: 'helper-app', deps: [] }]).repo;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function stamp(dest: string, name: string, value: unknown) {
  mkdirSync(join(dest, name), { recursive: true });
  writeFileSync(join(dest, name, 'oshal-app.yaml'), `name: ${name}\ndisplayName: Old local app\nversion: 0.1.0\n`);
  writeFileSync(join(dest, name, '.oshal-install.json'), JSON.stringify(value));
}
function install(dest: string, args: string[] = []) {
  return spawnSync(process.execPath, [resolve('scripts/oshal-app.js'), 'install', 'sample-app', '--repo', repo, '--dest', dest, '--registry', 'second-store', ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, OSHAL_PACKAGE_AUDIT_MODE: 'compatible' },
  });
}

describe('cross-store source approval at the installer boundary', () => {
  it('normalizes optional suffixes and URL hosts while preserving repository path case', () => {
    expect(canonicalRepo('https://EXAMPLE.test/team/store.git/')).toBe('https://example.test/team/store');
    expect(canonicalRepo('https://example.test/Team/store')).not.toBe(canonicalRepo('https://example.test/team/store'));
    expect(canonicalRepo('ssh://git@git.example.test/team/store.git')).toBe('ssh://git@git.example.test/team/store');
  });
  it('returns conflict before overwriting anything; an exact approved source replacement lands with provenance', () => {
    const dest = join(root, 'confirmed');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first', sha: 'a'.repeat(40), registry: 'first-store' });
    const before = readFileSync(join(dest, 'sample-app', 'oshal-app.yaml'), 'utf8');
    expect(install(dest).status).toBe(42);
    expect(readFileSync(join(dest, 'sample-app', 'oshal-app.yaml'), 'utf8')).toBe(before);
    const replacement = replacementFor(dest, 'sample-app', { repo, registry: 'second-store' })!;
    const result = install(dest, ['--replace-source', replacement.token]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'sample-app', '.oshal-install.json'), 'utf8'))).toMatchObject({ repo, registry: 'second-store' });
    expect(install(dest).status).toBe(0); // ordinary same-source upgrade requires no replacement token
  }, 30000);
  it('refuses approval after the prior source changes and refuses reuse for a different destination', () => {
    const dest = join(root, 'stale');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first', sha: 'a'.repeat(40) });
    const prior = replacementFor(dest, 'sample-app', { repo, registry: 'second-store' })!;
    expect(() => assertInstallSource(dest, 'sample-app', { repo: 'https://example.test/third', registry: 'second-store' }, prior.token)).toThrow(/confirmation/);
    stamp(dest, 'sample-app', { repo: 'https://example.test/first', sha: 'b'.repeat(40) });
    expect(install(dest, ['--replace-source', prior.token]).status).toBe(42);
    expect(readFileSync(join(dest, 'sample-app', '.oshal-install.json'), 'utf8')).toContain('b'.repeat(40));
  });
  it('does not replace an existing dependency from another store when approving its parent', () => {
    const dest = join(root, 'dependencies');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first' });
    stamp(dest, 'helper-app', { repo: 'https://example.test/third', sha: 'c'.repeat(40) });
    const previousHelper = readFileSync(join(dest, 'helper-app', '.oshal-install.json'), 'utf8');
    const approval = replacementFor(dest, 'sample-app', { repo, registry: 'second-store' })!;
    const result = install(dest, ['--replace-source', approval.token]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dest, 'helper-app', '.oshal-install.json'), 'utf8')).toBe(previousHelper);
  }, 30000);
  it('requires explicit approval for missing or corrupt legacy provenance', () => {
    const dest = join(root, 'legacy');
    stamp(dest, 'sample-app', { repo });
    for (const raw of ['broken JSON', 'null', '"string"', '[]']) {
      writeFileSync(join(dest, 'sample-app', '.oshal-install.json'), raw);
      expect(install(dest).status).toBe(42);
      expect(replacementFor(dest, 'sample-app', { repo })?.from.repo).toBeNull();
    }
  });
  it('requires confirmation for different known registries even when their repo URLs match', () => {
    const dest = join(root, 'same-repo');
    stamp(dest, 'sample-app', { repo, registry: 'first-store' });
    expect(replacementFor(dest, 'sample-app', { repo, registry: 'second-store' })?.from.registry).toBe('first-store');
    expect(replacementFor(dest, 'sample-app', { repo })).toBeNull();
  });
  it('omits the old registry when an explicitly approved CLI repo switch names no registry', () => {
    const dest = join(root, 'cli-no-registry');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first', registry: 'first-store' });
    const approval = replacementFor(dest, 'sample-app', { repo })!;
    const result = spawnSync(process.execPath, [resolve('scripts/oshal-app.js'), 'install', 'sample-app', '--repo', repo,
      '--dest', dest, '--replace-source', approval.token], { encoding: 'utf8', timeout: 30000, env: { ...process.env, OSHAL_PACKAGE_AUDIT_MODE: 'compatible' } });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dest, 'sample-app', '.oshal-install.json'), 'utf8')).registry).toBeUndefined();
  }, 30000);
  it('serializes the final mutation and rejects a stale token inside the lock', () => {
    const dest = join(root, 'lock');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first' });
    const approval = replacementFor(dest, 'sample-app', { repo })!;
    withInstallSourceLock(dest, 'sample-app', () => {
      expect(() => withInstallSourceLock(dest, 'sample-app', () => undefined)).toThrow(/another install/);
      stamp(dest, 'sample-app', { repo: 'https://example.test/other' });
      expect(() => assertInstallSource(dest, 'sample-app', { repo }, approval.token)).toThrow(/confirmation/);
    });
  });
  it('rechecks provenance after the real Git fetch before the installer replaces the directory', async () => {
    const dest = join(root, 'changed-during-fetch');
    stamp(dest, 'sample-app', { repo: 'https://example.test/first' });
    const approval = replacementFor(dest, 'sample-app', { repo, registry: 'second-store' })!;
    let changed = false;
    const result = await new Promise<{ status: number | null; output: string }>((done, reject) => {
      let output = '';
      const child = spawn(process.execPath, [resolve('scripts/oshal-app.js'), 'install', 'sample-app', '--repo', repo,
        '--dest', dest, '--registry', 'second-store', '--replace-source', approval.token], {
        env: { ...process.env, OSHAL_PACKAGE_AUDIT_MODE: 'compatible' }, timeout: 30000,
      });
      child.on('error', reject);
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (!changed && output.includes('fetching sample-app')) {
          changed = true;
          stamp(dest, 'sample-app', { repo: 'https://example.test/changed-during-fetch' });
        }
      });
      child.stderr.on('data', chunk => { output += String(chunk); });
      child.on('close', status => done({ status, output }));
    });
    expect(changed).toBe(true);
    expect(result.status, result.output).toBe(42);
    expect(JSON.parse(readFileSync(join(dest, 'sample-app', '.oshal-install.json'), 'utf8')).repo).toBe('https://example.test/changed-during-fetch');
  }, 30000);
});
