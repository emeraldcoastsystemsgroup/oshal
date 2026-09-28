/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the step-up for a local-auth session, through the REAL second-factor verifier over a private PostgreSQL (oshal_local_users with the TOTP columns, a secret enrolled and confirmed through the local-auth store, encrypted at rest under the session secret). A local-auth session is asked for a code, not sent to a sign-in window; a wrong code proves nothing and a challenge dies after its allowed attempts; the right code proves it; the same code cannot prove a second challenge (the verifier records the step it accepted); an account without a second factor is told to enrol; and an identity-provider session cannot use the code path at all. The session is the local-auth rail's req.oidc shape; everything behind it is real.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: "the challenge dies after its attempts" was true for one challenge only; script could open challenge after challenge and keep guessing. The first case now says so, and a new case pins the per-person failed-code budget over HTTP: a second enrolled account spends it across three challenges, then every fresh challenge gets 429 too-many-failures, the right code among them proves nothing (the challenge stays pending and the verifier's replay marker, totp_last_step, never moves, so the code was never checked), and another account is not affected.
 */

import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  base32Decode, beginTotpEnrolment, confirmTotpEnrolment, currentStep, ensureLocalUserSchema, ensureTotpSchema, totpCodeForStep,
} from '@/features/local-auth';
import { LocationStepUpStore } from '@/app/location-step-up';
import { createLocationRoutes } from '@/app/routes/location-routes';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const ENROLLED = 'local-0123456789abcdef';
const BUDGETED = 'local-0a1b2c3d4e5f6071';
const NOT_ENROLLED = 'local-fedcba9876543210';
const db = new DisposablePostgres({ purpose: 'location-step-up-totp' });
const BUDGET = 6;
const store = new LocationStepUpStore({ maxTotpAttempts: 2, totpFailureBudget: BUDGET, totpFailureWindowMs: 600_000 });
let pool: Pool;
let budgetedSecret = '';
let server: Server;
let base = '';
let secret = '';

const localSession: RequestHandler = (req, _res, next) => {
  const sub = req.get('x-fixture-local-sub');
  const idp = req.get('x-fixture-idp-sub');
  if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, idToken: 'local-session', user: { iss: LOCAL_AUTH_PRINCIPAL_ISSUER, sub } } });
  if (idp) Object.assign(req, { oidc: { isAuthenticated: () => true, idToken: 'eyJ.fixture.sig', idTokenClaims: { iss: 'https://login.oshal.example.com', sub: idp }, user: { sub: idp } } });
  next();
};

async function call(headers: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/location${path}`, { method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}
const as = (sub: string) => ({ 'x-fixture-local-sub': sub });
const code = () => totpCodeForStep(base32Decode(secret), currentStep(Date.now()));
const codeFor = (secretBase32: string) => totpCodeForStep(base32Decode(secretBase32), currentStep(Date.now()));
/** A six-digit code that is none of the codes the verifier accepts around now. */
function wrongCodeFor(secretBase32: string): string {
  const key = base32Decode(secretBase32);
  const step = currentStep(Date.now());
  const accepted = new Set([-2, -1, 0, 1, 2].map((offset) => totpCodeForStep(key, step + offset)));
  for (let n = 0; ; n += 1) { const candidate = String(n).padStart(6, '0'); if (!accepted.has(candidate)) return candidate; }
}
const lastStepOf = async (sub: string) => (await pool.query('SELECT totp_last_step FROM oshal_local_users WHERE user_sub = $1', [sub])).rows[0]?.totp_last_step ?? null;
const open = async (sub: string) => (await call(as(sub), 'POST', '/step-up', { operation: 'opt-in', params: { precisionClass: 'block' } })).json;

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'location-totp-fixture-session-secret-0123456789');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', '');
  vi.stubEnv('LOG_LEVEL', 'silent');
  pool = await db.start() as Pool;
  await ensureLocalUserSchema(pool);
  await ensureTotpSchema(pool);
  for (const [sub, email] of [[ENROLLED, 'enrolled@oshal.example.com'], [NOT_ENROLLED, 'plain@oshal.example.com'], [BUDGETED, 'budgeted@oshal.example.com']]) {
    await pool.query("INSERT INTO oshal_local_users (id, email, user_sub, status) VALUES ($1, $2, $1, 'active')", [sub, email]);
  }
  secret = (await beginTotpEnrolment(pool, ENROLLED, 'oshal', 'enrolled@oshal.example.com')).secretBase32;
  expect(await confirmTotpEnrolment(pool, ENROLLED, code())).toBe(true);
  budgetedSecret = (await beginTotpEnrolment(pool, BUDGETED, 'oshal', 'budgeted@oshal.example.com')).secretBase32;
  expect(await confirmTotpEnrolment(pool, BUDGETED, codeFor(budgetedSecret))).toBe(true);
  const app = express();
  app.use(localSession);
  app.use('/api/location', createLocationRoutes({ pool, stepUpStore: store }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  await db.stop();
  vi.unstubAllEnvs();
}, 60_000);

describe('location step-up for a local-auth session', () => {
  it('asks for a code instead of a sign-in window; a wrong code proves nothing and one challenge dies after its own attempts', async () => {
    const challenge = await open(ENROLLED);
    expect(challenge).toMatchObject({ method: 'local-totp', startUrl: null, totpUrl: expect.stringContaining('/totp') });
    expect((await call(as(ENROLLED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: '000000' })).json.error).toBe('totp_invalid');
    expect((await call(as(ENROLLED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: '999999' })).json.error).toBe('totp_invalid');
    const third = await call(as(ENROLLED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: code() });
    expect(third).toMatchObject({ status: 429, json: { reason: 'too-many-attempts' } });
    expect((await call(as(ENROLLED), 'GET', `/step-up/${challenge.challengeId}`)).status).toBe(404);
  });

  it('the right code proves the challenge, and the same code cannot prove another', async () => {
    const first = await open(ENROLLED);
    const used = code();
    expect(await call(as(ENROLLED), 'POST', `/step-up/${first.challengeId}/totp`, { code: used })).toMatchObject({ status: 200, json: { state: 'proven' } });
    expect((await call(as(ENROLLED), 'GET', `/step-up/${first.challengeId}`)).json.state).toBe('proven');
    const second = await open(ENROLLED);
    expect((await call(as(ENROLLED), 'POST', `/step-up/${second.challengeId}/totp`, { code: used })).json.error).toBe('totp_invalid');
    expect((await call(as(ENROLLED), 'GET', `/step-up/${second.challengeId}`)).json.state).toBe('pending');
  });

  it('an account without a second factor is told to enrol one', async () => {
    const challenge = await open(NOT_ENROLLED);
    const res = await call(as(NOT_ENROLLED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: '123456' });
    expect(res).toMatchObject({ status: 409, json: { error: 'totp_not_enrolled' } });
  });

  it('a person\'s failed codes are budgeted across challenges: once spent, fresh challenges get 429 and the right code proves nothing', async () => {
    for (let round = 0; round < BUDGET / 2; round += 1) {
      const challenge = await open(BUDGETED);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await call(as(BUDGETED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: wrongCodeFor(budgetedSecret) });
        expect(res).toMatchObject({ status: 403, json: { error: 'totp_invalid' } });
      }
    }
    for (let fresh = 0; fresh < 3; fresh += 1) {
      const challenge = await open(BUDGETED);
      for (const attempt of [codeFor(budgetedSecret), wrongCodeFor(budgetedSecret)]) {
        const res = await call(as(BUDGETED), 'POST', `/step-up/${challenge.challengeId}/totp`, { code: attempt });
        expect(res).toMatchObject({ status: 429, json: { error: 'step_up_refused', reason: 'too-many-failures' } });
      }
      expect((await call(as(BUDGETED), 'GET', `/step-up/${challenge.challengeId}`)).json.state).toBe('pending');
    }
    expect(await lastStepOf(BUDGETED)).toBeNull();
    const other = await open(NOT_ENROLLED);
    expect(await call(as(NOT_ENROLLED), 'POST', `/step-up/${other.challengeId}/totp`, { code: '123456' })).toMatchObject({ status: 409 });
  });

  it('an identity-provider session cannot use the code path', async () => {
    const opened = await call({ 'x-fixture-idp-sub': 'idp-person' }, 'POST', '/step-up', { operation: 'opt-in', params: { precisionClass: 'block' } });
    expect(opened.json.method).toBe('oidc-max-age');
    const res = await call({ 'x-fixture-idp-sub': 'idp-person' }, 'POST', `/step-up/${opened.json.challengeId}/totp`, { code: code() });
    expect(res).toMatchObject({ status: 404, json: { error: 'step_up_not_found' } });
  });
});
