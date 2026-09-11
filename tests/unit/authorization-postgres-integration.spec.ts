/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, PostgresAuthorizationStore } from '../../src/features/application-authorization';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import type { AuthorizationActor, AuthorizationChange } from '../../src/shared/application-authorization';
import { assertBotNodeApplicationTransport } from '../../src/app/bot-node-application-authorization';
import { readApplicationExecutionOwnership } from '../../src/app/application-execution-ownership';

const container = `oshal-auth-fixture-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
let started = false; let owner: Pool; let runtime: Pool; let service: ApplicationAuthorizationService;
const admin: AuthorizationActor = { sub: 'fixture-admin', issuer: 'fixture', isActive: true, isSwarmAdmin: true };
const user: AuthorizationActor = { sub: 'fixture-user', issuer: 'fixture', isActive: true, isSwarmAdmin: false };
function docker(args: string[]): string { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim(); }

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=authorization_fixture', 'postgres:16-alpine']);
  started = true; const port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  owner = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'authorization_fixture', connectionTimeoutMillis: 500 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await owner.query('SELECT 1'); ready = true; break; } catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 200)); }
  }
  if (!ready) throw new Error('Disposable authorization PostgreSQL did not become ready');
  await owner.query(readFileSync(resolve('scripts/migrations/127-application-authorization.sql'), 'utf8'));
  await owner.query('CREATE TABLE swarm_applications(name TEXT PRIMARY KEY, agent_ids TEXT[], tool_names TEXT[], manifest_path TEXT, manifest JSONB)');
  await owner.query("CREATE ROLE authorization_runtime LOGIN PASSWORD 'fixture-only' NOSUPERUSER NOBYPASSRLS");
  await owner.query('GRANT USAGE ON SCHEMA public TO authorization_runtime');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authorization_runtime');
  runtime = wrapPoolWithGuc(new Pool({ host: '127.0.0.1', port, user: 'authorization_runtime', password: 'fixture-only', database: 'authorization_fixture' }));
}, 30_000);
beforeEach(async () => {
  await owner.query('TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,oshal_authorization_applications,swarm_applications');
  await owner.query('UPDATE oshal_authorization_state SET revision=0');
  service = new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime));
  await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
});
afterAll(async () => {
  if (runtime) await runtime.end(); if (owner) await owner.end();
  if (started) docker(['rm', '--force', container]);
});
describe('PostgreSQL application authorization transaction boundary', () => {
  it('persists protected bot ownership through disable/uninstall and fails closed on schema loss', async () => {
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce', agentIds: ['protected-bot'] });
    service.unregisterApp('fixture-app');
    await expect(assertBotNodeApplicationTransport(runtime, 'protected-bot', 'legacy-bot')).rejects.toMatchObject({ code: 'authorization_bot_transport_unavailable' });
    await expect(assertBotNodeApplicationTransport(runtime, 'legacy-bot', 'protected-bot')).rejects.toMatchObject({ code: 'authorization_bot_transport_unavailable' });
    await expect(assertBotNodeApplicationTransport(runtime, 'legacy-bot', 'legacy-bot')).resolves.toBeUndefined();
    await owner.query("INSERT INTO swarm_applications(name,agent_ids,manifest) VALUES('declared-app',ARRAY['declared-bot'],'{\"authorization\":{\"version\":1}}')");
    await expect(assertBotNodeApplicationTransport(runtime, 'declared-bot', 'declared-bot')).rejects.toMatchObject({ code: 'authorization_bot_transport_unavailable' });
    await owner.query('ALTER TABLE oshal_authorization_applications RENAME TO temporarily_unavailable');
    try { await expect(assertBotNodeApplicationTransport(runtime, 'legacy-bot', 'legacy-bot')).rejects.toMatchObject({ code: 'authorization_bot_posture_unavailable' }); }
    finally { await owner.query('ALTER TABLE temporarily_unavailable RENAME TO oshal_authorization_applications'); }
  });
  it('resolves durable tool ownership before activation, after uninstall and across ambiguous claims', async () => {
    await owner.query("INSERT INTO swarm_applications VALUES('startup-app',ARRAY['startup-bot'],ARRAY['startup-tool'],'C:/apps/startup/oshal-app.yaml','{}')");
    expect(await readApplicationExecutionOwnership(runtime, { kind: 'tools', id: 'startup-tool', mode: 'enforce' })).toEqual({ app: 'startup-app', protected: true });
    expect(await readApplicationExecutionOwnership(runtime, { kind: 'tools', id: 'startup-tool', mode: 'legacy' })).toEqual({ app: 'startup-app', protected: false });
    await service.registerApp({ app: 'startup-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce', toolNames: ['startup-tool'] });
    service.unregisterApp('startup-app'); await owner.query("DELETE FROM swarm_applications WHERE name='startup-app'");
    expect(await readApplicationExecutionOwnership(runtime, { kind: 'tools', id: 'startup-tool', mode: 'legacy' })).toEqual({ app: 'startup-app', protected: true });
    expect(await readApplicationExecutionOwnership(runtime, { kind: 'tools', id: 'kernel-tool', mode: 'enforce' })).toBeUndefined();
    await owner.query("INSERT INTO swarm_applications(name,tool_names,manifest) VALUES('other-app',ARRAY['startup-tool'],'{}')");
    await expect(readApplicationExecutionOwnership(runtime, { kind: 'tools', id: 'startup-tool', mode: 'enforce' })).rejects.toMatchObject({ code: 'authorization_ownership_unavailable' });
  });
  it('uses restricted runtime role, hides control tables without identity, and persists an audited grant across services', async () => {
    expect((await runtime.query('SELECT * FROM oshal_authorization_state')).rows).toEqual([]);
    const change: AuthorizationChange = { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Fixture grant', expectedRevision: 0 };
    const preview = await service.previewChange(admin, change);
    const receipt = await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId });
    const reloaded = new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime));
    await reloaded.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce' });
    expect((await reloaded.authorize(user, { app: 'fixture-app' })).allowed).toBe(true);
    expect((await owner.query('SELECT revision FROM oshal_authorization_audit')).rows).toEqual([{ revision: String(receipt.revision) }]);
    expect((await runtime.query('SELECT * FROM oshal_authorization_assignments')).rows).toEqual([]);
  });
  it('serializes concurrent approvals and commits exactly one audit/assignment at the expected revision', async () => {
    const change: AuthorizationChange = { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Concurrent fixture', expectedRevision: 0 };
    const [a,b] = await Promise.all([service.previewChange(admin, change), service.previewChange(admin, change)]);
    const results = await Promise.allSettled([a,b].map(preview => service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM oshal_authorization_audit')).rows[0].n)).toBe(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM oshal_authorization_assignments')).rows[0].n)).toBe(1);
  });
  it('rolls back all authority changes if the transactional audit write fails', async () => {
    const preview = await service.previewChange(admin, { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: user.sub, targetIssuer: user.issuer, reason: 'Rollback fixture', expectedRevision: 0 });
    await owner.query('REVOKE INSERT ON oshal_authorization_audit FROM authorization_runtime');
    try {
      await expect(service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId })).rejects.toThrow();
      expect((await service.authorize(user, { app: 'fixture-app' })).allowed).toBe(false);
      expect((await service.catalog(admin)).revision).toBe(0);
    } finally { await owner.query('GRANT INSERT ON oshal_authorization_audit TO authorization_runtime'); }
  });
});
