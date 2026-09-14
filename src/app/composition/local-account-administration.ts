/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Protect current-root status and credentials in the same transaction as concurrent role changes.
 */
import type { Pool, PoolClient } from 'pg';
import { getUserById, setUserStatus, type LocalUser } from '@/features/local-auth';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
/** @description Change an authorized local account status while retaining the swarm's root account.
 * @param pool Control-plane pool. @param id Exact local account ID. @param status Requested status.
 * @returns Updated account or null. @throws 409 if the current root would be disabled.
 */
export async function changeLocalAccountStatus(pool: Pool, id: string, status: 'active' | 'disabled'): Promise<LocalUser | null> {
  return accountTransaction(pool, async client => {
    const user = await getUserById(client, id);
    if (!user) return null;
    if (status === 'disabled') {
      const root = await client.query("SELECT 1 FROM swarm_roles WHERE user_sub=$1 AND role='root'", [user.userSub]);
      if (root.rows.length) throw Object.assign(new Error('Transfer swarm root before disabling this account.'), { status: 409 });
    }
    return setUserStatus(client, id, status);
  });
}
/** @description Protect root credentials against a different administrator or a service credential.
 * @param pool Control-plane pool. @param input Exact account selector and authenticated caller.
 * @param operation Credential update, inside the role/account transaction. @returns The committed operation result.
 */
export async function withLocalAccountRecovery<T>(pool: Pool, input: {
  id?: string; email?: string; callerSub: string | null; callerIssuer: string | null;
}, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return accountTransaction(pool, async client => {
    const field = input.id !== undefined ? 'id' : 'email';
    const target = input.id ?? (input.email ?? '').trim().toLowerCase();
    const result = await client.query(`SELECT r.user_sub FROM swarm_roles r JOIN oshal_local_users u ON u.user_sub=r.user_sub
      WHERE r.role='root' AND u.${field}=$1`, [target]);
    if (result.rows.length && (input.callerIssuer !== LOCAL_AUTH_PRINCIPAL_ISSUER || input.callerSub !== result.rows[0].user_sub)) {
      throw Object.assign(new Error('Only the current root may reset root account credentials.'), { status: 403 });
    }
    return operation(client);
  });
}
async function accountTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE oshal_local_users, swarm_roles IN SHARE ROW EXCLUSIVE MODE');
      const result = await operation(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
}
