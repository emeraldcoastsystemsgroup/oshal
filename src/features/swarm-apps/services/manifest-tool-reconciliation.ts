/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Provide bounded manifest-update tool reconciliation: exact removed-name diffs, scoped declared-bot grant cleanup, pre-activation snapshots, and snapshot-preserving rollback primitives.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { RuntimeToolRegistrationService } from '@/features/tool-registry';
import type {
  SwarmAppManifest,
  SwarmApplicationRecord,
  SwarmAppToolDeclaration,
} from '../types';
import { otherProvidersOf, providedToolNames } from './tool-ownership';

const logger = createChildLogger({ module: 'manifest-tool-reconciliation' });

export interface ManifestToolGrantRow {
  agent_id: string;
  tool_name: string;
}

export interface RemovedToolPrivilegeScope {
  agentIds: string[];
  toolNames: string[];
}

export interface PreparedManifestToolUpdate {
  retired: RemovedToolPrivilegeScope;
  priorGrants: ManifestToolGrantRow[];
}

/** @description Return unique bot identities explicitly declared by one manifest revision. */
function declaredBotIds(manifest: SwarmAppManifest): string[] {
  return Array.from(new Set((manifest.bots ?? []).map((bot) => bot.agentId)));
}

/** @description Return prior tool declarations whose names are absent from the incoming revision. */
function removedToolDeclarations(
  previous: SwarmAppManifest,
  incoming: SwarmAppManifest,
): SwarmAppToolDeclaration[] {
  const incomingNames = new Set((incoming.tools ?? []).map((tool) => tool.name));
  const removed = (previous.tools ?? []).filter((tool) => !incomingNames.has(tool.name));
  return Array.from(new Map(removed.map((tool) => [tool.name, tool])).values());
}

/** @description Run one compensating action and retain its error so every cleanup is attempted. */
export async function collectCleanupFailure(
  failures: unknown[],
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

/** @description Tear down sole-owner executors while retaining another active app's provider. */
export async function deregisterOwnedManifestTools(
  manifest: SwarmAppManifest,
  otherActiveApps: SwarmApplicationRecord[],
  runtimeTools: RuntimeToolRegistrationService | undefined,
  failLoud = false,
): Promise<void> {
  if (!manifest.tools?.length || (!runtimeTools && !failLoud)) return;
  const failures: unknown[] = [];
  for (const tool of manifest.tools) {
    const retainers = otherProvidersOf(tool.name, otherActiveApps);
    if (retainers.length > 0) {
      logger.info(
        { appName: manifest.name, toolName: tool.name, retainedBy: retainers },
        'Manifest tool RETAINED — another active app provides it',
      );
      continue;
    }
    if (!runtimeTools) {
      failures.push(new Error(`Runtime tool service unavailable while retiring ${tool.name}`));
      continue;
    }
    try {
      await runtimeTools.deregisterRuntimeTool(tool.name, true);
    } catch (error) {
      logger.error({ err: error, appName: manifest.name, toolName: tool.name },
        'Manifest tool deregistration failed');
      if (failLoud) failures.push(error);
    }
  }
  if (failLoud && failures.length > 0) {
    throw new AggregateError(failures, `Manifest tool teardown failed for app ${manifest.name}`);
  }
}

/** @description Delete grants only for explicit bot ids and exact tool registry names. */
export async function deleteManifestBotToolGrants(
  pool: Pool,
  agentIds: string[],
  toolNames: string[],
): Promise<void> {
  if (agentIds.length === 0 || toolNames.length === 0) return;
  await pool.query(
    `DELETE FROM agent_tools at
      USING tools t
      WHERE at.tool_id = t.tool_id
        AND at.agent_id::text = ANY($1::text[])
        AND t.name = ANY($2::text[])`,
    [agentIds, toolNames],
  );
}

/**
 * @description Retract privileges represented only by the stored manifest revision. Runtime
 * teardown and grant deletion are both attempted; either failure aborts before upsert.
 */
export async function reconcileRemovedToolPrivileges(
  pool: Pool,
  previous: SwarmApplicationRecord | null,
  incoming: SwarmAppManifest,
  deregister: (retired: SwarmAppManifest) => Promise<void>,
): Promise<RemovedToolPrivilegeScope> {
  if (!previous) return { agentIds: [], toolNames: [] };
  const removed = removedToolDeclarations(previous.manifest, incoming);
  if (removed.length === 0) return { agentIds: [], toolNames: [] };

  const failures: unknown[] = [];
  const agentIds = Array.from(new Set([
    ...declaredBotIds(previous.manifest),
    ...declaredBotIds(incoming),
  ]));
  const toolNames = removed.map((tool) => tool.name);
  await collectCleanupFailure(failures, () => deregister({ ...previous.manifest, tools: removed }));
  await collectCleanupFailure(failures, () => deleteManifestBotToolGrants(pool, agentIds, toolNames));
  if (failures.length > 0) {
    throw new AggregateError(failures, `Removed-tool reconciliation failed for app ${incoming.name}`);
  }
  return { agentIds, toolNames };
}

/** @description Complete all fail-loud privilege preparation before the manifest row is upserted. */
export async function prepareManifestToolUpdate(
  pool: Pool,
  previous: SwarmApplicationRecord | null,
  incoming: SwarmAppManifest,
  deregister: (retired: SwarmAppManifest) => Promise<void>,
): Promise<PreparedManifestToolUpdate> {
  const retired = await reconcileRemovedToolPrivileges(pool, previous, incoming, deregister);
  const priorGrants = await snapshotManifestToolGrants(pool, incoming);
  return { retired, priorGrants };
}

/** @description Snapshot exact app-bot/tool grants so failed activation removes only new rows. */
export async function snapshotManifestToolGrants(
  pool: Pool,
  manifest: SwarmAppManifest,
): Promise<ManifestToolGrantRow[]> {
  const agentIds = declaredBotIds(manifest);
  const toolNames = providedToolNames(manifest);
  if (agentIds.length === 0 || toolNames.length === 0) return [];
  const { rows } = await pool.query<ManifestToolGrantRow>(
    `SELECT at.agent_id::text AS agent_id, t.name AS tool_name
       FROM agent_tools at
       JOIN tools t ON t.tool_id = at.tool_id
      WHERE at.agent_id::text = ANY($1::text[])
        AND t.name = ANY($2::text[])`,
    [agentIds, toolNames],
  );
  return rows;
}

/** @description Remove failed-activation grants while preserving every exact prior row. */
export async function rollbackNewManifestToolGrants(
  pool: Pool,
  manifest: SwarmAppManifest,
  priorGrants: ManifestToolGrantRow[],
): Promise<void> {
  const agentIds = declaredBotIds(manifest);
  const toolNames = providedToolNames(manifest);
  if (agentIds.length === 0 || toolNames.length === 0) return;
  await pool.query(
    `DELETE FROM agent_tools at
      USING tools t
      WHERE at.tool_id = t.tool_id
        AND at.agent_id::text = ANY($1::text[])
        AND t.name = ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS prior(agent_id text, tool_name text)
           WHERE prior.agent_id = at.agent_id::text AND prior.tool_name = t.name
        )`,
    [agentIds, toolNames, JSON.stringify(priorGrants)],
  );
}

/** @description Attempt every compensation, report rollback failures, and rethrow activation. */
export async function failClosedManifestActivation(
  appName: string,
  activationError: unknown,
  compensations: Array<() => Promise<unknown>>,
): Promise<never> {
  const failures: unknown[] = [];
  for (const compensate of compensations) {
    await collectCleanupFailure(failures, compensate);
  }
  logger.error(
    { err: activationError, rollbackFailures: failures.length, app: appName },
    'App activation failed; model-tool privilege was retracted',
  );
  if (failures.length > 0) {
    throw new AggregateError([activationError, ...failures], `Activation failed closed for app ${appName}`);
  }
  throw activationError;
}
