/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove Files and data-lifecycle use the installed Career mapper, preserve exact subjects, and reject traversal/symlink escapes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/connectors-routes', () => ({ getValidAccessToken: vi.fn() }));

import { browse, listRoots, readBytes } from '@/app/routes/storage-browse';
import { buildCareerHunterExporter } from '@/features/data-lifecycle';

const roots: string[] = [];
let savedStoreRoot: string | undefined;
let savedMapper: string | undefined;

/** Install a side-effect-free test mapper with the same exact-subject structural contract. */
function installMapper(root: string): string {
  const modulePath = path.join(root, 'career-mapper.js');
  fs.writeFileSync(modulePath, `'use strict';
const fs = require('fs');
const path = require('path');
function findUserStoreLayout(root, tenant, sub) {
  const tenantDir = path.resolve(root, tenant);
  const userSegment = 'u-' + Buffer.from(sub, 'utf8').toString('hex');
  const userDir = path.resolve(tenantDir, userSegment);
  if (!fs.existsSync(userDir) || !fs.statSync(userDir).isDirectory()) return null;
  return { tenantDir, userDir, userSegment, userDb: path.join(userDir, 'user-' + userSegment + '.db') };
}
module.exports = { findUserStoreLayout };
`, 'utf8');
  return modulePath;
}

function mappedLayout(root: string, subject: string) {
  const segment = `u-${Buffer.from(subject, 'utf8').toString('hex')}`;
  const userDir = path.join(root, 'store', 'default', segment);
  return { segment, userDir, userDb: path.join(userDir, `user-${segment}.db`) };
}

function context() {
  return { pool: { query: vi.fn(async () => ({ rows: [] })) } } as any;
}

beforeEach(() => {
  savedStoreRoot = process.env.JOBHUNTER_STORE_ROOT;
  savedMapper = process.env.JOBHUNTER_USER_STORE_MODULE;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-core-path-'));
  roots.push(root);
  process.env.JOBHUNTER_STORE_ROOT = path.join(root, 'store');
  process.env.JOBHUNTER_USER_STORE_MODULE = installMapper(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStoreRoot === undefined) delete process.env.JOBHUNTER_STORE_ROOT;
  else process.env.JOBHUNTER_STORE_ROOT = savedStoreRoot;
  if (savedMapper === undefined) delete process.env.JOBHUNTER_USER_STORE_MODULE;
  else process.env.JOBHUNTER_USER_STORE_MODULE = savedMapper;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Career store kernel integration', () => {
  it('browses only the mapper-selected exact subject and rejects traversal', async () => {
    const root = roots.at(-1)!;
    const subject = ' ../victim ';
    const own = mappedLayout(root, subject);
    fs.mkdirSync(path.join(own.userDir, 'applications'), { recursive: true });
    fs.writeFileSync(path.join(own.userDir, 'applications', 'own.txt'), 'owned', 'utf8');
    const rawVictim = path.join(root, 'store', 'default', 'victim', 'applications');
    fs.mkdirSync(rawVictim, { recursive: true });
    fs.writeFileSync(path.join(rawVictim, 'secret.txt'), 'other user', 'utf8');

    expect((await listRoots(context(), subject)).map((entry) => entry.provider)).toContain('career');
    expect(await browse(context(), subject, 'career', 'applications')).toMatchObject([
      { name: 'own.txt', type: 'file', path: 'applications/own.txt' },
    ]);
    expect((await readBytes(context(), subject, 'career', 'applications/own.txt')).buf.toString())
      .toBe('owned');
    await expect(browse(context(), subject, 'career', 'applications/../victim'))
      .rejects.toThrow('invalid path');
  });

  it('omits linked entries and exports/deletes only the mapped directory', async () => {
    const root = roots.at(-1)!;
    const subject = ' Owner/Exact ';
    const own = mappedLayout(root, subject);
    const uploads = path.join(own.userDir, 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'resume.txt'), 'resume', 'utf8');
    const db = new Database(own.userDb);
    db.exec('CREATE TABLE facts (owner_sub TEXT, value TEXT)');
    db.prepare('INSERT INTO facts VALUES (?, ?)').run(subject, 'private');
    db.close();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside', 'utf8');
    try { fs.symlinkSync(outside, path.join(uploads, 'linked'), 'junction'); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    }
    const rawVictim = path.join(root, 'store', 'default', 'victim');
    fs.mkdirSync(rawVictim, { recursive: true });

    const entries = await browse(context(), subject, 'career', 'uploads');
    expect(entries.map((entry) => entry.name)).toEqual(['resume.txt']);
    const exporter = buildCareerHunterExporter();
    const rows = await exporter.exportRows(subject) as Array<Record<string, unknown>>;
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'file', file: 'uploads/resume.txt' }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'db-row', table: 'facts' }));
    expect(rows.some((row) => String(row.file || '').includes('outside'))).toBe(false);
    await expect(exporter.deleteRows?.(subject)).resolves.toBeGreaterThan(0);
    expect(fs.existsSync(own.userDir)).toBe(false);
    expect(fs.existsSync(rawVictim)).toBe(true);
  });
});
