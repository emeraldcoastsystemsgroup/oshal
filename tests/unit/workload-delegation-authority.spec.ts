/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add adversarial SEC-01 guards for 256-bit hash-only workload credentials, exact route metadata, persisted issuance, legacy-shadow-enforce migration, signed identity derivation, replay, audience/method/path/body/scope/workload/expiry/revocation rejection, and migration RLS shape.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exercise victim-header substitution against every delegated Graph/Jarvis user-data method-path policy.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove nested Jarvis visual identity propagation and split security scenarios into governance-bounded suites.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDelegationRouteTokenVerifier,
  createRecordedDelegationTokenIssuer,
} from '@/shared/security/delegation-token';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import type { DelegationTokenClaims } from '@/shared/types';
import { createJarvisVisualRoutes } from '@/app/routes/jarvis-visual-response';
import {
  canonicalDelegationPath,
  createWorkloadDelegationMiddleware,
  generateWorkloadCredential,
  getVerifiedWorkloadDelegation,
  GRAPH_READ_SCOPE,
  GRAPH_WRITE_SCOPE,
  hashWorkloadCredential,
  JARVIS_READ_SCOPE,
  JARVIS_WRITE_SCOPE,
  resolveWorkloadDelegationRoute,
  workloadCredentialHashMatches,
  workloadDelegationMode,
  WorkloadDelegationIssuerService,
  type AuthenticateWorkloadCredentialInput,
  type RecordUserDelegationInput,
  type RegisterWorkloadIdentityInput,
  type RotateWorkloadCredentialInput,
  type WorkloadDelegationConsumeOutcome,
  type WorkloadDelegationStore,
  type WorkloadIdentityRecord,
} from '@/features/security';

const NOW = 1_800_000_000;
const WORKLOAD_ID = 'bot:graph-reader-1';
const USER_SUB = 'oidc|alice';
const PRINCIPAL_ISSUER = 'https://identity.example.test/realms/main';
const KEY_PAIR = generateKeyPairSync('ed25519');
const originalServiceSecret = process.env.SWARM_SERVICE_SECRET;

function privatePem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function publicPem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function signingEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    OSHAL_DELEGATION_SIGNING_KID: 'current',
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: privatePem(KEY_PAIR.privateKey),
    OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS: '900',
    OSHAL_WORKLOAD_DELEGATION_AUDIENCE: 'urn:oshal:api',
    ...overrides,
  };
}

function verifierEnv(mode: 'legacy' | 'shadow' | 'enforce' = 'enforce') {
  return {
    OSHAL_WORKLOAD_DELEGATION_MODE: mode,
    OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: publicPem(KEY_PAIR.publicKey) }),
    OSHAL_WORKLOAD_DELEGATION_AUDIENCE: 'urn:oshal:api',
  };
}

class MemoryAuthority implements WorkloadDelegationStore {
  readonly records = new Map<string, RecordUserDelegationInput>();
  readonly consumed = new Set<string>();
  nextOutcome: WorkloadDelegationConsumeOutcome | null = null;

  async registerWorkload(_input: RegisterWorkloadIdentityInput): Promise<WorkloadIdentityRecord> {
    throw new Error('not used');
  }

  async rotateWorkloadCredential(_input: RotateWorkloadCredentialInput): Promise<boolean> {
    return false;
  }

  async authenticateWorkloadCredential(_input: AuthenticateWorkloadCredentialInput): Promise<boolean> {
    return false;
  }

  async canIssueForWorkload(workloadId: string, scopes: readonly string[]): Promise<boolean> {
    const delegatedScopes = [GRAPH_READ_SCOPE, GRAPH_WRITE_SCOPE, JARVIS_READ_SCOPE, JARVIS_WRITE_SCOPE];
    return workloadId === WORKLOAD_ID && scopes.length === 1 && delegatedScopes.includes(scopes[0]);
  }

  async recordDelegation(input: RecordUserDelegationInput): Promise<void> {
    this.records.set(input.claims.jti, input);
  }

  async consumeDelegation(claims: DelegationTokenClaims): Promise<WorkloadDelegationConsumeOutcome> {
    if (this.nextOutcome) return this.nextOutcome;
    const recorded = this.records.get(claims.jti);
    if (!recorded) return 'not_found';
    if (this.consumed.has(claims.jti)) return 'replayed';
    if (recorded.claims.azp !== claims.azp) return 'binding_mismatch';
    this.consumed.add(claims.jti);
    return 'authorized';
  }

  async revokeDelegation(): Promise<boolean> {
    return false;
  }
}

function responseFixture(): Response & { statusCode: number; payload: unknown } {
  const response = {
    locals: {},
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: unknown };
}

async function issueGraphToken(store: WorkloadDelegationStore, body: unknown = { aql: 'RETURN 1' }) {
  const issuer = new WorkloadDelegationIssuerService(store, {
    env: signingEnv(),
    nowEpochSeconds: () => NOW,
  });
  return issuer.issue({
    workloadId: WORKLOAD_ID,
    userSub: USER_SUB,
    principalIssuer: PRINCIPAL_ISSUER,
    ticketId: 'ticket-42',
    method: 'POST',
    path: '/api/graph/query',
    body,
    dispatchExpiresAt: new Date((NOW + 1_200) * 1_000),
  });
}

async function invoke(
  store: WorkloadDelegationStore,
  token: string | null,
  overrides: Partial<Request> = {},
  mode: 'legacy' | 'shadow' | 'enforce' = 'enforce',
) {
  let fallbackCalls = 0;
  let nextCalls = 0;
  let identity: ReturnType<typeof getRequestIdentity>;
  let delegated: DelegationTokenClaims | null = null;
  const middleware = createWorkloadDelegationMiddleware({
    store,
    verifier: createDelegationRouteTokenVerifier({
      env: { OSHAL_DELEGATION_PUBLIC_KEYS: verifierEnv(mode).OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS },
      nowEpochSeconds: () => NOW,
    }),
    env: verifierEnv(mode),
    nowEpochSeconds: () => NOW,
    fallback: (_req, _res, next) => { fallbackCalls += 1; next(); },
  });
  const req = {
    method: 'POST',
    originalUrl: '/api/graph/query',
    body: { aql: 'RETURN 1' },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...overrides,
  } as unknown as Request;
  const res = responseFixture();
  await (middleware as unknown as (
    request: Request,
    response: Response,
    next: () => void,
  ) => Promise<void>)(req, res, () => {
    nextCalls += 1;
    identity = getRequestIdentity();
    delegated = getVerifiedWorkloadDelegation(req);
  });
  return { res, fallbackCalls, nextCalls, identity, delegated };
}

afterEach(() => {
  if (originalServiceSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = originalServiceSecret;
  vi.restoreAllMocks();
});

describe('SEC-01 workload credentials and route metadata', () => {
  it('generates canonical 256-bit credentials and persists only a constant-time comparable hash', () => {
    const generated = generateWorkloadCredential();
    const encoded = generated.credential.slice('oshal_wk_'.length);
    const digest = hashWorkloadCredential(generated.credential);
    expect(Buffer.from(encoded, 'base64url')).toHaveLength(32);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(encoded);
    expect(workloadCredentialHashMatches(generated.credential, digest)).toBe(true);
    expect(workloadCredentialHashMatches(`${generated.credential}x`, digest)).toBe(false);
  });

  it('maps every delegated user route by exact method/path and rejects ambiguous paths', () => {
    expect(resolveWorkloadDelegationRoute('POST', '/api/graph/query')).toMatchObject({
      routeTemplate: '/api/graph/query', requiredScopes: [GRAPH_READ_SCOPE],
    });
    expect(resolveWorkloadDelegationRoute('GET', '/api/graph/query')).toBeNull();
    expect(resolveWorkloadDelegationRoute('POST', '/api/jarvis/tasks/id-1/delivered')).toMatchObject({
      routeTemplate: '/api/jarvis/tasks/:id/delivered',
    });
    expect(() => canonicalDelegationPath('/api/graph//query')).toThrow();
    expect(() => canonicalDelegationPath('/api/graph/%2e%2e/query')).toThrow();
    expect(() => canonicalDelegationPath('/api/graph/%2fquery')).toThrow();
  });

  it('fails unknown rollout configuration closed to enforce', () => {
    expect(workloadDelegationMode({ OSHAL_WORKLOAD_DELEGATION_MODE: 'typo' })).toBe('enforce');
  });
});

describe('SEC-01 signed issuance and route authorization', () => {
  it('caps a 30-minute token at parent expiry and refuses a parent with under 15 minutes', async () => {
    const store = new MemoryAuthority();
    const issuer = new WorkloadDelegationIssuerService(store, {
      env: signingEnv({ OSHAL_WORKLOAD_DELEGATION_TTL_SECONDS: '1800' }),
      nowEpochSeconds: () => NOW,
    });
    const base = {
      workloadId: WORKLOAD_ID, userSub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER,
      ticketId: 'ticket-42', method: 'POST', path: '/api/graph/query', body: { aql: 'RETURN 1' },
    };
    const capped = await issuer.issue({
      ...base, dispatchExpiresAt: new Date((NOW + 1_200) * 1_000),
    });
    expect(capped.claims.exp).toBe(NOW + 1_200);
    await expect(issuer.issue({
      ...base, dispatchExpiresAt: new Date((NOW + 899) * 1_000),
    })).rejects.toThrow(/less than 15 minutes/);
  });
});

describe('SEC-01 delegated user-route matrix', () => {
  it.each([
    ['POST', '/api/graph/query', GRAPH_READ_SCOPE],
    ['GET', '/api/graph/neighbors', GRAPH_READ_SCOPE],
    ['GET', '/api/graph/path', GRAPH_READ_SCOPE],
    ['POST', '/api/graph/nodes', GRAPH_WRITE_SCOPE],
    ['POST', '/api/graph/edges', GRAPH_WRITE_SCOPE],
    ['GET', '/api/jarvis/history', JARVIS_READ_SCOPE],
    ['GET', '/api/jarvis/tasks', JARVIS_READ_SCOPE],
    ['GET', '/api/jarvis/overview', JARVIS_READ_SCOPE],
    ['GET', '/api/jarvis/ask/result', JARVIS_READ_SCOPE],
    ['GET', '/api/jarvis/ask/jobs', JARVIS_READ_SCOPE],
    ['GET', '/api/jarvis/visuals/artifact-1', JARVIS_READ_SCOPE],
    ['POST', '/api/jarvis/tasks/task-1/delivered', JARVIS_WRITE_SCOPE],
    ['POST', '/api/jarvis/ask', JARVIS_WRITE_SCOPE],
    ['POST', '/api/jarvis/thread/close', JARVIS_WRITE_SCOPE],
    ['POST', '/api/jarvis/ask/dismiss', JARVIS_WRITE_SCOPE],
  ])('ignores a victim header on delegated %s %s', async (method, path, expectedScope) => {
    const store = new MemoryAuthority();
    const body = method === 'GET' ? undefined : { value: 'bounded' };
    const receipt = await new WorkloadDelegationIssuerService(store, {
      env: signingEnv(), nowEpochSeconds: () => NOW,
    }).issue({
      workloadId: WORKLOAD_ID, userSub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER,
      ticketId: 'ticket-42', method, path, body,
      dispatchExpiresAt: new Date((NOW + 1_200) * 1_000),
    });
    const accepted = await invoke(store, receipt.token, {
      method, originalUrl: path, body,
      headers: { authorization: `Bearer ${receipt.token}`, 'x-oshal-user-sub': 'victim-sub' },
    });
    expect(accepted.identity).toMatchObject({ sub: USER_SUB, isOperator: false });
    expect(accepted.delegated).toMatchObject({ sub: USER_SUB, scope: [expectedScope] });
  });
});

describe('SEC-01 nested Jarvis owner identity', () => {
  it('threads verified identity into the nested owner-scoped Jarvis visual router', async () => {
    const store = new MemoryAuthority();
    const artifactId = '8f3b2cb0-4bba-45f5-8d73-10732fa13469';
    const path = `/api/jarvis/visuals/${artifactId}`;
    const receipt = await new WorkloadDelegationIssuerService(store, {
      env: signingEnv(), nowEpochSeconds: () => NOW,
    }).issue({
      workloadId: WORKLOAD_ID, userSub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER,
      ticketId: 'ticket-visual', method: 'GET', path,
      dispatchExpiresAt: new Date((NOW + 1_200) * 1_000),
    });
    const service = { getArtifact: vi.fn().mockResolvedValue(null) };
    const app = express();
    app.use('/api/jarvis', createWorkloadDelegationMiddleware({
      store, env: verifierEnv(), nowEpochSeconds: () => NOW,
      verifier: createDelegationRouteTokenVerifier({
        env: { OSHAL_DELEGATION_PUBLIC_KEYS: verifierEnv().OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS },
        nowEpochSeconds: () => NOW,
      }),
      fallback: (_req, res) => { res.status(401).json({ error: 'ordinary_auth_required' }); },
    }));
    app.use('/api/jarvis/visuals', createJarvisVisualRoutes(service as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${receipt.token}`, 'x-oshal-user-sub': 'victim-sub' },
      });
      expect(response.status).toBe(404);
      expect(service.getArtifact).toHaveBeenCalledWith(USER_SUB, artifactId);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('SEC-01 durable authorization and replay', () => {
  it('records before release, binds parent expiry, and derives non-operator DB identity from claims', async () => {
    const store = new MemoryAuthority();
    const receipt = await issueGraphToken(store);
    expect(store.records.get(receipt.claims.jti)?.claims).toEqual(receipt.claims);
    expect(receipt.claims.exp).toBe(NOW + 900);
    expect(receipt.claims).toMatchObject({
      sub: USER_SUB,
      principal_iss: PRINCIPAL_ISSUER,
      azp: WORKLOAD_ID,
      task_id: 'ticket-42',
      method: 'POST',
      path: '/api/graph/query',
      scope: [GRAPH_READ_SCOPE],
    });
    const accepted = await invoke(store, receipt.token);
    expect(accepted.res.statusCode).toBe(200);
    expect(accepted.nextCalls).toBe(1);
    expect(accepted.fallbackCalls).toBe(0);
    expect(accepted.identity).toMatchObject({
      sub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER, isOperator: false,
    });
    expect(accepted.delegated).toMatchObject({ sub: USER_SUB, azp: WORKLOAD_ID });
  });

  it('rejects replay before any second route execution', async () => {
    const store = new MemoryAuthority();
    const receipt = await issueGraphToken(store);
    expect((await invoke(store, receipt.token)).nextCalls).toBe(1);
    const replay = await invoke(store, receipt.token);
    expect(replay.nextCalls).toBe(0);
    expect(replay.res.statusCode).toBe(409);
    expect(replay.res.payload).toEqual({ error: 'delegation_replayed' });
  });

  it.each([
    ['method', { method: 'GET', originalUrl: '/api/graph/neighbors' }],
    ['path', { originalUrl: '/api/graph/nodes' }],
    ['body', { body: { aql: 'RETURN 2' } }],
  ])('rejects wrong %s before durable consumption', async (_label, override) => {
    const store = new MemoryAuthority();
    const receipt = await issueGraphToken(store);
    const result = await invoke(store, receipt.token, override as Partial<Request>);
    expect(result.nextCalls).toBe(0);
    expect(result.res.statusCode).toBe(401);
    expect(store.consumed.size).toBe(0);
  });
});

describe('SEC-01 adversarial token and durable-state rejection', () => {
  it('rejects wrong audience and expired tokens before durable consumption', async () => {
    const store = new MemoryAuthority();
    const receipt = await issueGraphToken(store);
    const wrongAudience = createWorkloadDelegationMiddleware({
      store,
      verifier: createDelegationRouteTokenVerifier({
        env: { OSHAL_DELEGATION_PUBLIC_KEYS: verifierEnv().OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS },
        nowEpochSeconds: () => NOW,
      }),
      env: { ...verifierEnv(), OSHAL_WORKLOAD_DELEGATION_AUDIENCE: 'urn:other:api' },
      fallback: (_req, _res, next) => next(),
    });
    const req = { method: 'POST', originalUrl: '/api/graph/query', body: { aql: 'RETURN 1' }, headers: { authorization: `Bearer ${receipt.token}` } } as unknown as Request;
    const wrongRes = responseFixture();
    await (wrongAudience as unknown as (a: Request, b: Response, c: () => void) => Promise<void>)(req, wrongRes, () => undefined);
    expect(wrongRes.statusCode).toBe(401);
    const expiredVerifier = createDelegationRouteTokenVerifier({
      env: { OSHAL_DELEGATION_PUBLIC_KEYS: verifierEnv().OSHAL_WORKLOAD_DELEGATION_PUBLIC_KEYS },
      nowEpochSeconds: () => NOW + 1_000,
    });
    expect(() => expiredVerifier.verify(receipt.token, {
      iss: 'urn:oshal:controller', aud: 'urn:oshal:api', method: 'POST', path: '/api/graph/query',
      body_sha256: receipt.claims.body_sha256, scope: [GRAPH_READ_SCOPE],
    })).toThrow();
    expect(store.consumed.size).toBe(0);
  });

  it.each([
    ['revoked', 401, 'invalid_delegation'],
    ['not_active', 403, 'delegation_forbidden'],
    ['binding_mismatch', 403, 'delegation_forbidden'],
    ['insufficient_scope', 403, 'delegation_forbidden'],
  ] as const)('maps durable %s refusal without executing', async (outcome, status, code) => {
    const store = new MemoryAuthority();
    const receipt = await issueGraphToken(store);
    store.nextOutcome = outcome;
    const result = await invoke(store, receipt.token);
    expect(result.nextCalls).toBe(0);
    expect(result.res.statusCode).toBe(status);
    expect(result.res.payload).toEqual({ error: code });
  });
});

describe('SEC-01 migration stages and schema guard', () => {
  it('keeps legacy/shadow compatibility explicit and removes fleet-secret user identity in enforce', async () => {
    process.env.SWARM_SERVICE_SECRET = 'fleet-secret-for-test';
    const headers = { 'x-service-secret': process.env.SWARM_SERVICE_SECRET };
    const legacy = await invoke(new MemoryAuthority(), null, { headers } as Partial<Request>, 'legacy');
    const shadow = await invoke(new MemoryAuthority(), null, { headers } as Partial<Request>, 'shadow');
    const enforce = await invoke(new MemoryAuthority(), null, { headers } as Partial<Request>, 'enforce');
    expect(legacy.fallbackCalls).toBe(1);
    expect(shadow.fallbackCalls).toBe(1);
    expect(enforce.fallbackCalls).toBe(0);
    expect(enforce.res.statusCode).toBe(403);
    expect(enforce.res.payload).toEqual({ error: 'legacy_service_identity_not_allowed' });
  });

  it('preserves independently authenticated OIDC/PAT identity in enforce mode', async () => {
    process.env.SWARM_SERVICE_SECRET = 'fleet-secret-for-test';
    const result = await invoke(new MemoryAuthority(), null, {
      headers: { 'x-service-secret': process.env.SWARM_SERVICE_SECRET },
      oidc: { isAuthenticated: () => true, user: { sub: USER_SUB } },
    } as Partial<Request>);
    expect(result.fallbackCalls).toBe(1);
    expect(result.nextCalls).toBe(1);
  });

  it('pins migration 119 hash-only fields, immutable grants, and broker-only forced RLS', () => {
    const migration = readFileSync('scripts/migrations/119-workload-delegation-authority.sql', 'utf8');
    const roleMigration = readFileSync('scripts/migrations/099-bot-db-role.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS oshal_workload_identities');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS oshal_user_delegations');
    expect(migration).toContain('credential_hash TEXT NOT NULL');
    expect(migration).not.toMatch(/credential_(?:secret|plaintext)\s+TEXT/i);
    expect(migration).toContain('previous_valid_until TIMESTAMPTZ');
    expect(migration).toContain('trg_oshal_user_delegation_immutable');
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration.match(/oshal\.workload_delegation_broker/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toMatch(/REVOKE ALL PRIVILEGES[\s\S]+FROM oshal_bot/);
    expect(roleMigration).toMatch(/oshal_workload_identities[\s\S]+FROM oshal_bot/);
  });
});
