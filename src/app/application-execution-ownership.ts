/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** Durable package ownership closes the interval before activation and survives disabled/uninstalled packages. */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
export interface ApplicationExecutionOwnership { app: string; protected: boolean }
export class ApplicationOwnershipUnavailableError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'authorization_ownership_unavailable';
  constructor() { super('Application execution ownership is unavailable'); this.name = 'ApplicationOwnershipUnavailableError'; }
}
/** Inputs come from fixed executable names; package payloads cannot declare ownership or protection. */
export async function readApplicationExecutionOwnership(pool: Pick<Pool, 'query'> | null, input: {
  kind: 'bots' | 'tools'; id: string; app?: string; mode: 'legacy' | 'enforce';
}): Promise<ApplicationExecutionOwnership | undefined> {
  if (!pool || !input.id || !['bots','tools'].includes(input.kind)) throw new ApplicationOwnershipUnavailableError();
  const column = input.kind === 'bots' ? 'agent_ids' : 'tool_names';
  try {
    const result = await runWithSystemIdentity(() => pool.query(`
      SELECT app, bool_or(protected) AS protected FROM (
        SELECT app_name AS app, protected FROM oshal_authorization_applications
          WHERE CASE WHEN $2::text IS NULL THEN $1=ANY(${column}) ELSE app_name=$2 END
        UNION ALL
        SELECT sa.name AS app, (sa.manifest ? 'authorization' OR COALESCE(aa.protected,FALSE)
          OR ($3::boolean AND replace(sa.manifest_path,chr(92),'/') ~ '(^|/)oshal-app[.]yaml$')) AS protected
        FROM swarm_applications sa LEFT JOIN oshal_authorization_applications aa ON aa.app_name=sa.name
          WHERE CASE WHEN $2::text IS NULL THEN $1=ANY(sa.${column}) ELSE sa.name=$2 END
      ) ownership GROUP BY app`, [input.id, input.app ?? null, input.mode !== 'legacy']));
    if (result.rows.length > 1) throw new Error('Ambiguous package ownership');
    const row = result.rows[0];
    if (!row) return undefined;
    if (typeof row.app !== 'string' || !row.app || typeof row.protected !== 'boolean') throw new Error('Invalid package ownership');
    return { app: row.app, protected: row.protected };
  } catch { throw new ApplicationOwnershipUnavailableError(); }
}
