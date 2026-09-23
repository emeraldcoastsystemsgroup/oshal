/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 concierge coverage contract: one trimmed selector (chatBot -> workflow.workerBot -> first bots[].name), a warn/enforce rollout mode that rejects unknown values, and a pure coverage problem builder shared by the manifest loader and its guards.
 */

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
 * @description Names external agent associations in durable order: the canonical concierge first,
 * then a distinct no-inline workflow worker. Declared bots are excluded because their ids already
 * come from bots[].agentId. This is association order, not lifecycle ownership.
 * @param manifest - A parsed application manifest.
 * @returns Unique trimmed external agent names in persistence order.
 */
export function manifestExternalAgentNames(
  manifest: Pick<SwarmAppManifest, 'chatBot' | 'workflow' | 'bots'>,
): string[] {
  const declaredNames = new Set((manifest.bots ?? []).flatMap(bot => {
    const name = nonBlank(bot.name);
    return name ? [name] : [];
  }));
  const workerName = nonBlank(manifest.workflow?.workerBot);
  return [...new Set([manifestConciergeName(manifest), workerName].filter(
    (name): name is string => typeof name === 'string' && !declaredNames.has(name),
  ))];
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
