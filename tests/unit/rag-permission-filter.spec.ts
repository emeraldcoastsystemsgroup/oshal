/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard permission-filter owner, explicit-user, group, tenant, operator, and public grants.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact owner/allowed-user OIDC subject matching while retaining case-insensitive verified-email grants.
 */

import { describe, expect, it } from 'vitest';
import {
  canReadRagMetadata,
  filterRagHitsByPermission,
  permissionBasisForRagMetadata,
} from '../../src/features/rag/services/permission-filter';

describe('permission-aware RAG filter foundation', () => {
  it('allows owner, explicit user, and group access', () => {
    expect(permissionBasisForRagMetadata({ owner_sub: 'user-a' }, { userSub: 'user-a' })).toBe('owner');
    expect(permissionBasisForRagMetadata({ allowed_users: 'user-b,user-c' }, { userSub: 'user-c' })).toBe('explicit-user');
    expect(permissionBasisForRagMetadata({ allowed_groups: ['Finance', 'Ops'] }, { userSub: 'user-x', groups: ['ops'] })).toBe('group');
  });

  it('matches OIDC subjects exactly but verified source emails case-insensitively', () => {
    const exactSub = ' Auth0|Case-Owner ';
    expect(permissionBasisForRagMetadata({ owner_sub: exactSub }, { userSub: exactSub })).toBe('owner');
    expect(permissionBasisForRagMetadata({ owner_sub: exactSub }, { userSub: 'Auth0|Case-Owner' })).toBeNull();
    expect(permissionBasisForRagMetadata({ allowed_users: [exactSub] }, { userSub: exactSub })).toBe('explicit-user');
    expect(permissionBasisForRagMetadata({ allowed_users: [exactSub] }, { userSub: 'Auth0|Case-Owner' })).toBeNull();
    expect(permissionBasisForRagMetadata(
      { allowed_users: 'Alice@Corp.Example' },
      { userSub: 'oidc|alice', emails: ['alice@corp.example'] },
    )).toBe('explicit-user');
  });

  it('denies tenant mismatch before user or group grants', () => {
    expect(canReadRagMetadata(
      { tenant_id: 'tenant-a', owner_sub: 'user-a', allowed_groups: ['ops'] },
      { userSub: 'user-a', tenantId: 'tenant-b', groups: ['ops'] },
    )).toBe(false);
  });

  it('denies unowned public chunks unless explicitly allowed', () => {
    expect(canReadRagMetadata({}, { userSub: 'user-a' })).toBe(false);
    expect(permissionBasisForRagMetadata({}, { userSub: 'user-a', allowPublic: true })).toBe('public');
  });

  it('allows operators to inspect all chunks', () => {
    expect(permissionBasisForRagMetadata(
      { tenant_id: 'other-tenant', owner_sub: 'other-user' },
      { userSub: 'operator', tenantId: 'tenant-a', isOperator: true },
    )).toBe('operator');
  });

  it('filters hits and annotates the permission basis', () => {
    const hits = [
      { id: 'mine', metadata: { owner_sub: 'user-a' } },
      { id: 'group', metadata: { allowed_groups: 'ops' } },
      { id: 'other', metadata: { owner_sub: 'user-b' } },
    ];

    const filtered = filterRagHitsByPermission(hits, { userSub: 'user-a', groups: ['ops'] });

    expect(filtered.map((entry) => entry.hit.id)).toEqual(['mine', 'group']);
    expect(filtered.map((entry) => entry.permissionBasis)).toEqual(['owner', 'group']);
  });
});
