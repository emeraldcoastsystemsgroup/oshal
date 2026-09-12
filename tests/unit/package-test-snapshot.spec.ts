/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise source growth races and bounded snapshot reads with real temporary files.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const race = vi.hoisted(() => ({ phase: '', file: '', largestRead: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    if (race.phase === 'open') { race.phase = ''; fs.appendFileSync(race.file, Buffer.alloc(5 * 1024 * 1024)); }
    return fd;
  }, readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    race.largestRead = Math.max(race.largestRead, buffer.length);
    if (race.phase === 'read') { race.phase = ''; fs.appendFileSync(race.file, Buffer.alloc(5 * 1024 * 1024)); }
    return fs.readSync(fd, buffer, offset, length, position);
  } };
});
import { snapshotPackageTests, packageTestRecipePending } from '@/features/swarm-apps/services/package-test-snapshot';
import { inventoryPackageTests } from '@/features/swarm-apps/services/package-test-inventory';
import { mkdirSync } from 'node:fs';
import { packageTestCase } from '../fixtures/package-testing';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); race.phase = ''; });

it('keeps unsupported Node source languages visibly pending before execution', () => {
  const declaration = packageTestCase({ runner: { kind: 'node-test', scope: 'package', files: ['tests/invoice.test.ts'] } });
  expect(packageTestRecipePending(declaration)).toContain('JavaScript suite files');
});

it.each(['open', 'read'])('refuses source growth during %s without allocating the grown file', phase => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-source-race-')); roots.push(root);
  race.file = path.join(root, 'routes.js'); race.largestRead = 0;
  writeFileSync(race.file, 'module.exports = {};'); race.phase = phase;
  expect(() => snapshotPackageTests(root)).toThrow('Package source changed while reading.');
  expect(race.largestRead).toBeLessThanOrEqual(21);
});

it('seals unchanged source bytes without including the installer stamp in child input', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-source-stable-')); roots.push(root);
  writeFileSync(path.join(root, 'routes.js'), 'module.exports = {};');
  writeFileSync(path.join(root, '.oshal-install.json'), JSON.stringify({ sha: 'a'.repeat(40) }));
  const result = snapshotPackageTests(root);
  expect(result.sourceCommit).toBe('a'.repeat(40));
  expect(result.files.map(file => file.path)).toEqual(['routes.js']);
  expect(result.files[0].content.toString()).toBe('module.exports = {};');
  expect(snapshotPackageTests(root).revision).toBe(result.revision);
});

it('detects a newly shipped unregistered suite while ignoring helper files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-inventory-')); roots.push(root);
  mkdirSync(path.join(root, 'tests'));
  for (const name of ['known.test.js', 'fixture.js', 'new.spec.ts']) writeFileSync(path.join(root, 'tests', name), '');
  expect(inventoryPackageTests('fixture', root, new Set(['tests/known.test.js']))).toEqual({
    appName: 'fixture', missingRegistrations: ['tests/new.spec.ts'],
  });
  expect(inventoryPackageTests('fixture', root, new Set(['tests/known.test.js', 'tests/new.spec.ts'])).missingRegistrations).toEqual([]);
});
