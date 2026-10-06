/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added adversarial bot-side HTTP delegation guards for rollout posture, exact signed bindings, replay/outage handling, local-agent enforcement, and unsigned mesh/batch prohibition.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the required independent service-secret posture whenever public-key delegation enforcement is active.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reject prompt, direct-entitlement, credential, and provider-intent mutations through the signed canonical body digest before replay consumption.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reject valid signatures carrying any method/path other than exact POST /api/swarm-execute.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Concierge (multi-agent) node cases N1-N6 over the real verifier and the real served-agent policy with a doubled ownership pool: a dedicated node handed its own policy still refuses a foreign agentId; azp naming a served agent passes and spends its nonce; azp A with body B is 401 before any ownership read and leaves the nonce unspent; a kernel, static or unowned target is 403 target_agent_not_served with the nonce unspent; a served node without verification keys refuses to start; a missing agentId is 403.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | N4's static-registry target is now vault-bot, a core static inline bot: feeds-curator joined the reviewed static app concierges the concierge node may serve (concierge-static-app-bots.ts).
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  createDelegationTokenIssuer,
  createDelegationTokenVerifier,
} from '@/shared/security/delegation-token';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import type { DelegationReplayStore } from '@/shared/security/delegation-replay-store';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import {
  assertDelegationBatchRuntimeAllowed,
  createBotNodeDelegationRuntime,
  getVerifiedDelegationClaims,
  prohibitUnsignedMeshExecution,
} from '@/app/bot-node-delegation';
import { createServedAgentPolicy } from '@/app/bot-node-served-agents';

const AGENT_ID = 'agent-17';
const TASK_ID = 'task-42';
const USER_SUB = 'oidc|alice';
const PRINCIPAL_ISSUER = 'https://identity.example.test/realms/main';
const NOW = 1_800_000_000;
const KEY_PAIR = generateKeyPairSync('ed25519');
const MACHINE_ENV = Object.freeze({ SWARM_SERVICE_SECRET: 'machine-test-secret' });

function privatePem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function publicPem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function verifier() {
  return createDelegationTokenVerifier({
    env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: publicPem(KEY_PAIR.publicKey) }) },
    nowEpochSeconds: () => NOW,
  });
}

function token(
  overrides: Record<string, unknown> = {},
  boundBody: Record<string, unknown> = body(),
): string {
  const issuer = createDelegationTokenIssuer({
    env: {
      OSHAL_DELEGATION_SIGNING_KID: 'current',
      OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: privatePem(KEY_PAIR.privateKey),
      OSHAL_DELEGATION_TTL_SECONDS: '300',
    },
    nowEpochSeconds: () => NOW,
    generateJti: () => String(overrides.jti ?? 'nonce-http-001'),
  });
  return issuer.issue({
    iss: String(overrides.iss ?? 'urn:oshal:controller'),
    aud: String(overrides.aud ?? 'urn:oshal:bot-node'),
    sub: String(overrides.sub ?? USER_SUB),
    principal_iss: String(overrides.principal_iss ?? PRINCIPAL_ISSUER),
    azp: String(overrides.azp ?? AGENT_ID),
    task_id: String(overrides.task_id ?? TASK_ID),
    method: String(overrides.method ?? 'POST'),
    path: String(overrides.path ?? '/api/swarm-execute'),
    body_sha256: String(overrides.body_sha256 ?? delegationRequestBodySha256(boundBody)),
    scope: (overrides.scope as string[] | undefined) ?? ['swarm:execute'],
  });
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'work',
    taskId: TASK_ID,
    workspaceFolderId: TASK_ID,
    agentId: AGENT_ID,
    userSub: USER_SUB,
    principalIssuer: PRINCIPAL_ISSUER,
    ...overrides,
  };
}

function responseFixture(): Response & { statusCode: number; payload: unknown } {
  const state = {
    statusCode: 200,
    payload: undefined as unknown,
    locals: {},
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  };
  return state as unknown as Response & { statusCode: number; payload: unknown };
}

async function invoke(
  runtime: ReturnType<typeof createBotNodeDelegationRuntime>,
  requestBody: Record<string, unknown>,
  delegationToken?: string | string[],
): Promise<{ nextCalls: number; res: ReturnType<typeof responseFixture> }> {
  const res = responseFixture();
  const req = {
    body: requestBody,
    headers: delegationToken === undefined ? {} : { [DELEGATION_HTTP_HEADER]: delegationToken },
  } as unknown as Request;
  let nextCalls = 0;
  await runtime.authorize(req, res, () => { nextCalls += 1; });
  return { nextCalls, res };
}

function acceptingReplayStore(): DelegationReplayStore & { consume: ReturnType<typeof vi.fn> } {
  return { consume: vi.fn(async () => true) };
}

describe('bot-node delegation rollout posture', () => {
  it('allows tokenless legacy traffic only while disabled and rejects every presented token', async () => {
    const runtime = createBotNodeDelegationRuntime({ localAgentId: AGENT_ID, env: {} });
    const absent = await invoke(runtime, body());
    const present = await invoke(runtime, body(), 'malformed.present.token');

    expect(runtime.enforcementEnabled).toBe(false);
    expect(absent.nextCalls).toBe(1);
    expect(present.res.statusCode).toBe(401);
    expect(present.res.payload).toEqual({ success: false, error: 'delegation_not_configured' });
  });

  it('rejects a body agent mismatch even before key rollout', async () => {
    const runtime = createBotNodeDelegationRuntime({ localAgentId: AGENT_ID, env: {} });
    const result = await invoke(runtime, body({ agentId: 'other-agent' }));
    expect(result.nextCalls).toBe(0);
    expect(result.res.statusCode).toBe(403);
  });

  it('fails startup on partial or private-on-bot key configuration', () => {
    expect(() => createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      env: { ...MACHINE_ENV, OSHAL_DELEGATION_PUBLIC_KEYS: '{' },
    })).toThrow();
    expect(() => createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      env: { ...MACHINE_ENV, OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: privatePem(KEY_PAIR.privateKey) },
    })).toThrow();
  });

  it('fails startup when delegation is enabled without the independent machine secret', () => {
    expect(() => createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: acceptingReplayStore(),
      env: {},
    })).toThrow(/SWARM_SERVICE_SECRET/);
  });
});

describe('bot-node delegation exact HTTP authorization', () => {
  it('requires a token, verifies it, consumes its nonce, and exposes only signed claims', async () => {
    const replayStore = acceptingReplayStore();
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore,
      env: MACHINE_ENV,
    });
    const missing = await invoke(runtime, body());
    const accepted = await invoke(runtime, body(), token());

    expect(missing.res.statusCode).toBe(401);
    expect(accepted.nextCalls).toBe(1);
    expect(getVerifiedDelegationClaims(accepted.res)).toMatchObject({
      sub: USER_SUB,
      principal_iss: PRINCIPAL_ISSUER,
      azp: AGENT_ID,
      task_id: TASK_ID,
      method: 'POST',
      path: '/api/swarm-execute',
      body_sha256: delegationRequestBodySha256(body()),
      scope: ['swarm:execute'],
    });
    expect(replayStore.consume).toHaveBeenCalledWith(expect.objectContaining({
      issuer: 'urn:oshal:controller',
      jti: 'nonce-http-001',
    }));
  });

  it.each([
    ['task', body({ taskId: 'task-other' }), token()],
    ['subject', body({ userSub: 'oidc|mallory' }), token()],
    ['principal issuer', body({ principalIssuer: 'https://identity.example.test/other' }), token()],
    ['token issuer', body(), token({ iss: 'urn:other:controller' })],
    ['audience', body(), token({ aud: 'urn:other:bot' })],
    ['method', body(), token({ method: 'GET' })],
    ['path', body(), token({ path: '/api/token-chase/replay-call' })],
    ['scope', body(), token({ scope: ['swarm:execute', 'admin'] })],
  ])('rejects the wrong %s binding before replay consumption', async (_label, requestBody, signed) => {
    const replayStore = acceptingReplayStore();
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore,
      env: MACHINE_ENV,
    });
    const result = await invoke(runtime, requestBody, signed);
    expect(result.res.statusCode).toBe(401);
    expect(replayStore.consume).not.toHaveBeenCalled();
  });

  it('requires the body target under enforcement and rejects local-agent substitution', async () => {
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: acceptingReplayStore(),
      env: MACHINE_ENV,
    });
    const { agentId: _removed, ...missingAgent } = body();
    expect((await invoke(runtime, missingAgent, token())).res.statusCode).toBe(403);
    expect((await invoke(runtime, body({ agentId: 'other-agent' }), token())).res.statusCode).toBe(403);
  });

  it.each([
    ['prompt', { text: 'attacker replacement prompt' }],
    ['direct entitlement', { direct: false }],
    ['brokered credentials', { creds: { google: 'attacker-token' } }],
    ['provider intent', { providerIntent: { provider: 'attacker-provider' } }],
  ])('rejects a raced %s mutation before replay consumption', async (_label, mutation) => {
    const approvedBody = body({
      text: 'approved prompt',
      direct: true,
      creds: { google: 'approved-token' },
      providerIntent: { provider: 'approved-provider' },
    });
    const replayStore = acceptingReplayStore();
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore,
      env: MACHINE_ENV,
    });
    const result = await invoke(runtime, { ...approvedBody, ...mutation }, token({}, approvedBody));
    expect(result.res.statusCode).toBe(401);
    expect(replayStore.consume).not.toHaveBeenCalled();
  });

  it('returns conflict on replay and 503 when atomic replay protection is unavailable', async () => {
    const replayed = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: { consume: vi.fn(async () => false) },
      env: MACHINE_ENV,
    });
    const unavailable = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: { consume: vi.fn(async () => { throw new Error('redis down'); }) },
      env: MACHINE_ENV,
    });

    expect((await invoke(replayed, body(), token())).res.statusCode).toBe(409);
    expect((await invoke(unavailable, body(), token())).res.statusCode).toBe(503);
  });

  it('treats a repeated or array-valued token header as malformed, never absent', async () => {
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: acceptingReplayStore(),
      env: MACHINE_ENV,
    });
    const result = await invoke(runtime, body(), [token(), token({ jti: 'other' })]);
    expect(result.res.statusCode).toBe(401);
  });
});

describe('unsigned runtime bypass prohibition', () => {
  it('rejects mesh execution without invoking the LLM handler while enforcement is active', async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const guarded = prohibitUnsignedMeshExecution(true, execute);
    const result = await guarded({
      correlationId: 'mesh-1',
      fromAgentId: 'controller',
      toAgentId: AGENT_ID,
      channel: 'agent.test',
      messageType: 'request',
      payload: {},
    });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('prohibits batch when verifier key material is present', () => {
    expect(() => assertDelegationBatchRuntimeAllowed({
      OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: publicPem(KEY_PAIR.publicKey) }),
    })).toThrow(/prohibited/);
    expect(() => assertDelegationBatchRuntimeAllowed({})).not.toThrow();
  });
});

describe('concierge (multi-agent) node delegation', () => {
  const SERVED_AGENT = 'c0ffee00-0000-4000-8000-0000000000d1';
  const OTHER_SERVED = 'c0ffee00-0000-4000-8000-0000000000d2';
  const UNOWNED = 'c0ffee00-0000-4000-8000-0000000000d3';
  const KERNEL_AGENT = 'a0000000-0000-0000-0000-000000000050';
  const STATIC_AGENT = 'a0000000-0000-0000-0000-0000000000d0'; // vault-bot: a core static inline bot (feeds-curator is now a reviewed app concierge)
  const SERVES_ENV = { BOT_NODE_SERVES: 'inline-app-bots' };

  /** The real policy over an ownership pool that knows two installed application bots. */
  function servedPolicy() {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: [SERVED_AGENT, OTHER_SERVED].includes(String(params[1])) ? [{ app: 'spec-concierge-app', protected: false }] : [],
    }));
    const policy = createServedAgentPolicy({ localAgentId: AGENT_ID, pool: { query } as never, env: SERVES_ENV });
    return { policy, query };
  }

  function conciergeRuntime(replayStore = acceptingReplayStore()) {
    const { policy, query } = servedPolicy();
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID, verifier: verifier(), replayStore, env: MACHINE_ENV, servedAgents: policy,
    });
    return { runtime, replayStore, query };
  }

  it('N1: a dedicated node handed its own policy still refuses a foreign agentId', async () => {
    const replayStore = acceptingReplayStore();
    const dedicated = createServedAgentPolicy({ localAgentId: AGENT_ID, pool: null, env: {} });
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID, verifier: verifier(), replayStore, env: MACHINE_ENV, servedAgents: dedicated,
    });
    const foreign = body({ agentId: SERVED_AGENT });
    const result = await invoke(runtime, foreign, token({ azp: SERVED_AGENT }, foreign));
    expect(dedicated.multiAgent).toBe(false);
    expect(result.res.statusCode).toBe(403);
    expect(result.res.payload).toEqual({ success: false, error: 'target_agent_mismatch' });
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect((await invoke(runtime, body(), token())).nextCalls).toBe(1);
  });

  it('N2: azp naming a served agent passes and spends its nonce', async () => {
    const { runtime, replayStore, query } = conciergeRuntime();
    const served = body({ agentId: SERVED_AGENT });
    const result = await invoke(runtime, served, token({ azp: SERVED_AGENT }, served));
    expect(result.nextCalls).toBe(1);
    expect(getVerifiedDelegationClaims(result.res)).toMatchObject({ azp: SERVED_AGENT });
    expect(replayStore.consume).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    // The node's own agent is still served without any ownership read.
    expect((await invoke(runtime, body(), token({ jti: 'nonce-local' }))).nextCalls).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('N3: azp A with body B is 401 before any ownership read and leaves the nonce unspent', async () => {
    const { runtime, replayStore, query } = conciergeRuntime();
    const other = body({ agentId: OTHER_SERVED });
    const result = await invoke(runtime, other, token({ azp: SERVED_AGENT }, other));
    expect(result.res.statusCode).toBe(401);
    expect(result.nextCalls).toBe(0);
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['kernel', KERNEL_AGENT, false],
    ['static registry', STATIC_AGENT, false],
    ['unowned', UNOWNED, true],
  ])('N4: a %s target is 403 target_agent_not_served and leaves the nonce unspent', async (_label, target, readsOwnership) => {
    const { runtime, replayStore, query } = conciergeRuntime();
    const request = body({ agentId: target });
    const result = await invoke(runtime, request, token({ azp: target }, request));
    expect(result.res.statusCode).toBe(403);
    expect(result.res.payload).toEqual({ success: false, error: 'target_agent_not_served' });
    expect(replayStore.consume).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(readsOwnership ? 1 : 0);
  });

  it('N4b: an ownership read that fails refuses closed (503) and leaves the nonce unspent', async () => {
    const replayStore = acceptingReplayStore();
    const policy = createServedAgentPolicy({ localAgentId: AGENT_ID, env: SERVES_ENV,
      pool: { query: vi.fn(async () => { throw new Error('database unreachable'); }) } as never });
    const runtime = createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID, verifier: verifier(), replayStore, env: MACHINE_ENV, servedAgents: policy,
    });
    const request = body({ agentId: SERVED_AGENT });
    const result = await invoke(runtime, request, token({ azp: SERVED_AGENT }, request));
    expect(result.res.statusCode).toBe(503);
    expect(replayStore.consume).not.toHaveBeenCalled();
  });

  it('N5: a served node without verification keys refuses to start', () => {
    const { policy } = servedPolicy();
    expect(() => createBotNodeDelegationRuntime({ localAgentId: AGENT_ID, env: {}, servedAgents: policy }))
      .toThrow(/BOT_NODE_SERVES/);
  });

  it('N6: a missing or non-string agentId is 403 target_agent_mismatch', async () => {
    const { runtime, replayStore } = conciergeRuntime();
    const { agentId: _removed, ...missing } = body();
    expect((await invoke(runtime, missing, token({}, missing))).res.payload)
      .toEqual({ success: false, error: 'target_agent_mismatch' });
    const numeric = body({ agentId: 17 });
    expect((await invoke(runtime, numeric, token({}, numeric))).res.statusCode).toBe(403);
    expect(replayStore.consume).not.toHaveBeenCalled();
  });
});
