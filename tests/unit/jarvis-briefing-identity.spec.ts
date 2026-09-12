/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep legacy scheduler recipients exact and require existing business grants even for platform administrators.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBriefingAccessCheck, createBriefingRecipientResolver } from '@/app/composition/jarvis-briefing-wiring';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import type { VerifiedPrincipal } from '@/features/principal-directory';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const local: AuthorizationActor = { sub: 'same-subject', issuer: LOCAL_AUTH_PRINCIPAL_ISSUER, isActive: true, isSwarmAdmin: false };
const native: AuthorizationActor = { ...local, issuer: 'https://accounts.google.com' };
const env = { LOCAL_AUTH: 'true', ENTRA_LOCAL_IDENTITY_BRIDGE: 'true', GOOGLE_LOGIN: 'true', GOOGLE_OIDC_CLIENT_ID: 'fixture-client', GOOGLE_OIDC_CLIENT_SECRET: 'fixture-value' };
const observed = (patch: Partial<VerifiedPrincipal> = {}): VerifiedPrincipal => ({ issuer: native.issuer, sub: native.sub, provider: 'google', email: null,
  emailVerified: false, displayName: null, canonicalLocalSub: null, status: 'active', firstSeenAt: new Date(0).toISOString(), lastSeenAt: new Date().toISOString(), ...patch });

describe('briefing recipient identity', () => {
  it('refuses same-subject ambiguity, disabled providers, and disabled accounts', async () => {
    const records = [observed()];
    const target = async (sub: string, issuer: string) => sub === local.sub ? issuer === local.issuer ? local : native : null;
    expect(await createBriefingRecipientResolver({ list: async () => records }, target, env)(local.sub)).toBeNull();
    expect(await createBriefingRecipientResolver({ list: async () => records }, async () => ({ ...native, isActive: false }), env)(local.sub)).toBeNull();
    expect(await createBriefingRecipientResolver({ list: async () => records }, async () => native, { LOCAL_AUTH: 'true' })(local.sub)).toBeNull();
  });
  it('deduplicates only an explicit bridge to the exact canonical local subject', async () => {
    const target = async (_sub: string, issuer: string) => issuer === local.issuer ? local : null;
    expect(await createBriefingRecipientResolver({ list: async () => [observed({ canonicalLocalSub: local.sub })] }, target, env)(local.sub)).toEqual(local);
    expect(await createBriefingRecipientResolver({ list: async () => [observed({ canonicalLocalSub: 'other-local' })] }, async () => null, env)(local.sub)).toBeNull();
  });
});

it('real no-catalog policy permits existing explicit local/native app grants and never infers a root business grant', async () => {
  const store = new MemoryAuthorizationStore(); const policy = new ApplicationAuthorizationService(store);
  await policy.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', mode: 'enforce', catalog: null });
  const manager: AuthorizationActor = { sub: 'separate-manager', issuer: local.issuer, isActive: true, isSwarmAdmin: true };
  let active = true;
  const access = createBriefingAccessCheck({
    targetActor: async (sub, issuer) => ({ sub, issuer, isActive: active, isSwarmAdmin: false }), isProtected: async () => true,
    runtime: { canDiscover: async () => true, authorize: (actor: AuthorizationActor, operation: Parameters<typeof policy.authorize>[1]) => policy.authorize(actor, operation) } as never,
  });
  expect(await access({ ...local, isSwarmAdmin: true }, 'fixture-app')).toBe(false);
  for (const actor of [local, native]) {
    const preview = await policy.previewChange(manager, { action: 'grant', app: 'fixture-app', targetSub: actor.sub, targetIssuer: actor.issuer,
      role: '@app-admin', reason: 'Isolated existing-grant delivery proof', expectedRevision: (await store.read()).revision });
    await policy.applyChange(manager, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
    expect(await access(actor, 'fixture-app')).toBe(true);
  }
  active = false; expect(await access(local, 'fixture-app')).toBe(false);
});

it('refreshes current account availability even for an unprotected legacy application', async () => {
  let active = true;
  const check = createBriefingAccessCheck({ targetActor: async () => ({ ...local, isActive: active }), isProtected: async () => false,
    runtime: { canDiscover: async () => true } as never });
  expect(await check(local, 'fixture-app')).toBe(true); active = false;
  expect(await check(local, 'fixture-app')).toBe(false);
});
