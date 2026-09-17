/**
 * Guard: the credential `POST /api/join/enroll` hands out is a DEVICE credential, and both
 * halves of it travel together.
 *
 * WHAT FAILED. A node token authenticates only a node that registers under the clientId the
 * token names (`oshal_cli_tokens.node_client_id`). The device id does not exist until something
 * mints it, so the enrol route's opt-in `clientId` could not be supplied on the first enrolment
 * of a new machine — the only case that matters — and every such enrolment took the unbound
 * branch instead: an ACCOUNT-wide PAT, clamped to an hour, left sitting on an edge machine. A
 * node configured from it registers (an unbound PAT authenticates everywhere), then dies when
 * the hour is up. A caller who did supply a clientId fared no better, because the install
 * commands the same response printed carried the token and not the id, so the node kept the
 * `oshal-chat-<uuid>` it had invented for itself and register answered 403
 * `node_token_client_mismatch`.
 *
 * THE BOUNDARY THIS CROSSES. Nothing here is asserted about the route in isolation. The REAL
 * join router mints through the REAL `insertCliToken` into the statement-matching token store,
 * the REAL `createCliTokenAuthMiddleware` reads that row back off the wire, and the REAL
 * remote-client router applies the register-body binding — so "the token this route mints can
 * register the device this route named" is proven by registering it, over HTTP, under the
 * fail-closed `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true` posture with no shared secret configured
 * anywhere. The doubled boundary is Postgres itself (rows, not RLS or types); the enforcing
 * SQL, middleware and route are all the production ones.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - device-bound-by-default enrolment: the minted id, the non-expiring credential, both halves in every printed instruction, the register round trip on the pair, the 403 a node that keeps its own id still earns, and the reach a bound token does NOT have that the unbound one did.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteTaskJournalService } from '../../src/features/remote-client';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';
import { FakeCliTokenPool } from '../helpers/fake-cli-token-pool';
import { createCliTokenAuthMiddleware } from '../../src/app/routes/cli-token-routes';

const ENV_KEYS = [
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'REMOTE_CLIENT_REQUIRE_NODE_TOKEN',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS',
];
const saved: Record<string, string | undefined> = {};

/** The person enrolling their own computer. Not an operator: enrolment is not an admin act. */
const USER = 'auth0|node-owner';

/** What the node app invents for itself when nothing seeds `OSHAL_CLIENT_ID` (config.ts). */
const SELF_MINTED_ID = 'oshal-chat-6f1c0f0e-0b3a-4d9f-9a7e-2f6c1d8a55b1';

const servers: Array<{ close: (cb: () => void) => void }> = [];

/** What the enrol route answers, in the fields this guard reads. */
interface EnrollResponse {
  enrollment: {
    token: string;
    expiresAt: string | null;
    ttlMinutes: number | null;
    nodeClientId: string | null;
    clientIdMinted?: boolean;
  };
  install: {
    existingNode: string;
    newInstall: string;
    workerPlaneToken: string | null;
    oneClick?: string;
    note: string;
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  // The posture this whole path exists for: the swarm-wide secret is retired, so a per-device
  // token is the ONLY way onto the worker plane. Nothing below configures a secret.
  process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = 'true';
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
});

/**
 * @description Stands in for the browser session `requiresAuth` would have proven, and only
 * when the CLI-token middleware ahead of it has not already authenticated the caller — so a
 * bearer token is never quietly upgraded into a session by the harness.
 * @returns The Express middleware.
 */
function browserSession(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const sub = req.header('x-test-sub');
    const existing = (req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (sub && !existing?.isAuthenticated?.()) {
      (req as Request & { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub, email: `${sub}@example.test` },
      };
    }
    next();
  };
}

/**
 * @description Boots the REAL join router, the REAL CLI-token auth middleware and the REAL
 * remote-client router over one token store, in the order server.ts mounts them.
 * @param pool - The token-store fixture both halves share.
 * @returns The base origin of the listening app.
 */
async function bootApp(pool: FakeCliTokenPool): Promise<string> {
  const { createJoinRoutes } = await import('../../src/app/routes/join-routes');
  const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
  const app = express();
  app.use(express.json());
  app.use(createCliTokenAuthMiddleware(pool.asPool()));
  app.use(browserSession());
  app.use('/api/join', createJoinRoutes(__dirname, pool.asPool()));
  app.use('/api/remote-clients', createRemoteClientRoutes({
    pool: pool.asPool(),
    taskJournalService: new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture()),
  }));
  // An ordinary account surface, standing in for everything behind requiresAuth that an
  // edge machine's credential must not reach.
  app.get('/api/content', (req: Request, res: Response) => {
    const oidc = (req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (!oidc?.isAuthenticated?.()) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.json({ ok: true });
  });
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

/** Enrols a computer the way the "Add a computer" surface does: a name, nothing else. */
async function enrol(base: string, body: Record<string, unknown> = {}): Promise<EnrollResponse> {
  const res = await fetch(`${base}/api/join/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-sub': USER },
    body: JSON.stringify(body),
  });
  expect(res.status, 'enrol should succeed for a signed-in user').toBe(201);
  return (await res.json()) as EnrollResponse;
}

/** The registration payload a node sends on first contact. */
function registrationBody(clientId: string): Record<string, unknown> {
  return {
    clientId,
    name: 'Garage PC',
    transport: 'http',
    platform: 'windows',
    controlPlaneUrl: 'http://swarm.lan:35457',
    capabilities: ['mcp.call-tool'],
    tags: ['spec'],
  };
}

/** Registers as `clientId` presenting `token` as the node's bearer — nothing else. */
function register(base: string, token: string, clientId: string): Promise<Response> {
  return fetch(`${base}/api/remote-clients/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(registrationBody(clientId)),
  });
}

describe('POST /api/join/enroll — the enrolment is device-bound by default', () => {
  it('mints the device id itself and returns it beside the token', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });

    expect(body.enrollment.nodeClientId, 'a node credential names the device it is for').toBeTruthy();
    expect(body.enrollment.clientIdMinted, 'the swarm minted it; the caller had none').toBe(true);
    // The binding is in the STORE, not only in the response: this is what the auth middleware reads.
    const row = pool.rows.find((r) => r.node_client_id === body.enrollment.nodeClientId);
    expect(row, 'the minted row carries the binding').toBeDefined();
    expect(row?.user_sub).toBe(USER);
    // Generous: this is the first case to pay the routers' import cost in this file.
  }, 30_000);

  it('does not expire — a computer that is off for a week still comes back', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });

    expect(body.enrollment.expiresAt, 'a steady-state credential has no expiry').toBeNull();
    expect(body.enrollment.ttlMinutes).toBeNull();
    expect(pool.rows[0].expires_at, 'and the row agrees with the response').toBeNull();
  });

  it('puts BOTH halves in every instruction it prints', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });
    const id = String(body.enrollment.nodeClientId);

    // install-node.ps1 seeds OSHAL_CLIENT_ID from -ClientId; without it the node keeps its own id.
    expect(body.install.newInstall).toContain(`-ClientId "${id}"`);
    expect(body.install.newInstall).toContain(body.enrollment.token);
    // The already-installed path reads the same two variables out of the environment.
    expect(body.install.existingNode).toContain(`OSHAL_CLIENT_ID=${id}`);
    expect(body.install.existingNode).toContain(`OSHAL_ENROLLMENT_TOKEN=${body.enrollment.token}`);
    // The token IS the worker-plane credential now, so that line is never absent.
    expect(body.install.workerPlaneToken).toContain(body.enrollment.token);
    expect(body.install.note).toContain(id);
  });

  it('honours a device id the caller already has, and says it did not mint one', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { clientId: 'garage-pc', computerName: 'garage pc' });

    expect(body.enrollment.nodeClientId).toBe('garage-pc');
    expect(body.enrollment.clientIdMinted).toBe(false);
    expect(body.install.newInstall).toContain('-ClientId "garage-pc"');
  });

  it('refuses a device id that would not survive being written into the commands it prints', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const res = await fetch(`${base}/api/join/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': USER },
      body: JSON.stringify({ clientId: 'garage-pc" && curl evil.example' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_client_id');
    expect(pool.rows, 'a refused enrolment leaves no live credential behind').toHaveLength(0);
  });

  it('still issues the short handoff when a caller explicitly asks for one — bound all the same', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { ttlMinutes: 30 });

    expect(body.enrollment.ttlMinutes).toBe(30);
    expect(body.enrollment.expiresAt).not.toBeNull();
    expect(body.enrollment.nodeClientId, 'a TTL is not a reason to hand out account reach').toBeTruthy();
  });
});

describe('the enrolled pair, over the real worker plane', () => {
  it('registers the device the enrolment named, with no shared secret anywhere', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });
    // There is nothing to register AS unless the enrolment named a device - which is the
    // whole point, so it is asserted here rather than papered over by String(null).
    expect(body.enrollment.nodeClientId, 'the enrolment must name the device').toBeTruthy();
    const clientId = String(body.enrollment.nodeClientId);
    const res = await register(base, body.enrollment.token, clientId);

    expect(res.status, 'the pair this route hands out must be able to register').toBe(201);
    // The registered device is the one the enrolment named, not whatever the body happened to say.
    const registered = (await res.json()) as { client: { clientId: string; ownerSub: string | null } };
    expect(registered.client.clientId).toBe(clientId);
    expect(registered.client.ownerSub, 'and it belongs to the person who enrolled it').toBe(USER);
    expect(process.env.REMOTE_CLIENT_SHARED_SECRET, 'proven with the secret retired').toBeUndefined();
  }, 30_000);

  it('REFUSES the same token from a node that kept the id it invented for itself', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });
    const res = await register(base, body.enrollment.token, SELF_MINTED_ID);

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('node_token_client_mismatch');
  });

  it('carries no account reach: the credential left on the machine cannot read the owner\'s data', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);

    const body = await enrol(base, { computerName: 'garage pc' });
    const res = await fetch(`${base}/api/content`, {
      headers: { authorization: `Bearer ${body.enrollment.token}` },
    });

    expect(res.status, 'an unbound PAT would be 200 here — that is the reach being removed').toBe(401);
  });
});

describe('who can mint one', () => {
  it('a headless caller holding an account PAT mints a BOUND node credential', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);
    const accountPat = pool.seed({ sub: USER });

    const res = await fetch(`${base}/api/join/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accountPat}` },
      body: JSON.stringify({ computerName: 'headless box' }),
    });

    expect(res.status, 'no browser is required to enrol a machine').toBe(201);
    const body = (await res.json()) as EnrollResponse;
    expect(body.enrollment.nodeClientId, 'and what it gets is narrower than what it held').toBeTruthy();
    expect(body.enrollment.expiresAt).toBeNull();
  });

  it('a node cannot enrol a second device with its own credential', async () => {
    const pool = new FakeCliTokenPool();
    const base = await bootApp(pool);
    const nodeToken = pool.seed({ sub: USER, nodeClientId: 'garage-pc' });

    const res = await fetch(`${base}/api/join/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({ computerName: 'a device of my own' }),
    });

    expect(res.status, 'minting is off-plane for a device credential').toBe(401);
    expect(pool.rows).toHaveLength(1);
  });
});
