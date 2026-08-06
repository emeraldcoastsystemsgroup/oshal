/**
 * Guard: per-node worker-plane tokens, and the retirement of the swarm-wide shared
 * secret (docs/backlog/hardening.md #7).
 *
 * Goes red if any of these regress:
 *  - a NODE-BOUND credential stops being confined to its own device: it must be
 *    refused on a sibling device's plane and on every non-plane route, so a token
 *    lifted off an edge machine is not an ACCOUNT credential (this is the property
 *    the swarm-wide secret structurally could not have);
 *  - POST /register stops checking the BODY clientId against the binding — the one
 *    worker-plane route where the device identity does not travel in the URL;
 *  - rotation breaks: a rotate must revoke EVERY live generation for the device and
 *    mint exactly one successor, in one call;
 *  - the deprecated shared secret stops being refused under
 *    REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true, or loses its deprecation stamp while
 *    still accepted, or becomes able to mint per-node credentials for itself.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the per-node token work: the pure scope matrix, the REAL createCliTokenAuthMiddleware confining a bound token over HTTP, the REAL remote-client router enforcing the register-body binding, rotation over a fake pool, and both halves of the shared-secret retirement switch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extend the token-store model and rotation proof to preserve an owner's verified issuer namespace in successor node credentials.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Inject the explicit test-only task journal so token-store pool fixtures do not masquerade as the production journal database.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact device-owner subjects through owner-scoped revocation, successor minting, and the HTTP rotation surface; case/whitespace variants remain separate principals.
 */

import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideNodeTokenScope,
  nodeTokenBindingMatches,
  RemoteTaskJournalService,
  sharedSecretRetired,
} from '../../src/features/remote-client';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';
import {
  CLI_TOKEN_PREFIX,
  createCliTokenAuthMiddleware,
  hashCliToken,
  insertCliToken,
  rotateNodeToken,
} from '../../src/app/routes/cli-token-routes';

const ENV_KEYS = [
  'REMOTE_CLIENT_SHARED_SECRET',
  'REMOTE_CLIENT_CONTROL_PLANE_TOKEN',
  'REMOTE_CLIENT_AUTH_HEADER',
  'REMOTE_CLIENT_REQUIRE_NODE_TOKEN',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
  'OSHAL_ALLOW_LEGACY_UNOWNED',
  'OSHAL_RATE_LIMIT_REMOTE_CLIENTS',
];
const saved: Record<string, string | undefined> = {};

const SECRET = 'node-token-spec-shared-secret';
const OWNER = 'auth0|node-owner';
const MINE = 'my-laptop';
const SIBLING = 'my-desktop';

const servers: Array<{ close: (cb: () => void) => void }> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
});

// ── An in-memory stand-in for oshal_cli_tokens, driven by the REAL SQL ─────────────

interface TokenRow {
  id: string;
  user_sub: string;
  email: string | null;
  label: string;
  token_hash: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  node_client_id: string | null;
  principal_issuer: string | null;
}

/**
 * @description Minimal Pool stand-in that answers the three statements the token store
 * issues (auth lookup, last_used_at touch, rotation revoke + insert) off an array of rows,
 * so the REAL middleware and the REAL rotateNodeToken run unmodified.
 */
class FakeTokenPool {
  rows: TokenRow[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT id, user_sub, email, node_client_id, principal_issuer FROM oshal_cli_tokens')) {
      const hash = params[0] as string;
      const now = Date.now();
      const hit = this.rows.find((r) => (
        r.token_hash === hash && r.revoked_at === null && (r.expires_at === null || r.expires_at.getTime() > now)
      ));
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
    }
    if (text.startsWith('UPDATE oshal_cli_tokens SET last_used_at')) {
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE oshal_cli_tokens SET revoked_at = NOW() WHERE node_client_id')) {
      const [clientId, ownerSub] = params as [string, string];
      const hits = this.rows.filter((r) => r.node_client_id === clientId && r.user_sub === ownerSub && r.revoked_at === null);
      for (const row of hits) row.revoked_at = new Date();
      return { rows: [], rowCount: hits.length };
    }
    if (text.startsWith('INSERT INTO oshal_cli_tokens')) {
      const [id, userSub, email, label, tokenHash, expiresAt, nodeClientId, principalIssuer] = params as [
        string, string, string | null, string, string, Date | null, string | null, string | null,
      ];
      this.rows.push({
        id, user_sub: userSub, email, label, token_hash: tokenHash,
        expires_at: expiresAt, revoked_at: null, node_client_id: nodeClientId,
        principal_issuer: principalIssuer,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeTokenPool: unexpected SQL: ${text.slice(0, 90)}`);
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }

  /** Seeds a token row directly and returns its plaintext (bypassing the mint route). */
  seed(opts: {
    sub: string;
    nodeClientId?: string | null;
    revoked?: boolean;
    principalIssuer?: string | null;
  }): string {
    const token = `${CLI_TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    this.rows.push({
      id: crypto.randomUUID(),
      user_sub: opts.sub,
      email: null,
      label: 'spec token',
      token_hash: hashCliToken(token),
      expires_at: null,
      revoked_at: opts.revoked ? new Date() : null,
      node_client_id: opts.nodeClientId ?? null,
      principal_issuer: opts.principalIssuer ?? null,
    });
    return token;
  }
}

// ── Pure scope decisions ──────────────────────────────────────────────────────────

describe('decideNodeTokenScope', () => {
  it('admits the bound device own plane, at the root and beneath it', () => {
    expect(decideNodeTokenScope({ boundClientId: MINE, path: `/api/remote-clients/${MINE}` }))
      .toEqual({ allowed: true, reason: 'own-device-plane' });
    expect(decideNodeTokenScope({ boundClientId: MINE, path: `/api/remote-clients/${MINE}/tasks/next` }))
      .toEqual({ allowed: true, reason: 'own-device-plane' });
    // Trailing slash and a percent-encoded id are the same device.
    expect(decideNodeTokenScope({ boundClientId: MINE, path: `/api/remote-clients/${MINE}/` }).allowed).toBe(true);
    expect(decideNodeTokenScope({ boundClientId: 'gabe-pc', path: '/api/remote-clients/gabe%2Dpc/heartbeat' }).allowed).toBe(true);
  });

  it('REFUSES a sibling device — the property the swarm-wide secret never had', () => {
    expect(decideNodeTokenScope({ boundClientId: MINE, path: `/api/remote-clients/${SIBLING}/tasks` }))
      .toEqual({ allowed: false, reason: 'foreign-device' });
    // Prefix confusion: a longer id that merely STARTS with the bound one is a different device.
    expect(decideNodeTokenScope({ boundClientId: MINE, path: `/api/remote-clients/${MINE}-evil/tasks` }))
      .toEqual({ allowed: false, reason: 'foreign-device' });
  });

  it('REFUSES every non-plane route — a device credential is not an account credential', () => {
    for (const path of ['/api/content', '/api/cli-tokens', '/api/linkedin-assistant/posts', '/api/tickets', '/']) {
      expect(decideNodeTokenScope({ boundClientId: MINE, path }).allowed, path).toBe(false);
    }
    // Including the token-management surface itself: no self-escalation to an unbound PAT.
    expect(decideNodeTokenScope({ boundClientId: MINE, path: '/api/cli-tokens' }).reason).toBe('off-plane');
  });

  it('admits exactly the two enrollment-handshake paths', () => {
    expect(decideNodeTokenScope({ boundClientId: MINE, path: '/api/cli-tokens/whoami' }))
      .toEqual({ allowed: true, reason: 'handshake' });
    expect(decideNodeTokenScope({ boundClientId: MINE, path: '/api/remote-clients/register' }))
      .toEqual({ allowed: true, reason: 'handshake' });
  });

  it('fails closed on a blank binding (never treat a non-node token as one)', () => {
    expect(decideNodeTokenScope({ boundClientId: '', path: `/api/remote-clients/${MINE}` }).allowed).toBe(false);
    expect(decideNodeTokenScope({ boundClientId: '  ', path: '/api/cli-tokens/whoami' }).allowed).toBe(false);
  });
});

describe('nodeTokenBindingMatches / sharedSecretRetired', () => {
  it('matches only the same device, and never on a blank either side', () => {
    expect(nodeTokenBindingMatches(MINE, MINE)).toBe(true);
    expect(nodeTokenBindingMatches(MINE, ` ${MINE} `)).toBe(true);
    expect(nodeTokenBindingMatches(MINE, SIBLING)).toBe(false);
    expect(nodeTokenBindingMatches(MINE, undefined)).toBe(false);
    expect(nodeTokenBindingMatches(null, MINE)).toBe(false);
  });

  it('defaults to NOT retired (field nodes keep working) and flips on an explicit true', () => {
    expect(sharedSecretRetired({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sharedSecretRetired({ REMOTE_CLIENT_REQUIRE_NODE_TOKEN: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    for (const value of ['true', '1', 'on', 'yes', 'TRUE']) {
      expect(sharedSecretRetired({ REMOTE_CLIENT_REQUIRE_NODE_TOKEN: value } as NodeJS.ProcessEnv), value).toBe(true);
    }
  });
});

// ── The REAL auth middleware confines a bound token ───────────────────────────────

describe('createCliTokenAuthMiddleware — node-bound confinement over HTTP', () => {
  async function bootTokenApp(pool: FakeTokenPool): Promise<string> {
    const app = express();
    app.use(createCliTokenAuthMiddleware(pool.asPool()));
    // Stands in for requiresAuth: authenticated -> 200, otherwise the normal 401.
    const probe = (req: Request, res: Response): void => {
      const oidc = (req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (!oidc?.isAuthenticated?.()) { res.status(401).json({ error: 'Unauthorized' }); return; }
      res.json({
        sub: (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub,
        node: (req as Request & { oshalNodeToken?: { clientId: string } }).oshalNodeToken?.clientId ?? null,
      });
    };
    app.get('/api/remote-clients/:clientId/tasks/next', probe);
    app.post('/api/remote-clients/register', probe);
    app.get('/api/cli-tokens/whoami', probe);
    app.get('/api/content', probe);
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  it('a bound token authenticates on its OWN plane and the handshake, and NOWHERE else', async () => {
    const pool = new FakeTokenPool();
    const token = pool.seed({ sub: OWNER, nodeClientId: MINE });
    const base = await bootTokenApp(pool);
    const auth = { authorization: `Bearer ${token}` };

    const own = await fetch(`${base}/api/remote-clients/${MINE}/tasks/next`, { headers: auth });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ sub: OWNER, node: MINE });

    expect((await fetch(`${base}/api/cli-tokens/whoami`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/remote-clients/register`, { method: 'POST', headers: auth })).status).toBe(200);

    // A sibling device the SAME owner owns: still refused. Ownership is not the boundary here.
    const sibling = await fetch(`${base}/api/remote-clients/${SIBLING}/tasks/next`, { headers: auth });
    expect(sibling.status, 'a device credential must not reach a sibling device').toBe(401);

    // The account surfaces the PAT takeover (#83) was about: unreachable from an edge machine.
    expect((await fetch(`${base}/api/content`, { headers: auth })).status).toBe(401);
  }, 20_000);

  it('an UNBOUND PAT is unchanged — it still authenticates everywhere (no regression)', async () => {
    const pool = new FakeTokenPool();
    const token = pool.seed({ sub: OWNER });
    const base = await bootTokenApp(pool);
    const auth = { authorization: `Bearer ${token}` };

    for (const path of [`/api/remote-clients/${MINE}/tasks/next`, '/api/cli-tokens/whoami', '/api/content']) {
      const res = await fetch(`${base}${path}`, { headers: auth });
      expect(res.status, path).toBe(200);
      expect((await res.json()).node, 'an unbound PAT carries no device binding').toBeNull();
    }
  });

  it('a revoked bound token authenticates nowhere', async () => {
    const pool = new FakeTokenPool();
    const token = pool.seed({ sub: OWNER, nodeClientId: MINE, revoked: true });
    const base = await bootTokenApp(pool);
    const res = await fetch(`${base}/api/remote-clients/${MINE}/tasks/next`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });
});

// ── Rotation ──────────────────────────────────────────────────────────────────────

describe('rotateNodeToken', () => {
  it('revokes EVERY live generation for the device and mints exactly one successor', async () => {
    const pool = new FakeTokenPool();
    pool.seed({ sub: OWNER, nodeClientId: MINE });
    pool.seed({ sub: OWNER, nodeClientId: MINE });
    const otherDevice = pool.seed({ sub: OWNER, nodeClientId: SIBLING });
    const accountPat = pool.seed({ sub: OWNER });

    const principalIssuer = 'https://issuer.example.test/realms/devices';
    const rotated = await rotateNodeToken(pool.asPool(), {
      clientId: MINE,
      ownerSub: OWNER,
      principalIssuer,
    });

    expect(rotated.revokedCount).toBe(2);
    expect(rotated.nodeClientId).toBe(MINE);
    expect(rotated.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
    const live = pool.rows.filter((r) => r.revoked_at === null);
    // The successor + the sibling device's token + the account PAT survive; nothing else.
    expect(live).toHaveLength(3);
    expect(live.map((r) => r.token_hash)).toContain(hashCliToken(rotated.token));
    expect(live.map((r) => r.token_hash)).toContain(hashCliToken(otherDevice));
    expect(live.map((r) => r.token_hash)).toContain(hashCliToken(accountPat));
    expect(pool.rows.find((r) => r.id === rotated.id)?.principal_issuer).toBe(principalIssuer);
  });

  it('never crosses owners: another user tokens for the same clientId are untouched', async () => {
    const pool = new FakeTokenPool();
    pool.seed({ sub: OWNER, nodeClientId: MINE });
    const foreign = pool.seed({ sub: 'auth0|someone-else', nodeClientId: MINE });

    const rotated = await rotateNodeToken(pool.asPool(), { clientId: MINE, ownerSub: OWNER });

    expect(rotated.revokedCount).toBe(1);
    const foreignRow = pool.rows.find((r) => r.token_hash === hashCliToken(foreign));
    expect(foreignRow?.revoked_at).toBeNull();
  });

  it('refuses to run without both a clientId and an owner (no accidentally-unbound mint)', async () => {
    const pool = new FakeTokenPool();
    await expect(rotateNodeToken(pool.asPool(), { clientId: '', ownerSub: OWNER })).rejects.toThrow(/clientId/);
    await expect(rotateNodeToken(pool.asPool(), { clientId: MINE, ownerSub: '  ' })).rejects.toThrow(/ownerSub/);
    expect(pool.rows).toHaveLength(0);
  });

  it('insertCliToken stores the binding (and null for an ordinary PAT)', async () => {
    const pool = new FakeTokenPool();
    const bound = await insertCliToken(pool.asPool(), { sub: OWNER, nodeClientId: MINE });
    const unbound = await insertCliToken(pool.asPool(), { sub: OWNER });
    expect(bound.nodeClientId).toBe(MINE);
    expect(unbound.nodeClientId).toBeNull();
    expect(pool.rows.find((r) => r.id === bound.id)?.node_client_id).toBe(MINE);
    expect(pool.rows.find((r) => r.id === unbound.id)?.node_client_id).toBeNull();
  });
});

describe('rotateNodeToken exact owner identity', () => {
  it('revokes and mints only for the byte-exact subject', async () => {
    const pool = new FakeTokenPool();
    const exactOwner = ' Auth0|Case-Owner ';
    pool.seed({ sub: exactOwner, nodeClientId: MINE });
    const normalizedAlias = pool.seed({ sub: 'Auth0|Case-Owner', nodeClientId: MINE });

    const rotated = await rotateNodeToken(pool.asPool(), { clientId: MINE, ownerSub: exactOwner });

    expect(rotated.revokedCount).toBe(1);
    expect(pool.rows.find((row) => row.id === rotated.id)?.user_sub).toBe(exactOwner);
    expect(pool.rows.find((row) => row.token_hash === hashCliToken(normalizedAlias))?.revoked_at).toBeNull();
  });
});

// ── The router: retirement switch + register-body binding + rotate route ──────────

describe('remote-client router — shared-secret retirement and the rotate surface', () => {
  /** Mirrors the req.oidc + binding shape createCliTokenAuthMiddleware stamps. */
  function stampedIdentity(): (req: Request, _res: Response, next: NextFunction) => void {
    return (req, _res, next) => {
      const sub = req.header('x-test-sub');
      const boundClientId = req.header('x-test-node');
      if (sub) {
        (req as Request & { oidc?: unknown }).oidc = {
          isAuthenticated: () => true,
          user: { sub, email: `${sub}@example.test` },
        };
      }
      if (boundClientId) {
        (req as Request & { oshalNodeToken?: unknown }).oshalNodeToken = { clientId: boundClientId, tokenId: 'spec-token' };
      }
      next();
    };
  }

  async function bootRouter(pool?: FakeTokenPool): Promise<string> {
    const { createRemoteClientRoutes } = await import('../../src/app/routes/remote-client-routes');
    const app = express();
    app.use(express.json());
    app.use(stampedIdentity());
    const taskJournalService = new RemoteTaskJournalService(new InMemoryRemoteTaskJournalFixture());
    app.use('/api/remote-clients', createRemoteClientRoutes({
      pool: pool?.asPool(),
      taskJournalService,
    }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return `http://127.0.0.1:${address.port}/api/remote-clients`;
  }

  function registrationBody(clientId: string): Record<string, unknown> {
    return {
      clientId,
      name: `Device ${clientId}`,
      transport: 'http',
      platform: 'windows',
      controlPlaneUrl: 'http://localhost:35457',
      capabilities: ['mcp.call-tool', 'shell.exec'],
      tags: ['spec'],
    };
  }

  it('REFUSES the swarm-wide secret once REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = 'true';
    const base = await bootRouter();

    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify(registrationBody('retired-secret-device')),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized', code: 'shared_secret_retired' });
    // A node token still gets through with the switch on — that is the whole point.
    const viaNodeToken = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER, 'x-test-node': 'retired-secret-device' },
      body: JSON.stringify(registrationBody('retired-secret-device')),
    });
    expect(viaNodeToken.status).toBe(201);
  }, 30_000);

  it('with the switch OFF the secret still works, but is stamped deprecated (the migration observable)', async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    const base = await bootRouter();
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify(registrationBody('deprecated-secret-device')),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-oshal-shared-secret-deprecated')).toBe('1');
  });

  it('a node-bound credential cannot REGISTER a different device (the body-clientId case)', async () => {
    const base = await bootRouter();
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER, 'x-test-node': MINE },
      body: JSON.stringify(registrationBody(`${SIBLING}-hijack`)),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('node_token_client_mismatch');

    // Its own clientId is accepted.
    const own = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER, 'x-test-node': `${MINE}-ok` },
      body: JSON.stringify(registrationBody(`${MINE}-ok`)),
    });
    expect(own.status).toBe(201);
  });

  it('rotate mints for the DEVICE OWNER and refuses the deprecated secret', async () => {
    const pool = new FakeTokenPool();
    const device = 'rotate-device';
    pool.seed({ sub: OWNER, nodeClientId: device });
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    const base = await bootRouter(pool);

    // Enrol the device so it has an owner (machine registration, the field path).
    const registered = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify({ ...registrationBody(device), ownerSub: OWNER }),
    });
    expect(registered.status).toBe(201);

    // The credential being retired may NOT mint its own replacement.
    const bySecret = await fetch(`${base}/${device}/token/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
    });
    expect(bySecret.status).toBe(403);
    expect((await bySecret.json()).code).toBe('shared_secret_cannot_rotate');

    // The owner rotates: a new token, the old generation revoked.
    const rotated = await fetch(`${base}/${device}/token/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
    });
    expect(rotated.status).toBe(201);
    const body = (await rotated.json()) as { token: string; ownerSub: string; revokedCount: number };
    expect(body.ownerSub).toBe(OWNER);
    expect(body.revokedCount).toBe(1);
    expect(body.token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);

    // Someone else cannot rotate another person's device.
    const intruder = await fetch(`${base}/${device}/token/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': 'auth0|intruder' },
    });
    expect(intruder.status).toBe(403);
  }, 20_000);

  it('operator rotation preserves the device exact owner in the response and token row', async () => {
    const pool = new FakeTokenPool();
    const device = 'rotate-exact-owner-device';
    const exactOwner = ' Auth0|Exact-Owner ';
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    process.env.OSHAL_OPERATOR_SUBS = OWNER;
    const base = await bootRouter(pool);

    const registered = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
      body: JSON.stringify({ ...registrationBody(device), ownerSub: exactOwner }),
    });
    expect(registered.status).toBe(201);

    const rotated = await fetch(`${base}/${device}/token/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-sub': OWNER },
    });
    expect(rotated.status).toBe(201);
    expect(((await rotated.json()) as { ownerSub: string }).ownerSub).toBe(exactOwner);
    expect(pool.rows.find((row) => row.node_client_id === device)?.user_sub).toBe(exactOwner);
  }, 20_000);
});
