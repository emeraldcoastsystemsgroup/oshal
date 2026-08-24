/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added adversarial bot-side HTTP delegation guards for rollout posture, exact signed bindings, replay/outage handling, local-agent enforcement, and unsigned mesh/batch prohibition.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the required independent service-secret posture whenever public-key delegation enforcement is active.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reject prompt, direct-entitlement, credential, and provider-intent mutations through the signed canonical body digest before replay consumption.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reject valid signatures carrying any method/path other than exact POST /api/swarm-execute.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove signed delegation is sufficient machine authority without SWARM_SERVICE_SECRET.
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

  it('uses verified single-use delegation as the machine credential without a fleet secret', () => {
    expect(() => createBotNodeDelegationRuntime({
      localAgentId: AGENT_ID,
      verifier: verifier(),
      replayStore: acceptingReplayStore(),
      env: {},
    })).not.toThrow();
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
