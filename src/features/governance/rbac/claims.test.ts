import { describe, it, expect } from 'vitest';
import { rolesFromClaims, mapClaimRolesToRole } from './claims';
import { resolveRole } from './policy';
import { Role } from './roles';

// Pure tests for IdP-role extraction + mapping, and the combined resolveRole precedence.
// No env mutation needed for claim mapping (env injected); resolveRole reads process.env for the
// allowlists, so those cases set/clear the specific vars they assert.

describe('rolesFromClaims — Keycloak-shaped extraction', () => {
  it('reads realm_access.roles', () => {
    expect(rolesFromClaims({ realm_access: { roles: ['oshal-admin', 'offline_access'] } }))
      .toEqual(['oshal-admin', 'offline_access']);
  });
  it('reads every resource_access[*].roles and lowercases + dedupes', () => {
    const user = {
      resource_access: {
        'oshal-api': { roles: ['Operator'] },
        account: { roles: ['operator', 'manage-account'] },
      },
    };
    expect(rolesFromClaims(user).sort()).toEqual(['manage-account', 'operator']);
  });
  it('reads a flat roles[] fallback', () => {
    expect(rolesFromClaims({ roles: ['viewer'] })).toEqual(['viewer']);
  });
  it('returns [] for null / wrong-typed / missing shapes (never throws)', () => {
    expect(rolesFromClaims(null)).toEqual([]);
    expect(rolesFromClaims('nope')).toEqual([]);
    expect(rolesFromClaims({ realm_access: { roles: 'not-an-array' } })).toEqual([]);
    expect(rolesFromClaims({})).toEqual([]);
  });
});

describe('mapClaimRolesToRole — names → coarse role, highest wins', () => {
  it('maps default admin names', () => {
    expect(mapClaimRolesToRole(['oshal-admin'], {})).toBe(Role.Admin);
    expect(mapClaimRolesToRole(['admin'], {})).toBe(Role.Admin);
  });
  it('maps default operator + viewer names', () => {
    expect(mapClaimRolesToRole(['operator'], {})).toBe(Role.Operator);
    expect(mapClaimRolesToRole(['viewer'], {})).toBe(Role.Viewer);
  });
  it('returns null when nothing matches', () => {
    expect(mapClaimRolesToRole(['random', 'offline_access'], {})).toBeNull();
    expect(mapClaimRolesToRole([], {})).toBeNull();
  });
  it('admin beats operator beats viewer when several present', () => {
    expect(mapClaimRolesToRole(['viewer', 'operator', 'oshal-admin'], {})).toBe(Role.Admin);
    expect(mapClaimRolesToRole(['viewer', 'operator'], {})).toBe(Role.Operator);
  });
  it('honors configurable role-name lists', () => {
    const env = { OSHAL_RBAC_ADMIN_ROLES: 'superuser', OSHAL_RBAC_OPERATOR_ROLES: 'staff' } as unknown as NodeJS.ProcessEnv;
    expect(mapClaimRolesToRole(['superuser'], env)).toBe(Role.Admin);
    expect(mapClaimRolesToRole(['staff'], env)).toBe(Role.Operator);
    // default admin name no longer maps once overridden
    expect(mapClaimRolesToRole(['admin'], env)).toBeNull();
  });
});

describe('resolveRole — claim roles ∪ env allowlist, highest privilege wins', () => {
  const clearEnv = () => {
    for (const k of ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_RBAC_OPERATOR_SUBS', 'OSHAL_RBAC_OPERATOR_EMAILS']) {
      delete process.env[k];
    }
  };

  it('defaults to viewer with no roles and no allowlist (backward compatible)', () => {
    clearEnv();
    expect(resolveRole({ sub: 'u1', email: 'u1@x.com' })).toBe(Role.Viewer);
    expect(resolveRole(null)).toBe(Role.Viewer);
  });

  it('grants admin purely from a token claim (no env edit needed)', () => {
    clearEnv();
    expect(resolveRole({ sub: 'u1', email: 'u1@x.com', roles: ['oshal-admin'] })).toBe(Role.Admin);
  });

  it('still honors the existing operator allowlist → admin', () => {
    clearEnv();
    process.env.OSHAL_OPERATOR_EMAILS = 'boss@x.com';
    expect(resolveRole({ sub: 'u9', email: 'boss@x.com' })).toBe(Role.Admin);
    clearEnv();
  });

  it('allowlist RAISES a viewer-claim caller to admin (highest wins)', () => {
    clearEnv();
    process.env.OSHAL_OPERATOR_SUBS = 'u1';
    expect(resolveRole({ sub: 'u1', email: 'u1@x.com', roles: ['viewer'] })).toBe(Role.Admin);
    clearEnv();
  });

  it('claim admin is NOT lowered by a mere operator allowlist', () => {
    clearEnv();
    process.env.OSHAL_RBAC_OPERATOR_SUBS = 'u1';
    expect(resolveRole({ sub: 'u1', email: 'u1@x.com', roles: ['oshal-admin'] })).toBe(Role.Admin);
    clearEnv();
  });
});
