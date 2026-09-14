/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Distinguish a fresh installation from existing local, role or verified external accounts.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
/** @description Check established identity state without listing users or creating schema.
 * @param pool Read-only query port; local-auth schema is already available. @returns True when first-root setup must remain closed.
 */
export async function hasEstablishedInstallation(pool: Pick<Pool, 'query'>): Promise<boolean> {
  return runWithSystemIdentity(async () => {
    if ((await pool.query('SELECT 1 FROM oshal_local_users LIMIT 1')).rows.length) return true;
    for (const table of ['swarm_roles','oshal_verified_principals','oshal_installer_root_setup']) {
      const exists = await pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present',[table]);
      if (!exists.rows[0]?.present) continue;
      // Table names are a fixed code-owned list, never caller input.
      const where = table === 'oshal_installer_root_setup' ? ' WHERE completed_at IS NOT NULL' : '';
      if ((await pool.query(`SELECT 1 FROM ${table}${where} LIMIT 1`)).rows.length) return true;
    }
    return false;
  });
}
