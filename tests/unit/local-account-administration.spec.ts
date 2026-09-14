/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove existing-account adoption and serialized root-safe administration through real PostgreSQL and HTTP.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep case registration bounded while preserving the root-administration suite and shared fixture hooks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAccountFixture, fixtureServiceSecret } from '../fixtures/local-account-administration';
import { issueInstallerRootSetup } from '@/app/composition/installer-root-bootstrap';
import { refreshPrivilegedCache } from '@/features/swarm-roles';

const fixture = new LocalAccountFixture();
beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'isolated-session-signing-secret-for-users-regression');
  vi.stubEnv('SWARM_SERVICE_SECRET', fixtureServiceSecret);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('LOCAL_AUTH_PUBLIC_URL', ''); vi.stubEnv('APP_URL', ''); vi.stubEnv('SMTP_HOST', '');
  await fixture.start();
}, 90_000);
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { await fixture.close(); vi.unstubAllEnvs(); }, 30_000);
const userRoute = (id: string, action: string) => `/api/local-auth/users/${id}/${action}`;

describe('established accounts close fresh-root setup', () => {
  it('reports an empty installation once and requires the installer proof even then', async () => {
    await fixture.reset(false);
    expect(await (await fetch(fixture.base + '/api/local-auth/state')).json()).toMatchObject({ bootstrapRequired: true });
    const response = await fixture.post('/api/local-auth/bootstrap', { email: 'new@example.test', password: 'long-enough-password' }, '');
    expect(response.status).toBe(403);
  });

  it.each(['local', 'role', 'external', 'completed'] as const)('keeps setup closed for existing %s state', async kind => {
    if (kind !== 'local') await fixture.reset(false);
    if (kind === 'role') await fixture.owner.query("INSERT INTO swarm_roles (user_sub,role) VALUES ('historical-unknown-issuer','user')");
    if (kind === 'external') await fixture.externalIdentity();
    if (kind === 'completed') {
      await issueInstallerRootSetup(fixture.runtime, fixture.base);
      await fixture.owner.query("UPDATE oshal_installer_root_setup SET completed_sub='local-historical', completed_issuer='urn:oshal:local-auth', completed_at=NOW()");
    }
    const response = await fetch(fixture.base + '/api/local-auth/state');
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ bootstrapRequired: false });
    await expect(issueInstallerRootSetup(fixture.runtime, fixture.base)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an already-issued installer proof after the first verified external account appears', async () => {
    await fixture.reset(false);
    const proof = await issueInstallerRootSetup(fixture.runtime, fixture.base);
    await fixture.externalIdentity();
    const response = await fixture.post('/api/local-auth/bootstrap', {
      email: 'replacement@example.test', password: 'long-enough-password', setupToken: proof.token,
    }, '');
    expect(response.status).toBe(409);
    expect((await fixture.owner.query('SELECT * FROM oshal_local_users')).rows).toHaveLength(0);
    expect((await fixture.owner.query('SELECT completed_at FROM oshal_installer_root_setup')).rows[0].completed_at).toBeNull();
  });
});

/** Register caller and exact-root credential boundaries in the existing suite. */
function registerAdministrationCallerCases() {
  it('rejects anonymous and nonadministrator writes, including root credential reset attempts', async () => {
    for (const caller of ['', 'member']) {
      const expected = caller ? 403 : 401;
      expect((await fixture.post('/api/local-auth/users', { email: 'intruder@example.test' }, caller)).status).toBe(expected);
      for (const action of ['disable', 'enable', 'reinvite', '2fa']) {
        expect((await fixture.post(userRoute(fixture.users.root.id, action), { reset: true }, caller)).status).toBe(expected);
      }
    }
  });

  it('refuses disabling current root for all administrators and service callers without touching sessions', async () => {
    const before = (await fixture.owner.query('SELECT status,token_version FROM oshal_local_users WHERE id=$1', [fixture.users.root.id])).rows[0];
    for (const caller of ['root', 'admin', 'service']) {
      expect((await fixture.post(userRoute(fixture.users.root.id, 'disable'), {}, caller)).status).toBe(409);
    }
    expect((await fixture.owner.query('SELECT status,token_version FROM oshal_local_users WHERE id=$1', [fixture.users.root.id])).rows[0]).toEqual(before);
  });

  it('guards reinvite, invite-by-email and factor reset with exact current-root issuer and subject', async () => {
    await fixture.owner.query('UPDATE oshal_local_users SET totp_enabled=TRUE,totp_required=TRUE WHERE id=$1', [fixture.users.root.id]);
    const operations = [
      { route: userRoute(fixture.users.root.id, 'reinvite'), body: {} },
      { route: '/api/local-auth/users', body: { email: fixture.users.root.email.toUpperCase() } },
      { route: userRoute(fixture.users.root.id, '2fa'), body: { reset: true, required: false } },
    ];
    for (const operation of operations) {
      for (const caller of ['admin', 'service']) expect((await fixture.post(operation.route, operation.body, caller)).status).toBe(403);
      expect((await fixture.post(operation.route, operation.body, 'root', 'https://accounts.google.com')).status).toBe(403);
    }
    expect((await fixture.owner.query('SELECT invite_token_hash,totp_enabled,totp_required FROM oshal_local_users WHERE id=$1', [fixture.users.root.id])).rows[0])
      .toEqual({ invite_token_hash: null, totp_enabled: true, totp_required: true });
    expect((await fixture.post(operations[0].route, {}, 'root')).status).toBe(200);
    expect((await fixture.post(operations[1].route, operations[1].body, 'root')).status).toBe(201);
    expect((await fixture.post(operations[2].route, operations[2].body, 'root')).status).toBe(200);
  });

}

/** Register serialized root-transfer checks using the same per-case database reset. */
function registerRootTransferCases() {
  it.each(['disable', 'reinvite', '2fa'])('rechecks current root after a concurrent role transfer before %s', async action => {
    const client = await fixture.owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE oshal_local_users, swarm_roles IN SHARE ROW EXCLUSIVE MODE');
      await client.query("UPDATE swarm_roles SET role='admin' WHERE role='root'");
      await client.query("INSERT INTO swarm_roles (user_sub,role) VALUES ($1,'root')", [fixture.users.member.userSub]);
      const request = fixture.post(userRoute(fixture.users.member.id, action), { reset: true });
      await expect.poll(async () => (await fixture.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename='users_runtime' AND wait_event_type='Lock' AND query LIKE 'LOCK TABLE oshal_local_users%'`)).rows[0].n).toBeGreaterThan(0);
      await client.query('COMMIT');
      expect((await request).status).toBe(action === 'disable' ? 409 : 403);
      expect((await fixture.owner.query('SELECT status,invite_token_hash,token_version FROM oshal_local_users WHERE id=$1', [fixture.users.member.id])).rows[0])
        .toEqual({ status: 'active', invite_token_hash: null, token_version: fixture.users.member.tokenVersion });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('permits disabling the former root after an explicit transfer while preserving the new root', async () => {
    const transfer = await fixture.post('/api/swarm/roles/transfer-root', { toSub: fixture.users.member.userSub }, 'root');
    expect(transfer.status).toBe(200);
    await refreshPrivilegedCache(fixture.runtime);
    expect((await fixture.post(userRoute(fixture.users.root.id, 'disable'))).status).toBe(200);
    expect((await fixture.post(userRoute(fixture.users.member.id, 'disable'))).status).toBe(409);
  });
}

describe('root-safe local account administration', () => {
  registerAdministrationCallerCases();
  registerRootTransferCases();
});
