/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: a localhost server shaped like the real one for the location consent specs. The REAL MOCK_OIDC middleware set from createOidcMiddleware (with the header override on, so each browser context or request picks its synthetic person), the same request-identity stamp server.ts installs, the real /api/location mount exactly as server.ts writes it (service-rail refusal, requiresAuth, createLocationRoutes), the real cockpit tool pages and shared UI assets, and a same-origin page standing in for a packaged surface, over a private PostgreSQL whose tables are owned by the NOSUPERUSER NOBYPASSRLS runtime role (FORCE row-level security is what holds). Synthetic identities and coordinates only; nothing reaches a deployment database.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Pool } from 'pg';
import { vi } from 'vitest';
import { LocationStepUpStore } from '@/app/location-step-up';
import { createLocationRoutes } from '@/app/routes/location-routes';
import { refuseLocationServiceRail } from '@/app/routes/location-session';
import { getCaller, hasValidServiceSecret, isOperator } from '@/shared/middleware/authz';
import { createOidcMiddleware } from '@/shared/middleware/oidc';
import { MOCK_OIDC_PRINCIPAL_ISSUER, getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { DisposablePostgres } from './disposable-postgres';
import { asSession, convergeAppRole, locationDatabase } from './location-postgres-fixture';

/** The shared secret the fixture server knows, so its refusal can be proven. Never a real one. */
export const FIXTURE_SERVICE_SECRET = 'location-fixture-service-secret';

/** The issuer every MOCK_OIDC person signs in under. */
export const MOCK_ISSUER = MOCK_OIDC_PRINCIPAL_ISSUER;

/** The header MOCK_OIDC reads the synthetic person from when the override is on. */
export const MOCK_SUB_HEADER = 'x-mock-oidc-sub';

/** A same-origin page standing in for a packaged app surface: script on it runs as the person. */
export const PACKAGED_SURFACE_PATH = '/apps/fixture-package/surface.html';

/** A running fixture server. */
export interface LocationBrowserServer {
  base: string;
  db: DisposablePostgres;
  runtime: Pool;
  store: LocationStepUpStore;
  close: () => Promise<void>;
}

/**
 * @description Start the private database and the localhost server.
 * @param purpose - Names the database container.
 * @returns The running server.
 */
export async function startLocationBrowserServer(purpose: string): Promise<LocationBrowserServer> {
  vi.stubEnv('MOCK_OIDC', 'true');
  vi.stubEnv('MOCK_OIDC_ALLOW_HEADER', 'true');
  vi.stubEnv('SWARM_SERVICE_SECRET', FIXTURE_SERVICE_SECRET);
  vi.stubEnv('LOG_LEVEL', 'silent');
  const db = locationDatabase(purpose);
  await db.start();
  const runtime = await convergeAppRole(db);
  const store = new LocationStepUpStore();
  const { authMiddleware, requiresAuth } = createOidcMiddleware();
  const app = express();
  app.use(authMiddleware);
  app.use((req, _res, next) => {
    runWithRequestIdentity({ sub: getCaller(req).sub, principalIssuer: getAuthenticatedPrincipalIssuer(req),
      isOperator: isOperator(req) || hasValidServiceSecret(req) }, () => next());
  });
  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });
  app.use('/shared/ui/css', express.static(path.resolve('src/shared/ui/css')));
  app.use('/shared/ui/js', express.static(path.resolve('src/shared/ui/js')));
  app.use('/cockpit', requiresAuth, express.static(path.resolve('src/pages/cockpit')));
  app.get(PACKAGED_SURFACE_PATH, (_req, res) => {
    res.type('html').send('<!doctype html><title>Fixture package</title><p id="surface">A packaged surface.</p>');
  });
  app.use('/api/location', refuseLocationServiceRail, requiresAuth, createLocationRoutes({ pool: runtime, stepUpStore: store, ingestMinIntervalMs: 0 }));
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, db, runtime, store,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await db.stop();
      vi.unstubAllEnvs();
    },
  };
}

/**
 * @description Seed one of the person's own places, through row-level security as that person.
 * @param server - The fixture.
 * @param sub - The person.
 * @param place - Name, label, synthetic centre and radius.
 * @returns The place id.
 */
export async function seedOwnPlace(server: LocationBrowserServer, sub: string,
  place: { name: string; label: string; lat: number; lon: number; radiusM: number }): Promise<string> {
  const result = await asSession({ sub, issuer: MOCK_ISSUER }, () => server.runtime.query(
    `INSERT INTO location_places (owner_sub, principal_issuer, name, label, center_lat, center_lon, radius_m, created_by_sub)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $1) RETURNING place_id`,
    [sub, MOCK_ISSUER, place.name, place.label, place.lat, place.lon, place.radiusM]));
  return String(result.rows[0].place_id);
}

/**
 * @description Count rows as the superuser (the ground truth, past row-level security).
 * @param server - The fixture.
 * @param fromWhere - "table WHERE …".
 * @param params - Parameters.
 * @returns The count.
 */
export async function countRows(server: LocationBrowserServer, fromWhere: string, params: unknown[] = []): Promise<number> {
  return Number((await server.db.pool.query(`SELECT count(*)::int AS n FROM ${fromWhere}`, params)).rows[0].n);
}
