/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile repository for dedicated persisted chat-agent personalization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added createAgent and deleteAgent for agent-factory bot provisioning
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exposed base selector metadata on profile reads so swarm routing can preserve seeded capabilities and keywords
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added non-UUID runtime identity lookup by agent name so architect-bot and other named swarm agents can load profiles
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | listAgents/createAgent: log the pre-migration "relation agents does not exist" case (pg 42P01) at WARN instead of ERROR — on a clean-DB first boot these fire before migrations create the table and self-heal on the caller's next pass; errors still rethrow unchanged (BACKLOG "Noisy first-boot logs")
 */

import { Pool } from 'pg';
import { logger } from '@/shared/logger';
import { type AgentProfile, type AgentSummary } from '../schemas';

/** pg 42P01 undefined_table — on a clean-DB first boot, callers race the migration that creates
 *  `agents`; that case is self-healing (the caller retries / the next ensure pass succeeds) and
 *  is logged at WARN so a first boot doesn't scream ERROR for expected ordering. */
const isMissingTable = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === '42P01';

interface PersistAgentProfileInput {
  agentId: string;
  name: string;
  status: string;
  providerId: string;
  modelId?: string;
  metadata: Record<string, unknown>;
  baseCapabilities: string[];
  baseSelectorDescriptor: string;
  baseRoutingKeywords: string[];
}

/**
 * @description Input for creating a new agent record.
 */
export interface CreateAgentInput {
  name: string;
  status?: string;
  apiProviderId: string;
  modelId?: string;
  persona: Record<string, unknown>;
  baseCapabilities: string[];
  baseSelectorDescriptor: string;
  baseRoutingKeywords: string[];
  metadata?: Record<string, unknown>;
}

/**
 * @description Repository for narrow agent-profile reads and writes against the `agents` table.
 * The profile is scoped by `agentId`, which is what keeps same-bot tenants isolated from each other.
 */
export class AgentProfileRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Reads the persisted agent-profile for one agent.
   * @param agentId - Agent identifier.
   * @returns Normalized agent-profile, or null when the agent row is missing.
   */
  async getAgentProfile(agentId: string): Promise<AgentProfile | null> {
    const query = isUuidAgentIdentity(agentId)
      ? `
      SELECT
        agent_id,
        name,
        status,
        api_provider_id,
        model_id,
        persona,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords,
        updated_at
      FROM agents
      WHERE agent_id = $1
    `
      : `
      SELECT
        agent_id,
        name,
        status,
        api_provider_id,
        model_id,
        persona,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords,
        updated_at
      FROM agents
      WHERE name = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    try {
      const result = await this.pool.query(query, [agentId]);
      if (result.rows.length === 0) {
        logger.warn({ agentId }, 'Agent profile not found');
        return null;
      }

      const profile = mapAgentProfileRow(result.rows[0] as Record<string, unknown>);
      logger.info({ agentId }, 'Agent profile retrieved');
      return profile;
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to read agent profile');
      throw error;
    }
  }

  /**
   * @description Lists persisted agent-profile summaries for cross-bot operations UIs.
   * @returns Lightweight agent summaries ordered by name.
   */
  async listAgents(): Promise<AgentSummary[]> {
    const query = `
      SELECT
        agent_id,
        name,
        status,
        api_provider_id,
        model_id,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords,
        computed_capabilities,
        computed_selector_descriptor,
        computed_routing_keywords,
        updated_at
      FROM agents
      ORDER BY name ASC, agent_id ASC
    `;

    try {
      const result = await this.pool.query(query);
      const agents = result.rows.map((row) => mapAgentSummaryRow(row as Record<string, unknown>));
      logger.info({ count: agents.length }, 'Agent summaries retrieved');
      return agents;
    } catch (error) {
      if (isMissingTable(error)) {
        logger.warn({ err: error }, 'Agent summaries unavailable — agents table not created yet (pre-migration boot race, self-healing)');
      } else {
        logger.error({ err: error }, 'Failed to list agent summaries');
      }
      throw error;
    }
  }

  /**
   * @description Creates a new agent record in the agents table.
   * @param input - Agent definition fields.
   * @returns The created agent profile.
   */
  async createAgent(input: CreateAgentInput): Promise<AgentProfile> {
    const query = `
      INSERT INTO agents (
        name, status, api_provider_id, model_id,
        persona, base_capabilities, base_selector_descriptor,
        base_routing_keywords, metadata
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8::text[], $9::jsonb)
      RETURNING
        agent_id, name, status, api_provider_id, model_id,
        persona, metadata, base_capabilities, base_selector_descriptor, base_routing_keywords, updated_at
    `;

    try {
      const result = await this.pool.query(query, [
        input.name,
        input.status || 'active',
        input.apiProviderId,
        input.modelId || null,
        JSON.stringify(input.persona),
        input.baseCapabilities,
        input.baseSelectorDescriptor,
        input.baseRoutingKeywords,
        JSON.stringify(input.metadata || {}),
      ]);

      const profile = mapAgentProfileRow(result.rows[0] as Record<string, unknown>);
      logger.info({ agentId: profile.agentId, name: input.name }, 'Agent created');
      return profile;
    } catch (error) {
      if (isMissingTable(error)) {
        logger.warn({ err: error, name: input.name }, 'Agent create deferred — agents table not created yet (pre-migration boot race, self-healing)');
      } else {
        logger.error({ err: error, name: input.name }, 'Failed to create agent');
      }
      throw error;
    }
  }

  /**
   * @description Deletes an agent record from the agents table.
   * @param agentId - Agent identifier.
   * @returns True if the agent was deleted, false if not found.
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'DELETE FROM agents WHERE agent_id = $1',
        [agentId],
      );
      const deleted = (result.rowCount ?? 0) > 0;
      if (deleted) {
        logger.info({ agentId }, 'Agent deleted');
      } else {
        logger.warn({ agentId }, 'Agent not found for deletion');
      }
      return deleted;
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to delete agent');
      throw error;
    }
  }

  /**
   * @description Persists the agent-profile and selector base fields for one agent.
   * @param input - Persisted agent-profile fields.
   * @returns Updated normalized agent-profile, or null when the agent row is missing.
   */
  /**
   * @description Updates the status of an agent (active/inactive/error/provisioning/maintenance).
   * Used by the enable/disable toggle to control swarm routing participation.
   *
   * @param agentId - The UUID of the agent
   * @param status - New status value
   * @returns Updated agent profile or null if not found
   */
  async updateAgentStatus(agentId: string, status: string): Promise<AgentProfile | null> {
    const result = await this.pool.query(
      'UPDATE agents SET status = $1, updated_at = NOW() WHERE agent_id = $2 RETURNING *',
      [status, agentId],
    );
    if (result.rows.length === 0) return null;
    return mapAgentProfileRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * @description Narrow update — only overwrites api_provider_id and model_id.
   * Used by boot-time registry sync so harness config never drifts from the DB.
   */
  async syncProviderModel(agentId: string, providerId: string, modelId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        'UPDATE agents SET api_provider_id = $2, model_id = $3, updated_at = NOW() WHERE agent_id = $1',
        [agentId, providerId, modelId],
      );
      if (result.rowCount && result.rowCount > 0) {
        logger.info({ agentId, providerId, modelId }, 'Boot sync: agent provider/model updated');
      }
    } catch (error) {
      logger.error({ err: error, agentId }, 'Boot sync: failed to update agent provider/model');
    }
  }

  async updateAgentProfile(input: PersistAgentProfileInput): Promise<AgentProfile | null> {
    const query = `
      UPDATE agents
      SET
        name = $2,
        status = $3,
        api_provider_id = $4,
        model_id = $5,
        metadata = $6::jsonb,
        base_capabilities = $7::text[],
        base_selector_descriptor = $8,
        base_routing_keywords = $9::text[],
        updated_at = NOW()
      WHERE agent_id = $1
      RETURNING
        agent_id,
        name,
        status,
        api_provider_id,
        model_id,
        persona,
        metadata,
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords,
        updated_at
    `;

    try {
      const result = await this.pool.query(query, [
        input.agentId,
        input.name,
        input.status,
        input.providerId,
        input.modelId || null,
        JSON.stringify(input.metadata),
        input.baseCapabilities,
        input.baseSelectorDescriptor,
        input.baseRoutingKeywords,
      ]);
      if (result.rows.length === 0) {
        logger.warn({ agentId: input.agentId }, 'Agent profile update skipped because agent was missing');
        return null;
      }

      const profile = mapAgentProfileRow(result.rows[0] as Record<string, unknown>);
      logger.info({ agentId: input.agentId }, 'Agent profile updated');
      return profile;
    } catch (error) {
      logger.error({ err: error, agentId: input.agentId }, 'Failed to update agent profile');
      throw error;
    }
  }
}

/**
 * @description Detects whether one runtime identity is stored as a UUID in Postgres.
 * Named swarm agents such as architect-bot are persisted with UUID primary keys and must
 * be looked up by name instead of agent_id.
 * @param agentId - Runtime agent identity from the mesh envelope.
 * @returns True when the identifier is a UUID string.
 */
function isUuidAgentIdentity(agentId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId);
}

/**
 * @description Maps a raw `agents` row into the normalized agent-profile DTO.
 * @param row - Raw database row.
 * @returns Normalized profile.
 */
function mapAgentProfileRow(row: Record<string, unknown>): AgentProfile {
  const metadata = readRecord(row.metadata);
  return {
    agentId: readString(row.agent_id),
    name: readString(row.name),
    status: readString(row.status),
    providerId: readString(row.api_provider_id),
    modelId: readOptionalString(row.model_id),
    persona: readRecord(row.persona),
    baseCapabilities: readStringArray(row.base_capabilities),
    selectorDescriptor: readOptionalString(row.base_selector_descriptor) || '',
    routingKeywords: readStringArray(row.base_routing_keywords),
    projectUrl: readOptionalString(metadata.projectUrl) || '',
    selectorSkillsText: readOptionalString(metadata.selectorSkillsText) || readOptionalString(row.base_selector_descriptor) || '',
    avatarUrl: readOptionalString(metadata.avatarUrl) || '',
    themePreference: readOptionalString(metadata.themePreference) || 'midnight',
    excludeFromBulkConfig: metadata.excludeFromBulkConfig === true,
    metadata,
    updatedAt: normalizeDate(row.updated_at),
  };
}

/**
 * @description Maps a raw `agents` row into a lightweight agent-summary DTO.
 * @param row - Raw database row.
 * @returns Lightweight summary for scheduling UIs.
 */
function mapAgentSummaryRow(row: Record<string, unknown>): AgentSummary {
  const metadata = readRecord(row.metadata);
  // Use computed capabilities (base + tool-provided) when available, fall back to base-only
  const baseCapabilities = readStringArray(row.base_capabilities);
  const computedCapabilities = readStringArray(row.computed_capabilities);
  const mergedCapabilities = computedCapabilities.length > 0
    ? [...new Set([...baseCapabilities, ...computedCapabilities])]
    : baseCapabilities;

  const baseKeywords = readStringArray(row.base_routing_keywords);
  const computedKeywords = readStringArray(row.computed_routing_keywords);
  const mergedKeywords = computedKeywords.length > 0
    ? [...new Set([...baseKeywords, ...computedKeywords])]
    : baseKeywords;

  const baseDescriptor = readOptionalString(row.base_selector_descriptor) || '';
  const computedDescriptor = readOptionalString(row.computed_selector_descriptor) || '';
  const mergedDescriptor = computedDescriptor || baseDescriptor;

  return {
    agentId: readString(row.agent_id),
    name: readString(row.name),
    status: readString(row.status),
    providerId: readString(row.api_provider_id),
    modelId: readOptionalString(row.model_id),
    baseCapabilities: mergedCapabilities,
    selectorDescriptor: mergedDescriptor,
    routingKeywords: mergedKeywords,
    projectUrl: readOptionalString(metadata.projectUrl) || '',
    avatarUrl: readOptionalString(metadata.avatarUrl) || '',
    themePreference: readOptionalString(metadata.themePreference) || 'midnight',
    excludeFromBulkConfig: metadata.excludeFromBulkConfig === true,
    updatedAt: normalizeDate(row.updated_at),
  };
}

/**
 * @description Reads an object value from unknown input.
 * @param value - Raw input.
 * @returns Object value or an empty object.
 */
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * @description Reads a required string field.
 * @param value - Raw input.
 * @returns Trimmed string, or an empty string when missing.
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Reads an optional string field.
 * @param value - Raw input.
 * @returns Trimmed string or undefined.
 */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

/**
 * @description Reads a string array from unknown database values.
 * @param value - Raw input.
 * @returns Normalized string array.
 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * @description Normalizes date-like database values into ISO strings.
 * @param value - Raw timestamp column.
 * @returns ISO timestamp string.
 */
function normalizeDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}
