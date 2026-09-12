/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify bounded facts, trusted identity, activation staging and in-flight revocation without external data.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { SpecialistContextRegistry, type SpecialistContextDeclaration } from '@/shared/specialist-context';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import type { AuthorizationActor } from '@/shared/application-authorization';

const actor: AuthorizationActor = { sub: 'alice', issuer: 'https://context.fixture.test', isActive: true, isSwarmAdmin: true };
const principal = { sub: actor.sub, issuer: actor.issuer };
const identity = { sub: actor.sub, principalIssuer: actor.issuer, isOperator: true };
function caller<T>(fn: () => Promise<T>) { return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity(identity, fn)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(read: SpecialistContextDeclaration['read'] = async () => ({ 'documents.out': 2 }), timeoutMs = 100) {
  const decision = { allowed: true, reason: 'allowed', decisionId: 'fixture', revision: 1, app: 'fixture-app', grants: [] };
  const authorize = vi.fn(async () => ({ ...decision }));
  const registry = new SpecialistContextRegistry({ owner: (_kind, id) => id.startsWith('other') ? 'other-app' : 'fixture-app', authorize }, { timeoutMs });
  const declaration = { agentId: 'specialist', toolName: 'read-board-counts', facts: ['documents.out'], read };
  const stage = registry.stage('fixture-app'); stage.port.register(declaration); stage.publish();
  return { registry, authorize, decision, declaration };
}
afterEach(() => configureApplicationExecutionPolicy(undefined));

it('passes only frozen caller identity and an abort signal, and narrows operator database authority', async () => {
  const read = vi.fn(async input => {
    expect(Object.keys(input).sort()).toEqual(['issuer', 'signal', 'sub']); expect(Object.isFrozen(input)).toBe(true);
    expect(getRequestIdentity()).toEqual({ ...identity, isOperator: false }); return { 'documents.out': 2 };
  });
  const { registry, authorize } = fixture(read);
  expect(await caller(() => registry.append('specialist', 'Summarize my board', principal)))
    .toBe('Summarize my board\n\nApplication facts (fixture-app; read-board-counts):\n{"documents.out":2}');
  expect(read).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledTimes(2);
  expect(authorize).toHaveBeenCalledWith(actor, { app: 'fixture-app', kind: 'tools', operation: 'read-board-counts' });
});

it('requires matching actor, request identity and issuer, and refuses a system identity', async () => {
  const read = vi.fn(async () => ({ 'documents.out': 2 })); const { registry } = fixture(read);
  await expect(registry.append('specialist', '', principal)).rejects.toThrow('specialist_context_identity_required');
  await expect(caller(() => registry.append('specialist', '', { ...principal, sub: 'other' }))).rejects.toThrow('identity_required');
  await expect(caller(() => registry.append('specialist', '', { ...principal, issuer: 'https://forged.test' }))).rejects.toThrow('identity_required');
  await expect(runWithApplicationAuthorizationActor(actor, () => runWithSystemIdentity(() => registry.append('specialist', '', principal))))
    .rejects.toThrow('identity_required');
  expect(read).not.toHaveBeenCalled();
});

it.each([
  { 'documents.out': 'placeholder-credential' }, { 'documents.out': { count: 2 } }, { 'documents.out': Infinity },
  { 'documents.out': 2, token: 'placeholder-credential' }, {}, Object.defineProperty({}, 'documents.out', { enumerable: true, get: () => 2 }),
])('rejects undeclared, non-finite, textual or accessor facts: %j', async value => {
  const { registry } = fixture(async () => value as never);
  await expect(caller(() => registry.append('specialist', '', principal))).rejects.toThrow('specialist_context_result_invalid');
});

it('accepts declared boolean/null facts with deterministic key ordering', async () => {
  const { registry, declaration } = fixture(); const stage = registry.stage('fixture-app');
  stage.port.register({ ...declaration, facts: ['available', 'estimate'], read: async () => ({ estimate: null, available: false }) }); stage.publish();
  expect(await caller(() => registry.append('specialist', '', principal))).toContain('{"available":false,"estimate":null}');
});

it('rejects ownership mistakes, duplicate registrations and delayed factory registration', () => {
  const { registry, declaration } = fixture(); const stage = registry.stage('fixture-app');
  expect(() => stage.port.register({ ...declaration, agentId: 'other-specialist' })).toThrow('owner_mismatch');
  expect(() => stage.port.register({ ...declaration, toolName: 'other-reader' })).toThrow('owner_mismatch');
  stage.port.register(declaration); expect(() => stage.port.register(declaration)).toThrow('duplicate'); stage.publish();
  expect(() => stage.port.register(declaration)).toThrow('registration_closed');
});

it('rolls back failed factory contributions and remembers a retired reader requirement', async () => {
  const { registry, declaration } = fixture(); const stage = registry.stage('fixture-app');
  stage.port.register(declaration); stage.rollback(0); stage.publish();
  expect(registry.requires('specialist')).toBe(true);
  await expect(caller(() => registry.append('specialist', '', principal))).rejects.toThrow('context_unavailable');
});

it('remembers a first accepted requirement even when its factory never publishes', () => {
  const { registry, declaration } = fixture(); const stage = registry.stage('fixture-app');
  stage.port.register({ ...declaration, agentId: 'new-specialist' }); stage.rollback(0); stage.abort();
  expect(registry.requires('new-specialist')).toBe(true); expect(() => registry.capture('new-specialist')).toThrow('context_unavailable');
});

it('never publishes a superseded activation or an activation canceled by unmount', async () => {
  const { registry, declaration } = fixture(); const old = registry.stage('fixture-app'); old.port.register(declaration);
  const next = registry.stage('fixture-app'); next.port.register({ ...declaration, read: async () => ({ 'documents.out': 7 }) }); next.publish();
  expect(() => old.publish()).toThrow('registration_superseded'); old.abort();
  expect(await caller(() => registry.append('specialist', '', principal))).toContain('{"documents.out":7}');
  const canceled = registry.stage('fixture-app'); canceled.port.register(declaration); registry.unregister('fixture-app');
  expect(() => canceled.publish()).toThrow('registration_superseded');
});

it('aborts timed-out reads and suppresses package exception details', async () => {
  let signal: AbortSignal | undefined;
  const { registry } = fixture(async input => { signal = input.signal; return new Promise(() => undefined); }, 20);
  await expect(caller(() => registry.append('specialist', '', principal))).rejects.toThrow('specialist_context_timeout'); expect(signal?.aborted).toBe(true);
  const failing = fixture(async () => { throw new Error('postgres://secret-private-connection'); });
  await expect(caller(() => failing.registry.append('specialist', '', principal))).rejects.toThrow(/^specialist_context_read_failed$/);
});

it('refuses facts when permission is revoked during the read', async () => {
  const started = deferred<void>(), finish = deferred<Record<string, number>>();
  const { registry, decision } = fixture(async () => { started.resolve(); return finish.promise; });
  const pending = caller(() => registry.append('specialist', '', principal)); await started.promise;
  decision.allowed = false; finish.resolve({ 'documents.out': 2 });
  await expect(pending).rejects.toThrow('specialist_context_permission_denied');
});

it('refuses facts when unmount happens during the final authority check', async () => {
  const { registry, authorize, decision } = fixture(); const started = deferred<void>(), finish = deferred<void>();
  authorize.mockImplementationOnce(async () => ({ ...decision })).mockImplementationOnce(async () => {
    started.resolve(); await finish.promise; return { ...decision };
  });
  const pending = caller(() => registry.append('specialist', '', principal)); await started.promise;
  registry.unregister('fixture-app'); finish.resolve(); await expect(pending).rejects.toThrow('specialist_context_changed');
});

it.each(['initial', 'final'])('bounds a stalled %s authority check and never starts a late reader', async phase => {
  const read = vi.fn(async () => ({ 'documents.out': 2 })); const { registry, authorize, decision } = fixture(read, 20);
  const finish = deferred<void>();
  if (phase === 'final') authorize.mockImplementationOnce(async () => ({ ...decision }));
  authorize.mockImplementationOnce(async () => { await finish.promise; return { ...decision }; });
  await expect(caller(() => registry.append('specialist', '', principal))).rejects.toThrow('specialist_context_timeout');
  finish.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(phase === 'initial' ? 0 : 1);
});
