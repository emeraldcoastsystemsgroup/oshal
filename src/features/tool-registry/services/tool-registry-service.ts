/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ToolRegistryService for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed logger import path to shared/logger; updated Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added seedBaselineAgentTools for presentron and RAG tool registration
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added baseline rag-query tool registration for direct Chroma-backed retrieval
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Expanded baseline tool catalog with common cloud/devops/scm CLIs for switch-framework driven chat profiles
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added baseline agent-scheduler capability metadata for Redis-backed self-scheduling workflows
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Expanded baseline CLI catalog toward any-bot devops parity (helm/argocd/ansible/vault/azure/yq/git/uv/docker-compose)
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Registered google-search and knowledge-enhancement in seedBaselineAgentTools (#4 fix)
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added 7 persona tools (bash, browser, read-file, write-file, fetch, chroma-mcp, plane-mcp)
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Extracted baseline/persona seed catalogs into dedicated modules to satisfy file-size governance limits
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Existence checks now use getToolByName instead of scanning getAllTools() (capped at LIMIT 100) — once the tools table passed 100 rows, seeding collided on the unique name constraint and aborted; seeding also tolerates the concurrent-container 23505 race
 */

import { Tool } from '@/shared/types/tool';
import { ToolRepository, ToolFiltersSchema, type CreateToolInput, type UpdateToolInput } from '@/entities/tool';
import { TOOL_REGISTRY_BASELINE_TOOLS } from './tool-registry-baseline-tools';
import { TOOL_REGISTRY_PERSONA_TOOLS } from './tool-registry-persona-tools';
import { z } from 'zod';
type ToolFilters = z.infer<typeof ToolFiltersSchema>;

/**
 * @description Business logic service for tool registry management.
 * Wraps ToolRepository with additional validation, registration workflows,
 * and category/auth group management. Provides the service layer between
 * controllers and the data access layer.
 */
export class ToolRegistryService {
  constructor(
    private readonly toolRepo: ToolRepository,
    private readonly logger: any
  ) {}

  /**
   * @description Registers a new tool in the registry. Validates uniqueness
   * of tool name before creation.
   * 
   * @param input - Tool creation data
   * @returns Created Tool object
   * @throws Error if tool name already exists
   */
  async registerTool(input: CreateToolInput): Promise<Tool> {
    // Exact indexed lookup — getAllTools() pages at LIMIT 100, so scanning it misses
    // any existing tool past the first page and the insert dies on tools_name_key.
    const existing = await this.toolRepo.getToolByName(input.name);
    if (existing) {
      const error = new Error(`Tool with name '${input.name}' already exists`);
      this.logger.error({ name: input.name }, 'Tool registration failed: duplicate name');
      throw error;
    }

    const tool = await this.toolRepo.createTool(input);
    this.logger.info({ toolId: tool.toolId, name: tool.name }, 'Tool registered successfully');
    
    return tool;
  }

  /**
   * @description Retrieves a single tool by its unique registry name.
   *
   * @param name - Tool name used in LLM tool calls
   * @returns Tool object or null if not found
   */
  async getToolByName(name: string): Promise<Tool | null> {
    return this.toolRepo.getToolByName(name);
  }

  /**
   * @description Idempotently creates or updates a tool by name.
   *
   * Runtime and manifest-driven registrations call this so reloads can refresh
   * descriptions, schemas, and auth defaults without failing on duplicates.
   *
   * @param input - Tool creation/update data
   * @returns Upserted tool and whether a new row was created
   */
  async registerOrUpdateTool(input: CreateToolInput): Promise<{ tool: Tool; created: boolean }> {
    const existing = await this.toolRepo.getToolByName(input.name);
    if (!existing) {
      const tool = await this.registerTool(input);
      return { tool, created: true };
    }

    const { registeredBy: _registeredBy, ...updates } = input;
    const updated = await this.updateTool(existing.toolId, updates);
    if (!updated) {
      throw new Error(`Tool with name '${input.name}' disappeared before update`);
    }

    return { tool: updated, created: false };
  }

  /**
   * @description Retrieves all tools from the registry with optional filtering.
   * 
   * @param filters - Optional filter criteria (name, type, category, authGroup, etc.)
   * @returns Array of Tool objects matching the filters
   */
  async getAllTools(filters?: ToolFilters): Promise<Tool[]> {
    return this.toolRepo.getAllTools(filters);
  }

  /**
   * @description Retrieves a single tool by ID.
   * 
   * @param toolId - The UUID of the tool
   * @returns Tool object or null if not found
   */
  async getToolById(toolId: string): Promise<Tool | null> {
    return this.toolRepo.getToolById(toolId);
  }

  /**
   * @description Updates an existing tool. Validates name uniqueness if name
   * is being changed.
   * 
   * @param toolId - The UUID of the tool to update
   * @param updates - Partial tool data to update
   * @returns Updated Tool object or null if tool not found
   * @throws Error if new name conflicts with existing tool
   */
  async updateTool(toolId: string, updates: UpdateToolInput): Promise<Tool | null> {
    // If name is being updated, check for uniqueness
    if (updates.name) {
      const allTools = await this.toolRepo.getAllTools();
      const conflict = allTools.find((t) => t.name === updates.name && t.toolId !== toolId);
      if (conflict) {
        const error = new Error(`Tool with name '${updates.name}' already exists`);
        this.logger.error({ toolId, name: updates.name }, 'Tool update failed: duplicate name');
        throw error;
      }
    }

    const tool = await this.toolRepo.updateTool(toolId, updates);
    if (tool) {
      this.logger.info({ toolId, updatedFields: Object.keys(updates) }, 'Tool updated successfully');
    } else {
      this.logger.warn({ toolId }, 'Tool update failed: tool not found');
    }
    
    return tool;
  }

  /**
   * @description Deletes a tool from the registry. Note: This will cascade
   * to agent_tools records via database foreign key constraint.
   * 
   * @param toolId - The UUID of the tool to delete
   * @returns true if deleted, false if tool not found
   */
  async deleteTool(toolId: string): Promise<boolean> {
    const deleted = await this.toolRepo.deleteTool(toolId);
    if (deleted) {
      this.logger.info({ toolId }, 'Tool deleted successfully');
    } else {
      this.logger.warn({ toolId }, 'Tool deletion failed: tool not found');
    }
    
    return deleted;
  }

  /**
   * @description Retrieves all unique tool categories from the registry.
   * 
   * @returns Array of category strings
   */
  async getCategories(): Promise<string[]> {
    return this.toolRepo.getCategories();
  }

  /**
   * @description Retrieves all unique auth groups from the registry.
   * 
   * @returns Array of auth group names
   */
  async getAuthGroups(): Promise<string[]> {
    const groups = await this.toolRepo.getAuthGroups();
    return Array.isArray(groups) ? groups.map((g: any) => typeof g === 'string' ? g : g.groupName) : [];
  }

  /**
   * @description Performs full-text search across tool names, descriptions,
   * and display names.
   * 
   * @param searchTerm - The search query string
   * @returns Array of Tool objects matching the search
   */
  async searchTools(searchTerm: string): Promise<Tool[]> {
    return this.toolRepo.getAllTools({ search: searchTerm });
  }

  /**
   * @description Retrieves all tools in a specific category.
   * 
   * @param category - The category name
   * @returns Array of Tool objects in the category
   */
  async getToolsByCategory(category: string): Promise<Tool[]> {
    return this.toolRepo.getAllTools({ category });
  }

  /**
   * @description Retrieves all tools in a specific auth group.
   * 
   * @param authGroup - The auth group name
   * @returns Array of Tool objects in the auth group
   */
  async getToolsByAuthGroup(authGroup: string): Promise<Tool[]> {
    return this.toolRepo.getAllTools({ authGroup });
  }

  /**
   * @description Seeds baseline agent tools (presentron, RAG) into the registry if not present.
   * Ensures all required agent tools are available and discoverable.
   * 
   * @returns Promise resolving to an array of registered or existing tool names
   */
  async seedBaselineAgentTools(): Promise<string[]> {
    const baselineTools: CreateToolInput[] = [
      ...TOOL_REGISTRY_BASELINE_TOOLS,
      ...TOOL_REGISTRY_PERSONA_TOOLS,
    ];

    const registered: string[] = [];

    for (const tool of baselineTools) {
      // Per-name lookup, not a getAllTools() scan: the scan pages at LIMIT 100, so a
      // baseline tool past the first page looked missing and the re-insert aborted the
      // whole seed loop — every tool after it went unchecked.
      const existing = await this.toolRepo.getToolByName(tool.name);
      if (!existing) {
        try {
          await this.registerTool(tool);
          this.logger.info({ tool: tool.name }, 'Seeded baseline agent tool');
        } catch (err: any) {
          // api + bot-node containers seed concurrently at stack bring-up; losing that
          // insert race (23505 / duplicate-name) means the tool exists — the seed's goal.
          const isDuplicate = err?.code === '23505' || /already exists/i.test(err?.message ?? '');
          if (!isDuplicate) {
            this.logger.error({ err, tool: tool.name }, 'Baseline tool seeding failed');
            throw err;
          }
          this.logger.info({ tool: tool.name }, 'Baseline tool seeded concurrently elsewhere — skipping');
        }
      }
      registered.push(tool.name);
    }
    return registered;
  }
}
