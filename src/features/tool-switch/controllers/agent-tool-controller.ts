/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of AgentToolController for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed logger import path to shared/logger; updated Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added endpoint for persisting unified per-tool runtime/auth configuration
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added malformed-agent validation and cockpit-compatible tool response fields for Session 69 stabilization
 */

import { Request, Response } from 'express';
import { BaseController } from '@/app/base-controller';
import { SwitchFrameworkService } from '../services/switch-framework-service';
import { SelectorCompositionService } from '@/features/selector-composition';
import {
  SetAgentToolAuthModeSchema,
  SetAgentToolConfigSchema,
  SetGroupAuthModeSchema,
} from '@/entities/tool';
import type { AgentTool, Tool } from '@/shared/types/tool';

/**
 * @description Controller for agent-tool relationship and authorization mode HTTP endpoints.
 * Provides API for managing tool switches (auto/ask/off), auth group operations,
 * and selector composition. Extends BaseController for standardized error handling.
 */
export class AgentToolController extends BaseController {
  constructor(
    private readonly switchService: SwitchFrameworkService,
    private readonly selectorService: SelectorCompositionService,
    logger: any
  ) {
    super(logger);
  }

  /**
   * @description GET /api/agents/:agentId/tools - Get all tools and their auth modes for an agent
   */
  getAgentTools = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr }, 'Rejected malformed agent-tools request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const agentTools = await this.switchService.getAgentTools(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      tools: agentTools.map((tool) => mapAgentToolForResponse(tool)),
      count: agentTools.length,
    });
  });

  /**
   * @description GET /api/agents/:agentId/tools/enabled - Get enabled tools for an agent
   */
  getEnabledTools = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr }, 'Rejected malformed enabled-tools request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const enabledTools = await this.switchService.getEnabledTools(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      tools: enabledTools.map((tool) => mapAgentToolForResponse(tool)),
      count: enabledTools.length,
    });
  });

  /**
   * @description PUT /api/agents/:agentId/tools/:toolId - Set auth mode for a specific tool
   * Body: { authMode: 'auto' | 'ask' | 'off' }
   */
  setToolAuthMode = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    const toolIdStr = readRouteParam(req.params.toolId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr, toolId: toolIdStr }, 'Rejected malformed tool auth-mode request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const { authMode } = SetAgentToolAuthModeSchema.parse(req.body);
    
    const result = await this.switchService.setToolAuthMode(agentIdStr, toolIdStr, authMode);
    
    // Trigger selector recomposition if auth mode changed
    const selector = await this.selectorService.recomposeOnToolChange(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      toolId: toolIdStr,
      authMode,
      ...result,
      selector,
    });
  });

  /**
   * @description PUT /api/agents/:agentId/tools/:toolId/config - Set runtime config for a specific tool
   * Body: { toolConfig: { auth, env, endpoint, metadata } }
   */
  setToolConfig = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    const toolIdStr = readRouteParam(req.params.toolId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr, toolId: toolIdStr }, 'Rejected malformed tool-config request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const { toolConfig } = SetAgentToolConfigSchema.parse(req.body);

    const result = await this.switchService.setToolConfig(
      agentIdStr,
      toolIdStr,
      toolConfig as Record<string, unknown>,
    );

    return this.success(res, {
      agentId: agentIdStr,
      toolId: toolIdStr,
      ...result,
    });
  });

  /**
   * @description PUT /api/agents/:agentId/tools/groups/:groupName - Set auth mode for all tools in a group
   * Body: { authMode: 'auto' | 'ask' | 'off' }
   */
  setGroupAuthMode = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    const groupNameStr = readRouteParam(req.params.groupName);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr, groupName: groupNameStr }, 'Rejected malformed tool-group request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const { authMode } = SetGroupAuthModeSchema.parse(req.body);
    
    const result = await this.switchService.setGroupAuthMode(agentIdStr, groupNameStr, authMode);
    
    // Trigger selector recomposition after group change
    const selector = await this.selectorService.recomposeOnToolChange(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      groupName: groupNameStr,
      authMode,
      ...result,
      selector,
    });
  });

  /**
   * @description GET /api/agents/:agentId/selector - Get the composed selector for an agent
   */
  getComposedSelector = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr }, 'Rejected malformed selector request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const selector = await this.selectorService.getComposedSelector(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      selector,
    });
  });

  /**
   * @description POST /api/agents/:agentId/selector/recompose - Force recomposition of selector
   */
  recomposeSelector = this.asyncHandler(async (req: Request, res: Response) => {
    const agentIdStr = readRouteParam(req.params.agentId);
    if (!isUuidLike(agentIdStr)) {
      this.logger.warn({ agentId: agentIdStr }, 'Rejected malformed selector recompose request');
      return this.badRequest(res, 'Agent id must be a UUID');
    }

    const selector = await this.selectorService.composeSelector(agentIdStr);
    
    return this.success(res, {
      agentId: agentIdStr,
      selector,
      message: 'Selector recomposed successfully',
    });
  });

  /**
   * @description POST /api/agents/selectors/recompose-all - Recompose selectors for all agents
   * (Admin operation)
   */
  recomposeAllSelectors = this.asyncHandler(async (req: Request, res: Response) => {
    const count = await this.selectorService.recomposeAllAgents();
    
    return this.success(res, {
      count,
      message: `Selectors recomposed for ${count} agents`,
    });
  });
}

/**
 * @description Normalizes an Express route parameter into a single string.
 *
 * @param value - Raw route parameter value
 * @returns First route value when repeated, otherwise the string itself
 */
function readRouteParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @description Checks whether a route parameter looks like a UUID-backed agent id.
 *
 * @param value - Route value to validate
 * @returns True when the input matches the persisted OSHAL agent id shape
 */
function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * @description Adds small compatibility aliases expected by the cockpit settings surface
 * while preserving the canonical agent-tool payload shape used elsewhere.
 *
 * @param agentTool - Canonical agent-tool row
 * @returns Canonical row plus top-level cockpit compatibility fields
 */
function mapAgentToolForResponse(agentTool: AgentTool | Tool): Record<string, unknown> {
  const nestedTool = 'tool' in agentTool ? readRecord(agentTool.tool) : {};
  const toolId = readString(agentTool.toolId) || readString(nestedTool.toolId);
  const name = readString('name' in agentTool ? agentTool.name : undefined) || readString(nestedTool.name);
  const displayName = readString('displayName' in agentTool ? agentTool.displayName : undefined) || name;

  return {
    ...agentTool,
    id: toolId,
    name,
    displayName,
  };
}

/**
 * @description Reads a string value from an unknown field.
 *
 * @param value - Unknown field value
 * @returns Trimmed string or an empty string when missing
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Reads a nested object from an unknown field.
 *
 * @param value - Unknown field value
 * @returns Plain object or an empty object when missing
 */
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}
