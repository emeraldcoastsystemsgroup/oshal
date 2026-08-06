/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool auth interceptor
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: unknown or missing-registry tools always deny; remove the environment-controlled graceful raw-executor fallback.
 */

import { createChildLogger } from '@/shared/logger';
import type { AuthMode, AuthorizationResult, Tool } from '@/shared/types/tool';
import type { ApprovalWorkflowService } from './approval-workflow-service';

const logger = createChildLogger({ module: 'tool-auth-interceptor' });

/**
 * @description Callback type for the original tool execution function.
 */
export type ToolExecutor = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<string>;

/**
 * @description Callback to look up the auth mode for a tool/agent pair.
 * Returns the auth mode and tool metadata, or null if tool not in registry.
 */
export type AuthModeLookup = (
  agentId: string,
  toolName: string,
) => Promise<{ authMode: AuthMode; tool: Tool } | null>;

/**
 * @description Dependencies for the ToolAuthInterceptor
 */
export interface ToolAuthInterceptorDeps {
  approvalService: ApprovalWorkflowService;
  lookupAuthMode: AuthModeLookup;
}

/**
 * @description Pre-execution authorization interceptor for the tool switch framework.
 * Wraps the original tool executor with auth mode enforcement:
 * - auto → execute immediately
 * - ask → trigger approval workflow, wait for decision
 * - off → reject execution
 * - not in registry / registry unavailable → reject execution
 */
export class ToolAuthInterceptor {
  private readonly approvalService: ApprovalWorkflowService;
  private readonly lookupAuthMode: AuthModeLookup;

  constructor(deps: ToolAuthInterceptorDeps) {
    this.approvalService = deps.approvalService;
    this.lookupAuthMode = deps.lookupAuthMode;
    logger.info('ToolAuthInterceptor initialized (unknown tools fail closed)');
  }

  /**
   * @description Creates a wrapped tool executor that enforces auth mode checks.
   * The returned function has the same signature as the original executor.
   *
   * @param originalExecutor - The original tool execution callback
   * @param agentId - The agent requesting tool execution
   * @param taskId - The current task context
   * @returns A wrapped executor that checks authorization before executing
   */
  createInterceptedExecutor(
    originalExecutor: ToolExecutor,
    agentId: string,
    taskId: string,
  ): ToolExecutor {
    return async (toolName: string, toolInput: Record<string, unknown>) => {
      const authResult = await this.checkAuthorization(agentId, toolName, taskId, toolInput);
      return this.executeWithAuth(authResult, originalExecutor, toolName, toolInput);
    };
  }

  /**
   * @description Checks the authorization status for a tool execution request.
   *
   * @param agentId - The agent requesting execution
   * @param toolName - The tool being invoked
   * @param taskId - The current task context
   * @param toolInput - The tool input arguments
   * @returns Authorization result with decision and metadata
   */
  private async checkAuthorization(
    agentId: string,
    toolName: string,
    taskId: string,
    toolInput: Record<string, unknown>,
  ): Promise<AuthorizationResult> {
    const lookup = await this.lookupAuthMode(agentId, toolName);

    if (!lookup) {
      return this.handleUnregisteredTool(toolName);
    }

    const { authMode, tool } = lookup;

    logger.info(
      { toolName, agentId, authMode, toolId: tool.toolId },
      'Auth mode check for tool execution',
    );

    switch (authMode) {
      case 'auto':
        return this.handleAutoMode(toolName);
      case 'ask':
        return this.handleAskMode(tool, agentId, taskId, toolInput);
      case 'off':
        return this.handleOffMode(toolName, agentId);
      default:
        return this.handleUnknownMode(toolName, authMode);
    }
  }

  /**
   * @description Executes the tool based on the authorization result.
   */
  private async executeWithAuth(
    authResult: AuthorizationResult,
    originalExecutor: ToolExecutor,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<string> {
    if (!authResult.authorized) {
      const reason = authResult.reason ?? 'Tool execution not authorized';
      logger.warn({ toolName, authMode: authResult.authMode }, reason);
      return `[BLOCKED] ${reason}`;
    }

    logger.info({ toolName, authMode: authResult.authMode }, 'Tool authorized — executing');
    return originalExecutor(toolName, toolInput);
  }

  /**
   * @description Handles tools not found in the registry — deterministic denial.
   */
  private handleUnregisteredTool(toolName: string): AuthorizationResult {
    const reason = `Tool '${toolName}' is not registered in the auth framework and cannot execute.`;
    logger.warn({ toolName }, reason);
    return { authorized: false, authMode: 'off' as AuthMode, reason };
  }

  /**
   * @description Handles auto mode — immediate execution allowed.
   */
  private handleAutoMode(toolName: string): AuthorizationResult {
    logger.debug({ toolName }, 'Auth mode: auto — execution allowed');
    return { authorized: true, authMode: 'auto' as AuthMode };
  }

  /**
   * @description Handles ask mode — creates approval request and waits.
   */
  private async handleAskMode(
    tool: Tool,
    agentId: string,
    taskId: string,
    toolInput: Record<string, unknown>,
  ): Promise<AuthorizationResult> {
    logger.info(
      { toolName: tool.name, agentId, taskId },
      'Auth mode: ask — requesting user approval',
    );

    const decision = await this.approvalService.requestApproval({
      taskId,
      agentId,
      toolId: tool.toolId,
      toolName: tool.name,
      toolInput,
      timeoutMs: tool.timeoutMs,
      context: {
        displayName: tool.displayName,
        description: tool.description,
        category: tool.category,
        type: tool.type,
      },
    });

    if (decision.approved) {
      return { authorized: true, authMode: 'ask' as AuthMode };
    }

    const reason = decision.reason ?? 'User denied tool execution';
    return { authorized: false, authMode: 'ask' as AuthMode, reason };
  }

  /**
   * @description Handles off mode — tool is disabled for this agent.
   */
  private handleOffMode(toolName: string, agentId: string): AuthorizationResult {
    const reason = `Tool '${toolName}' is disabled (auth_mode=off) for agent '${agentId}'`;
    logger.info({ toolName, agentId }, reason);
    return { authorized: false, authMode: 'off' as AuthMode, reason };
  }

  /**
   * @description Handles unknown auth mode — defensive fallback.
   */
  private handleUnknownMode(toolName: string, authMode: string): AuthorizationResult {
    const reason = `Unknown auth mode '${authMode}' for tool '${toolName}' — blocking execution`;
    logger.error({ toolName, authMode }, reason);
    return { authorized: false, authMode: authMode as AuthMode, reason };
  }
}
