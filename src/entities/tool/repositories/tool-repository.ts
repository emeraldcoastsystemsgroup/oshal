/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool repository
 */

import { Pool } from 'pg';
import { Tool, AuthGroup, ToolInstallLog } from '@/shared/types/tool';
import { ToolFilters } from '../schemas/tool-schemas';
import { logger } from '@/shared/logger';

/**
 * @description Repository for tool data access operations
 */
export class ToolRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Get all tools with optional filters
   * @param filters - Optional filters for tools
   * @returns Array of tools matching filters
   */
  async getAllTools(filters?: ToolFilters): Promise<Tool[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters?.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(filters.type);
    }

    if (filters?.category) {
      conditions.push(`category = $${paramIndex++}`);
      params.push(filters.category);
    }

    if (filters?.authGroup) {
      conditions.push(`auth_group = $${paramIndex++}`);
      params.push(filters.authGroup);
    }

    if (filters?.enabled !== undefined) {
      conditions.push(`enabled = $${paramIndex++}`);
      params.push(filters.enabled);
    }

    if (filters?.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${paramIndex++}`);
      params.push(filters.tags);
    }

    if (filters?.search) {
      conditions.push(
        `to_tsvector('english', name || ' ' || description) @@ plainto_tsquery('english', $${paramIndex++})`
      );
      params.push(filters.search);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;

    const query = `
      SELECT 
        tool_id as "toolId",
        name,
        display_name as "displayName",
        type,
        category,
        version,
        install_spec as "installSpec",
        skills,
        selector_fragment as "selectorFragment",
        routing_tags as "routingTags",
        auth_group as "authGroup",
        default_auth_mode as "defaultAuthMode",
        description,
        input_schema as "inputSchema",
        output_schema as "outputSchema",
        usage_instructions as "usageInstructions",
        examples,
        requires_approval as "requiresApproval",
        timeout_ms as "timeoutMs",
        tags,
        enabled,
        registered_by as "registeredBy",
        registered_at as "registeredAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tools
      ${whereClause}
      ORDER BY name ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;

    params.push(limit, offset);

    try {
      const result = await this.pool.query(query, params);
      logger.info({ count: result.rows.length, filters }, 'Tools retrieved');
      return result.rows;
    } catch (error) {
      logger.error({ err: error, filters }, 'Failed to get tools');
      throw error;
    }
  }

  /**
   * @description Get tool by ID
   * @param toolId - Tool UUID
   * @returns Tool or null if not found
   */
  async getToolById(toolId: string): Promise<Tool | null> {
    const query = `
      SELECT 
        tool_id as "toolId",
        name,
        display_name as "displayName",
        type,
        category,
        version,
        install_spec as "installSpec",
        skills,
        selector_fragment as "selectorFragment",
        routing_tags as "routingTags",
        auth_group as "authGroup",
        default_auth_mode as "defaultAuthMode",
        description,
        input_schema as "inputSchema",
        output_schema as "outputSchema",
        usage_instructions as "usageInstructions",
        examples,
        requires_approval as "requiresApproval",
        timeout_ms as "timeoutMs",
        tags,
        enabled,
        registered_by as "registeredBy",
        registered_at as "registeredAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tools
      WHERE tool_id = $1
    `;

    try {
      const result = await this.pool.query(query, [toolId]);
      if (result.rows.length === 0) {
        logger.warn({ toolId }, 'Tool not found');
        return null;
      }
      logger.info({ toolId }, 'Tool retrieved');
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, toolId }, 'Failed to get tool by ID');
      throw error;
    }
  }

  /**
   * @description Get tool by unique name.
   * @param name - Tool registry name
   * @returns Tool or null if not found
   */
  async getToolByName(name: string): Promise<Tool | null> {
    const query = `
      SELECT
        tool_id as "toolId",
        name,
        display_name as "displayName",
        type,
        category,
        version,
        install_spec as "installSpec",
        skills,
        selector_fragment as "selectorFragment",
        routing_tags as "routingTags",
        auth_group as "authGroup",
        default_auth_mode as "defaultAuthMode",
        description,
        input_schema as "inputSchema",
        output_schema as "outputSchema",
        usage_instructions as "usageInstructions",
        examples,
        requires_approval as "requiresApproval",
        timeout_ms as "timeoutMs",
        tags,
        enabled,
        registered_by as "registeredBy",
        registered_at as "registeredAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM tools
      WHERE name = $1
    `;

    try {
      const result = await this.pool.query(query, [name]);
      if (result.rows.length === 0) {
        logger.warn({ name }, 'Tool not found by name');
        return null;
      }
      logger.info({ name, toolId: result.rows[0].toolId }, 'Tool retrieved by name');
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, name }, 'Failed to get tool by name');
      throw error;
    }
  }

  /**
   * @description Get all categories
   * @returns Array of unique category names
   */
  async getCategories(): Promise<string[]> {
    const query = `
      SELECT DISTINCT category
      FROM tools
      WHERE enabled = true
      ORDER BY category ASC
    `;

    try {
      const result = await this.pool.query(query);
      const categories = result.rows.map((row) => row.category);
      logger.info({ count: categories.length }, 'Categories retrieved');
      return categories;
    } catch (error) {
      logger.error({ err: error }, 'Failed to get categories');
      throw error;
    }
  }

  /**
   * @description Get all authorization groups with tool counts
   * @returns Array of auth groups with metadata
   */
  async getAuthGroups(): Promise<AuthGroup[]> {
    const query = `
      SELECT 
        auth_group as "groupName",
        array_agg(tool_id) as "toolIds",
        COUNT(*) as "toolCount"
      FROM tools
      WHERE auth_group != '' AND enabled = true
      GROUP BY auth_group
      ORDER BY auth_group ASC
    `;

    try {
      const result = await this.pool.query(query);
      logger.info({ count: result.rows.length }, 'Auth groups retrieved');
      return result.rows.map(row => ({
        ...row,
        toolCount: parseInt(row.toolCount, 10)
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to get auth groups');
      throw error;
    }
  }

  /**
   * @description Create a new tool
   * @param tool - Tool data (without toolId, timestamps)
   * @returns Created tool with generated ID
   */
  async createTool(tool: Omit<Tool, 'toolId' | 'createdAt' | 'updatedAt' | 'registeredAt'>): Promise<Tool> {
    const query = `
      INSERT INTO tools (
        name, display_name, type, category, version,
        install_spec, skills, selector_fragment, routing_tags,
        auth_group, default_auth_mode, description, input_schema,
        output_schema, usage_instructions, examples, requires_approval,
        timeout_ms, tags, enabled, registered_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
      RETURNING 
        tool_id as "toolId",
        name,
        display_name as "displayName",
        type,
        category,
        version,
        install_spec as "installSpec",
        skills,
        selector_fragment as "selectorFragment",
        routing_tags as "routingTags",
        auth_group as "authGroup",
        default_auth_mode as "defaultAuthMode",
        description,
        input_schema as "inputSchema",
        output_schema as "outputSchema",
        usage_instructions as "usageInstructions",
        examples,
        requires_approval as "requiresApproval",
        timeout_ms as "timeoutMs",
        tags,
        enabled,
        registered_by as "registeredBy",
        registered_at as "registeredAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;

    const params = [
      tool.name,
      tool.displayName,
      tool.type,
      tool.category,
      tool.version,
      JSON.stringify(tool.installSpec),
      tool.skills,
      tool.selectorFragment,
      tool.routingTags,
      tool.authGroup,
      tool.defaultAuthMode,
      tool.description,
      JSON.stringify(tool.inputSchema),
      tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
      tool.usageInstructions,
      JSON.stringify(tool.examples),
      tool.requiresApproval,
      tool.timeoutMs,
      tool.tags,
      tool.enabled,
      tool.registeredBy,
    ];

    try {
      const result = await this.pool.query(query, params);
      const createdTool = result.rows[0];
      logger.info({ toolId: createdTool.toolId, name: tool.name }, 'Tool created');
      return createdTool;
    } catch (error) {
      logger.error({ err: error, toolName: tool.name }, 'Failed to create tool');
      throw error;
    }
  }

  /**
   * @description Update an existing tool
   * @param toolId - Tool UUID
   * @param updates - Partial tool data to update
   * @returns Updated tool or null if not found
   */
  async updateTool(toolId: string, updates: Partial<Omit<Tool, 'toolId' | 'createdAt' | 'updatedAt' | 'registeredAt' | 'registeredBy'>>): Promise<Tool | null> {
    // Build dynamic UPDATE statement
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Map TypeScript field names to database column names
    const fieldMap: Record<string, string> = {
      name: 'name',
      displayName: 'display_name',
      type: 'type',
      category: 'category',
      version: 'version',
      installSpec: 'install_spec',
      skills: 'skills',
      selectorFragment: 'selector_fragment',
      routingTags: 'routing_tags',
      authGroup: 'auth_group',
      defaultAuthMode: 'default_auth_mode',
      description: 'description',
      inputSchema: 'input_schema',
      outputSchema: 'output_schema',
      usageInstructions: 'usage_instructions',
      examples: 'examples',
      requiresApproval: 'requires_approval',
      timeoutMs: 'timeout_ms',
      tags: 'tags',
      enabled: 'enabled',
    };

    for (const [tsField, dbColumn] of Object.entries(fieldMap)) {
      if (tsField in updates) {
        const value = updates[tsField as keyof typeof updates];
        // JSON fields need to be stringified
        if (['installSpec', 'inputSchema', 'outputSchema', 'examples'].includes(tsField)) {
          setClauses.push(`${dbColumn} = $${paramIndex++}`);
          params.push(value ? JSON.stringify(value) : null);
        } else {
          setClauses.push(`${dbColumn} = $${paramIndex++}`);
          params.push(value);
        }
      }
    }

    if (setClauses.length === 0) {
      logger.warn({ toolId }, 'No fields to update');
      return this.getToolById(toolId);
    }

    params.push(toolId);

    const query = `
      UPDATE tools
      SET ${setClauses.join(', ')}
      WHERE tool_id = $${paramIndex}
      RETURNING 
        tool_id as "toolId",
        name,
        display_name as "displayName",
        type,
        category,
        version,
        install_spec as "installSpec",
        skills,
        selector_fragment as "selectorFragment",
        routing_tags as "routingTags",
        auth_group as "authGroup",
        default_auth_mode as "defaultAuthMode",
        description,
        input_schema as "inputSchema",
        output_schema as "outputSchema",
        usage_instructions as "usageInstructions",
        examples,
        requires_approval as "requiresApproval",
        timeout_ms as "timeoutMs",
        tags,
        enabled,
        registered_by as "registeredBy",
        registered_at as "registeredAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
    `;

    try {
      const result = await this.pool.query(query, params);
      if (result.rows.length === 0) {
        logger.warn({ toolId }, 'Tool not found for update');
        return null;
      }
      logger.info({ toolId, updates: Object.keys(updates) }, 'Tool updated');
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, toolId }, 'Failed to update tool');
      throw error;
    }
  }

  /**
   * @description Delete a tool
   * @param toolId - Tool UUID
   * @returns True if deleted, false if not found
   */
  async deleteTool(toolId: string): Promise<boolean> {
    const query = `DELETE FROM tools WHERE tool_id = $1`;

    try {
      const result = await this.pool.query(query, [toolId]);
      const deleted = result.rowCount !== null && result.rowCount > 0;
      if (deleted) {
        logger.info({ toolId }, 'Tool deleted');
      } else {
        logger.warn({ toolId }, 'Tool not found for deletion');
      }
      return deleted;
    } catch (error) {
      logger.error({ err: error, toolId }, 'Failed to delete tool');
      throw error;
    }
  }
}
