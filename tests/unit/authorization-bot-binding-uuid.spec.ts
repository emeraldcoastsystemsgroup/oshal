/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard: a package catalog can bind its own bot when the agentId is a digit-first UUID (Intelligent Sales' concierge 15000000-…-0001), through the YAML loader and the real authorization service; every other binding kind and every non-canonical UUID still fails the identifier rule.
 */
import { describe, it, expect } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '../../src/features/application-authorization';
import { validateAuthorizationCatalog, parseAuthorizationCatalog, type AuthorizationActor, type AuthorizationCatalog } from '../../src/shared/application-authorization';

const BOT = '15000000-0000-0000-0000-000000000001';
const APP = 'crm-fixture';
const admin: AuthorizationActor = { sub: 'admin', issuer: 'fixture', isActive: true, isSwarmAdmin: true, tenantIds: [] };
const rep: AuthorizationActor = { sub: 'rep', issuer: 'fixture', isActive: true, isSwarmAdmin: false, tenantIds: [] };

function catalog(bindings: AuthorizationCatalog['bindings']): AuthorizationCatalog {
  return {
    version: 1,
    resources: { crm: { scopes: ['own'] } },
    permissions: { 'crm.concierge.invoke': { resource: 'crm', effect: 'execute', minimumTier: 'editor' } },
    roles: { sales_rep: { tier: 'editor', grants: [{ permission: 'crm.concierge.invoke', scope: 'own' }] } },
    bindings,
  };
}
const ALLOW = ['crm.concierge.invoke'];

describe('bot binding ids', () => {
  it('accepts a digit-first canonical UUID agentId for a bots binding, including from package YAML', () => {
    expect(() => validateAuthorizationCatalog(catalog({ bots: [{ id: BOT, allOf: ALLOW }] }))).not.toThrow();
    const yaml = [
      'version: 1',
      'resources: { crm: { scopes: [own] } }',
      'permissions: { crm.concierge.invoke: { resource: crm, effect: execute, minimumTier: editor } }',
      'roles: { sales_rep: { tier: editor, grants: [ { permission: crm.concierge.invoke, scope: own } ] } }',
      `bindings: { bots: [ { id: ${BOT}, allOf: [crm.concierge.invoke] } ] }`,
    ].join('\n');
    expect(parseAuthorizationCatalog(yaml).bindings.bots).toEqual([{ id: BOT, allOf: ALLOW }]);
  });

  it.each([
    '15000000-0000-0000-0000-00000000000',
    '15000000-0000-0000-0000-0000000000011',
    '15000000-0000-0000-0000-00000000000A',
    '15000000-0000-0000-0000-00000000000g',
    ` ${BOT}`,
    '1abc',
    '__proto__',
  ])('still refuses a malformed bot binding id %j', bad => {
    expect(() => validateAuthorizationCatalog(catalog({ bots: [{ id: bad, allOf: ALLOW }] }))).toThrow(/invalid identifier/);
  });

  it.each(['tools', 'jobs', 'artifactActions'] as const)('keeps the identifier rule for %s bindings', kind => {
    expect(() => validateAuthorizationCatalog(catalog({ [kind]: [{ id: BOT, allOf: ALLOW }] }))).toThrow(/invalid identifier/);
  });

  it('keeps the identifier rule for http binding ids', () => {
    const http = [{ id: BOT, method: 'GET' as const, path: '/me', allOf: ALLOW }];
    expect(() => validateAuthorizationCatalog(catalog({ http }))).toThrow(/invalid identifier/);
  });
});

describe('bot binding ids through the real authorization service', () => {
  it('admits a granted user to the UUID-bound bot and refuses the ungranted and the unbound', async () => {
    const service = new ApplicationAuthorizationService(new MemoryAuthorizationStore(), {
      resolveActor: async (sub, issuer) => ({ ...rep, sub, issuer }),
    });
    await service.registerApp({ app: APP, source: 'fixture', version: '1', catalog: catalog({ bots: [{ id: BOT, allOf: ALLOW }] }), mode: 'enforce' });
    service.registerResourceAdapter(APP, 'crm', { authorize: async () => true });

    const before = await service.authorize(rep, { app: APP, kind: 'bots', operation: BOT });
    expect(before.allowed).toBe(false);

    const revision = (await service.catalog(admin)).revision;
    const preview = await service.previewChange(admin, { action: 'grant', app: APP, role: 'sales_rep', targetSub: rep.sub,
      targetIssuer: rep.issuer, reason: 'Bot binding regression fixture', expectedRevision: revision });
    await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: preview.previewId });

    expect((await service.authorize(rep, { app: APP, kind: 'bots', operation: BOT })).allowed).toBe(true);
    const unbound = await service.authorize(rep, { app: APP, kind: 'bots', operation: '25000000-0000-0000-0000-000000000002' });
    expect(unbound.allowed).toBe(false);
    expect(unbound.reason).toBe('authorization_operation_unbound');
  });
});
