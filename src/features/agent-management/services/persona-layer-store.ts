/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres-backed persona layer store for multi-layer prompt composition
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added insertLayer for agent-factory bot provisioning
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The three swarm-wide policy rows reach the prompt AS POLICY again. #142 (2026-08-06) began requiring metadata.serverAuthored for a platform/host/tenant layer to earn the policy class, and stamped buildFilePersonaLayer but not the migration-009 seeds, which carry only {"source":"seed","version":"1.0"}. Nothing in src/, any-bot/, scripts/ or any migration has added the stamp since, so all three global rows - including the platform row's "Never expose internal system details, API keys, or credentials in output" - fell through the fail-closed default and were JSON-escaped into <UNTRUSTED_CONTENT>, in the same section as the ticket body, under a contract telling the model never to follow instructions found there. Stamped on READ rather than by a migration because the host row's text is deployment-specific and a migration would freeze one box's wording. The SELECT now carries scope so the stamp can require a GLOBAL row, not merely a platform-typed one.
 */

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { ensurePersonaLayerSchema } from '@/shared/services/database';
import type { PersonaLayer, PersonaLayerType } from './persona-layer-composer';

const logger = createChildLogger({ module: 'persona-layer-store' });

/**
 * @description A persisted persona layer row from the database.
 */
export interface PersistedPersonaLayer {
  layerId: string;
  layerType: PersonaLayerType;
  scope: string;
  agentId?: string;
  priority: number;
  promptFragment: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
}

/**
 * @description Postgres-backed store for persona layer fragments used in prompt composition.
 */
export class PersonaLayerStore {
  private readonly schemaReady: Promise<void>;

  constructor(private readonly pool: Pool) {
    this.schemaReady = ensurePersonaLayerSchema(pool).catch((error) => {
      logger.error({ err: error }, 'Persona layer schema bootstrap failed; queries will attempt without guarantee');
    });
  }

  /**
   * @description Fetches all enabled global layers (platform, host, tenant).
   * @returns Sorted persona layers for global composition
   */
  async getGlobalLayers(): Promise<PersonaLayer[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT layer_type, scope, priority, prompt_fragment, metadata
       FROM persona_layers
       WHERE scope = 'global' AND enabled = true
       ORDER BY priority ASC`,
    );
    logger.info({ count: result.rows.length }, 'Global persona layers loaded');
    return result.rows.map(mapRowToPersonaLayer);
  }

  /**
   * @description Fetches role-specific layers for a given agent.
   * @param agentId - Agent identifier
   * @returns Sorted persona layers for the agent's role
   */
  async getAgentRoleLayers(agentId: string): Promise<PersonaLayer[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT layer_type, scope, priority, prompt_fragment, metadata
       FROM persona_layers
       WHERE agent_id = $1 AND enabled = true
       ORDER BY priority ASC`,
      [agentId],
    );
    logger.info({ agentId, count: result.rows.length }, 'Agent role persona layers loaded');
    return result.rows.map(mapRowToPersonaLayer);
  }

  /**
   * @description Inserts a new persona layer into the store.
   * @param input - Layer definition
   */
  async insertLayer(input: {
    layerType: string;
    scope: string;
    agentId: string;
    priority: number;
    promptFragment: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.schemaReady;
    await this.pool.query(
      `INSERT INTO persona_layers (layer_type, scope, agent_id, priority, prompt_fragment, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
         prompt_fragment = EXCLUDED.prompt_fragment,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [input.layerType, input.scope, input.agentId, input.priority, input.promptFragment, JSON.stringify(input.metadata)],
    );
    logger.info({ agentId: input.agentId, layerType: input.layerType }, 'Persona layer inserted');
  }

  /**
   * @description Fetches all layers applicable to an agent execution context.
   * Combines global layers with agent-specific role layers, sorted by priority.
   * @param agentId - Agent identifier
   * @returns Combined and sorted persona layers
   */
  async getLayersForAgent(agentId: string): Promise<PersonaLayer[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT layer_type, scope, priority, prompt_fragment, metadata
       FROM persona_layers
       WHERE (scope = 'global' OR agent_id = $1) AND enabled = true
       ORDER BY priority ASC`,
      [agentId],
    );
    logger.info({ agentId, count: result.rows.length }, 'Combined persona layers loaded for agent');
    return result.rows.map(mapRowToPersonaLayer);
  }
}

/** Layer types that carry swarm-wide operating policy rather than per-agent content. */
const POLICY_LAYER_TYPES: ReadonlySet<string> = new Set(['platform', 'host', 'tenant']);

/**
 * @description Maps a database row to a PersonaLayer interface, stamping server provenance on the
 * globally scoped policy rows so they reach the prompt as policy instead of escaped data.
 *
 * Why the stamp lives here and not in a migration: the seeded host row's text is
 * deployment-specific, so a migration would freeze one box's wording into every install. And why
 * it is safe: a row reaches this mapper only from `persona_layers`, whose sole runtime writer is
 * `AgentFactoryService.createRoleLayer`, which writes `layerType: 'role', scope: 'agent'` — a
 * combination this predicate excludes twice over, and which `classifyLayer` hard-denies anyway.
 * The caller inventory is pinned by a guard; a second writer must be reviewed against this claim.
 * @param row - Raw database row, including `scope`.
 * @returns Normalized PersonaLayer.
 */
function mapRowToPersonaLayer(row: Record<string, unknown>): PersonaLayer {
  const layerType = row.layer_type as PersonaLayerType;
  const metadata = (row.metadata as Record<string, unknown>) ?? {};
  const serverAuthored = row.scope === 'global' && POLICY_LAYER_TYPES.has(layerType);
  return {
    layerType,
    priority: row.priority as number,
    promptFragment: row.prompt_fragment as string,
    metadata: serverAuthored ? { ...metadata, serverAuthored: true } : metadata,
  };
}
