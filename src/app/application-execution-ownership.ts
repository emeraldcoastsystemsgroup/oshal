/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Compare the bound executable name against the ownership arrays as text. `swarm_applications.agent_ids` is UUID[] (migration 022) while the parameter binds as text, so `$1=ANY(agent_ids)` raised `operator does not exist: text = uuid` for every kind:'bots' read. That threw ApplicationOwnershipUnavailableError, which canReadProtectedResult swallows to `false`, so every Jarvis ask answered 404 session_not_found from 2026-09-11 (c18f057a) onward. Log the swallowed failure: callers turn it into a bare refusal, so an unlogged one hid a three-day Jarvis outage.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolve an ambiguous bot association to the loader-stamped owner instead of refusing. `swarm_applications.agent_ids` is an ASSOCIATION column and is deliberately many-to-many (swarm-app-repository `upsert` resolves `workflow.workerBot` by name for carved apps with no `bots:`, so Jarvis catalog/mesh/selector keep working after ADR-085) — twelve live ids are claimed by more than one app, several of them correctly. Reading it as ownership, which must be 1:1, raised `Ambiguous package ownership` on every such read; callers swallow that to `false`, so tickets vanished from the operator's own listing (docs/operations/agent-id-ownership-collisions.md). `agents.metadata.manifestApp` is loader-stamped (manifest-bot-runtime `upsertManifestBot`) and is the authoritative owner, so arbitrate with it. No stamp, an inactive agent, a tool name, or a stamp that is not one of the claimants still refuses: this is an authorization path and an unresolvable case must fail closed.
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
interface OwnershipClaim { app: string; protected: boolean }

/**
 * @description Name the competing claimants inside the refusal, bounded, so an unresolvable
 * collision is actionable from the ERROR log without a database session.
 * @param claims - Validated claimant rows for one executable.
 * @returns Comma-separated claimant application names, truncated past eight.
 */
function describeClaims(claims: OwnershipClaim[]): string {
  const names = claims.map(claim => claim.app).sort();
  return names.length > 8 ? `${names.slice(0, 8).join(',')},+${names.length - 8}` : names.join(',');
}

/**
 * @description Read the loader-stamped owner of a bot. The stamp is written by the manifest loader
 * (`upsertManifestBot`) and re-asserted on every load, so it is the one authoritative 1:1 statement
 * of ownership; the association array is not. Only an active agent arbitrates — a disabled row's
 * stamp can name a package that no longer owns it, and guessing there would be worse than refusing.
 * @param pool - System-identity database handle.
 * @param id - Bound agent identifier, compared as text so a non-UUID input refuses instead of erroring.
 * @returns The single stamped application name.
 */
async function readStampedOwner(pool: Pick<Pool, 'query'>, id: string): Promise<string> {
  const stamped = await runWithSystemIdentity(() => pool.query(
    `SELECT metadata->>'manifestApp' AS app FROM agents WHERE agent_id::text=$1 AND status='active'`, [id]));
  const app = stamped.rows.length === 1 ? (stamped.rows[0] as { app?: unknown }).app : undefined;
  if (typeof app !== 'string' || !app) throw new Error('Ambiguous package ownership: no stamped owner');
  return app;
}

/**
 * @description Arbitrate a many-to-many association down to the stamped owner. Protection stays the
 * OR across every claim, never the stamped row alone, so arbitration can only ever be at least as
 * restrictive as the claims it replaces.
 * @param claims - Validated claimant rows, two or more.
 * @param stamp - Loader-stamped owner application name.
 * @returns Ownership attributed to the stamped owner.
 */
function resolveStampedOwnership(claims: OwnershipClaim[], stamp: string): ApplicationExecutionOwnership {
  if (!claims.some(claim => claim.app === stamp)) {
    throw new Error(`Ambiguous package ownership: stamped owner is not a claimant of ${describeClaims(claims)}`);
  }
  return { app: stamp, protected: claims.some(claim => claim.protected) };
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
    if (!result.rows.length) return undefined;
    const claims = result.rows.map((row: { app?: unknown; protected?: unknown }) => {
      if (typeof row.app !== 'string' || !row.app || typeof row.protected !== 'boolean') throw new Error('Invalid package ownership');
      return { app: row.app, protected: row.protected };
    });
    // A single claim is the whole answer, byte for byte as before: this path is what un-broke Jarvis.
    if (claims.length === 1) return claims[0];
    // A tool name has no stamped agent row to arbitrate it, so `tools` keeps the honest refusal.
    if (input.kind !== 'bots') throw new Error(`Ambiguous package ownership: ${describeClaims(claims)}`);
    return resolveStampedOwnership(claims, await readStampedOwner(pool, input.id));
  } catch (err) {
    // Callers fail closed on this error, and several swallow it to a bare `false` (a refused Jarvis
    // conversation, an unreadable result). Name it here or the next schema drift is silent again.
    logger.error({ err, kind: input.kind, id: input.id, app: input.app ?? null }, 'application execution ownership read failed');
    throw new ApplicationOwnershipUnavailableError();
  }
}
