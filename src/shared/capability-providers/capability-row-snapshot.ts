/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D6: the swarm rows (migration 183) held in memory so every capability call reads them without a query, refreshed at boot, after every write through the operator route, and on a timer, so one operator write moves the next call with no restart (the provider-switch snapshot pattern, ProviderSwitchSnapshot). A failed refresh keeps the last good rows and logs at ERROR. The process installs one snapshot; an installed snapshot that has never completed a read answers "not loaded", which the resolver refuses on rather than guessing the seed, and with nothing installed (no Postgres) the reader answers "no rows", which is today's behaviour.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D6: a refresh asked for while a read is running no longer shares that read. The running read (the timer's, say) may have begun before the operator's write committed, so the route's refresh after the write could answer with the old rows and the next call would resolve the old default until the next tick. Such a call now gets one further read that starts when the running one ends (shared by every caller that asks meanwhile). Guard: tests/unit/capability-row-snapshot.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b: the snapshot also holds the provider offers (migration 184) when its source lists them, so a spend recording reads the unit price from memory; offerFor() and installedCapabilityOfferReader() answer it, and the status counts the offers.
 */

/**
 * @description The in-memory swarm capability rows and the process-wide installed instance.
 * @module shared/capability-providers/capability-row-snapshot
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type {
  Capability,
  CapabilityOfferReader,
  CapabilityProviderOffer,
  CapabilitySwarmRow,
  CapabilitySwarmRowReader,
} from './capability-types';

const logger = createChildLogger({ module: 'capability-row-snapshot' });

/** Default refresh period. Override with OSHAL_CAPABILITY_ROWS_REFRESH_MS; 0 disables the timer. */
const DEFAULT_REFRESH_MS = 30_000;

/** What the snapshot reads: the swarm rows, and (from S1b) the provider offers. */
export interface CapabilitySwarmRowSource {
  listAll(): Promise<CapabilitySwarmRow[]>;
  /** The offer rows (migration 184); a source without it has no offers. */
  listOffers?(): Promise<CapabilityProviderOffer[]>;
}

/** What the snapshot knows about its own freshness, for the operator route to report. */
export interface CapabilityRowSnapshotStatus {
  loaded: boolean;
  loadedAt: string | null;
  rowCount: number;
  offerCount: number;
  lastError: string | null;
}

/**
 * @description The refresh period from the environment.
 * @param env - Environment map (process.env by default).
 * @returns Milliseconds between refreshes; 0 disables the timer.
 */
export function resolveCapabilityRowsRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSHAL_CAPABILITY_ROWS_REFRESH_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_REFRESH_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_REFRESH_MS;
}

/** @description The key one row is held under. */
function rowKey(scopeId: string, capability: Capability): string {
  return `${scopeId}\u0000${capability}`;
}

/**
 * @description The swarm rows as last read, answered synchronously.
 */
export class CapabilityRowSnapshot implements CapabilitySwarmRowReader, CapabilityOfferReader {
  private rows = new Map<string, CapabilitySwarmRow>();
  private offers = new Map<string, CapabilityProviderOffer>();
  private loaded = false;
  private loadedAt: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(private readonly source: CapabilitySwarmRowSource) {}

  /**
   * @description Re-read every row under the system identity (the table is readable by every
   * identity; the system context keeps a strict GUC mode from starving the read). A call made while
   * a read is running gets ONE further read that starts when it ends, shared by every such caller:
   * the running read may have begun before the caller's write committed, so a refresh asked for after
   * a write always answers with a read that began after it. A failure keeps the previous rows and is
   * logged — never thrown into a call.
   * @returns Resolves when a read that began after this call completed or failed.
   */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.queued ??= this.inFlight.then(() => {
        this.queued = null;
        return this.refresh();
      });
      return this.queued;
    }
    this.inFlight = runWithSystemIdentity(async () => {
      const startedAt = Date.now();
      try {
        const rows = await this.source.listAll();
        const offers = this.source.listOffers ? await this.source.listOffers() : [];
        this.rows = new Map(rows.map((row) => [rowKey(row.scopeId, row.capability), row]));
        this.offers = new Map(offers.map((offer) => [rowKey(offer.providerId, offer.capability), offer]));
        this.loaded = true;
        this.loadedAt = new Date().toISOString();
        this.lastError = null;
        logger.debug({ rowCount: rows.length, offerCount: offers.length, durationMs: Date.now() - startedAt }, 'Capability row snapshot refreshed');
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ err, keptRows: this.rows.size, durationMs: Date.now() - startedAt },
          'Capability row snapshot refresh failed — keeping the last good rows');
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
  start(intervalMs: number = resolveCapabilityRowsRefreshMs()): void {
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
   * @description Installed by construction; loaded once one read has succeeded.
   * @returns The reader state.
   */
  state(): { installed: boolean; loaded: boolean } {
    return { installed: true, loaded: this.loaded };
  }

  /**
   * @description One row from memory.
   * @param scopeId - The fleet scope or an agent id.
   * @param capability - The capability.
   * @returns The row, or null.
   */
  rowFor(scopeId: string, capability: Capability): CapabilitySwarmRow | null {
    return this.rows.get(rowKey(scopeId, capability)) ?? null;
  }

  /** @description Every row in memory, for the operator route. */
  allRows(): CapabilitySwarmRow[] {
    return Array.from(this.rows.values());
  }

  /**
   * @description One provider's offer row from memory (ADR-173 D4: its unit price and quota label).
   * @param capability - The capability.
   * @param providerId - The provider.
   * @returns The offer, or null when none is set.
   */
  offerFor(capability: Capability, providerId: string): CapabilityProviderOffer | null {
    return this.offers.get(rowKey(providerId, capability)) ?? null;
  }

  /** @description Freshness for the operator route to report. */
  status(): CapabilityRowSnapshotStatus {
    return { loaded: this.loaded, loadedAt: this.loadedAt, rowCount: this.rows.size, offerCount: this.offers.size, lastError: this.lastError };
  }
}

/** The reader with nothing installed: no Postgres, so no rows can exist — today's behaviour. */
const NOTHING_INSTALLED: CapabilitySwarmRowReader = Object.freeze({
  state: () => ({ installed: false, loaded: false }),
  rowFor: () => null,
});

/** No offers at all: no snapshot installed. */
const NO_OFFERS: CapabilityOfferReader = Object.freeze({ offerFor: () => null });

let installed: CapabilityRowSnapshot | null = null;

/**
 * @description Install the process-wide snapshot (the composition root does this at boot).
 * @param snapshot - The snapshot, or null to clear (tests).
 * @returns void
 */
export function installCapabilityRowSnapshot(snapshot: CapabilityRowSnapshot | null): void {
  installed = snapshot;
}

/**
 * @description The installed snapshot, for the operator route that writes rows and refreshes after.
 * @returns The snapshot, or null when nothing is installed.
 */
export function installedCapabilityRowSnapshot(): CapabilityRowSnapshot | null {
  return installed;
}

/**
 * @description The reader every capability resolution uses: the installed snapshot, or "no rows"
 * when nothing is installed.
 * @returns The reader.
 */
export function installedCapabilityRowReader(): CapabilitySwarmRowReader {
  return installed ?? NOTHING_INSTALLED;
}

/**
 * @description The offer reader every spend recording uses: the installed snapshot, or "no offers".
 * @returns The reader.
 */
export function installedCapabilityOfferReader(): CapabilityOfferReader {
  return installed ?? NO_OFFERS;
}
