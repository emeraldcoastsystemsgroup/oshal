/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added real-HTTP controller guards for signed target/task/user issuer propagation, explicit system subjects, target mismatch, and partial-key startup failure.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard delegation posture reporting and service-secret authentication on provider mutation push-down.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Verify the real HTTP token binds the complete canonical request body received by the bot.
 */

import * as http from 'node:http';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BotNodeClient,
  type BotNodeRequest,
} from '@/features/agent-management';
import {
  createDelegationTokenIssuer,
  createDelegationTokenVerifier,
} from '@/shared/security/delegation-token';
import {
  CONTROLLER_SYSTEM_SUBJECT,
  DELEGATION_HTTP_HEADER,
  PLATFORM_SYSTEM_PRINCIPAL_ISSUER,
} from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import {
  runWithRequestIdentity,
  runWithSystemIdentity,
} from '@/shared/services/database/request-identity';

const AGENT_ID = 'agent-http-17';
const USER_SUB = 'oidc|alice';
const PRINCIPAL_ISSUER = 'https://identity.example.test/realms/main';
const NOW = 1_800_000_000;
const PAIR = generateKeyPairSync('ed25519');
const servers: http.Server[] = [];

function privatePem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function publicPem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function issuer() {
  return createDelegationTokenIssuer({
    env: {
      OSHAL_DELEGATION_SIGNING_KID: 'current',
      OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: privatePem(PAIR.privateKey),
      OSHAL_DELEGATION_TTL_SECONDS: '300',
    },
    nowEpochSeconds: () => NOW,
    generateJti: () => 'nonce-client-001',
  });
}

function verifier() {
  return createDelegationTokenVerifier({
    env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: publicPem(PAIR.publicKey) }) },
    nowEpochSeconds: () => NOW,
  });
}

function request(overrides: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'perform bounded work',
    taskId: 'task-http-42',
    workspaceFolderId: 'task-http-42',
    agentId: AGENT_ID,
    agenticMode: true,
    ...overrides,
  };
}

function responseBody(): string {
  return JSON.stringify({
    success: true,
    response: 'done',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    cost: 0,
    model: 'test',
    provider: 'noop',
    durationMs: 1,
  });
}

async function captureOneRequest(): Promise<{
  endpoint: string;
  captured: Promise<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
}> {
  let resolveCapture!: (value: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) => void;
  const captured = new Promise<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>((resolve) => {
    resolveCapture = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolveCapture({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseBody());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return { endpoint: `http://127.0.0.1:${address.port}`, captured };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
});

describe('BotNodeClient HTTP delegation issuance', () => {
  it('signs the trusted user issuer and exact target/task onto the real HTTP request', async () => {
    const wire = await captureOneRequest();
    const client = new BotNodeClient(() => wire.endpoint, 5_000, {
      env: {},
      delegationIssuer: issuer(),
    });
    expect(client.isDelegationEnforced()).toBe(true);
    await runWithRequestIdentity(
      { sub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER, isOperator: false },
      () => client.execute(AGENT_ID, request({ userSub: USER_SUB })),
    );
    const captured = await wire.captured;
    const signed = String(captured.headers[DELEGATION_HTTP_HEADER]);
    const claims = verifier().verify(signed, {
      iss: 'urn:oshal:controller',
      aud: 'urn:oshal:bot-node',
      sub: USER_SUB,
      principal_iss: PRINCIPAL_ISSUER,
      azp: AGENT_ID,
      task_id: 'task-http-42',
      body_sha256: delegationRequestBodySha256(captured.body),
      scope: ['swarm:execute'],
    });

    expect(claims.jti).toBe('nonce-client-001');
    expect(captured.body).toMatchObject({
      agentId: AGENT_ID,
      taskId: 'task-http-42',
      userSub: USER_SUB,
      principalIssuer: PRINCIPAL_ISSUER,
    });
  });

  it('stamps an explicit namespaced subject only under the trusted system sentinel', async () => {
    const wire = await captureOneRequest();
    const client = new BotNodeClient(() => wire.endpoint, 5_000, {
      env: {},
      delegationIssuer: issuer(),
    });
    await runWithSystemIdentity(() => client.execute(AGENT_ID, request()));
    const captured = await wire.captured;
    expect(captured.body.userSub).toBe(CONTROLLER_SYSTEM_SUBJECT);
    expect(captured.body.principalIssuer).toBe(PLATFORM_SYSTEM_PRINCIPAL_ISSUER);
  });

  it('fails before network I/O when a user issuer is absent or conflicts with trusted context', async () => {
    const client = new BotNodeClient(() => 'http://127.0.0.1:1', 50, {
      env: {},
      delegationIssuer: issuer(),
    });
    await expect(runWithRequestIdentity(
      { sub: USER_SUB, principalIssuer: null, isOperator: false },
      () => client.execute(AGENT_ID, request({ userSub: USER_SUB })),
    )).rejects.toThrow(/verified principal issuer/);
    await expect(runWithRequestIdentity(
      { sub: USER_SUB, principalIssuer: PRINCIPAL_ISSUER, isOperator: false },
      () => client.execute(AGENT_ID, request({
        userSub: USER_SUB,
        principalIssuer: 'https://identity.example.test/realms/forged',
      })),
    )).rejects.toThrow(/does not match/);
  });

  it('rejects a request-body target mismatch and partial signing configuration', async () => {
    const client = new BotNodeClient(() => 'http://127.0.0.1:1', 50, { env: {} });
    await expect(client.execute(AGENT_ID, request({ agentId: 'other-agent' }))).rejects.toThrow(/trusted dispatch target/);
    expect(() => new BotNodeClient(() => null, 50, {
      env: { OSHAL_DELEGATION_SIGNING_KID: 'current' },
    })).toThrow();
  });

  it('preserves the tokenless legacy wire shape when no signing material is configured', async () => {
    const wire = await captureOneRequest();
    const client = new BotNodeClient(() => wire.endpoint, 5_000, { env: {} });
    expect(client.isDelegationEnforced()).toBe(false);
    await client.execute(AGENT_ID, request());
    const captured = await wire.captured;
    expect(captured.headers[DELEGATION_HTTP_HEADER]).toBeUndefined();
    expect(captured.body.principalIssuer).toBeUndefined();
    expect(captured.body.userSub).toBeUndefined();
  });

  it('sends the machine secret on provider configuration mutations', async () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', 'machine-secret-42');
    const wire = await captureOneRequest();
    const client = new BotNodeClient(() => wire.endpoint, 5_000, { env: {} });
    await client.switchProvider(AGENT_ID, 'noop', 'test-model');
    const captured = await wire.captured;
    expect(captured.headers['x-service-secret']).toBe('machine-secret-42');
    expect(captured.headers['x-config-source']).toBe('oshal-push');
  });
});
