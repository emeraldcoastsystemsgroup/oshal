/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool auth interceptor
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: unknown or missing-registry tools always deny; remove the environment-controlled graceful raw-executor fallback.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Provider-embedded tool tier: a name in the embedded catalog is judged by the per-agent embedded policy instead of being denied as not-registered. The registry tier never held these, so a real embedded tool and a typo refused identically, with no tier and no provider operation recorded anywhere. Denial stays fail-closed (no policy, no declaration, or any mode other than exactly auto) and the reason leads with the stable embedded_tool_denied code and names the tier and the provider operation.
 */

import { createChildLogger } from '@/shared/logger';
import type { AuthMode, AuthorizationResult, Tool } from '@/shared/types/tool';
import {
  decideEmbeddedToolUse,
  getEmbeddedTool,
  type EmbeddedToolPolicy,
} from '@/shared/tools/embedded-tool-tier';
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
  /** Per-agent grant source for the provider-embedded tier. Absent = every embedded tool denies. */
  embeddedToolPolicy?: EmbeddedToolPolicy;
}

/**
 * @description Pre-execution authorization interceptor for the tool switch framework.
 * Wraps the original tool executor with auth mode enforcement:
 * - auto → execute immediately
 * - ask → trigger approval workflow, wait for decision
 * - off → reject execution
 * - not in registry / registry unavailable → reject execution
 *
 * A name in the provider-embedded catalog never reaches the registry lookup: that tier is
 * governed by its own per-agent policy, and its refusals name the tier and provider operation.
 */
export class ToolAuthInterceptor {
  private readonly approvalService: ApprovalWorkflowService;
  private readonly lookupAuthMode: AuthModeLookup;
  private readonly embeddedToolPolicy: EmbeddedToolPolicy | null;

  constructor(deps: ToolAuthInterceptorDeps) {
    this.approvalService = deps.approvalService;
    this.lookupAuthMode = deps.lookupAuthMode;
    this.embeddedToolPolicy = deps.embeddedToolPolicy ?? null;
    logger.info(
      { embeddedTierGoverned: this.embeddedToolPolicy !== null },
      'ToolAuthInterceptor initialized (unknown tools fail closed)',
    );
  }

  /**
   * @description Creates a wrapped tool executor that enforces auth mode checks.
   * The returned function has the same signature as the original executor.
   *
   * @param originalExecutor - The original tool execution callback
   * @param agentId - The agent requesting tool execution
   * @param taskId - The current task context
   * @param providerId - Active model provider for this run; names the provider operation an
   *                     embedded-tier decision applies to. Omitted outside a live turn.
   * @returns A wrapped executor that checks authorization before executing
   */
  createInterceptedExecutor(
    originalExecutor: ToolExecutor,
    agentId: string,
    taskId: string,
    providerId?: string,
  ): ToolExecutor {
    return async (toolName: string, toolInput: Record<string, unknown>) => {
      const authResult = await this.checkAuthorization(agentId, toolName, taskId, toolInput, providerId);
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
   * @param providerId - Active model provider, for embedded-tier operation resolution
   * @returns Authorization result with decision and metadata
   */
  private async checkAuthorization(
    agentId: string,
    toolName: string,
    taskId: string,
    toolInput: Record<string, unknown>,
    providerId?: string,
  ): Promise<AuthorizationResult> {
    const lookup = await this.lookupAuthMode(agentId, toolName);

    // The REGISTRY decides for any name the registry knows, and the embedded tier is the fallback
    // for names it does not. Checking embedded first inverted that: `google_search` normalises onto
    // the shipped `google-search` registry tool (defaultAuthMode 'off'), so a persona file beat the
    // database and the cockpit toggle stopped working in BOTH directions for the 57 personas that
    // declare it. An operator's explicit 'off' or 'ask' is not something a provider tier may
    // overrule.
    if (!lookup) {
      if (getEmbeddedTool(toolName)) {
        return this.checkEmbeddedTool(agentId, toolName, providerId);
      }
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
   * @description Authorizes a provider-embedded tool against the per-agent policy. The provider
   * executes these inside its own service, so the platform's only lever is whether the agent may
   * reach the operation at all — and the refusal has to say which tier and which operation it was.
   *
   * @param agentId - The agent requesting execution
   * @param toolName - The embedded tool name, in any accepted spelling
   * @param providerId - Active model provider, when known
   * @returns Authorization result carrying the tier-aware reason on denial
   */
  private async checkEmbeddedTool(
    agentId: string,
    toolName: string,
    providerId?: string,
  ): Promise<AuthorizationResult> {
    const mode = this.embeddedToolPolicy
      ? await this.embeddedToolPolicy.resolveMode(agentId, toolName)
      : null;
    const decision = decideEmbeddedToolUse({ toolName, agentId, providerId, mode });

    if (!decision.allowed) {
      logger.warn(
        {
          toolName,
          agentId,
          tier: decision.tier,
          providerId: decision.providerId,
          providerOperation: decision.providerOperation,
          mode: decision.mode,
          policyWired: this.embeddedToolPolicy !== null,
        },
        'Embedded tool denied',
      );
      return { authorized: false, authMode: 'off' as AuthMode, reason: decision.reason };
    }

    logger.info(
      {
        toolName,
        agentId,
        tier: decision.tier,
        providerId: decision.providerId,
        providerOperation: decision.providerOperation,
      },
      'Embedded tool authorized',
    );
    return { authorized: true, authMode: 'auto' as AuthMode };
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
