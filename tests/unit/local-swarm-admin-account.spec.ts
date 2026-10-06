/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2a guard on a disposable PostgreSQL: the swarm-admin account has the reserved login 'admin', is created once and never replaced, reports its kind through login and session snapshots, and cannot be created or taken over through invites or email resets. Accounts that existed before the column are users.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SWARM_ADMIN_LOGIN, createPasswordReset, createSwarmAdmin, ensureLocalUserSchema, getSessionSnapshot,
  localSubForEmail, upsertInvite, verifyLogin,
} from '@/features/local-auth';

const container = `oshal-swarm-admin-${randomUUID().slice(0, 8)}`;
const password = `fixture-${randomUUID()}`;
const ADMIN_PASSWORD = 'placeholder-admin-password-0123456789';
let started = false;
let pool: Pool;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=swarm_admin_fixture', 'postgres:16-alpine']);
  started = true;
  const port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'swarm_admin_fixture', connectionTimeoutMillis: 500 });
  for (let attempt = 0; ; attempt += 1) {
    try { await pool.query('SELECT 1'); break; } catch (err) {
      if (attempt > 60) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started) docker(['rm', '--force', container]);
});

beforeEach(async () => {
  await pool.query('DROP TABLE IF EXISTS oshal_local_users CASCADE');
});

describe('the swarm-admin account', () => {
  it("is created once with the reserved login and reports its kind on login and in session snapshots", async () => {
    await ensureLocalUserSchema(pool);
    const admin = await createSwarmAdmin(pool, { password: ADMIN_PASSWORD });
    expect(admin).toMatchObject({ email: SWARM_ADMIN_LOGIN, accountKind: 'swarm-admin', status: 'active', userSub: localSubForEmail('admin') });
    expect(await verifyLogin(pool, 'admin', ADMIN_PASSWORD)).toMatchObject({ accountKind: 'swarm-admin' });
    expect(await getSessionSnapshot(pool, admin!.userSub)).toMatchObject({ accountKind: 'swarm-admin', status: 'active' });
  });

  it('is never replaced by a second create, which keeps the original password', async () => {
    await ensureLocalUserSchema(pool);
    await createSwarmAdmin(pool, { password: ADMIN_PASSWORD });
    expect(await createSwarmAdmin(pool, { password: 'placeholder-takeover-password-value' })).toBeNull();
    expect(await verifyLogin(pool, 'admin', ADMIN_PASSWORD)).not.toBeNull();
    expect(await verifyLogin(pool, 'admin', 'placeholder-takeover-password-value')).toBeNull();
  });

  it('refuses a password shorter than the policy', async () => {
    await ensureLocalUserSchema(pool);
    await expect(createSwarmAdmin(pool, { password: 'short' })).rejects.toMatchObject({ status: 400 });
  });

  it('cannot be created by an invite or reset by email, while a user still can be', async () => {
    await ensureLocalUserSchema(pool);
    await expect(upsertInvite(pool, { email: 'admin' })).rejects.toMatchObject({ status: 400 });
    await createSwarmAdmin(pool, { password: ADMIN_PASSWORD });
    expect(await createPasswordReset(pool, 'admin')).toBeNull();

    const invited = await upsertInvite(pool, { email: 'person@example.test' });
    expect(invited.user.accountKind).toBe('user');
    await pool.query("UPDATE oshal_local_users SET status = 'active' WHERE email = 'person@example.test'");
    expect(await createPasswordReset(pool, 'person@example.test')).not.toBeNull();
  });

  it('allows only the two account kinds', async () => {
    await ensureLocalUserSchema(pool);
    await expect(pool.query(
      `INSERT INTO oshal_local_users (id, email, user_sub, status, account_kind) VALUES ($1, 'x@example.test', 'local-x', 'active', 'root')`,
      [randomUUID()],
    )).rejects.toThrow(/check constraint/i);
  });
});

describe('accounts created before the column existed', () => {
  it('read as users once the schema is brought up to date', async () => {
    await pool.query(`CREATE TABLE oshal_local_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT, user_sub TEXT UNIQUE NOT NULL, password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'invited', token_version INTEGER NOT NULL DEFAULT 1, invite_token_hash TEXT,
      invite_expires_at TIMESTAMPTZ, invited_by_sub TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), activated_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ)`);
    await pool.query(`INSERT INTO oshal_local_users (id, email, user_sub, status) VALUES ($1, 'early@example.test', $2, 'active')`,
      [randomUUID(), localSubForEmail('early@example.test')]);
    await ensureLocalUserSchema(pool);
    expect(await getSessionSnapshot(pool, localSubForEmail('early@example.test'))).toMatchObject({ accountKind: 'user' });
  });
});
