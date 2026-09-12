/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove unattended execution re-resolves an exact observed account and its current administrator authority.
 */
import type { Request } from 'express';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { resolveTestLabScheduledActor } from '@/app/composition/test-lab-schedule-wiring';
import type { AuthorizationActor } from '@/shared/application-authorization';

function fixture() {
  const principal = { issuer: 'https://schedule-provider.test', sub: 'owner' };
  const state = { active: true, admin: true, targetIssuer: principal.issuer, reads: 0 };
  const current = createApplicationAuthorizationActorResolver({} as Pool, { env: {}, tenantIds: async () => [],
    nativePrincipal: async () => { state.reads++; return { isActive: state.active, isSwarmAdmin: state.admin }; } });
  const ports = {
    targetActor: async (): Promise<AuthorizationActor> => ({ ...principal, issuer: state.targetIssuer,
      isActive: state.active, isSwarmAdmin: false, directory: [] }),
    refreshActor: async (original: AuthorizationActor) => {
      expect(original.directory).toEqual([]); expect(original.allowedPermissions).toBeUndefined();
      const resolved = await current({ headers: {}, oidc: { isAuthenticated: () => true,
        user: { iss: original.issuer, sub: original.sub } } } as unknown as Request);
      return { ...resolved, isSwarmAdmin: resolved.isSwarmAdmin && original.isSwarmAdmin };
    },
  };
  return { principal, state, ports };
}

it('uses current provider administrator status and refuses the same saved owner after revocation', async () => {
  const f = fixture();
  expect(await resolveTestLabScheduledActor(f.ports, f.principal)).toMatchObject({ ...f.principal, isSwarmAdmin: true, directory: [] });
  f.state.admin = false;
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('authority is unavailable');
  expect(f.state.reads).toBe(2);
});

it('refuses disabled or wrong-issuer account lookup before current authority is considered', async () => {
  const f = fixture(); f.state.active = false;
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('account is unavailable');
  f.state.active = true; f.state.targetIssuer = 'https://another-provider.test';
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('account is unavailable');
  expect(f.state.reads).toBe(0);
});
