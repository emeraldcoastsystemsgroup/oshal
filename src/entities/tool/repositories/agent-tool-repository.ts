/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of AgentToolRepository for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned tool queries with current registry schema columns to prevent runtime SQL errors
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persisted tool_config load/save support for dynamic per-agent tool credential and auth configuration
 */

import { Pool } from 'pg';
import { logger } from '@/shared/logger';
import { Tool, AgentTool, AuthMode } from '@/shared/types/tool';

/**
 * @description Repository for managing agent-tool relationships and authorization modes.
 * Handles CRUD operations on the agent_tools table, including auth mode management,
 * installation state tracking, and tool enablement queries.
 */
export class AgentToolRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Retrieves all tools associated with an agent, including their
   * authorization modes and installation state. Returns a full join of agent_tools
   * and tools tables.
   * 
   * @param agentId - The UUID of the agent
   * @returns Array of AgentTool objects with full tool details
   */
  async getAgentTools(agentId: string): Promise<AgentTool[]> {
    const query = `
      SELECT 
        at.agent_id,
        at.tool_id,
        at.auth_mode,
        at.installed,
        at.install_verified,
        at.tool_config,
        at.created_at AS agent_tool_created_at,
        at.updated_at AS agent_tool_updated_at,
        t.name,
        t.type,
        t.display_name,
        t.description,
        t.category,
        t.install_spec,
        t.version,
        t.skills,
        t.selector_fragment,
        t.routing_tags,
        t.input_schema,
        t.output_schema,
        t.usage_instructions,
        t.examples,
        t.auth_group,
        t.default_auth_mode,
        t.requires_approval,
        t.timeout_ms,
        t.tags,
        t.enabled,
        t.registered_by,
        t.registered_at,
        t.created_at AS tool_created_at,
        t.updated_at AS tool_updated_at
      FROM agent_tools at
      INNER JOIN tools t ON at.tool_id = t.tool_id
      WHERE at.agent_id = $1
      ORDER BY t.name ASC
    `;

    try {
      const result = await this.pool.query(query, [agentId]);
      
      const agentTools: AgentTool[] = result.rows.map((row) => ({
        agentId: row.agent_id,
        toolId: row.tool_id,
        authMode: row.auth_mode as AuthMode,
        installed: row.installed,
        installVerified: row.install_verified,
        toolConfig: row.tool_config && typeof row.tool_config === 'object' ? row.tool_config : {},
        createdAt: row.agent_tool_created_at,
        updatedAt: row.agent_tool_updated_at,
        tool: {
          toolId: row.tool_id,
          name: row.name,
          type: row.type,
          displayName: row.display_name,
          description: row.description,
          category: row.category,
          version: row.version ?? '1.0.0',
          installSpec: row.install_spec,
          skills: row.skills,
          selectorFragment: row.selector_fragment,
          routingTags: row.routing_tags,
          authGroup: row.auth_group,
          defaultAuthMode: row.default_auth_mode,
          requiresApproval: row.requires_approval ?? false,
          timeoutMs: row.timeout_ms ?? 30000,
          tags: row.tags ?? [],
          enabled: row.enabled ?? true,
          registeredBy: row.registered_by ?? '',
          registeredAt: row.registered_at ?? row.tool_created_at ?? new Date(),
          createdAt: row.tool_created_at ?? new Date(),
          updatedAt: row.tool_updated_at ?? new Date(),
          inputSchema: row.input_schema,
          outputSchema: row.output_schema,
          usageInstructions: row.usage_instructions,
          examples: row.examples,
        },
      }));

      logger.info({ agentId, count: agentTools.length }, 'Agent tools retrieved');
      return agentTools;
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to get agent tools');
      throw error;
    }
  }

  /**
   * @description Sets the authorization mode for a specific tool for an agent.
   * Creates the agent_tools record if it doesn't exist (INSERT ON CONFLICT UPDATE).
   * 
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   * @param authMode - The authorization mode (auto/ask/off)
   */
  async setAuthMode(agentId: string, toolId: string, authMode: AuthMode): Promise<void> {
    const query = `
      INSERT INTO agent_tools (agent_id, tool_id, auth_mode, installed, install_verified)
      VALUES ($1, $2, $3, false, false)
      ON CONFLICT (agent_id, tool_id)
      DO UPDATE SET 
        auth_mode = EXCLUDED.auth_mode,
        updated_at = NOW()
    `;

    try {
      await this.pool.query(query, [agentId, toolId, authMode]);
      logger.info({ agentId, toolId, authMode }, 'Auth mode set for agent tool');
    } catch (error) {
      logger.error({ err: error, agentId, toolId, authMode }, 'Failed to set auth mode');
      throw error;
    }
  }

  /**
   * @description Sets the tool runtime configuration for a specific tool for an agent.
   * Creates the agent_tools record if it does not exist, preserving auth_mode='off' by default.
   *
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   * @param toolConfig - Unified runtime/auth configuration object
   * @returns Promise that resolves when configuration is persisted
   */
  async setToolConfig(agentId: string, toolId: string, toolConfig: Record<string, unknown>): Promise<void> {
    const query = `
      INSERT INTO agent_tools (agent_id, tool_id, auth_mode, installed, install_verified, tool_config)
      VALUES ($1, $2, 'off', false, false, $3::jsonb)
      ON CONFLICT (agent_id, tool_id)
      DO UPDATE SET
        tool_config = EXCLUDED.tool_config,
        updated_at = NOW()
    `;

    try {
      await this.pool.query(query, [agentId, toolId, JSON.stringify(toolConfig ?? {})]);
      logger.info({ agentId, toolId }, 'Tool configuration updated for agent tool');
    } catch (error) {
      logger.error({ err: error, agentId, toolId }, 'Failed to set tool configuration');
      throw error;
    }
  }

  /**
   * @description Sets the authorization mode for all tools in an auth group for an agent.
   * Uses a bulk UPDATE operation targeting tools with matching auth_group.
   * 
   * @param agentId - The UUID of the agent
   * @param groupName - The auth group name
   * @param authMode - The authorization mode (auto/ask/off)
   * @returns Number of tools updated
   */
  async setGroupAuthMode(agentId: string, groupName: string, authMode: AuthMode): Promise<number> {
    // First, ensure all tools in the group have agent_tools records
    const insertQuery = `
      INSERT INTO agent_tools (agent_id, tool_id, auth_mode, installed, install_verified)
      SELECT $1, t.tool_id, $2, false, false
      FROM tools t
      WHERE t.auth_group = $3
      ON CONFLICT (agent_id, tool_id) DO NOTHING
    `;

    // Then update the auth_mode for all tools in the group
    const updateQuery = `
      UPDATE agent_tools
      SET 
        auth_mode = $2,
        updated_at = NOW()
      FROM tools t
      WHERE agent_tools.tool_id = t.tool_id
        AND agent_tools.agent_id = $1
        AND t.auth_group = $3
    `;

    try {
      // Insert missing records
      await this.pool.query(insertQuery, [agentId, authMode, groupName]);

      // Update all records in group
      const result = await this.pool.query(updateQuery, [agentId, authMode, groupName]);
      const count = result.rowCount || 0;

      logger.info({ agentId, groupName, authMode, count }, 'Auth mode set for tool group');
      return count;
    } catch (error) {
      logger.error({ err: error, agentId, groupName, authMode }, 'Failed to set group auth mode');
      throw error;
    }
  }

  /**
   * @description Marks a tool as installed for an agent.
   * Sets installed=true, install_verified=false (pending verification).
   * 
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   */
  async markInstalled(agentId: string, toolId: string): Promise<void> {
    const query = `
      UPDATE agent_tools
      SET 
        installed = true,
        install_verified = false,
        updated_at = NOW()
      WHERE agent_id = $1 AND tool_id = $2
    `;

    try {
      await this.pool.query(query, [agentId, toolId]);
      logger.info({ agentId, toolId }, 'Tool marked as installed');
    } catch (error) {
      logger.error({ err: error, agentId, toolId }, 'Failed to mark tool as installed');
      throw error;
    }
  }

  /**
   * @description Marks a tool as uninstalled for an agent.
   * Sets installed=false, install_verified=false.
   * 
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   */
  async markUninstalled(agentId: string, toolId: string): Promise<void> {
    const query = `
      UPDATE agent_tools
      SET 
        installed = false,
        install_verified = false,
        updated_at = NOW()
      WHERE agent_id = $1 AND tool_id = $2
    `;

    try {
      await this.pool.query(query, [agentId, toolId]);
      logger.info({ agentId, toolId }, 'Tool marked as uninstalled');
    } catch (error) {
      logger.error({ err: error, agentId, toolId }, 'Failed to mark tool as uninstalled');
      throw error;
    }
  }

  /**
   * @description Retrieves all enabled tools for an agent (auth_mode != 'off').
   * Returns full tool details for tools that are available to the agent.
   * 
   * @param agentId - The UUID of the agent
   * @returns Array of Tool objects for enabled tools
   */
  async getEnabledTools(agentId: string): Promise<Tool[]> {
    const query = `
      SELECT 
        t.tool_id,
        t.name,
        t.type,
        t.display_name,
        t.description,
        t.category,
        t.install_spec,
        t.version,
        t.skills,
        t.selector_fragment,
        t.routing_tags,
        t.input_schema,
        t.output_schema,
        t.usage_instructions,
        t.examples,
        t.auth_group,
        t.default_auth_mode,
        t.requires_approval,
        t.timeout_ms,
        t.tags,
        t.enabled,
        t.registered_by,
        t.registered_at,
        t.created_at,
        t.updated_at
      FROM tools t
      INNER JOIN agent_tools at ON t.tool_id = at.tool_id
      WHERE at.agent_id = $1
        AND at.auth_mode != 'off'
      ORDER BY t.name ASC
    `;

    try {
      const result = await this.pool.query(query, [agentId]);
      
      const tools: Tool[] = result.rows.map((row) => ({
        toolId: row.tool_id,
        name: row.name,
        type: row.type,
        displayName: row.display_name,
        description: row.description,
        category: row.category,
        version: row.version ?? '1.0.0',
        installSpec: row.install_spec,
        skills: row.skills,
        selectorFragment: row.selector_fragment,
        routingTags: row.routing_tags,
        authGroup: row.auth_group,
        defaultAuthMode: row.default_auth_mode,
        requiresApproval: row.requires_approval ?? false,
        timeoutMs: row.timeout_ms ?? 30000,
        tags: row.tags ?? [],
        enabled: row.enabled ?? true,
        registeredBy: row.registered_by ?? '',
        registeredAt: row.registered_at ?? row.created_at ?? new Date(),
        createdAt: row.created_at ?? new Date(),
        updatedAt: row.updated_at ?? new Date(),
        inputSchema: row.input_schema,
        outputSchema: row.output_schema,
        usageInstructions: row.usage_instructions,
        examples: row.examples,
      }));

      logger.info({ agentId, count: tools.length }, 'Enabled tools retrieved');
      return tools;
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to get enabled tools');
      throw error;
    }
  }
}
