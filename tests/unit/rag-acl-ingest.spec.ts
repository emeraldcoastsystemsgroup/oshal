import { describe, expect, it } from 'vitest';
import { ragAclFromBody, ragAclFromConnection, tenantGroup } from '../../src/app/routes/rag-routes';
import { permissionBasisForRagMetadata } from '../../src/features/rag/services/permission-filter';

describe('ragAclFromBody (ingest ACL extraction)', () => {
  it('stamps owner + groups + users, and expresses a tenant share as a tenant group', () => {
    const acl = ragAclFromBody(
      { allowedGroups: ['Eng', 'Ops'], allowedUsers: 'u1,u2', tenantId: 'acme' },
      'owner-1',
    );
    expect(acl).toEqual({
      owner_sub: 'owner-1',
      allowed_groups: 'Eng,Ops,tenant:acme',
      allowed_users: 'u1,u2',
    });
  });

  it('accepts snake_case + csv lists and trims/drops empties', () => {
    expect(ragAclFromBody({ allowed_groups: ' a , b ,,c ' }, null)).toEqual({ allowed_groups: 'a,b,c' });
  });

  it('returns empty metadata for shared/public ingest (no ACL, no owner)', () => {
    expect(ragAclFromBody({}, null)).toEqual({});
  });
});

describe('ACL ingest -> retrieval filter (end-to-end)', () => {
  it('group-shared chunk: readable in-group, denied out-of-group', () => {
    const md = ragAclFromBody({ allowedGroups: ['eng'] }, null);
    expect(permissionBasisForRagMetadata(md, { userSub: 'x', groups: ['eng'] })).toBe('group');
    expect(permissionBasisForRagMetadata(md, { userSub: 'y', groups: ['sales'] })).toBeNull();
  });

  it('tenant-shared chunk: readable by a member (has the tenant group), denied to a non-member', () => {
    const md = ragAclFromBody({ tenantId: 'acme' }, null);
    expect(md.allowed_groups).toBe('tenant:acme');
    expect(permissionBasisForRagMetadata(md, { userSub: 'x', groups: [tenantGroup('acme')] })).toBe('group');
    expect(permissionBasisForRagMetadata(md, { userSub: 'y', groups: [tenantGroup('other')] })).toBeNull();
  });

  it('owner-private chunk stays owner-scoped', () => {
    const md = ragAclFromBody({ private: true }, 'owner-1');
    expect(permissionBasisForRagMetadata(md, { userSub: 'owner-1' })).toBe('owner');
    expect(permissionBasisForRagMetadata(md, { userSub: 'someone-else' })).toBeNull();
  });
});

describe('ragAclFromConnection (connector-source ACL sync)', () => {
  it('a tenant-shared connection grants to that tenant via a tenant group', () => {
    const md = ragAclFromConnection({ tenant_id: 't1' });
    expect(md).toEqual({ allowed_groups: 'tenant:t1' });
    expect(permissionBasisForRagMetadata(md, { userSub: 'a', groups: [tenantGroup('t1')] })).toBe('group');
    expect(permissionBasisForRagMetadata(md, { userSub: 'b', groups: [tenantGroup('t2')] })).toBeNull();
  });

  it('a personal connection grants to its owner (connected_by wins, else user_sub)', () => {
    expect(ragAclFromConnection({ user_sub: 'u1' })).toEqual({ owner_sub: 'u1' });
    expect(ragAclFromConnection({ tenant_id: null, connected_by_sub: 'grantor', user_sub: 'u1' })).toEqual({ owner_sub: 'grantor' });
  });

  it('an ownerless, tenantless connection yields no ACL (public corpus behavior)', () => {
    expect(ragAclFromConnection({})).toEqual({});
  });
});
