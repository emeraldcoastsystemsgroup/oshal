/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2b-i guard on a disposable PostgreSQL and the real login routes: the swarm admin gets no session from the password alone. Its first sign-in returns the authenticator QR, only a correct code starts the session, later sign-ins ask for the code, and the factor cannot be switched off. A user without a factor still signs in with a password.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import {
  base32Decode, createSwarmAdmin, currentStep, ensureLocalUserSchema, ensureTotpSchema, hashPassword, localSubForEmail,
  totpCodeForStep,
} from '@/features/local-auth';

const container = `oshal-admin-login-${randomUUID().slice(0, 8)}`;
const dbPassword = `fixture-${randomUUID()}`;
const ADMIN_PASSWORD = 'placeholder-admin-password-0123456789';
let started = false;
let pool: Pool;
let server: Server | undefined;
let base = '';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${dbPassword}`, '--env', 'POSTGRES_DB=admin_login_fixture', 'postgres:16-alpine']);
  started = true;
  const port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password: dbPassword, database: 'admin_login_fixture', connectionTimeoutMillis: 500 });
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
  process.env.SESSION_SECRET = 'placeholder-session-secret-0000';
  await pool.query('DROP TABLE IF EXISTS oshal_local_users CASCADE');
  await ensureLocalUserSchema(pool);
  await ensureTotpSchema(pool);
  await createSwarmAdmin(pool, { password: ADMIN_PASSWORD });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  delete process.env.SESSION_SECRET;
});

/** Serves the real login routes; `asSub` simulates an already signed-in session for the factor routes. */
async function startApp(asSub?: string): Promise<void> {
  const app = express();
  app.use(express.json());
  if (asSub) app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: asSub } } }); next(); });
  app.use(createLocalAuthRoutes(pool));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

async function login(body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/local-auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown>, cookie: res.headers.get('set-cookie') ?? '' };
}

function codeFor(secret: string): string {
  return totpCodeForStep(base32Decode(secret.replace(/\s+/g, '')), currentStep());
}

describe('the swarm admin signs in only with a working authenticator', () => {
  it('gets the QR and no session from the password alone on first sign-in', async () => {
    await startApp();
    const first = await login({ email: 'admin', password: ADMIN_PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: false, secondFactor: 'enrol' });
    expect(String(first.body.qrDataUri)).toMatch(/^data:image\/png;base64,/);
    expect((first.body.recoveryCodes as string[]).length).toBeGreaterThan(0);
    expect(first.cookie).not.toContain('oshal_local=');
  });

  it('refuses a wrong code, then starts the session with the right one', async () => {
    await startApp();
    const first = await login({ email: 'admin', password: ADMIN_PASSWORD });
    const wrong = await login({ email: 'admin', password: ADMIN_PASSWORD, code: '000000' === codeFor(String(first.body.secret)) ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.cookie).not.toContain('oshal_local=');
    const right = await login({ email: 'admin', password: ADMIN_PASSWORD, code: codeFor(String(first.body.secret)) });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ ok: true });
    expect(right.cookie).toContain('oshal_local=');
  });

  it('asks for the code on every later sign-in instead of enrolling again', async () => {
    await startApp();
    const first = await login({ email: 'admin', password: ADMIN_PASSWORD });
    await login({ email: 'admin', password: ADMIN_PASSWORD, code: codeFor(String(first.body.secret)) });
    const again = await login({ email: 'admin', password: ADMIN_PASSWORD });
    expect(again.body).toMatchObject({ ok: false, secondFactor: 'required' });
    expect(again.body.qrDataUri).toBeUndefined();
    expect(again.cookie).not.toContain('oshal_local=');
  });

  it('cannot switch the factor off', async () => {
    await startApp(localSubForEmail('admin'));
    const res = await fetch(`${base}/api/local-auth/2fa/disable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(403);
  });
});

describe('ordinary local accounts', () => {
  it('still sign in with a password when they have no factor', async () => {
    await pool.query(
      `INSERT INTO oshal_local_users (id, email, user_sub, status, password_hash) VALUES ($1, 'person@example.test', $2, 'active', $3)`,
      [randomUUID(), localSubForEmail('person@example.test'), hashPassword('placeholder-person-password-01')],
    );
    await startApp();
    const res = await login({ email: 'person@example.test', password: 'placeholder-person-password-01' });
    expect(res.body).toMatchObject({ ok: true });
    expect(res.cookie).toContain('oshal_local=');
  });
});
