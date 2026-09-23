/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 concierge coverage contract: one trimmed selector (chatBot -> workflow.workerBot -> first bots[].name), a warn/enforce rollout mode that rejects unknown values, and a pure coverage problem builder shared by the manifest loader and its guards.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep metadata-only chatBot references out of durable agent_ids. That column feeds execution-ownership claims as well as discovery, so associating Ambient Recall with the framework general-bot turned a borrowed cockpit concierge into a second package owner and made generic task dispatch fail closed. Only a distinct external workflow worker remains a durable association; profile and Jarvis concierge lookup resolve the canonical name directly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Centralize fail-closed profile identity resolution: declared bots keep their explicit id, workflow fallback stays inside executable associations, and only a distinct metadata-only chatBot may resolve globally when exactly one ACTIVE row carries the name.
 */

import type { Pool } from 'pg';
import type { SwarmAppManifest } from '../types';
import { hasCockpitSurface } from './swarm-app-record-view';

/** The two deliberately staged P8 manifest-load postures. */
export type ConciergeCoverageMode = 'warn' | 'enforce';

/** Stable machine-readable event carried by every warn-mode coverage violation. */
export const CONCIERGE_COVERAGE_WARNING_EVENT = 'swarm_app.concierge_coverage_missing';

/** Stable human-readable warning; variable evidence belongs in the structured fields. */
export const CONCIERGE_COVERAGE_WARNING_MESSAGE =
  'Cockpit surface has no concierge declaration; manifest loaded in warn mode';

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * @description Select the manifest's accountable cockpit concierge using the one canonical
 * precedence rule. Blank or non-string values are absent and therefore fall through.
 * @param manifest - A parsed application manifest.
 * @returns The trimmed bot name, or undefined when no concierge is declared.
 */
export function manifestConciergeName(
  manifest: Pick<SwarmAppManifest, 'chatBot' | 'workflow' | 'bots'>,
): string | undefined {
  return nonBlank(manifest.chatBot)
    ?? nonBlank(manifest.workflow?.workerBot)
    ?? nonBlank(manifest.bots?.[0]?.name);
}

/**
 * @description Names external agents that belong in the durable association column. A no-inline
 * workflow worker remains associated because dispatch, mesh and ranking consume agent_ids. A
 * metadata-only chatBot does not: agent_ids also feeds authorization ownership claims, and a
 * borrowed concierge is not an executable the referencing package owns. Declared bots are
 * excluded because their ids already come from bots[].agentId.
 * @param manifest - A parsed application manifest.
 * @returns Unique trimmed external agent names in persistence order.
 */
export function manifestExternalAssociationNames(
  manifest: Pick<SwarmAppManifest, 'workflow' | 'bots'>,
): string[] {
  const declaredNames = new Set((manifest.bots ?? []).flatMap(bot => {
    const name = nonBlank(bot.name);
    return name ? [name] : [];
  }));
  const workerName = nonBlank(manifest.workflow?.workerBot);
  return workerName && !declaredNames.has(workerName) ? [workerName] : [];
}

/** A concierge identity safe to expose in an application-scoped cockpit profile. */
export interface ManifestConciergeAgent { agentId: string; name: string }

/**
 * @description Resolve the canonical profile concierge without conflating metadata borrowing with
 * durable ownership. Declared bots are bound to their manifest id. Workflow fallback is restricted
 * to associated executable ids. A distinct metadata-only chatBot is the sole global-name case and
 * succeeds only for one ACTIVE row, so duplicate or inactive names fail closed.
 */
export async function resolveManifestConciergeAgent(
  pool: Pick<Pool, 'query'>,
  manifest: Pick<SwarmAppManifest, 'chatBot' | 'workflow' | 'bots'>,
  associatedAgentIds: readonly string[],
): Promise<ManifestConciergeAgent | undefined> {
  const name = manifestConciergeName(manifest);
  if (!name) return undefined;
  const declared = (manifest.bots ?? []).find(bot => nonBlank(bot.name) === name);
  const declaredId = nonBlank(declared?.agentId);
  if (declaredId) return { agentId: declaredId, name };

  const explicit = nonBlank(manifest.chatBot);
  const worker = nonBlank(manifest.workflow?.workerBot);
  const metadataOnlyExternal = Boolean(explicit && explicit !== worker && !declared);
  if (!metadataOnlyExternal && associatedAgentIds.length === 0) return undefined;
  const { rows } = metadataOnlyExternal
    ? await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM (
         SELECT agent_id, COUNT(*) OVER () AS candidate_count
         FROM agents WHERE name = $1 AND status = 'active'
       ) candidates WHERE candidate_count = 1`,
      [name],
    )
    : await pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM (
         SELECT agent_id, COUNT(*) OVER () AS candidate_count
         FROM agents
         WHERE name = $1 AND status = 'active' AND agent_id = ANY($2::uuid[])
       ) candidates WHERE candidate_count = 1`,
      [name, associatedAgentIds],
    );
  const agentId = nonBlank(rows[0]?.agent_id);
  return agentId ? { agentId, name } : undefined;
}

/**
 * @description Resolve OSHAL_CONCIERGE_COVERAGE_MODE with the migration-safe warn default while
 * rejecting unknown values. A misspelled enforcement setting must not silently weaken loading.
 * @param value - Explicit value or the current process environment value.
 * @returns The normalized coverage mode.
 * @throws When the configured value is neither warn nor enforce.
 */
export function resolveConciergeCoverageMode(
  value: unknown = process.env.OSHAL_CONCIERGE_COVERAGE_MODE,
): ConciergeCoverageMode {
  const normalized = String(value ?? '').trim().toLowerCase() || 'warn';
  if (normalized !== 'warn' && normalized !== 'enforce') {
    throw new Error('OSHAL_CONCIERGE_COVERAGE_MODE must be warn or enforce');
  }
  return normalized;
}

/**
 * @description Build the precise load error for a surfaced package with no concierge. Uses the
 * canonical cockpit-surface predicate; assistant-only and genuinely headless packages are not
 * silently reclassified as surfaces here.
 * @param manifest - Parsed application manifest.
 * @param manifestPath - Absolute manifest path for operator diagnostics.
 * @returns The error message, or null when the contract is satisfied or does not apply.
 */
export function conciergeCoverageProblem(
  manifest: SwarmAppManifest,
  manifestPath: string,
): string | null {
  if (!hasCockpitSurface(manifest) || manifestConciergeName(manifest)) return null;
  return `Manifest ${manifestPath}: cockpit surface for app "${manifest.name}" requires a concierge. `
    + 'Declare a non-blank chatBot, workflow.workerBot, or bots[0].name.';
}
