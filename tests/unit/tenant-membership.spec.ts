import { describe, expect, it } from 'vitest';
import { listTenantMembers, removeMember, setMemberRole } from '../../src/app/routes/connector-tenancy';

/** In-memory tenant membership pool: answers the exact queries the functions issue. */
function fakeDb(members: Array<{ user_sub: string; role: string }>) {
  const deleted: string[] = [];
  const updated: Array<{ sub: string; role: string }> = [];
  return {
    deleted,
    updated,
    async query(sql: string, params: any[]) {
      if (/SELECT 1/.test(sql) && /role = 'admin'/.test(sql)) {
        const userSub = params[1];
        return { rows: members.some((m) => m.user_sub === userSub && m.role === 'admin') ? [{ ok: 1 }] : [] };
      }
      if (/count\(\*\)::int AS n/.test(sql)) {
        return { rows: [{ n: members.filter((m) => m.role === 'admin').length }] };
      }
      if (/SELECT role FROM oshal_tenant_memberships/.test(sql)) {
        const m = members.find((x) => x.user_sub === params[1]);
        return { rows: m ? [{ role: m.role }] : [] };
      }
      if (/SELECT user_sub, role FROM oshal_tenant_memberships/.test(sql)) {
        return { rows: members.map((m) => ({ user_sub: m.user_sub, role: m.role })) };
      }
      if (/^\s*UPDATE oshal_tenant_memberships SET role/.test(sql)) {
        const exists = members.some((m) => m.user_sub === params[1]);
        if (exists) updated.push({ sub: params[1], role: params[2] });
        return { rowCount: exists ? 1 : 0, rows: [] };
      }
      if (/^\s*DELETE FROM oshal_tenant_memberships/.test(sql)) {
        deleted.push(params[1]);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

describe('listTenantMembers', () => {
  it('returns the tenant members with their roles', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'member' }]);
    expect(await listTenantMembers(db, 't1')).toEqual([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'member' }]);
  });
});

describe('removeMember', () => {
  it('an admin can remove a member', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'member' }]);
    await removeMember(db, 't1', 'b', 'a');
    expect(db.deleted).toEqual(['b']);
  });

  it('rejects a non-admin caller', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'member' }, { user_sub: 'b', role: 'member' }]);
    await expect(removeMember(db, 't1', 'b', 'a')).rejects.toThrow('not a tenant admin');
    expect(db.deleted).toEqual([]);
  });

  it('refuses to remove the last admin (no orphaned tenant)', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }]);
    await expect(removeMember(db, 't1', 'a', 'a')).rejects.toThrow('cannot remove the last admin');
    expect(db.deleted).toEqual([]);
  });

  it('removes an admin when another admin remains', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'admin' }]);
    await removeMember(db, 't1', 'b', 'a');
    expect(db.deleted).toEqual(['b']);
  });
});

describe('setMemberRole', () => {
  it('an admin can promote a member to admin', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'member' }]);
    await setMemberRole(db, 't1', 'b', 'admin', 'a');
    expect(db.updated).toEqual([{ sub: 'b', role: 'admin' }]);
  });

  it('rejects a non-admin caller', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'member' }, { user_sub: 'b', role: 'member' }]);
    await expect(setMemberRole(db, 't1', 'b', 'admin', 'a')).rejects.toThrow('not a tenant admin');
    expect(db.updated).toEqual([]);
  });

  it('refuses to demote the last admin', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }]);
    await expect(setMemberRole(db, 't1', 'a', 'member', 'a')).rejects.toThrow('cannot demote the last admin');
    expect(db.updated).toEqual([]);
  });

  it('demotes an admin when another admin remains', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }, { user_sub: 'b', role: 'admin' }]);
    await setMemberRole(db, 't1', 'b', 'member', 'a');
    expect(db.updated).toEqual([{ sub: 'b', role: 'member' }]);
  });

  it('throws when the member does not exist', async () => {
    const db = fakeDb([{ user_sub: 'a', role: 'admin' }]);
    await expect(setMemberRole(db, 't1', 'zzz', 'member', 'a')).rejects.toThrow('member not found');
  });
});
