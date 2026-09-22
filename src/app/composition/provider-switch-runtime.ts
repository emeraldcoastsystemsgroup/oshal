/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | buildProviderSwitchCatalog now carries modelsByProvider from the same ProviderRegistry records it already reads for clineApiProviders, so checkModelAgainstCatalog has something to measure a written model against. Nothing is refused by it; the catalog simply stops being unable to answer the question.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expose the installed catalog (installedProviderSwitchCatalog) so the fleet-default routes validate a written id against the same runnable set the resolver refuses on.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The api-side seam for "a bot's LLM provider is a row in a table": builds the runnable catalog from the REAL HARNESS_FACTORIES keys + provider definitions, holds the one installed ProviderSwitchSnapshot so resolveHarnessForAgent (sync, inside getProvider) and dispatch stamping (async) answer from the same rows, and turns a REFUSED resolution into a provider that refuses every request with the reason — fail closed at the point of use, never a silent fall-through to the registry literal or FORCE_LLM_PROVIDER. With nothing installed every reader answers "registry", which is today's behaviour byte-identically.
 */

import { createChildLogger } from '@/shared/logger';
import {
  LLMService,
  ProviderRegistry,
  type LLMResponse,
  type SendRequestOptions,
} from '@/features/llm-provider';
import {
  ProviderSwitchSnapshot,
  type ProviderSwitchSource,
} from '@/features/agent-management';
import {
  resolveBotProviderSwitch,
  type BotProviderSwitchResolution,
  type ProviderSwitchCatalog,
  type SwitchRegistryEntry,
} from '@/shared/llm-runtime';

const logger = createChildLogger({ module: 'provider-switch-runtime' });

let installed: ProviderSwitchSnapshot | null = null;
let installedCatalog: ProviderSwitchCatalog | null = null;

/**
 * @description The runnable catalog: every harness factory key this build registers plus every
 * provider id the generic cline harness can front. Built from the real records, never a list.
 * @param harnessTypes - `Object.keys(HARNESS_FACTORIES)` from the composition root.
 * @returns The catalog the shared rule validates provider ids against.
 */
export function buildProviderSwitchCatalog(harnessTypes: readonly string[]): ProviderSwitchCatalog {
  const providers = new ProviderRegistry().getAll();
  return {
    harnessTypes: [...harnessTypes],
    clineApiProviders: providers.map((p) => p.id),
    // The model ids too, from the SAME records, so a written model can be measured against the
    // catalog rather than handed to the vendor unexamined. Built here and not in the shared rule
    // because shared/ is the bottom layer and may not reach into features/.
    modelsByProvider: Object.fromEntries(providers.map((p) => [p.id, p.models.map((model) => model.id)])),
  };
}

/**
 * @description Create, load and install the process-wide snapshot over a switch store. Awaits
 * the first read so the api never serves a dispatch before the rows are known; a failed first
 * read is logged and leaves the snapshot empty (registry behaviour) rather than blocking boot.
 * @param source - The switch store (listAll).
 * @param harnessTypes - `Object.keys(HARNESS_FACTORIES)`.
 * @returns The installed snapshot.
 */
export async function installProviderSwitchSnapshot(
  source: ProviderSwitchSource,
  harnessTypes: readonly string[],
): Promise<ProviderSwitchSnapshot> {
  const catalog = buildProviderSwitchCatalog(harnessTypes);
  const snapshot = new ProviderSwitchSnapshot(source, catalog);
  await snapshot.refresh();
  snapshot.start();
  installed = snapshot;
  installedCatalog = catalog;
  const status = snapshot.status();
  logger.info(
    { loaded: status.loaded, rowCount: status.rowCount, fleetDefault: status.fleetDefault?.providerId ?? null },
    'Provider switch snapshot installed — per-bot row > fleet default > registry literal',
  );
  return snapshot;
}

/**
 * @description The installed snapshot, for the routes that write rows and must refresh after.
 * @returns The snapshot, or null when no store was installed (no Postgres pool).
 */
export function installedProviderSwitchSnapshot(): ProviderSwitchSnapshot | null {
  return installed;
}

/**
 * @description The catalog the installed snapshot validates against, for the write routes.
 * @returns The catalog, or null when nothing is installed.
 */
export function installedProviderSwitchCatalog(): ProviderSwitchCatalog | null {
  return installedCatalog;
}

/**
 * @description Test seam: replace or clear the installed snapshot without a store.
 * @param snapshot - The snapshot to install, or null to clear.
 * @param catalog - The catalog it was built with.
 * @returns void
 */
export function setInstalledProviderSwitchSnapshot(
  snapshot: ProviderSwitchSnapshot | null,
  catalog: ProviderSwitchCatalog | null = null,
): void {
  installed = snapshot;
  installedCatalog = catalog;
}

/**
 * @description Resolve one bot's switch against the installed rows. With nothing installed the
 * answer is "registry" for every bot — the no-row case, byte-identical to today.
 * @param agentId - The bot's agent id.
 * @param registry - Its registry entry, or null.
 * @returns The resolution.
 */
export function resolveInstalledProviderSwitch(
  agentId: string,
  registry: SwitchRegistryEntry | null,
): BotProviderSwitchResolution {
  if (installed) return installed.resolve(agentId, registry);
  return resolveBotProviderSwitch({
    registry,
    catalog: installedCatalog ?? { harnessTypes: [], clineApiProviders: [] },
  });
}

/**
 * @description A provider that refuses every request with the switch row's reason. Returned in
 * place of a harness when the winning row names an id this build cannot run, so the failure is
 * loud, attributed and specific instead of a silent hop onto the registry literal.
 */
export class RefusedProviderSwitch extends LLMService {
  constructor(readonly agentId: string, readonly source: string, readonly reason: string) {
    super(`switch-refused:${source}`, {});
  }

  /**
   * @description Refuse the request with the row's reason.
   * @param _options - Ignored.
   * @returns Never resolves.
   * @throws Always, naming the bot, the rung and the reason.
   */
  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    this.requestCount++;
    const message = `LLM provider switch refused for agent ${this.agentId} (${this.source} row): ${this.reason}`;
    logger.error({ agentId: this.agentId, source: this.source, reason: this.reason }, message);
    throw new Error(message);
  }
}
