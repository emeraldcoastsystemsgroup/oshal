/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the Postgres store over oshal_capability_swarm_rows (migration 183). Plain DML over the caller's GUC-wrapped pool, so the identity the request established decides what the table's operator-only write policy allows: a non-operator's write is refused by Postgres (42501), not by code that could be bypassed. Options are written as a JSON object holding only a voice and/or a model; no secret is ever written or logged.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  isCapability,
  type Capability,
  type CapabilityRowOptions,
  type CapabilitySwarmRow,
} from '@/shared/capability-providers';

const logger = createChildLogger({ module: 'capability-swarm-row-store' });

/** One row of oshal_capability_swarm_rows as Postgres returns it. */
interface SwarmRowRecord {
  scope_id: string;
  capability: string;
  provider_id: string;
  options: unknown;
  updated_by: string | null;
  updated_at: Date | string | null;
}

/**
 * @description Keep only the two option keys a row may carry, as non-blank strings.
 * @param raw - The stored or supplied options.
 * @returns The options object.
 */
export function normalizeCapabilityRowOptions(raw: unknown): CapabilityRowOptions {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const options: CapabilityRowOptions = {};
  if (typeof source.voice === 'string' && source.voice.trim()) options.voice = source.voice.trim();
  if (typeof source.model === 'string' && source.model.trim()) options.model = source.model.trim();
  return options;
}

/**
 * @description Shape one table row into the shared record type; a row naming an unknown capability
 * (impossible past the CHECK) is dropped rather than guessed.
 * @param record - The row.
 * @returns The record, or null.
 */
function toRow(record: SwarmRowRecord): CapabilitySwarmRow | null {
  if (!isCapability(record.capability)) return null;
  const updatedAt = record.updated_at instanceof Date ? record.updated_at.toISOString() : record.updated_at;
  return {
    scopeId: record.scope_id,
    capability: record.capability,
    providerId: record.provider_id,
    options: normalizeCapabilityRowOptions(record.options),
    updatedBy: record.updated_by,
    updatedAt: updatedAt ?? null,
  };
}

const COLUMNS = 'scope_id, capability, provider_id, options, updated_by, updated_at';

/**
 * @description Postgres store for the swarm capability rows. The pool is the caller's (GUC-wrapped)
 * pool, so the table's own policy, not this class, decides who may write.
 */
export class CapabilitySwarmRowStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Every swarm row: the fleet-default rows first, then agent scopes, by capability.
   * @returns All rows.
   */
  async listAll(): Promise<CapabilitySwarmRow[]> {
    const result = await this.pool.query<SwarmRowRecord>(
      `SELECT ${COLUMNS} FROM oshal_capability_swarm_rows
        ORDER BY (scope_id = 'fleet-default') DESC, scope_id, capability`,
    );
    return result.rows.map(toRow).filter((row): row is CapabilitySwarmRow => row !== null);
  }

  /**
   * @description One row by scope and capability.
   * @param scopeId - 'fleet-default' or an agent id.
   * @param capability - The capability.
   * @returns The row, or null.
   */
  async get(scopeId: string, capability: Capability): Promise<CapabilitySwarmRow | null> {
    const result = await this.pool.query<SwarmRowRecord>(
      `SELECT ${COLUMNS} FROM oshal_capability_swarm_rows WHERE scope_id = $1 AND capability = $2`,
      [scopeId, capability],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  /**
   * @description Set one row: ONE upsert. The caller validates the provider id (and voice) against
   * the capability's registry first; this method records what it is given.
   * @param scopeId - 'fleet-default' or an agent id.
   * @param capability - The capability.
   * @param providerId - The provider id.
   * @param options - A voice and/or a model.
   * @param updatedBy - Who wrote it (the operator subject); never a secret.
   * @returns The row as stored.
   */
  async upsert(
    scopeId: string,
    capability: Capability,
    providerId: string,
    options: CapabilityRowOptions,
    updatedBy: string,
  ): Promise<CapabilitySwarmRow> {
    const clean = normalizeCapabilityRowOptions(options);
    const result = await this.pool.query<SwarmRowRecord>(
      `INSERT INTO oshal_capability_swarm_rows (scope_id, capability, provider_id, options, updated_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (scope_id, capability) DO UPDATE SET
         provider_id = EXCLUDED.provider_id,
         options = EXCLUDED.options,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [scopeId, capability, providerId, JSON.stringify(clean), updatedBy],
    );
    const row = toRow(result.rows[0]);
    if (!row) throw new Error(`capability swarm row write returned an unreadable row for ${capability}`);
    logger.info({ scopeId, capability, providerId, options: clean, updatedBy }, 'Capability swarm row written');
    return row;
  }

  /**
   * @description Clear one row, so the capability falls back to the seed for that scope.
   * @param scopeId - 'fleet-default' or an agent id.
   * @param capability - The capability.
   * @returns True when a row was removed.
   */
  async remove(scopeId: string, capability: Capability): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM oshal_capability_swarm_rows WHERE scope_id = $1 AND capability = $2',
      [scopeId, capability],
    );
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) logger.info({ scopeId, capability }, 'Capability swarm row removed');
    return removed;
  }
}
