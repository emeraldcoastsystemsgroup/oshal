/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres-backed persona layer store for multi-layer prompt composition
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added insertLayer for agent-factory bot provisioning
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
      `SELECT layer_type, priority, prompt_fragment, metadata
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
      `SELECT layer_type, priority, prompt_fragment, metadata
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
      `SELECT layer_type, priority, prompt_fragment, metadata
       FROM persona_layers
       WHERE (scope = 'global' OR agent_id = $1) AND enabled = true
       ORDER BY priority ASC`,
      [agentId],
    );
    logger.info({ agentId, count: result.rows.length }, 'Combined persona layers loaded for agent');
    return result.rows.map(mapRowToPersonaLayer);
  }
}

/**
 * @description Maps a database row to a PersonaLayer interface.
 * @param row - Raw database row
 * @returns Normalized PersonaLayer
 */
function mapRowToPersonaLayer(row: Record<string, unknown>): PersonaLayer {
  return {
    layerType: row.layer_type as PersonaLayerType,
    priority: row.priority as number,
    promptFragment: row.prompt_fragment as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}
