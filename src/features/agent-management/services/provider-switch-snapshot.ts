/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | In-memory snapshot of the switch table so the SYNCHRONOUS harness resolver (resolveHarnessForAgent runs inside getProvider(agentId), which has no await) and the async dispatch stamper read the same rows and therefore agree. Refreshed at boot, after every write through the api, and on a timer so a row written straight into the table ("literally a switch in a table") takes effect without an api restart. A failed refresh keeps the last good rows and logs the error; a snapshot that never loaded resolves as "no rows", which is today's registry behaviour.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | resolveFallbackChain: the fallback_order column had no reader. The cockpit wrote a row and the panel reported it while every bot resolved an empty chain, because resolveProviderFallbackChain had zero production callers. The chain now resolves from the same rows, by the same precedence, as the provider id.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pass the environment rung, which had zero callers. resolveProviderFallbackChain has accepted environmentOrder and defined a "environment" source since migration 148, and nothing in the repo - production or test - ever supplied it, so ADR-162's ladder ran one rung shorter than the migration COMMENT and the JSDoc both describe. Read from the api process only when neither the bot row nor the fleet row carries a chain; an empty value is not a chain and falls through to source "none", which the boot pull delivers as null so a node keeps whatever it already has.
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  FLEET_DEFAULT_SWITCH_ID,
  resolveBotProviderSwitch,
  resolveProviderFallbackChain,
  type ProviderFallbackChain,
  type BotProviderSwitchResolution,
  type ProviderSwitchCatalog,
  type ProviderSwitchRow,
  type SwitchRegistryEntry,
} from '@/shared/llm-runtime';

const logger = createChildLogger({ module: 'provider-switch-snapshot' });

/** Default refresh period. Override with OSHAL_PROVIDER_SWITCH_REFRESH_MS; 0 disables the timer. */
const DEFAULT_REFRESH_MS = 30_000;

/** The one method of the store the snapshot needs. */
export interface ProviderSwitchSource {
  listAll(): Promise<ProviderSwitchRow[]>;
}

/** What the snapshot knows about its own freshness — reported by the api so an operator can tell. */
export interface ProviderSwitchSnapshotStatus {
  loaded: boolean;
  loadedAt: string | null;
  rowCount: number;
  fleetDefault: ProviderSwitchRow | null;
  lastError: string | null;
}

/**
 * @description Resolve the refresh period from the environment.
 * @param env - Environment map (process.env by default).
 * @returns Milliseconds between refreshes; 0 disables the timer.
 */
export function resolveProviderSwitchRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSHAL_PROVIDER_SWITCH_REFRESH_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_REFRESH_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_REFRESH_MS;
}

/**
 * @description The switch rows as last read, answered synchronously. See the change log for why
 * a snapshot rather than a per-call query.
 */
export class ProviderSwitchSnapshot {
  private rows = new Map<string, ProviderSwitchRow>();
  private loaded = false;
  private loadedAt: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly source: ProviderSwitchSource,
    private readonly catalog: ProviderSwitchCatalog,
  ) {}

  /**
   * @description Re-read every row. Concurrent callers share one in-flight read. A failure keeps
   * the previous rows (or none) and is logged at ERROR — a switch must never throw inside a dispatch.
   * @returns Resolves when the read completed or failed.
   */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = runWithSystemIdentity(async () => {
      const startedAt = Date.now();
      try {
        const rows = await this.source.listAll();
        this.rows = new Map(rows.map((row) => [row.scopeId, row]));
        this.loaded = true;
        this.loadedAt = new Date().toISOString();
        this.lastError = null;
        logger.debug({ rowCount: rows.length, durationMs: Date.now() - startedAt }, 'Provider switch snapshot refreshed');
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, keptRows: this.rows.size, durationMs: Date.now() - startedAt },
          'Provider switch snapshot refresh failed — keeping the last good rows',
        );
      } finally {
        this.inFlight = null;
      }
    });
    return this.inFlight;
  }

  /**
   * @description Start the periodic refresh (unref'd, so it never keeps the process alive).
   * @param intervalMs - Period; 0 disables.
   * @returns void
   */
  start(intervalMs: number = resolveProviderSwitchRefreshMs()): void {
    this.stop();
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref();
  }

  /** @description Stop the periodic refresh. */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * @description The bot's own row, if any.
   * @param agentId - The agent id.
   * @returns The row or null.
   */
  rowFor(agentId: string): ProviderSwitchRow | null {
    return this.rows.get(agentId) ?? null;
  }

  /** @description The fleet-default row, if any. */
  fleetDefault(): ProviderSwitchRow | null {
    return this.rows.get(FLEET_DEFAULT_SWITCH_ID) ?? null;
  }

  /**
   * @description Resolve one bot against the rows in memory and the registry facts the caller
   * holds — the shared rule, applied to this snapshot.
   * @param agentId - The bot's agent id.
   * @param registry - Its registry entry (harnessType/apiType), or null when the registry has none.
   * @returns The resolution, with the rung that answered.
   */
  resolve(agentId: string, registry: SwitchRegistryEntry | null): BotProviderSwitchResolution {
    return resolveBotProviderSwitch({
      botRow: this.rowFor(agentId),
      fleetRow: this.fleetDefault(),
      registry,
      catalog: this.catalog,
    });
  }

  /**
   * @description Resolve the ordered FALLBACK CHAIN for one bot from the same rows, by the same
   * precedence as the provider itself. Without this the fallback_order column reaches nothing: the
   * cockpit wrote a row, the panel reported it, and every bot resolved an empty chain.
   * @param agentId - The bot's agent id.
   * @param primaryProviderId - The provider that would be failing over, excluded from its own chain.
   * @returns The ordered chain and the rung that supplied it.
   */
  resolveFallbackChain(agentId: string, primaryProviderId: string | null): ProviderFallbackChain {
    return resolveProviderFallbackChain({
      botRow: this.rowFor(agentId),
      fleetRow: this.fleetDefault(),
      // The third rung of the ADR-162 ladder, which had NO caller anywhere in the repo - so the
      // documented four-rung ladder was three, and the operator's "an env that correlates as
      // well" existed on neither side. This is the api process's own variable, read only when no
      // row supplies a chain; an empty value is not a chain and falls through to 'none'.
      environmentOrder: process.env.OSHAL_PROVIDER_FALLBACK_ORDER ?? null,
      primaryProviderId,
      catalog: this.catalog,
    });
  }

  /** @description Freshness for the api to report. */
  status(): ProviderSwitchSnapshotStatus {
    return {
      loaded: this.loaded,
      loadedAt: this.loadedAt,
      rowCount: this.rows.size,
      fleetDefault: this.fleetDefault(),
      lastError: this.lastError,
    };
  }
}
