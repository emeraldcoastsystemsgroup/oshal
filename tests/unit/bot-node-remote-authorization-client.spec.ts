/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove recorded controller signing precedes HTTP dispatch and result authority cannot be supplied by a worker.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotNodeClient, type BotNodeRequest } from '@/features/agent-management';
import type { ApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { createDelegationTokenVerifier, createRecordedDelegationTokenIssuer } from '@/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithRemoteExecutionResults } from '@/shared/remote-execution-results';
import { configureSpecialistContextRegistry, type SpecialistContextRegistry } from '@/shared/specialist-context';
import { RemoteExecutionFixture } from '../fixtures/application-remote-execution';

const actor = { sub: 'alice', issuer: 'https://controller.fixture.test', isActive: true, isSwarmAdmin: false };
const request: BotNodeRequest = { agentId: 'fixture-bot', taskId: 'fixture-task', workspaceFolderId: 'fixture-workspace',
  text: 'Authorized known facts', userSub: actor.sub, direct: true, agenticMode: false };
const key = generateKeyPairSync('ed25519');
const signer = createRecordedDelegationTokenIssuer({ env: { OSHAL_DELEGATION_SIGNING_KID: 'fixture',
  OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
const verifier = createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({
  fixture: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) } });
let server: Server, endpoint: string, executionId: string, events: string[], received: Record<string, unknown>[];
let allowed: boolean, failBind: boolean, body: Record<string, unknown>;
let authority: ApplicationRemoteExecutionAuthority;

beforeEach(async () => {
  executionId = randomUUID(); events = []; received = []; allowed = true; failBind = false;
  body = { success: true, response: 'PRIVATE ANSWER', applicationExecutionId: 'worker-forgery', taskId: 'worker-task' };
  authority = controllerAuthority();
  server = createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; });
    req.on('end', () => { events.push('http'); received.push(JSON.parse(data));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { configureSpecialistContextRegistry(undefined); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });

function controllerAuthority(): ApplicationRemoteExecutionAuthority {
  return {
    prepare: vi.fn(async caller => {
      events.push('prepare'); if (caller.sub !== actor.sub || caller.issuer !== actor.issuer || !caller.isActive) throw new Error('invalid actor');
      return { executionId, expiresAt: new Date(Date.now() + 300000).toISOString(), binding: { executionId, app: 'fixture-app',
        agentId: request.agentId, taskId: request.taskId, workspaceId: request.workspaceFolderId, sub: actor.sub, issuer: actor.issuer } };
    }),
    bind: vi.fn(async (id, receipt, payload) => {
      events.push('bind'); if (failBind) throw new Error('durable unavailable');
      expect(id).toBe(executionId); expect(payload.applicationExecutionId).toBe(id);
      expect(verifier.verify(receipt.token, { iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', sub: actor.sub,
        principal_iss: actor.issuer, azp: request.agentId, task_id: request.taskId, method: 'POST', path: '/api/swarm-execute',
        body_sha256: delegationRequestBodySha256(payload), scope: ['swarm:execute'] })).toEqual(receipt.claims);
    }),
    revalidate: vi.fn(async () => { throw new Error('Not used by controller dispatch'); }),
    assertResultAccess: vi.fn(async () => { events.push('result-check'); if (!allowed) throw new Error('revoked'); }),
    assertTaskResultAccess: vi.fn(async () => undefined), hasTaskResults: vi.fn(async () => true),
    linkResult: vi.fn(async () => { events.push('link'); }),
  };
}
function execute(client = new BotNodeClient(() => endpoint, 5000, { recordedDelegationIssuer: signer, remoteExecutionAuthority: authority }), input = request) {
  return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
    principalIssuer: actor.issuer, isOperator: false }, () => client.execute(input.agentId, input)));
}

it('durably binds the exact signed body before sending, then stamps only locally prepared result lineage', async () => {
  const result = await execute();
  expect(events).toEqual(['prepare', 'bind', 'http', 'result-check']);
  expect(received[0]).toMatchObject({ applicationExecutionId: executionId, userSub: actor.sub, principalIssuer: actor.issuer });
  expect(result.applicationExecutionId).toBe(executionId); expect(result.response).toBe('PRIVATE ANSWER');
});

it('links a protected result to the trusted parent before exposing it to persistence or cache', async () => {
  const record = vi.fn(async () => { events.push('persist'); });
  await runWithRemoteExecutionResults({ taskId: 'parent-session', record }, () => execute());
  expect(authority.linkResult).toHaveBeenCalledWith(executionId, 'parent-session', actor);
  expect(record).toHaveBeenCalledWith(executionId);
  expect(events.slice(-3)).toEqual(['result-check', 'link', 'persist']);
});

it('does not dispatch when durable binding or recorded signing is unavailable', async () => {
  failBind = true; await expect(execute()).rejects.toThrow('durable unavailable'); expect(received).toEqual([]);
  const client = new BotNodeClient(() => endpoint, 5000, { delegationIssuer: { issue: grant => signer.issue(grant).token }, remoteExecutionAuthority: authority });
  await expect(execute(client)).rejects.toThrow('authorization_recorded_delegation_required'); expect(received).toEqual([]);
});

it('refuses caller-supplied execution references before preparation or network use', async () => {
  await expect(execute(undefined, { ...request, applicationExecutionId: randomUUID() })).rejects.toThrow('authorization_execution_reference_reserved');
  expect(events).toEqual([]); expect(received).toEqual([]);
});

it('withholds successful remote output after revocation without caching its lineage', async () => {
  allowed = false; const record = vi.fn(async () => undefined);
  await expect(runWithRemoteExecutionResults({ taskId: 'parent-session', record }, () => execute())).rejects.toThrow('authorization_remote_execution_failed');
  expect(record).not.toHaveBeenCalled(); expect(authority.linkResult).not.toHaveBeenCalled();
});

it('sanitizes protected remote failures so response text cannot bypass result checks through an error', async () => {
  body = { success: false, error: 'PRIVATE ANSWER', applicationExecutionId: executionId };
  await expect(execute()).rejects.toThrow(/^authorization_remote_execution_failed$/);
});

it('does not accept worker-selected lineage for an unprotected dispatch', async () => {
  authority.prepare = vi.fn(async () => null);
  const result = await execute(); expect(result.applicationExecutionId).toBeUndefined();
  expect(authority.bind).not.toHaveBeenCalled(); expect(authority.assertResultAccess).not.toHaveBeenCalled();
});

it('refuses a retired specialist source after the durable bind await and before HTTP dispatch', async () => {
  let retired = false;
  configureSpecialistContextRegistry({ requires: () => true, append: async (_agent: string, text: string) => text,
    capture: () => () => { if (retired) throw new Error('source retired'); } } as unknown as SpecialistContextRegistry);
  const bind = authority.bind;
  authority.bind = async (...args) => { await bind(...args); retired = true; };
  await expect(execute()).rejects.toThrow('authorization_remote_execution_failed');
  expect(events).toEqual(['prepare', 'bind']); expect(received).toEqual([]);
});

it('captures data-read grants before enrichment so revocation during the read prevents dispatch', async () => {
  const current = await new RemoteExecutionFixture().start(); await current.change({ role: 'reader' });
  configureSpecialistContextRegistry({ requires: () => true, capture: () => () => undefined,
    append: async () => { await current.change({ action: 'revoke', role: 'reader' }); return 'Authorized fact 42'; } } as unknown as SpecialistContextRegistry);
  const client = new BotNodeClient(() => endpoint, 5000, { env: {}, recordedDelegationIssuer: current.issuer, remoteExecutionAuthority: current.authority });
  const result = runWithApplicationAuthorizationActor(current.actor, () => runWithRequestIdentity({ sub: current.actor.sub,
    principalIssuer: current.actor.issuer, isOperator: false }, () => client.execute(request.agentId, { ...request, userSub: current.actor.sub })));
  await expect(result).rejects.toThrow('remote_execution_original_grant_revoked'); expect(received).toEqual([]);
});
