/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise the real Gov-Contracting enqueue seam against digest-keyed and safe legacy CRM stores, proving exact owner propagation and fail-closed linked-database handling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove the app-owned Python scanner receives only exact owner paths, documented SAM settings, and runtime values rather than controller/database credentials.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';
import type { AppContext } from '../../src/app/composition/app-context';

vi.mock('@/features/graph', () => ({
  getGraphIngestionService: () => ({ ingestCaptureOpportunity: vi.fn(async () => undefined) }),
}));

const fixtures: string[] = [];
const originalRoot = process.env.GOVCON_STORE_ROOT;

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-gov-store-'));
  fixtures.push(root);
  return root;
}

function seedCrm(directory: string, noticeId = 'notice-1'): void {
  const db = new Database(path.join(directory, 'crm.db'));
  db.exec(`CREATE TABLE sam_notices (
    notice_id TEXT PRIMARY KEY, title TEXT, agency TEXT, naics TEXT, set_aside TEXT,
    due TEXT, url TEXT, fit_score REAL, promoted INTEGER
  )`);
  db.prepare('INSERT INTO sam_notices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(noticeId, 'Exact capture', 'Agency', '541512', '', '2026-09-01', 'https://sam.gov/example', 95, 1);
  db.close();
}

function context() {
  const createTicket = vi.fn(async () => ({ ticketId: `ticket-${createTicket.mock.calls.length}` }));
  return { ctx: { ticketService: { createTicket } } as unknown as AppContext, createTicket };
}

async function enqueueModule(root: string) {
  process.env.GOVCON_STORE_ROOT = root;
  vi.resetModules();
  return import('../../src/app/routes/gov-contracting-cron');
}

afterEach(() => {
  if (originalRoot === undefined) delete process.env.GOVCON_STORE_ROOT;
  else process.env.GOVCON_STORE_ROOT = originalRoot;
  vi.resetModules();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Gov-Contracting exact owner stores', () => {
  it('builds a least-privilege scanner environment', async () => {
    const root = fixtureRoot();
    const { buildGovContractingProcessEnv } = await enqueueModule(root);
    const env = buildGovContractingProcessEnv(' Owner-Exact ', {
      CRM_DB: 'C:\\owner\\crm.db',
      CRM_CAPTURE_DIR: 'C:\\owner\\capture',
      CRM_ECON_FILE: 'C:\\owner\\econ.json',
    }, {
      PATH: 'C:\\runtime',
      SAM_API_KEY: 'intended-sam-key',
      GOVCON_PROMOTE_MIN: '55',
      DATABASE_URL: 'controller-database',
      SESSION_SECRET: 'controller-session',
    });
    expect(env).toEqual({
      PATH: 'C:\\runtime',
      SAM_API_KEY: 'intended-sam-key',
      GOVCON_PROMOTE_MIN: '55',
      PYTHONNOUSERSITE: '1',
      OSHAL_USER_SUB: ' Owner-Exact ',
      CRM_DB: 'C:\\owner\\crm.db',
      CRM_CAPTURE_DIR: 'C:\\owner\\capture',
      CRM_ECON_FILE: 'C:\\owner\\econ.json',
    });
  });

  it('reads a separator-bearing exact owner from its canonical digest directory', async () => {
    const root = fixtureRoot();
    const userSub = ' oidc/Exact\\Owner ';
    const store = ensureExactSubjectStoreDirectory(root, 'default', userSub);
    seedCrm(store.subjectDir);
    const { enqueueDraftsForUser } = await enqueueModule(root);
    const { ctx, createTicket } = context();
    await expect(enqueueDraftsForUser(ctx, userSub, 80)).resolves.toBe(1);
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: userSub }));
  });

  it('preserves one exact safe legacy directory without accepting another case identity', async () => {
    const root = fixtureRoot();
    const userSub = 'Legacy.Owner';
    const legacyDir = path.join(root, 'default', userSub);
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o750 });
    seedCrm(legacyDir);
    const { enqueueDraftsForUser } = await enqueueModule(root);
    const first = context();
    const alias = context();
    await expect(enqueueDraftsForUser(first.ctx, userSub, 80)).resolves.toBe(1);
    await expect(enqueueDraftsForUser(alias.ctx, 'legacy.owner', 80)).resolves.toBe(0);
    expect(first.createTicket).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: userSub }));
    expect(alias.createTicket).not.toHaveBeenCalled();
  });

  it('refuses a hard-linked CRM database before opening or creating a ticket', async () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const userSub = 'linked-owner';
    const store = ensureExactSubjectStoreDirectory(root, 'default', userSub);
    const outsideDb = path.join(outside, 'outside.db');
    fs.writeFileSync(outsideDb, 'outside');
    fs.linkSync(outsideDb, path.join(store.subjectDir, 'crm.db'));
    const { enqueueDraftsForUser } = await enqueueModule(root);
    const { ctx, createTicket } = context();
    await expect(enqueueDraftsForUser(ctx, userSub, 80)).rejects.toThrow(/linked or nonregular/);
    expect(createTicket).not.toHaveBeenCalled();
  });
});
