/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of SwitchFrameworkService for Layer 1 Tools Framework
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Returned full tool catalog with effective per-agent auth modes so chat configuration can render switch state before explicit assignments
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added default unified auth config generation and per-tool runtime configuration persistence
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Disable persisted free-form verification and cleanup shell commands on HTTP-driven grant transitions; non-NONE installation now fails closed for reviewed out-of-band provisioning.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Make unattended isToolEnabled checks exact-AUTO so ASK remains a pending decision rather than an executable grant.
 */

import { logger } from '@/shared/logger';
import { AuthMode, Tool, InstallMethod, ToolAuthType } from '@/shared/types/tool';
import { AgentToolRepository, ToolRepository } from '@/entities/tool';

/**
 * @description Service for managing tool authorization modes and installation state.
 * Handles auth mode transitions, tool installation/uninstallation orchestration,
 * and auth group bulk operations. Implements the switch framework business logic.
 */
export class SwitchFrameworkService {
  constructor(
    private readonly agentToolRepo: AgentToolRepository,
    private readonly toolRepo: ToolRepository,
    private readonly logger: any
  ) {}

  /**
   * @description Sets the authorization mode for a specific tool for an agent.
   * Handles state transitions and triggers installation/uninstallation as needed:
   * - off → ask/auto: Install tool if not already installed
   * - ask/auto → off: Uninstall tool
   * - ask ↔ auto: No installation change
   * 
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   * @param authMode - The new authorization mode (auto/ask/off)
   * @returns Object with success status and any messages
   */
  async setToolAuthMode(
    agentId: string,
    toolId: string,
    authMode: AuthMode
  ): Promise<{ success: boolean; message?: string; installed?: boolean }> {
    // Get current tool state
    const agentTools = await this.agentToolRepo.getAgentTools(agentId);
    const currentTool = agentTools.find((at) => at.toolId === toolId);
    const currentAuthMode = currentTool?.authMode || 'off';
    const currentlyInstalled = currentTool?.installed || false;

    // Get tool details
    const tool = await this.toolRepo.getToolById(toolId);
    if (!tool) {
      const error = `Tool ${toolId} not found`;
      this.logger.error({ agentId, toolId }, error);
      throw new Error(error);
    }

    // Preflight an enable before changing the durable grant. Persisted install/verify shell
    // strings are legacy data, not reviewed executable policy; a non-NONE tool must be
    // provisioned out of band before an HTTP grant can make it available.
    if (authMode !== 'off' && !currentlyInstalled) {
      const installResult = await this.installTool(agentId, tool);
      if (!installResult.success) {
        return {
          success: false,
          message: `Tool grant unchanged: ${installResult.error}`,
          installed: false,
        };
      }
    }

    await this.agentToolRepo.setAuthMode(agentId, toolId, authMode);
    this.logger.info(
      { agentId, toolId, oldMode: currentAuthMode, newMode: authMode },
      'Auth mode updated'
    );

    if (authMode !== 'off' && !currentlyInstalled) {
      await this.agentToolRepo.markInstalled(agentId, toolId);
      return {
        success: true,
        message: `Auth mode set to ${authMode}; no-process installation verified`,
        installed: true,
      };
    }

    if (authMode === 'off' && currentlyInstalled) {
      // Disabling is always safe and never invokes a persisted cleanup command.
      await this.uninstallTool(agentId, tool);
      await this.agentToolRepo.markUninstalled(agentId, toolId);
      return {
        success: true,
        message: 'Auth mode set to off and tool marked uninstalled',
        installed: false,
      };
    }

    // No installation state change needed (ask ↔ auto, or already in correct state)
    return {
      success: true,
      message: `Auth mode set to ${authMode}`,
      installed: currentlyInstalled,
    };
  }

  /**
   * @description Sets the authorization mode for all tools in an auth group for an agent.
   * Handles bulk state transitions with the same logic as individual tool updates.
   * 
   * @param agentId - The UUID of the agent
   * @param groupName - The auth group name
   * @param authMode - The new authorization mode (auto/ask/off)
   * @returns Object with count of tools updated and installation results
   */
  async setGroupAuthMode(
    agentId: string,
    groupName: string,
    authMode: AuthMode
  ): Promise<{ success: boolean; count: number; installResults: Record<string, boolean> }> {
    // Validate that auth group exists
    const toolsInGroup = await this.toolRepo.getAllTools({ authGroup: groupName });
    if (toolsInGroup.length === 0) {
      const error = `Auth group '${groupName}' not found`;
      this.logger.error({ agentId, groupName }, error);
      throw new Error(error);
    }

    // Get current state of all tools in group
    const currentAgentTools = await this.agentToolRepo.getAgentTools(agentId);
    const installResults: Record<string, boolean> = {};

    // Preflight every newly-enabled member before the bulk write. One legacy install method
    // blocks the entire transition, preventing a half-applied group and preventing any persisted
    // verification command from becoming an HTTP-triggered shell program.
    if (authMode !== AuthMode.OFF) {
      for (const tool of toolsInGroup) {
        const currentTool = currentAgentTools.find((entry) => entry.toolId === tool.toolId);
        if (!currentTool?.installed) {
          const installResult = await this.installTool(agentId, tool);
          installResults[tool.name] = installResult.success;
          if (!installResult.success) {
            this.logger.warn(
              { agentId, toolId: tool.toolId, groupName },
              'Tool group grant refused by no-shell installation policy',
            );
            return { success: false, count: 0, installResults };
          }
        }
      }
    }

    const count = await this.agentToolRepo.setGroupAuthMode(agentId, groupName, authMode);

    // Persist installation flags only after the atomic authorization-mode update. Disabling never
    // invokes cleanupCommand; it only revokes the grant and records the safe logical state.
    for (const tool of toolsInGroup) {
      const currentTool = currentAgentTools.find((at) => at.toolId === tool.toolId);
      const currentAuthMode = currentTool?.authMode || 'off';
      const currentlyInstalled = currentTool?.installed || false;

      if (authMode !== 'off' && !currentlyInstalled) {
        await this.agentToolRepo.markInstalled(agentId, tool.toolId);
        installResults[tool.name] = true;
      } else if (authMode === 'off' && currentlyInstalled) {
        await this.uninstallTool(agentId, tool);
        await this.agentToolRepo.markUninstalled(agentId, tool.toolId);
        installResults[tool.name] = true;
      }
    }

    this.logger.info(
      { agentId, groupName, authMode, count, installResults },
      'Auth mode set for tool group'
    );

    return { success: true, count, installResults };
  }

  /**
   * @description Applies the no-process installation policy for HTTP grant transitions.
   * Only `none` is accepted. Persisted scripts and verify commands are data and are never run.
   * 
   * @param agentId - The UUID of the agent (for logging)
   * @param tool - The Tool object with install_spec
   * @returns Object with success status and optional error message
   */
  private async installTool(
    agentId: string,
    tool: Tool
  ): Promise<{ success: boolean; error?: string }> {
    const { method } = tool.installSpec;

    this.logger.info(
      { agentId, toolId: tool.toolId, method },
      'Evaluating no-process tool installation policy'
    );

    if (method === InstallMethod.NONE) {
      this.logger.info({ agentId, toolId: tool.toolId }, 'Tool requires no installation');
      return { success: true };
    }

    const error = `Install method '${method}' requires reviewed out-of-band provisioning; persisted shell commands are disabled`;
    this.logger.warn({ agentId, toolId: tool.toolId, method }, error);
    return { success: false, error };
  }

  /**
   * @description Records the safe logical uninstall step. A cleanup command stored in a manifest
   * is deliberately ignored; revocation must never become arbitrary shell execution.
   * 
   * @param agentId - The UUID of the agent (for logging)
   * @param tool - The Tool object with install_spec
   * @returns Object with success status and optional error message
   */
  private async uninstallTool(
    agentId: string,
    tool: Tool
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.info(
      { agentId, toolId: tool.toolId, method: tool.installSpec.method },
      'Tool marked uninstalled without executing persisted cleanup commands',
    );
    return { success: true };
  }

  /**
   * @description Retrieves all tools and their auth modes for an agent.
   * Used by controllers to get current switch states.
   * 
   * @param agentId - The UUID of the agent
   * @returns Array of agent tools with full details
   */
  async getAgentTools(agentId: string) {
    const [allTools, assignedTools] = await Promise.all([
      this.toolRepo.getAllTools({ enabled: true, limit: 500, offset: 0 }),
      this.agentToolRepo.getAgentTools(agentId),
    ]);
    const assignedByToolId = new Map(assignedTools.map((tool) => [tool.toolId, tool]));

    return allTools.map((tool) => {
      const assigned = assignedByToolId.get(tool.toolId);
      if (assigned) {
        return assigned;
      }

      return {
        agentId,
        toolId: tool.toolId,
        authMode: tool.defaultAuthMode,
        installed: false,
        installVerified: false,
        toolConfig: this.buildDefaultToolConfig(tool),
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
        tool,
      };
    });
  }

  /**
   * @description Sets per-agent runtime configuration for a tool.
   * This payload includes standardized auth settings (API key, OAuth2, cert, vault, cloud profiles, etc.).
   *
   * @param agentId - The UUID of the agent
   * @param toolId - The UUID of the tool
   * @param toolConfig - Unified runtime configuration object
   * @returns Promise resolving to success metadata
   */
  async setToolConfig(
    agentId: string,
    toolId: string,
    toolConfig: Record<string, unknown>,
  ): Promise<{ success: boolean; message: string }> {
    const tool = await this.toolRepo.getToolById(toolId);
    if (!tool) {
      const error = `Tool ${toolId} not found`;
      this.logger.error({ agentId, toolId }, error);
      throw new Error(error);
    }

    await this.agentToolRepo.setToolConfig(agentId, toolId, toolConfig);
    this.logger.info({ agentId, toolId }, 'Tool runtime configuration persisted');
    return { success: true, message: 'Tool configuration saved' };
  }

  /**
   * @description Retrieves all enabled tools for an agent (auth_mode != 'off').
   * Used by selector composition service to determine active tool capabilities.
   * 
   * @param agentId - The UUID of the agent
   * @returns Array of enabled Tool objects
   */
  async getEnabledTools(agentId: string) {
    const agentTools = await this.getAgentTools(agentId);
    return agentTools
      .filter((tool) => tool.authMode !== AuthMode.OFF)
      .map((tool) => tool.tool);
  }

  /**
   * @description Determines whether a named tool may execute unattended for an agent.
   *
   * @param agentId - The UUID of the agent
   * @param toolName - Stable tool registry name
   * @returns True only when the durable grant is exactly `auto`; ASK still needs a decision.
   */
  async isToolEnabled(agentId: string, toolName: string): Promise<boolean> {
    const executableTools = await this.agentToolRepo.getAutoExecutableTools(agentId);
    return executableTools.some((tool) => tool.name === toolName);
  }

  /**
   * @description Builds a baseline tool runtime configuration object for tools that
   * have not yet been explicitly configured for an agent.
   *
   * @param tool - Tool metadata from registry
   * @returns Default tool configuration object
   */
  private buildDefaultToolConfig(tool: Tool): Record<string, unknown> {
    const authTypeByGroup: Record<string, ToolAuthType> = {
      aws: ToolAuthType.AWS,
      gcp: ToolAuthType.GCP,
      azure: ToolAuthType.AZURE,
      github: ToolAuthType.OAUTH2,
      gitlab: ToolAuthType.OAUTH2,
      kubernetes: ToolAuthType.KUBECONFIG,
      vault: ToolAuthType.VAULT,
      terraform: ToolAuthType.API_KEY,
    };

    const defaultAuthType = authTypeByGroup[tool.authGroup] ?? ToolAuthType.NONE;
    return {
      auth: {
        type: defaultAuthType,
        enabled: tool.defaultAuthMode !== AuthMode.OFF,
      },
      env: {},
      endpoint: {},
      metadata: {},
    };
  }
}
