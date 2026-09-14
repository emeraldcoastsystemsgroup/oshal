/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Compare the bound executable name against the ownership arrays as text. `swarm_applications.agent_ids` is UUID[] (migration 022) while the parameter binds as text, so `$1=ANY(agent_ids)` raised `operator does not exist: text = uuid` for every kind:'bots' read. That threw ApplicationOwnershipUnavailableError, which canReadProtectedResult swallows to `false`, so every Jarvis ask answered 404 session_not_found from 2026-09-11 (c18f057a) onward. Log the swallowed failure: callers turn it into a bare refusal, so an unlogged one hid a three-day Jarvis outage.
 */
/** Durable package ownership closes the interval before activation and survives disabled/uninstalled packages. */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'application-execution-ownership' });
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
          WHERE CASE WHEN $2::text IS NULL THEN $1=ANY(${column}::text[]) ELSE app_name=$2 END
        UNION ALL
        SELECT sa.name AS app, (sa.manifest ? 'authorization' OR COALESCE(aa.protected,FALSE)
          OR ($3::boolean AND replace(sa.manifest_path,chr(92),'/') ~ '(^|/)oshal-app[.]yaml$')) AS protected
        FROM swarm_applications sa LEFT JOIN oshal_authorization_applications aa ON aa.app_name=sa.name
          WHERE CASE WHEN $2::text IS NULL THEN $1=ANY(sa.${column}::text[]) ELSE sa.name=$2 END
      ) ownership GROUP BY app`, [input.id, input.app ?? null, input.mode !== 'legacy']));
    if (result.rows.length > 1) throw new Error('Ambiguous package ownership');
    const row = result.rows[0];
    if (!row) return undefined;
    if (typeof row.app !== 'string' || !row.app || typeof row.protected !== 'boolean') throw new Error('Invalid package ownership');
    return { app: row.app, protected: row.protected };
  } catch (err) {
    // Callers fail closed on this error, and several swallow it to a bare `false` (a refused Jarvis
    // conversation, an unreadable result). Name it here or the next schema drift is silent again.
    logger.error({ err, kind: input.kind, id: input.id, app: input.app ?? null }, 'application execution ownership read failed');
    throw new ApplicationOwnershipUnavailableError();
  }
}
