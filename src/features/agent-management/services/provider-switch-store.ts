/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The switch table (migration 146) behind "a bot's LLM provider is a row in a table": one row per agent id plus the reserved 'fleet-default' row. Plain DML over the caller's pool, so the GUC wrapper's identity decides what the operator-only write policy allows; no secret is ever written or logged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot row is the EXISTING agent_config record, not a second per-bot table (BACKLOG entry, verbatim: "The per-bot row is the existing agent_config record"; the box already holds 70 such rows and dispatch stamping already carries them). listAll now unions the fleet-default row from oshal_bot_provider_switch with every agent_config record whose config_values names a providerId, shaped as the same ProviderSwitchRow, so the snapshot resolves per-bot > fleet > registry from the two stores that already exist. upsert/remove stay the fleet-row writers (the table's CHECK refuses any other scope); the per-bot write path is unchanged: PUT /api/agents/:id/runtime through ConfigSyncService.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchRow } from '@/shared/llm-runtime';

const logger = createChildLogger({ module: 'provider-switch-store' });

/** One row of oshal_bot_provider_switch, or one agent_config record projected to the same shape. */
interface SwitchRowRecord {
  scope_id: string;
  provider_id: string;
  model_id: string | null;
  updated_by: string | null;
  updated_at: Date | string | null;
}

/** @description Shape a table row into the shared record type. */
function toRow(record: SwitchRowRecord): ProviderSwitchRow {
  const updatedAt = record.updated_at instanceof Date ? record.updated_at.toISOString() : record.updated_at;
  return {
    scopeId: record.scope_id,
    providerId: record.provider_id,
    modelId: record.model_id,
    updatedBy: record.updated_by,
    updatedAt: updatedAt ?? null,
  };
}

/**
 * @description Postgres store for the provider switch rows. The pool is the caller's (GUC-wrapped)
 * pool, so a write from a non-operator identity is refused by the table's own policy rather than
 * by code that could be bypassed.
 */
export class ProviderSwitchStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Every switch row the ladder reads: the fleet-default row from this table plus
   * every per-bot record in agent_config whose config_values names a providerId (the record
   * PUT /api/agents/:id/runtime writes). The snapshot loads from this.
   * @returns All rows, fleet default first, then agent ids in order.
   */
  async listAll(): Promise<ProviderSwitchRow[]> {
    const result = await this.pool.query<SwitchRowRecord>(
      `SELECT scope_id, provider_id, model_id, updated_by, updated_at FROM (
         SELECT scope_id, provider_id, model_id, updated_by, updated_at
           FROM oshal_bot_provider_switch
          WHERE scope_id = $1
         UNION ALL
         SELECT agent_id::text AS scope_id,
                btrim(config_values->>'providerId') AS provider_id,
                NULLIF(btrim(config_values->>'modelId'), '') AS model_id,
                NULLIF(btrim(config_values->>'configUpdatedBy'), '') AS updated_by,
                updated_at
           FROM agent_config
          WHERE NULLIF(btrim(config_values->>'providerId'), '') IS NOT NULL
            AND lower(btrim(config_values->>'providerId')) <> 'auto'
       ) rows
       ORDER BY (scope_id = $1) DESC, scope_id`,
      [FLEET_DEFAULT_SWITCH_ID],
    );
    return result.rows.map(toRow);
  }

  /**
   * @description One row of this table by scope id (the fleet default).
   * @param scopeId - {@link FLEET_DEFAULT_SWITCH_ID}.
   * @returns The row, or null when no switch is set for that scope.
   */
  async get(scopeId: string): Promise<ProviderSwitchRow | null> {
    const result = await this.pool.query<SwitchRowRecord>(
      `SELECT scope_id, provider_id, model_id, updated_by, updated_at
         FROM oshal_bot_provider_switch WHERE scope_id = $1`,
      [scopeId],
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  /**
   * @description Set the fleet-default switch: ONE upsert. The caller validates the provider id
   * first (classifyProviderId) — this method records what it is given. The table's CHECK refuses
   * any scope but {@link FLEET_DEFAULT_SWITCH_ID}; per-bot rows are written through ConfigSyncService.
   * @param scopeId - {@link FLEET_DEFAULT_SWITCH_ID}.
   * @param providerId - The provider id to switch to.
   * @param modelId - The model, or null to let the harness default decide.
   * @param updatedBy - Who wrote it (an operator sub or a route name); never a secret.
   * @returns The row as stored.
   */
  async upsert(scopeId: string, providerId: string, modelId: string | null, updatedBy: string): Promise<ProviderSwitchRow> {
    const result = await this.pool.query<SwitchRowRecord>(
      `INSERT INTO oshal_bot_provider_switch (scope_id, provider_id, model_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (scope_id) DO UPDATE SET
         provider_id = EXCLUDED.provider_id,
         model_id = EXCLUDED.model_id,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING scope_id, provider_id, model_id, updated_by, updated_at`,
      [scopeId, providerId, modelId, updatedBy],
    );
    const row = toRow(result.rows[0]);
    logger.info({ scopeId, providerId, modelId, updatedBy }, 'Provider switch row written');
    return row;
  }

  /**
   * @description Clear the fleet-default switch, so resolution falls to the registry literal.
   * @param scopeId - {@link FLEET_DEFAULT_SWITCH_ID}.
   * @returns True when a row was removed.
   */
  async remove(scopeId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM oshal_bot_provider_switch WHERE scope_id = $1', [scopeId]);
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) logger.info({ scopeId }, 'Provider switch row removed');
    return removed;
  }
}
