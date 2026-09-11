/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reject correctly signed but mismatched or stale controller permits at real worker HTTP boundaries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBotControllerPermitCheck } from '@/app/bot-node-controller-permit';
import { startProtectedWorkerFixture } from '../fixtures/bot-node-protected-execution';
import type { RemoteExecutionPermit } from '@/shared/application-remote-execution';
import type { DelegationTokenClaims } from '@/shared/types';

let fixture: Awaited<ReturnType<typeof startProtectedWorkerFixture>>;
beforeEach(async () => { fixture = await startProtectedWorkerFixture(); });
afterEach(async () => { await fixture?.close(); });

describe('signed controller permit exactness', () => {
  const mutations: Array<[string, (permit: RemoteExecutionPermit) => void]> = [
    ['nonce', p => { p.nonce = randomUUID(); }], ['phase', p => { p.phase = 'complete'; }],
    ['execution', p => { p.executionId = randomUUID(); }], ['app', p => { p.app = 'different-app'; }],
    ['agent', p => { p.agentId = 'different-agent'; }], ['task', p => { p.taskId = 'different-task'; }],
    ['workspace', p => { p.workspaceId = 'different-workspace'; }], ['subject', p => { p.sub = 'different-sub'; }],
    ['issuer', p => { p.issuer = 'https://other.fixture.test'; }], ['dispatch', p => { p.dispatchJti = randomUUID(); }],
    ['expired', p => { p.expiresAt = new Date(Date.now() - 1).toISOString(); }],
    ['overlong lease', p => { p.expiresAt = new Date(Date.now() + 60_000).toISOString(); }],
    ['unsolicited action', p => { p.action = { kind: 'tools', operation: 'write' }; }],
  ];
  it.each(mutations)('rejects signed %s mismatch before task or provider', async (_name, mutate) => {
    fixture.state.mutatePermit = mutate;
    const response = await fixture.post(fixture.issue());
    expect(response.status).toBe(503);
    expect(fixture.store.listTasks()).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('rejects alteration after signing and tenant/scope escalation on subsequent checks', async () => {
    fixture.state.mutateSignedPermit = p => { p.app = 'unsigned-app'; };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    fixture.state.mutateSignedPermit = undefined;
    fixture.state.mutatePermit = p => { if (p.phase === 'work') p.tenantId = 'foreign-tenant'; };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    fixture.state.mutatePermit = p => { if (p.phase === 'work') p.allowedPermissions.push('foreign-app:admin'); };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    expect(fixture.state.calls).toEqual([]);
  });
});

describe('fixed controller destination', () => {
  it.each(['https://user:password@fixture.test', 'https://fixture.test/wrong-path',
    'https://fixture.test?redirect=elsewhere', 'https://fixture.test/#fragment', 'file:///tmp/permit'])('rejects unsafe configuration %s', url => {
    expect(() => createBotControllerPermitCheck({ env: { ...fixture.env, SWARM_CONTROLLER_URL: url } })).toThrow();
  });

  it('bounds controller response bytes and refuses an unavailable response', async () => {
    const request = fixture.issue();
    const claims = JSON.parse(Buffer.from(request.token.split('.')[1], 'base64url').toString('utf8')) as DelegationTokenClaims;
    const binding = { executionId: request.body.applicationExecutionId, app: 'fixture-business', agentId: request.body.agentId,
      taskId: request.body.taskId, workspaceId: request.body.workspaceFolderId, sub: request.body.userSub, issuer: request.body.principalIssuer };
    const oversized = createBotControllerPermitCheck({ env: fixture.env,
      fetchImpl: async () => new Response('x'.repeat(32_769), { status: 200 }) });
    await expect(oversized(binding, claims, request.token, 'start')).rejects.toThrow('too large');
    const unavailable = createBotControllerPermitCheck({ env: fixture.env,
      fetchImpl: async () => new Response('{}', { status: 503 }) });
    await expect(unavailable(binding, claims, request.token, 'start')).rejects.toThrow('denied');
  });

  it('aborts a stalled controller request at its fixed timeout', async () => {
    const request = fixture.issue();
    const claims = JSON.parse(Buffer.from(request.token.split('.')[1], 'base64url').toString('utf8')) as DelegationTokenClaims;
    const check = createBotControllerPermitCheck({ env: fixture.env, timeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        expect(init?.redirect).toBe('error');
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture_aborted')), { once: true });
      }) });
    await expect(check({ executionId: request.body.applicationExecutionId, app: 'fixture-business', agentId: request.body.agentId,
      taskId: request.body.taskId, workspaceId: request.body.workspaceFolderId, sub: request.body.userSub, issuer: request.body.principalIssuer },
    claims, request.token, 'start')).rejects.toThrow('fixture_aborted');
  });
});
