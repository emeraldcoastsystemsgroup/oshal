/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared fixture for the storyboard bot-level image rule (ADR-130 amendment 2026-10-02): the render bot's canonical provider record, built exactly as the swarm extension builds it for every bot-node dispatch (createAgentConfigRuntimeParamsResolver over the REAL installed ProviderSwitchSnapshot, the REAL registry readers, the REAL fallback-order reader, and the REAL snapshot-settlement gate). The only doubles are the two Postgres stores beneath it: the switch rows (an in-memory list the real snapshot reads) and agent_config (no per-agent record, or one the spec supplies).
 */

import { ProviderSwitchSnapshot } from '../../src/features/agent-management/services/provider-switch-snapshot';
import {
  createAgentConfigRuntimeParamsResolver,
  type RuntimeParamsResolver,
} from '../../src/features/agent-management/services/dispatch-runtime-params';
import {
  gateRuntimeParamsResolverOnProviderSwitchSnapshot,
  resolveInstalledProviderFallbackOrder,
  resolveInstalledProviderSwitch,
  setInstalledProviderSwitchSnapshot,
} from '../../src/app/composition/provider-switch-runtime';
import { registryDeclaredProvider, registryHarnessEntry } from '../../src/app/extensions/swarm/swarm-bot-registry';
import type { ProviderSwitchRow } from '../../src/shared/llm-runtime';

/** general-bot, the default render bot (STORYBOARD_CLI_IMAGE_BOT_ID unset). */
export const RENDER_BOT = 'a0000000-0000-0000-0000-000000000099';
/** The runnable catalog the snapshot classifies row ids against. */
export const SWITCH_CATALOG = { harnessTypes: ['codex-cli', 'antigravity-cli', 'claude-code', 'cline', 'gemini-cli'], clineApiProviders: ['gemini'] };

/** @description The switch store, the installed snapshot and the canonical resolver over them. */
export interface RenderBotSwitch {
  /** The switch rows by scope id ('fleet-default' or an agent id); edit, then refresh(). */
  rows: Map<string, ProviderSwitchRow>;
  snapshot: ProviderSwitchSnapshot;
  /** The canonical resolver, gated on the snapshot's first read like the api's. */
  resolver: RuntimeParamsResolver;
  /** Re-read the rows, as the snapshot's own timer does. */
  refresh(): Promise<void>;
}

/**
 * @description A switch row as the operator writes it.
 * @param {string} scopeId - 'fleet-default' or an agent id.
 * @param {string} providerId - The provider the row names.
 * @param {Partial<ProviderSwitchRow>} [extra] - modelId / fallbackOrder.
 * @returns {ProviderSwitchRow} The row.
 */
export function switchRow(scopeId: string, providerId: string, extra: Partial<ProviderSwitchRow> = {}): ProviderSwitchRow {
  return { scopeId, providerId, modelId: null, updatedBy: 'operator-sub-1', updatedAt: new Date().toISOString(), ...extra };
}

/**
 * @description Install a real snapshot over in-memory rows and build the canonical resolver.
 * @param {ProviderSwitchRow[]} initial - The rows present at the first read.
 * @param {{loaded?: boolean, agentConfig?: Record<string, unknown> | null}} [options] - loaded=false
 *   leaves the snapshot unread; agentConfig is the per-agent record values (default none).
 * @returns {Promise<RenderBotSwitch>} The installed switch.
 */
export async function installRenderBotSwitch(
  initial: ProviderSwitchRow[],
  options: { loaded?: boolean; agentConfig?: Record<string, unknown> | null } = {},
): Promise<RenderBotSwitch> {
  const rows = new Map(initial.map((row) => [row.scopeId, row]));
  const snapshot = new ProviderSwitchSnapshot({ listAll: async () => Array.from(rows.values()) }, SWITCH_CATALOG);
  setInstalledProviderSwitchSnapshot(snapshot, SWITCH_CATALOG);
  if (options.loaded !== false) await snapshot.refresh();
  const agentConfig = { getConfig: async () => (options.agentConfig ? { values: options.agentConfig } : null) };
  const base = createAgentConfigRuntimeParamsResolver(
    agentConfig as never,
    registryDeclaredProvider,
    (agentId) => resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId)),
    resolveInstalledProviderFallbackOrder,
  );
  return { rows, snapshot, resolver: gateRuntimeParamsResolverOnProviderSwitchSnapshot(base), refresh: () => snapshot.refresh() };
}

/**
 * @description Uninstall the snapshot (test isolation).
 * @returns {void}
 */
export function clearRenderBotSwitch(): void {
  setInstalledProviderSwitchSnapshot(null);
}
