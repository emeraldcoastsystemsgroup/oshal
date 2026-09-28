/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L2 done-when for the two account-erasure routes, over the real routers and a private PostgreSQL as the enforcing runtime role: POST /api/me/delete-confirm and DELETE /api/privacy/me each remove the caller's observations and current row, leave no live location device credential (the privacy route revokes it, the /api/me registry revokes it before its discovered delete removes the token row) and run the registered evaluator-state eraser for exactly that principal, while another person's rows and credential are untouched. Erasing a restricted member through /api/me removes their restriction and the group's guardian shares with the membership. A session without a verified issuer erases no location row on either route and says so. GET /api/me/export carries the caller's location rows once, in the location store, and nobody else's. Only the in-memory task, message and ticket stores behind the privacy route are doubles; the routes, the registry, the location erase, the GUC identity seam and PostgreSQL are real.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';
import { createDataLifecycleRouter } from '@/app/routes/data-lifecycle-routes';
import { PRIVACY_DELETE_CONFIRMATION, createPrivacyRoutes } from '@/app/routes/privacy-routes';
import { InMemoryMessageStore } from '@/entities/message';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { registerLocationStateEraser, type LocationPrincipal } from '@/features/location';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { FIXTURE_ISSUER, asSession, convergeAppRole, locationDatabase } from '../helpers/location-postgres-fixture';

const db = locationDatabase('location-erasure-routes', ['080-data-lifecycle.sql']);
let app: Pool;
const erased: LocationPrincipal[] = [];
let unregister: () => void = () => undefined;
/**
 * Every environment input the registry reads beyond PostgreSQL, pinned so the pass is hermetic: the
 * Chroma exporter would otherwise try its default localhost URL, the graph exporter ARANGO_URL, the
 * vault its enable flag and the Career exporter a store root under the working directory.
 */
const ENV_KEYS = ['SESSION_SECRET', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'CHROMADB_URL', 'ARANGO_URL',
  'ENABLE_PERSONAL_INTELLIGENCE', 'JOBHUNTER_STORE_ROOT'];
const savedEnv: Record<string, string | undefined> = {};

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

/** One person's location rows through RLS: settings, a place, a phone with a live credential, two fixes, a current row. */
async function seedPerson(sub: string): Promise<void> {
  const tokenId = `tok-${sub}`;
  await db.pool.query(`INSERT INTO oshal_cli_tokens (id, user_sub, label, token_hash, principal_issuer)
    VALUES ($1, $2, 'location phone', $3, $4)`, [tokenId, sub, `hash-${sub}`, FIXTURE_ISSUER]);
  await asSession({ sub }, async () => {
    const params = [sub, FIXTURE_ISSUER];
    await app.query('INSERT INTO location_settings (owner_sub, principal_issuer) VALUES ($1, $2)', params);
    await app.query(`INSERT INTO location_places (owner_sub, principal_issuer, name, center_lat, center_lon, radius_m, created_by_sub)
      VALUES ($1, $2, 'Home', -12.346, -31.988, 100, $1)`, params);
    await app.query(`INSERT INTO location_devices (device_kind, device_ref, owner_sub, principal_issuer, carried_by_sub, reporting_enabled, credential_id)
      VALUES ('phone', $1 || '-phone', $1, $2, $1, true, $3)`, [...params, tokenId]);
    for (let i = 0; i < 2; i += 1) {
      await app.query(`INSERT INTO location_observations (owner_sub, principal_issuer, subject_ref, source, precision_class, lat, lon, observed_at)
        VALUES ($1, $2, $1, 'android', 'block', -12.346, -31.988, NOW())`, params);
    }
    await app.query(`INSERT INTO location_current (owner_sub, principal_issuer, subject_ref, source, precision_class, lat, lon, observed_at)
      VALUES ($1, $2, $1, 'android', 'block', -12.346, -31.988, NOW())`, params);
  });
}

/** The person's location footprint, read as ground truth. */
async function footprint(sub: string): Promise<Record<string, number>> {
  return {
    observations: await count('location_observations WHERE owner_sub = $1', [sub]),
    current: await count('location_current WHERE owner_sub = $1', [sub]),
    devices: await count('location_devices WHERE owner_sub = $1', [sub]),
    liveCredentials: await count('oshal_cli_tokens WHERE user_sub = $1 AND revoked_at IS NULL', [sub]),
  };
}

/** requiresAuth as OIDC does it: 401 without a session user. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  if (!(req as unknown as { oidc?: { user?: unknown } }).oidc?.user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

/** The two erasure routers behind a session for `sub` (issuer optional) and the server's identity seam. */
function serverFor(sub: string, issuer: string | null): express.Express {
  const web = express();
  web.use(express.json());
  web.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub, email: `${sub}@example.test` },
      idTokenClaims: issuer ? { sub, iss: issuer } : undefined,
    };
    next();
  });
  web.use((req, _res, next) => runWithRequestIdentity(
    { sub: getCaller(req).sub, principalIssuer: getAuthenticatedPrincipalIssuer(req), isOperator: false }, () => next()));
  web.use('/api/me', createDataLifecycleRouter({ pool: app } as AppContext, requiresAuthStub));
  const ticketService = new TicketService(new InMemoryTicketStore());
  web.use('/api/privacy', requiresAuthStub, createPrivacyRoutes({
    pool: app, taskStore: new InMemoryTaskStore(), messageStore: new InMemoryMessageStore(), ticketService,
  } as never));
  return web;
}

/** One request against a throwaway listener. */
async function call(web: express.Express, method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const server = web.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The /api/me two-step deletion. */
async function deleteThroughMe(web: express.Express): Promise<{ status: number; json: any }> {
  const requested = await call(web, 'POST', '/api/me/delete-request', {});
  expect(requested.status).toBe(200);
  return call(web, 'POST', '/api/me/delete-confirm', { token: requested.json.token });
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SESSION_SECRET = 'location-erasure-fixture-secret';
  process.env.CHROMADB_URL = 'http://127.0.0.1:9';
  process.env.JOBHUNTER_STORE_ROOT = mkdtempSync(path.join(tmpdir(), 'location-erasure-career-'));
  for (const key of ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'ARANGO_URL', 'ENABLE_PERSONAL_INTELLIGENCE']) delete process.env[key];
  await db.start();
  app = await convergeAppRole(db);
  unregister = registerLocationStateEraser('spec-evaluator', (principal) => { erased.push(principal); });
  for (const sub of ['loc-export', 'loc-privacy', 'loc-me', 'loc-no-issuer', 'loc-bystander']) await seedPerson(sub);
}, 180_000);
afterAll(async () => {
  unregister();
  const careerRoot = process.env.JOBHUNTER_STORE_ROOT;
  if (careerRoot?.includes('location-erasure-career-')) rmSync(careerRoot, { recursive: true, force: true });
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await db.stop();
});

describe('ADR-169 L2 location erase through both account-erasure routes', () => {
  it('exports the caller\'s location rows once, in the location store, and nobody else\'s', async () => {
    const res = await call(serverFor('loc-export', FIXTURE_ISSUER), 'GET', '/api/me/export');
    expect(res.status).toBe(200);
    const rows = res.json.stores.location as Array<{ table: string; owner_sub?: string }>;
    expect(rows.filter((r) => r.table === 'location_observations')).toHaveLength(2);
    expect(rows.every((r) => r.owner_sub === undefined || r.owner_sub === 'loc-export')).toBe(true);
    expect(Object.keys(res.json.stores).filter((s: string) => s.startsWith('location_'))).toEqual([]);
    expect(res.json.manifest.stores.find((s: { store: string }) => s.store === 'location')).toMatchObject({ ok: true, deletable: true });
  });

  it('DELETE /api/privacy/me removes observations and current, revokes the credential and clears evaluator state', async () => {
    const bystander = await footprint('loc-bystander');
    expect(await footprint('loc-privacy')).toEqual({ observations: 2, current: 1, devices: 1, liveCredentials: 1 });
    const res = await call(serverFor('loc-privacy', FIXTURE_ISSUER), 'DELETE', '/api/privacy/me', { confirm: PRIVACY_DELETE_CONFIRMATION });
    expect(res.status).toBe(200);
    expect(res.json.locationDeleted).toMatchObject({ erased: true, credentialsRevoked: 1, stateErasersFailed: [] });
    expect(await footprint('loc-privacy')).toEqual({ observations: 0, current: 0, devices: 0, liveCredentials: 0 });
    expect(await count("oshal_cli_tokens WHERE id = 'tok-loc-privacy' AND revoked_at IS NOT NULL")).toBe(1);
    expect(erased).toContainEqual({ sub: 'loc-privacy', principalIssuer: FIXTURE_ISSUER });
    expect(await footprint('loc-bystander')).toEqual(bystander);
  });

});

describe('ADR-169 L2 location erase through /api/me', () => {
  it('/api/me/delete-confirm removes observations and current, leaves no live credential and clears evaluator state', async () => {
    const bystander = await footprint('loc-bystander');
    const res = await deleteThroughMe(serverFor('loc-me', FIXTURE_ISSUER));
    expect(res.status).toBe(200);
    expect(res.json.outcomes[0]).toMatchObject({ store: 'location', action: 'deleted' });
    expect(res.json.outcomes[0].deleted).toBeGreaterThanOrEqual(6);
    expect(await footprint('loc-me')).toEqual({ observations: 0, current: 0, devices: 0, liveCredentials: 0 });
    expect(erased).toContainEqual({ sub: 'loc-me', principalIssuer: FIXTURE_ISSUER });
    expect(await footprint('loc-bystander')).toEqual(bystander);
  });

  it('erasing a restricted member through /api/me removes the restriction and the group\'s guardian shares', async () => {
    const admin = 'loc-guardian-admin';
    const { createTenant, addMember } = await import('@/app/routes/connector-tenancy');
    const group = (await asSession({ sub: admin }, () => createTenant(app, { name: 'Family', createdBySub: admin }))).tenant_id;
    for (const sub of ['loc-minor-erased', 'loc-kin']) await asSession({ sub: admin }, () => addMember(app, group, sub, admin));
    await db.pool.query('INSERT INTO location_member_restrictions (tenant_id, user_sub, issued_by_sub) VALUES ($1, $2, $3)', [group, 'loc-minor-erased', admin]);
    const place = (await asSession({ sub: admin }, () => app.query(`INSERT INTO location_places (tenant_id, name, center_lat, center_lon, radius_m, created_by_sub)
      VALUES ($1, 'School', -12.35, -31.99, 200, $2) RETURNING place_id`, [group, admin]))).rows[0].place_id;
    await asSession({ sub: admin }, async () => {
      const d = (await app.query('SELECT location_places_digest($1, $2::uuid[]) AS d', [group, [place]])).rows[0].d;
      await app.query(`INSERT INTO location_guardian_shares (tenant_id, user_sub, granted_by_sub, grantees, place_ids, geometry_digest)
        VALUES ($1, 'loc-minor-erased', $2, $3::jsonb, $4::uuid[], $5)`, [group, admin, JSON.stringify([{ sub: 'loc-kin', issuer: FIXTURE_ISSUER }]), [place], d]);
    });
    expect(await count('location_guardian_shares WHERE user_sub = $1', ['loc-minor-erased'])).toBe(1);
    const res = await deleteThroughMe(serverFor('loc-minor-erased', FIXTURE_ISSUER));
    expect(res.status).toBe(200);
    expect(await count('location_member_restrictions WHERE user_sub = $1', ['loc-minor-erased'])).toBe(0);
    expect(await count('location_guardian_shares WHERE tenant_id = $1', [group])).toBe(0);
    expect(await count('location_places WHERE tenant_id = $1', [group])).toBe(1);
  });

  it('erases no location row without a verified issuer, and says so on both routes', async () => {
    const before = await footprint('loc-no-issuer');
    const web = serverFor('loc-no-issuer', null);
    const privacy = await call(web, 'DELETE', '/api/privacy/me', { confirm: PRIVACY_DELETE_CONFIRMATION });
    expect(privacy.json.locationDeleted).toMatchObject({ erased: false, reason: 'no-verified-issuer' });
    const me = await deleteThroughMe(web);
    expect(me.json.outcomes[0]).toMatchObject({ store: 'location', action: 'failed' });
    const after = await footprint('loc-no-issuer');
    expect({ observations: after.observations, current: after.current, devices: after.devices })
      .toEqual({ observations: before.observations, current: before.current, devices: before.devices });
  });
});
