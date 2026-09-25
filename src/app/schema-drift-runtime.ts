/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Periodic, non-overlapping schema comparisons with durable internal publication, explicit baseline control and visible detector failures.
 */

import type { Pool } from 'pg';
import { EnvelopeStore } from '@/features/alert-pipeline';
import type { DataModelService } from '@/features/data-model';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
import { schemaDriftEvent } from './data-model-alert';

const logger = createChildLogger({ module: 'schema-drift-runtime' });
export interface SchemaMonitorStatus {
  state: string;
  checkedAt: string | null;
  eventId: string | null;
  detail: string;
}
export interface SchemaDriftMonitor {
  tick(): Promise<void>;
  status(): SchemaMonitorStatus;
  stop(): void;
}

/**
 * @description Compare schemas periodically without acknowledging them. Only an operator's
 * explicit capture advances the baseline; retries use the durable producer receipt.
 * @param pool - Existing platform pool, never a separate deployment connection.
 * @param service - Same comparison service used by the operator explorer.
 * @param options - Timer and clock seams for isolated lifecycle tests.
 * @returns A stoppable monitor with read-only status for the explorer.
 */
export function createSchemaDriftMonitor(pool: Pool, service: DataModelService,
  options: { intervalMs?: number; now?: () => number; start?: boolean } = {}): SchemaDriftMonitor {
  const events = new EnvelopeStore(pool);
  const now = options.now ?? Date.now;
  let busy = false;
  let stopped = false;
  let state: SchemaMonitorStatus = { state: 'starting', checkedAt: null, eventId: null, detail: 'Waiting for the first schema comparison.' };
  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      await runWithSystemIdentity(async () => {
        const reading = await service.drift({ refresh: true });
        if (stopped) return;
        state = { state: reading.report?.state ?? 'unavailable', checkedAt: new Date(now()).toISOString(),
          eventId: null, detail: reading.unavailableReason || reading.report?.reason || '' };
        if (!reading.available || !reading.digest || !reading.report?.alarm) return;
        const input = schemaDriftEvent(reading.baseline ?? null, reading.digest, now());
        if (!input) throw new Error('An alarm comparison did not carry a usable baseline.');
        const landed = await events.landInternalEvent(input);
        state = { ...state, eventId: landed.eventId, detail: landed.created ? 'Alarm landed for operator ticket intake.' : 'This alarm occurrence was already landed.' };
      });
    } catch (err) {
      logger.error({ err }, 'Schema detector comparison or publication failed');
      state = { state: 'unavailable', checkedAt: new Date(now()).toISOString(), eventId: null,
        detail: 'The schema detector could not complete its check. See the server log; no successful alarm is claimed.' };
    } finally { busy = false; }
  };
  const timer = options.start === false ? null : setInterval(() => { void tick(); }, options.intervalMs ?? 60_000);
  timer?.unref();
  return { tick, status: () => ({ ...state }), stop: () => { stopped = true; if (timer) clearInterval(timer); } };
}

/**
 * @description Bind one monitor to the existing server shutdown lifecycle.
 * @param pool - Platform database or null when this process has no database.
 * @param service - Shared explorer service.
 * @returns Monitor when configured, otherwise null.
 */
export function startSchemaDriftMonitor(pool: Pool | null, service: DataModelService): SchemaDriftMonitor | null {
  if (!pool) return null;
  const monitor = createSchemaDriftMonitor(pool, service);
  registerShutdownHook('schema-drift-monitor', () => monitor.stop());
  return monitor;
}
