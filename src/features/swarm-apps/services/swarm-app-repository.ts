/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial repository for swarm_applications table
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { GuestTier } from '@/shared/middleware/guest-capability-matrix';
import type { SwarmApplicationRecord, SwarmAppManifest, SwarmAppScope } from '../types';

const logger = createChildLogger({ module: 'swarm-app-repository' });

/**
 * Scope metadata supplied at load/publish time. Owner/tenant are passed explicitly
 * by the publish route from the authenticated session — never read from the manifest
 * body. All fields optional: a plain boot auto-load passes none, so the row keeps its
 * default ('public') / existing owner.
 */
export interface SwarmAppScopeMeta {
  scope?: SwarmAppScope;
  ownerSub?: string | null;
  tenantId?: string | null;
}

interface RowShape {
  app_id: string;
  name: string;
  display_name: string;
  description: string;
  version: string;
  status: 'active' | 'inactive';
  manifest_path: string;
  agent_ids: string[];
  tool_names: string[];
  manifest: SwarmAppManifest;
  scope: SwarmAppScope;
  owner_sub: string | null;
  tenant_id: string | null;
  guest_tier_approved: GuestTier | null;
  loaded_at: Date;
  updated_at: Date;
}

function rowToRecord(row: RowShape): SwarmApplicationRecord {
  return {
    appId: row.app_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    status: row.status,
    manifestPath: row.manifest_path,
    agentIds: row.agent_ids ?? [],
    toolNames: row.tool_names ?? [],
    manifest: row.manifest,
    scope: row.scope ?? 'public',
    ownerSub: row.owner_sub ?? null,
    tenantId: row.tenant_id ?? null,
    // ADR-085 D4: null (the default, and the value for every app installed before migration 076)
    // means NOT APPROVED — the app gets the safe Tier-B default, never what its manifest asked for.
    guestTierApproved: row.guest_tier_approved ?? null,
    loadedAt: row.loaded_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @description Postgres-backed repository for the swarm_applications
 * table. Keeps the service layer free of SQL. Callers supply the pool so
 * this reuses the app-wide connection config.
 */
export class SwarmAppRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Upserts an application record keyed by name. Used at load
   * time and when a manifest is reloaded from disk.
   * @param manifest - the parsed YAML manifest
   * @param manifestPath - path the manifest was loaded from
   * @param toolNames - tool names registered for this app (caller computes)
   */
  async upsert(
    manifest: SwarmAppManifest,
    manifestPath: string,
    toolNames: string[],
    scopeMeta?: SwarmAppScopeMeta,
  ): Promise<SwarmApplicationRecord> {
    let agentIds = (manifest.bots ?? []).map(b => b.agentId);
    // ADR-085 carve parity: a store-carved app declares NO `bots:` (its worker is
    // framework-resident per ADR-093), but the app must still ASSOCIATE with that bot so
    // every `swarm_applications.agent_ids` consumer keeps working exactly as pre-carve —
    // Jarvis's dynamic catalog (delegate/handoff + ?app= deep link), mesh BID_REQUEST
    // fan-out, selector composition, and competency ranking all resolve the app's agent
    // from this column. Resolve the workflow.workerBot NAME → agentId here. Boot-order
    // safe: if the worker isn't seeded yet the array stays empty (no worse than before)
    // and the next reload fills it. Non-carved apps (with `bots:`) skip this untouched.
    if (agentIds.length === 0 && manifest.workflow?.workerBot) {
      try {
        const wb = await this.pool.query<{ agent_id: string }>(
          `SELECT agent_id FROM agents WHERE name = $1 LIMIT 1`, [manifest.workflow.workerBot]);
        if (wb.rows[0]?.agent_id) agentIds = [wb.rows[0].agent_id];
      } catch (err) {
        logger.warn({ err, app: manifest.name, workerBot: manifest.workflow.workerBot },
          'workerBot→agentId resolution failed; preserving any previously stored agent_ids');
      }
      // MONOTONE GUARD: never let a failed/unseeded resolution CLOBBER a previously
      // populated row. Upserting [] here isn't just a stale catalog entry — the same
      // load pass runs reconcileAgentsTable, which marks any manifestApp-stamped agent
      // not referenced by an active app's agent_ids as status='inactive', knocking the
      // framework-resident worker out of mesh bid fan-out and the Jarvis catalog until
      // a future reload happens to resolve. Reuse the existing row's ids instead; a
      // first-ever load (no row yet) stays empty exactly as before.
      if (agentIds.length === 0) {
        try {
          const prev = await this.pool.query<{ agent_ids: string[] }>(
            `SELECT agent_ids FROM swarm_applications WHERE name = $1 LIMIT 1`, [manifest.name]);
          if (prev.rows[0]?.agent_ids?.length) agentIds = prev.rows[0].agent_ids;
        } catch (err) {
          logger.warn({ err, app: manifest.name }, 'agent_ids preserve-read failed; row keeps empty agent_ids this pass');
        }
      }
    }
    // Scope/owner/tenant are bound NULLABLE: a plain boot reload passes none, so the
    // INSERT falls back to 'public' for brand-new rows and the ON CONFLICT path
    // PRESERVES whatever scope/owner a prior publish stamped (COALESCE($n, existing)).
    // An explicit publish passes scope='person' + ownerSub and overwrites accordingly.
    // Owner is never sourced from the manifest body — only from scopeMeta (the session).
    const scopeParam: SwarmAppScope | null = scopeMeta?.scope ?? manifest.scope ?? null;
    const ownerSubParam: string | null = scopeMeta?.ownerSub ?? null;
    const tenantIdParam: string | null = scopeMeta?.tenantId ?? null;
    // Status precedence:
    //  1. If the manifest path is in a variant directory (swarm-apps-build/,
    //     swarm-apps-incident/, swarm-apps-little-monsters/), the variant
    //     intent ALWAYS wins — force the manifest's declared status. This
    //     unblocks variant switching where the prior row's `inactive` was
    //     leftover from a different variant.
    //  2. Otherwise, preserve operator-applied inactive (the original
    //     behaviour). Operators who manually deactivate an app from the
    //     cockpit should not have their decision overwritten by a routine
    //     reload of the same swarm-apps/ directory.
    const isVariantManifest = /[\\/]swarm-apps-(build|incident)[\\/]/i.test(manifestPath);
    const sql = isVariantManifest
      ? `INSERT INTO swarm_applications
           (name, display_name, description, version, status, manifest_path, agent_ids, tool_names, manifest, scope, owner_sub, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'public'), $11, $12)
         ON CONFLICT (name) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description  = EXCLUDED.description,
           version      = EXCLUDED.version,
           status       = EXCLUDED.status,
           manifest_path = EXCLUDED.manifest_path,
           agent_ids    = EXCLUDED.agent_ids,
           tool_names   = EXCLUDED.tool_names,
           manifest     = EXCLUDED.manifest,
           scope        = COALESCE($10, swarm_applications.scope),
           owner_sub    = COALESCE($11, swarm_applications.owner_sub),
           tenant_id    = COALESCE($12, swarm_applications.tenant_id)
         RETURNING *`
      : `INSERT INTO swarm_applications
           (name, display_name, description, version, status, manifest_path, agent_ids, tool_names, manifest, scope, owner_sub, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'public'), $11, $12)
         ON CONFLICT (name) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description  = EXCLUDED.description,
           version      = EXCLUDED.version,
           status       = CASE
             WHEN swarm_applications.status = 'inactive' THEN swarm_applications.status
             ELSE EXCLUDED.status
           END,
           manifest_path = EXCLUDED.manifest_path,
           agent_ids    = EXCLUDED.agent_ids,
           tool_names   = EXCLUDED.tool_names,
           manifest     = EXCLUDED.manifest,
           scope        = COALESCE($10, swarm_applications.scope),
           owner_sub    = COALESCE($11, swarm_applications.owner_sub),
           tenant_id    = COALESCE($12, swarm_applications.tenant_id)
         RETURNING *`;
    const { rows } = await this.pool.query<RowShape>(sql, [
      manifest.name,
      manifest.displayName,
      manifest.description ?? '',
      manifest.version ?? '0.0.0',
      manifest.status ?? 'active',
      manifestPath,
      agentIds,
      toolNames,
      manifest,
      scopeParam,
      ownerSubParam,
      tenantIdParam,
    ]);
    logger.info({ name: manifest.name, agentCount: agentIds.length, toolCount: toolNames.length, variantOverride: isVariantManifest }, 'Swarm app upserted');
    return rowToRecord(rows[0]);
  }

  async findByName(name: string): Promise<SwarmApplicationRecord | null> {
    const { rows } = await this.pool.query<RowShape>(
      'SELECT * FROM swarm_applications WHERE name = $1 LIMIT 1',
      [name],
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async list(statusFilter?: 'active' | 'inactive'): Promise<SwarmApplicationRecord[]> {
    const sql = statusFilter
      ? 'SELECT * FROM swarm_applications WHERE status = $1 ORDER BY name'
      : 'SELECT * FROM swarm_applications ORDER BY name';
    const params = statusFilter ? [statusFilter] : [];
    const { rows } = await this.pool.query<RowShape>(sql, params);
    return rows.map(rowToRecord);
  }

  async updateStatus(name: string, status: 'active' | 'inactive'): Promise<SwarmApplicationRecord | null> {
    const { rows } = await this.pool.query<RowShape>(
      `UPDATE swarm_applications SET status = $2 WHERE name = $1 RETURNING *`,
      [name, status],
    );
    if (rows.length === 0) return null;
    logger.info({ name, status }, 'Swarm app status updated');
    return rowToRecord(rows[0]);
  }

  /**
   * @description Record the guest tier an OPERATOR approved for an app (ADR-085 D4).
   *
   * This is the ONLY write path for `guest_tier_approved`. Nothing in the manifest-load path may
   * reach it: a manifest's `guestTier` is a request, and guests are unauthenticated, so letting a
   * package grant itself a tier would silently widen what an anonymous visitor can reach.
   *
   * @param name - App name.
   * @param tier - The approved tier, or null to REVOKE (back to the read-only default).
   * @returns The updated record, or null when the app doesn't exist.
   */
  async setGuestTierApproval(name: string, tier: GuestTier | null): Promise<SwarmApplicationRecord | null> {
    const { rows } = await this.pool.query<RowShape>(
      `UPDATE swarm_applications SET guest_tier_approved = $2 WHERE name = $1 RETURNING *`,
      [name, tier],
    );
    if (rows.length === 0) return null;
    logger.info({ name, tier }, 'Swarm app guest tier approval updated (operator)');
    return rowToRecord(rows[0]);
  }

  async delete(name: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM swarm_applications WHERE name = $1', [name]);
    const deleted = (rowCount ?? 0) > 0;
    logger.info({ name, deleted }, 'Swarm app delete');
    return deleted;
  }
}
