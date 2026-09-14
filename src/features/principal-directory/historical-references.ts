/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Surface bounded issuerless account references without treating them as verified identities or migrating ownership.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const SOURCES = [
  ['oshal_connections', 'user_sub', 'Connected accounts'],
  ['user_preferences', 'user_id', 'Preferences'],
  ['user_model_state', 'user_sub', 'Model settings'],
  ['swarm_roles', 'user_sub', 'Saved swarm roles'],
] as const;
/** @description Read identity references from fixed legacy columns only. @param pool Control-plane connection. @returns Bounded unresolved references and truncation status. */
export async function historicalPrincipalReferences(pool: Pool) {
  return runWithSystemIdentity(async () => {
    const references = new Map<string, string[]>(); let truncated = false;
    for (const [table, column, label] of SOURCES) {
      const exists = await pool.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]);
      if (!exists.rowCount) continue;
      // Identifiers are constants above, never request parameters. No tokens or business payloads are read.
      const rows = (await pool.query<{ sub: string }>(`SELECT DISTINCT "${column}"::text AS sub FROM "${table}"
        WHERE "${column}" IS NOT NULL ORDER BY sub LIMIT 251`)).rows;
      truncated ||= rows.length > 250;
      for (const { sub } of rows.slice(0, 250)) references.set(sub, [...(references.get(sub) ?? []), label]);
    }
    return { entries: [...references].map(([sub, sources]) => ({ sub, sources })), truncated };
  });
}
