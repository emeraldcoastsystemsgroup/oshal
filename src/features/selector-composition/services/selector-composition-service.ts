/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of SelectorCompositionService for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed logger import path to shared/logger; updated Change Log author/timestamp
 */

import { Pool } from 'pg';
import { logger } from '@/shared/logger';
import { ComposedSelector } from '@/shared/types/tool';
import { AgentToolRepository } from '@/entities/tool';

/**
 * @description Service for composing agent selectors from base capabilities and enabled tools.
 * Implements the selector composition algorithm that combines base agent fields with
 * tool-provided skills, selector fragments, and routing tags. Updates computed fields
 * in the agents table for efficient runtime selector access.
 */
export class SelectorCompositionService {
  constructor(
    private readonly agentToolRepo: AgentToolRepository,
    private readonly pool: Pool,
    private readonly logger: any
  ) {}

  /**
   * @description Composes the full selector for an agent by combining base capabilities
   * with enabled tool capabilities. Implements the algorithm:
   * 1. Get agent base fields (base_capabilities, base_selector_descriptor, base_routing_keywords)
   * 2. Get enabled tools (auth_mode != 'off')
   * 3. Aggregate tool skills, selector_fragments, routing_tags
   * 4. Combine: computed = base ∪ tool
   * 5. UPDATE agents SET computed_* = ... WHERE agent_id = ...
   * 6. Return ComposedSelector
   * 
   * @param agentId - The UUID of the agent
   * @returns ComposedSelector object with base, tool, and combined capabilities
   */
  async composeSelector(agentId: string): Promise<ComposedSelector> {
    // Step 1: Get agent base fields
    const agentQuery = `
      SELECT 
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords
      FROM agents
      WHERE agent_id = $1
    `;

    let baseCapabilities: string[] = [];
    let baseSelectorDescriptor = '';
    let baseRoutingKeywords: string[] = [];

    try {
      const agentResult = await this.pool.query(agentQuery, [agentId]);
      if (agentResult.rows.length === 0) {
        const error = `Agent ${agentId} not found`;
        this.logger.error({ agentId }, error);
        throw new Error(error);
      }

      baseCapabilities = agentResult.rows[0].base_capabilities || [];
      baseSelectorDescriptor = agentResult.rows[0].base_selector_descriptor || '';
      baseRoutingKeywords = agentResult.rows[0].base_routing_keywords || [];
    } catch (error) {
      this.logger.error({ err: error, agentId }, 'Failed to get agent base fields');
      throw error;
    }

    // Step 2 & 3: Get enabled tools and aggregate their capabilities
    const enabledTools = await this.agentToolRepo.getEnabledTools(agentId);

    const toolCapabilities: string[] = [];
    let toolSelectorFragments: string[] = [];
    const toolRoutingTags: string[] = [];

    for (const tool of enabledTools) {
      // Aggregate skills (flatten array)
      if (tool.skills && tool.skills.length > 0) {
        toolCapabilities.push(...tool.skills);
      }

      // Aggregate selector fragments
      if (tool.selectorFragment) {
        toolSelectorFragments.push(tool.selectorFragment);
      }

      // Aggregate routing tags
      if (tool.routingTags && tool.routingTags.length > 0) {
        toolRoutingTags.push(...tool.routingTags);
      }
    }

    // Step 4: Combine base and tool capabilities (union, deduplicate)
    const combinedCapabilities = Array.from(
      new Set([...baseCapabilities, ...toolCapabilities])
    );

    // Combine selector descriptors (base + tool fragments separated by newlines)
    const combinedSelectorDescriptor = [
      baseSelectorDescriptor,
      ...toolSelectorFragments,
    ]
      .filter((s: string) => s.trim().length > 0)
      .join('\n\n');

    // Combine routing keywords (union, deduplicate)
    const combinedRoutingKeywords = Array.from(
      new Set([...baseRoutingKeywords, ...toolRoutingTags])
    );

    // Step 5: UPDATE agents computed fields
    const updateQuery = `
      UPDATE agents
      SET 
        computed_capabilities = $1,
        computed_selector_descriptor = $2,
        computed_routing_keywords = $3,
        updated_at = NOW()
      WHERE agent_id = $4
    `;

    try {
      await this.pool.query(updateQuery, [
        combinedCapabilities,
        combinedSelectorDescriptor,
        combinedRoutingKeywords,
        agentId,
      ]);

      this.logger.info(
        {
          agentId,
          baseCapabilitiesCount: baseCapabilities.length,
          toolCapabilitiesCount: toolCapabilities.length,
          combinedCapabilitiesCount: combinedCapabilities.length,
          toolsCount: enabledTools.length,
        },
        'Selector composition complete'
      );
    } catch (error) {
      this.logger.error({ err: error, agentId }, 'Failed to update computed selector fields');
      throw error;
    }

    // Step 6: Return ComposedSelector
    return {
      agentId,
      baseCapabilities,
      toolCapabilities,
      capabilities: combinedCapabilities,
      baseSelectorDescriptor,
      toolSelectorFragments: toolSelectorFragments.join('\n\n'),
      selectorDescriptor: combinedSelectorDescriptor,
      baseRoutingKeywords,
      toolRoutingTags,
      routingKeywords: combinedRoutingKeywords,
    };
  }

  /**
   * @description Recomposes the selector after a tool auth mode change.
   * This is a convenience method that should be called after any auth mode
   * transition to ensure computed fields are up to date.
   * 
   * @param agentId - The UUID of the agent
   * @returns ComposedSelector object with updated capabilities
   */
  async recomposeOnToolChange(agentId: string): Promise<ComposedSelector> {
    this.logger.info({ agentId }, 'Recomposing selector after tool change');
    return this.composeSelector(agentId);
  }

  /**
   * @description Retrieves the current composed selector for an agent without
   * recomputing. Reads from the computed_* fields in the agents table.
   * 
   * @param agentId - The UUID of the agent
   * @returns ComposedSelector object with current computed values
   */
  async getComposedSelector(agentId: string): Promise<ComposedSelector> {
    const query = `
      SELECT 
        base_capabilities,
        base_selector_descriptor,
        base_routing_keywords,
        computed_capabilities,
        computed_selector_descriptor,
        computed_routing_keywords
      FROM agents
      WHERE agent_id = $1
    `;

    try {
      const result = await this.pool.query(query, [agentId]);
      if (result.rows.length === 0) {
        const error = `Agent ${agentId} not found`;
        this.logger.error({ agentId }, error);
        throw new Error(error);
      }

      const row = result.rows[0];
      const baseCapabilities = row.base_capabilities || [];
      const computedCapabilities = row.computed_capabilities || [];
      const baseSelectorDescriptor = row.base_selector_descriptor || '';
      const computedSelectorDescriptor = row.computed_selector_descriptor || '';
      const baseRoutingKeywords = row.base_routing_keywords || [];
      const computedRoutingKeywords = row.computed_routing_keywords || [];

      // Calculate tool-only capabilities (computed - base)
      const toolCapabilities = computedCapabilities.filter(
        (cap: string) => !baseCapabilities.includes(cap)
      );

      // Extract tool selector fragments (computed - base)
      const toolSelectorFragments = computedSelectorDescriptor
        .replace(baseSelectorDescriptor, '')
        .trim()
        .split('\n\n')
        .filter((s: string) => s.length > 0);

      // Calculate tool-only routing tags (computed - base)
      const toolRoutingTags = computedRoutingKeywords.filter(
        (tag: string) => !baseRoutingKeywords.includes(tag)
      );

      this.logger.debug(
        { agentId, capabilitiesCount: computedCapabilities.length },
        'Retrieved composed selector'
      );

      return {
        agentId,
        baseCapabilities,
        toolCapabilities,
        capabilities: computedCapabilities,
        baseSelectorDescriptor,
        toolSelectorFragments: toolSelectorFragments.join('\n\n'),
        selectorDescriptor: computedSelectorDescriptor,
        baseRoutingKeywords,
        toolRoutingTags,
        routingKeywords: computedRoutingKeywords,
      };
    } catch (error) {
      this.logger.error({ err: error, agentId }, 'Failed to get composed selector');
      throw error;
    }
  }

  /**
   * @description Recomposes selectors for all agents in the system.
   * Useful for maintenance operations or after bulk tool registry changes.
   * 
   * @returns Number of agents recomposed
   */
  async recomposeAllAgents(): Promise<number> {
    const query = `SELECT agent_id FROM agents`;

    try {
      const result = await this.pool.query(query);
      const agentIds = result.rows.map((row) => row.agent_id);

      this.logger.info({ count: agentIds.length }, 'Starting bulk selector recomposition');

      for (const agentId of agentIds) {
        try {
          await this.composeSelector(agentId);
        } catch (error) {
          this.logger.error(
            { err: error, agentId },
            'Failed to recompose selector for agent during bulk operation'
          );
          // Continue with other agents
        }
      }

      this.logger.info({ count: agentIds.length }, 'Bulk selector recomposition complete');
      return agentIds.length;
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to recompose all agents');
      throw error;
    }
  }
}
