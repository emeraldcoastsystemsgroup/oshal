/**
 * Real-boundary guard for BACKLOG "Connector marketplace live brokered reads".
 *
 * THE BOUNDARY THAT FAILED: the connector READ tier left no audit row. A spec-route resource call
 * logged `{provider, resource, status, ok}` and nothing else — no caller, and no record of WHICH
 * credential went out, even though read-tier resolution may legitimately fall back to a shared
 * operator env key. So a successful read did not prove the owning user's credential was used, and
 * nothing named the caller at all.
 *
 * NOTHING ON THAT BOUNDARY IS DOUBLED HERE: a disposable postgres:16-alpine, the real migrations
 * (083 audit table, 112 FORCE-RLS owner policy, 151 read-tier columns), a NOSUPERUSER NOBYPASSRLS
 * runtime role behind the production GUC pool wrapper, the REAL connector-spec Express routes, the
 * REAL token broker (getValidAccessToken over real oshal_connections rows sealed with the real
 * per-user DEK envelope crypto) and the REAL caller-scoped trail reader.
 *
 * Doubled, OUTSIDE that boundary: the provider itself is a local node:http endpoint, because what
 * is under test is which credential went out and what was recorded — not GitHub's API. The five
 * LIVE credentialed reads the backlog entry also asks for are a deployment proof and are not
 * claimed here.
 *
 * SELF-VALIDATED: an INSERT that claims another user's sub is refused with SQLSTATE 42501, so the
 * fixture is enforcing row-level security rather than agreeing with itself.
 *
 * Docker is REQUIRED — a missing engine fails, never skips.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — proves a connector read writes one tier-'read' connector_action_audit row naming caller, connector, resource, credential source and redacted outcome; that two callers each get their OWN brokered token and their OWN row; that neither can see the other's row under RLS; and that a caller with no connection reading on the operator env key is recorded as 'operator-env' instead of passing for the owner's own read.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '../../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '../../../src/shared/services/database/request-identity';
import { mountConnectorSpecRoutes } from '../../../src/app/routes/connector-spec-routes';
import { readConnectorActionAudit } from '../../../src/app/routes/connector-action-audit';
import { ensureConnectionsSchema } from '../../../src/app/routes/connectors-routes';
import { upsertConnection } from '../../../src/app/routes/connector-tenancy';
import { encryptToken } from '../../../src/app/routes/connector-token-crypto';

/** The provider slug the fixture spec declares; it must be a registered broker provider. */
const PROVIDER = 'github';
const RESOURCE = 'viewer';
const RUNTIME_ROLE = 'connector_read_runtime';

const OWNER = 'read-audit-owner-sub';
const OTHER = 'read-audit-other-sub';
const UNCONNECTED = 'read-audit-unconnected-sub';

/** Per-user brokered tokens. Minted here so no literal secret is ever written down. */
const OWNER_TOKEN = `owner-${randomUUID()}`;
const OTHER_TOKEN = `other-${randomUUID()}`;
const OPERATOR_ENV_TOKEN = `operator-env-${randomUUID()}`;
const ENV_TOKEN_VAR = `CONNECTOR_${PROVIDER.toUpperCase()}_TOKEN`;

const fixture = new DisposablePostgres({
  purpose: 'connector-read-audit',
  migrations: [
    '083-connector-action-audit.sql',
    '112-owner-column-rls.sql',
    '151-connector-read-audit-columns.sql',
  ],
  roles: [RUNTIME_ROLE],
});

/** Every Authorization header the stub provider was called with, newest last. */
const providerCalls: Array<{ path: string; authorization: string | undefined }> = [];

let runtimePool: Pool;
let provider: Server;
let api: Server;
let baseUrl = '';
let specDir = '';

/** One audit row, read back straight out of the table. */
interface AuditRow {
  user_sub: string;
  connector_id: string;
  action: string;
  status: string;
  http_status: number | null;
  tier: string;
  credential_source: string | null;
  params_hash: string;
  error: string | null;
}

/** Reads the whole trail as a trusted operator would — RLS scoping is asserted separately. */
async function allAuditRows(): Promise<AuditRow[]> {
  return runWithSystemIdentity(async () => {
    const { rows } = await runtimePool.query(
      `SELECT user_sub, connector_id, action, status, http_status, tier, credential_source, params_hash, error
         FROM connector_action_audit ORDER BY ts ASC`,
    );
    return rows as AuditRow[];
  });
}

/** Calls the mounted connector read route as one caller. */
async function readAs(sub: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/connectors/${PROVIDER}/${RESOURCE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-sub': sub },
    body: JSON.stringify({}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Seeds one real brokered connection through the production upsert + envelope crypto. */
async function seedConnection(sub: string, token: string): Promise<void> {
  await runWithRequestIdentity({ sub, isOperator: false }, async () => {
    await upsertConnection(runtimePool, {
      userSub: sub,
      userEmail: '',
      provider: PROVIDER,
      accountEmail: null,
      accountId: sub,
      scopes: '',
      encAccess: await encryptToken(runtimePool, sub, token),
      encRefresh: null,
      expiry: new Date(Date.now() + 3_600_000),
      connectedBySub: sub,
      label: 'fixture',
    });
  });
}

function writeSpec(providerBaseUrl: string): void {
  specDir = mkdtempSync(join(tmpdir(), 'oshal-read-audit-spec-'));
  writeFileSync(join(specDir, `${PROVIDER}.yaml`), [
    `provider: ${PROVIDER}`,
    'displayName: Read audit fixture',
    'version: 1.0.0',
    `baseUrl: ${providerBaseUrl}`,
    'auth: { type: oauth2 }',
    'rateLimit: { burst: 5, perSecond: 20 }',
    'retry: { maxRetries: 0 }',
    'resources:',
    `  - name: ${RESOURCE}`,
    '    method: GET',
    `    path: /${RESOURCE}`,
    '',
  ].join('\n'));
}

/** The stub provider: answers 200 for a known token, 401 otherwise, and records what it saw. */
function startProvider(): Promise<void> {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    providerCalls.push({ path: String(req.url), authorization: req.headers.authorization });
    const known = [OWNER_TOKEN, OTHER_TOKEN, OPERATOR_ENV_TOKEN]
      .some((token) => req.headers.authorization === `Bearer ${token}`);
    res.writeHead(known ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(known ? { login: 'fixture-viewer' } : { message: 'Bad credentials' }));
  });
  return new Promise((done) => provider.listen(0, '127.0.0.1', () => done()));
}

/** The API under test: the production identity middleware shape plus the real connector routes. */
function startApi(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sub = req.header('x-fixture-sub') || undefined;
    (req as Request & { userSub?: string }).userSub = sub;
    runWithRequestIdentity({ sub: sub ?? null, isOperator: false }, () => next());
  });
  mountConnectorSpecRoutes(app, { pool: runtimePool }, (_req: Request, _res: Response, next: NextFunction) => next(), {
    specDirs: [specDir],
  });
  api = createServer(app);
  return new Promise((done) => api.listen(0, '127.0.0.1', () => done()));
}

beforeAll(async () => {
  // Envelope crypto derives the master KEK from this; minted here so nothing literal is stored.
  process.env.SESSION_SECRET = randomUUID();
  const owner = await fixture.start();
  await owner.query(`GRANT SELECT, INSERT ON connector_action_audit TO ${RUNTIME_ROLE}`);
  runtimePool = wrapPoolWithGuc(fixture.rolePool(RUNTIME_ROLE));
  await ensureConnectionsSchema(runtimePool);
  await seedConnection(OWNER, OWNER_TOKEN);
  await seedConnection(OTHER, OTHER_TOKEN);
  await startProvider();
  writeSpec(`http://127.0.0.1:${(provider.address() as AddressInfo).port}`);
  await startApi();
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  delete process.env[ENV_TOKEN_VAR];
  await new Promise((done) => (api ? api.close(() => done(null)) : done(null)));
  await new Promise((done) => (provider ? provider.close(() => done(null)) : done(null)));
  await fixture.stop();
  if (specDir) rmSync(specDir, { recursive: true, force: true });
});

describe('connector read tier audit trail', () => {
  it('records the caller, connector, action, outcome and credential source of one brokered read', async () => {
    const result = await readAs(OWNER);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(providerCalls.at(-1)).toEqual({ path: `/${RESOURCE}`, authorization: `Bearer ${OWNER_TOKEN}` });

    const rows = (await allAuditRows()).filter((row) => row.user_sub === OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_sub: OWNER,
      connector_id: PROVIDER,
      action: RESOURCE,
      status: 'success',
      http_status: 200,
      tier: 'read',
      credential_source: 'broker',
    });
    // The outcome is redacted by construction: a params hash, never the params or the response.
    expect(rows[0].params_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(OWNER_TOKEN);
  }, 60_000);

  it('gives a second caller their OWN token and their OWN row, never the first caller\'s', async () => {
    const before = (await allAuditRows()).length;

    const result = await readAs(OTHER);

    expect(result.status).toBe(200);
    expect(providerCalls.at(-1)?.authorization).toBe(`Bearer ${OTHER_TOKEN}`);
    // The owner's token has gone out exactly once, on the owner's own read — never substituted in.
    expect(providerCalls.filter((call) => call.authorization === `Bearer ${OWNER_TOKEN}`)).toHaveLength(1);
    const rows = await allAuditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.filter((row) => row.user_sub === OTHER)).toEqual([
      expect.objectContaining({ connector_id: PROVIDER, action: RESOURCE, status: 'success', tier: 'read', credential_source: 'broker' }),
    ]);
    // Exactly one row per caller: the second read did not append to the first caller's trail.
    expect(rows.filter((row) => row.user_sub === OWNER)).toHaveLength(1);
  }, 60_000);

  it('scopes each caller to their own trail under row-level security, and refuses a forged row', async () => {
    const ownerTrail = await runWithRequestIdentity({ sub: OWNER, isOperator: false }, () =>
      readConnectorActionAudit(runtimePool, OWNER, { tier: 'read' }));
    expect(ownerTrail.entries).toHaveLength(1);
    expect(ownerTrail.entries[0]).toMatchObject({
      connectorId: PROVIDER, action: RESOURCE, status: 'success', tier: 'read', credentialSource: 'broker',
    });

    // The other caller, asking the same reader for the owner's sub, gets nothing: the predicate is
    // the caller's own sub AND the policy is enforced against a NOBYPASSRLS role.
    const crossUser = await runWithRequestIdentity({ sub: OTHER, isOperator: false }, () =>
      runtimePool.query('SELECT user_sub FROM connector_action_audit WHERE user_sub = $1', [OWNER]));
    expect(crossUser.rows).toHaveLength(0);

    // Self-validation: if this INSERT succeeded, every assertion above would be vacuous.
    await expect(runWithRequestIdentity({ sub: OTHER, isOperator: false }, () => runtimePool.query(
      `INSERT INTO connector_action_audit (user_sub, connector_id, action, params_hash, status, tier, credential_source)
       VALUES ($1, $2, $3, 'forged', 'success', 'read', 'broker')`,
      [OWNER, PROVIDER, RESOURCE],
    ))).rejects.toMatchObject({ code: '42501' });
  }, 60_000);

  it('names the operator env key when a caller with no connection reads on the shared credential', async () => {
    process.env[ENV_TOKEN_VAR] = OPERATOR_ENV_TOKEN;
    try {
      const result = await readAs(UNCONNECTED);

      expect(result.status).toBe(200);
      expect(providerCalls.at(-1)?.authorization).toBe(`Bearer ${OPERATOR_ENV_TOKEN}`);
      const rows = (await allAuditRows()).filter((row) => row.user_sub === UNCONNECTED);
      expect(rows).toHaveLength(1);
      // The whole point: this read SUCCEEDED, and the trail still says it was not their credential.
      expect(rows[0]).toMatchObject({ status: 'success', tier: 'read', credential_source: 'operator-env' });
    } finally {
      delete process.env[ENV_TOKEN_VAR];
    }
  }, 60_000);

  it('still records a read the provider refused', async () => {
    const result = await readAs(UNCONNECTED);

    expect(result.status).toBe(401);
    const rows = (await allAuditRows()).filter((row) => row.user_sub === UNCONNECTED);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.credential_source === 'absent')).toEqual([
      expect.objectContaining({ status: 'error', http_status: 401, tier: 'read' }),
    ]);
  }, 60_000);
});
