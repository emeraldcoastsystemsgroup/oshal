/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the AUTH-07 Little Monsters upgrade acceptance script by running the REAL script as a child process against the REAL Access Administration routes and policy service on loopback: an upgrade that carried every assignment passes with authenticated GETs only; an unmigrated or too-old install, a grant revoked after the migration, a migration that removed a grant, a pending review, an unregistered package, a refused read and a missing PAT each fail with their own reason; the token never reaches output.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationChange } from '@/shared/application-authorization';
import { createAuthorizationRoutes } from '@/app/routes/authorization-routes';
import { CLASSROOM_143, CLASSROOM_144, CLASSROOM_APP, classroomRegistration, editedCatalog } from '../fixtures/authorization-catalog-migration';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const SCRIPT = 'scripts/operations/little-monsters-upgrade-proof.js';
const TOKEN = `oshal_pat_fixture_${Date.now()}`;
const ISSUER = 'https://identity.fixture.test';
const admin: AuthorizationActor = { sub: 'fixture-operator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const { verdict } = createRequire(__filename)(`../../${SCRIPT}`) as { verdict: (bodies: unknown, options?: unknown) => { ok: boolean; problems: string[] } };

let server: http.Server; let base: string; let store: MemoryAuthorizationStore; let service: ApplicationAuthorizationService;
let refuse = false; const seen: Array<{ method: string; url: string; authorization?: string }> = [];

async function change(input: Omit<AuthorizationChange, 'expectedRevision' | 'reason' | 'app'>): Promise<void> {
  const preview = await service.previewChange(admin, { app: CLASSROOM_APP, reason: 'Upgrade proof fixture',
    expectedRevision: (await store.read()).revision, ...input } as AuthorizationChange);
  await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId });
}
/** Installed 1.4.3 with a teacher and a student, as the live box had before staging. */
async function install143(): Promise<void> {
  await service.registerApp(classroomRegistration(CLASSROOM_143, '1.4.3'));
  await change({ action: 'grant', targetSub: 'fixture-teacher', targetIssuer: ISSUER, role: 'teacher' });
  await change({ action: 'grant', targetSub: 'fixture-student', targetIssuer: ISSUER, role: 'student' });
}

beforeEach(async () => {
  store = new MemoryAuthorizationStore(); service = new ApplicationAuthorizationService(store);
  refuse = false; seen.length = 0;
  const requiresAuth: RequestHandler = (req, res, next) => {
    seen.push({ method: req.method, url: req.originalUrl, authorization: req.headers.authorization });
    if (refuse || req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'authentication_required' }); return; }
    next();
  };
  const app = express();
  app.use('/api/authorization', createAuthorizationRoutes(service, { requiresAuth, resolveActor: async (_req: Request) => structuredClone(admin) }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });

/** Run the real script against the fixture; resolves with its exit code and output. */
function run(token = TOKEN, extra: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', OSHAL_VERIFY_BASE_URL: base,
      ...(token ? { OSHAL_VERIFY_OPERATOR_PAT: token } : {}), ...extra } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
}

describe('Little Monsters upgrade acceptance script', () => {
  it('passes an upgrade that carried every assignment, reading with authenticated GETs only', async () => {
    await install143();
    await service.registerApp(classroomRegistration(CLASSROOM_144, '1.4.4'));
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, problems: [], app: CLASSROOM_APP, version: '1.4.4', carried: 2 });
    expect(result.output).not.toContain(TOKEN);
    expect(seen.map(row => `${row.method} ${row.url.split('?')[0]}`)).toEqual(
      ['GET /api/authorization/catalog', 'GET /api/authorization/audit', 'GET /api/authorization/catalog-migrations']);
    expect(seen.every(row => row.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('fails an install that is still on the old version and never migrated', async () => {
    await install143();
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('registered at 1.4.3, below 1.4.4');
    expect(result.output).toContain('no catalog-migration onto the running catalog revision');
  });

  it('fails when a carried assignment is gone after the migration', async () => {
    await install143();
    await service.registerApp(classroomRegistration(CLASSROOM_144, '1.4.4'));
    await change({ action: 'revoke', targetSub: 'fixture-student', targetIssuer: ISSUER, role: 'student' });
    const result = await run();
    expect(result.code).toBe(1); expect(result.output).toContain('1 carried assignment(s) are no longer present');
  });

  it('fails a reviewed migration that removed a grant', async () => {
    await install143();
    const dropped = editedCatalog(catalog => { delete catalog.roles.student; }, CLASSROOM_144);
    const refusal = await service.validateRegistration(classroomRegistration(dropped, '1.5.0')).catch(error => error);
    await service.applyCatalogMigration(admin, { previewId: refusal.previewId, idempotencyKey: 'proof-reviewed-drop' });
    await service.registerApp(classroomRegistration(dropped, '1.5.0'));
    const result = await run();
    expect(result.code).toBe(1); expect(result.output).toContain('the migration removed 1 grant(s)');
  });

  it('fails an unregistered package, a refused read and a missing PAT with their own exit codes', async () => {
    const absent = await run();
    expect(absent.code).toBe(1); expect(absent.output).toContain('little-monsters is not registered');
    refuse = true;
    const refused = await run();
    expect(refused.code).toBe(1); expect(refused.output).toContain('answered 401'); expect(refused.output).not.toContain(TOKEN);
    seen.length = 0;
    const missing = await run('');
    expect(missing.code).toBe(2); expect(missing.output).toContain('OSHAL_VERIFY_OPERATOR_PAT is required');
    expect(seen).toEqual([]);
  });

  it('reports a review still pending for the running revision', () => {
    const catalog = { apps: [{ app: CLASSROOM_APP, status: 'catalog', version: '1.4.4', catalogRevision: 'running' }], assignments: [{ id: 'a1', app: CLASSROOM_APP }] };
    const audit = [{ action: 'catalog-migration', revision: 7, migration: { toRevision: 'running', assignmentIds: ['a1'], removedIds: [] } }];
    expect(verdict({ catalog, audit, migrations: [] })).toMatchObject({ ok: true });
    expect(verdict({ catalog, audit, migrations: [{ previewId: 'review-1', toRevision: 'running', status: 'pending' }] }).problems)
      .toEqual(['review review-1 for the running revision is still pending']);
  });
});
