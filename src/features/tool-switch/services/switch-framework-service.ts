/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of SwitchFrameworkService for Layer 1 Tools Framework
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Returned full tool catalog with effective per-agent auth modes so chat configuration can render switch state before explicit assignments
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added default unified auth config generation and per-tool runtime configuration persistence
 */

import { logger } from '@/shared/logger';
import { AuthMode, Tool, InstallMethod, ToolAuthType } from '@/shared/types/tool';
import { AgentToolRepository, ToolRepository } from '@/entities/tool';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

    // Set the new auth mode
    await this.agentToolRepo.setAuthMode(agentId, toolId, authMode);
    this.logger.info(
      { agentId, toolId, oldMode: currentAuthMode, newMode: authMode },
      'Auth mode updated'
    );

    // Handle installation state transitions
    if (authMode !== 'off' && currentAuthMode === 'off' && !currentlyInstalled) {
      // Transitioning from off to ask/auto - install tool
      const installResult = await this.installTool(agentId, tool);
      if (installResult.success) {
        await this.agentToolRepo.markInstalled(agentId, toolId);
        return {
          success: true,
          message: `Auth mode set to ${authMode} and tool installed`,
          installed: true,
        };
      } else {
        return {
          success: true,
          message: `Auth mode set to ${authMode}, but installation failed: ${installResult.error}`,
          installed: false,
        };
      }
    } else if (authMode === 'off' && currentlyInstalled) {
      // Transitioning to off - uninstall tool
      const uninstallResult = await this.uninstallTool(agentId, tool);
      if (uninstallResult.success) {
        await this.agentToolRepo.markUninstalled(agentId, toolId);
        return {
          success: true,
          message: `Auth mode set to off and tool uninstalled`,
          installed: false,
        };
      } else {
        return {
          success: true,
          message: `Auth mode set to off, but uninstallation failed: ${uninstallResult.error}`,
          installed: true,
        };
      }
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

    // Set auth mode for all tools in group
    const count = await this.agentToolRepo.setGroupAuthMode(agentId, groupName, authMode);

    // Handle installation state transitions for each tool
    for (const tool of toolsInGroup) {
      const currentTool = currentAgentTools.find((at) => at.toolId === tool.toolId);
      const currentAuthMode = currentTool?.authMode || 'off';
      const currentlyInstalled = currentTool?.installed || false;

      if (authMode !== 'off' && currentAuthMode === 'off' && !currentlyInstalled) {
        // Install tool
        const installResult = await this.installTool(agentId, tool);
        if (installResult.success) {
          await this.agentToolRepo.markInstalled(agentId, tool.toolId);
          installResults[tool.name] = true;
        } else {
          this.logger.warn(
            { agentId, toolId: tool.toolId, error: installResult.error },
            'Tool installation failed during group auth mode change'
          );
          installResults[tool.name] = false;
        }
      } else if (authMode === 'off' && currentlyInstalled) {
        // Uninstall tool
        const uninstallResult = await this.uninstallTool(agentId, tool);
        if (uninstallResult.success) {
          await this.agentToolRepo.markUninstalled(agentId, tool.toolId);
          installResults[tool.name] = true;
        } else {
          this.logger.warn(
            { agentId, toolId: tool.toolId, error: uninstallResult.error },
            'Tool uninstallation failed during group auth mode change'
          );
          installResults[tool.name] = false;
        }
      }
    }

    this.logger.info(
      { agentId, groupName, authMode, count, installResults },
      'Auth mode set for tool group'
    );

    return { success: true, count, installResults };
  }

  /**
   * @description Installs a tool based on its install_spec configuration.
   * Handles different installation methods (apt, npm, pip, binary, script, none).
   * 
   * @param agentId - The UUID of the agent (for logging)
   * @param tool - The Tool object with install_spec
   * @returns Object with success status and optional error message
   */
  private async installTool(
    agentId: string,
    tool: Tool
  ): Promise<{ success: boolean; error?: string }> {
    const { installSpec } = tool;
    const { method, verifyCommand, cleanupCommand } = installSpec;

    this.logger.info(
      { agentId, toolId: tool.toolId, method, verifyCommand },
      'Installing tool'
    );

    // Handle NONE method - no installation needed
    if (method === InstallMethod.NONE) {
      this.logger.info({ agentId, toolId: tool.toolId }, 'Tool requires no installation');
      return { success: true };
    }

    // Validate verifyCommand exists
    if (!verifyCommand) {
      const error = 'Verify command not specified in install_spec';
      this.logger.error({ agentId, toolId: tool.toolId }, error);
      throw new Error(error);
    }

    try {
      // Execute installation verify command
      const { stdout, stderr } = await execAsync(verifyCommand);

      this.logger.info(
        { agentId, toolId: tool.toolId, stdout, stderr },
        'Installation verify command output'
      );

      // Verify installation if verifyCommand is provided
      if (verifyCommand) {
        try {
          await execAsync(verifyCommand);
          this.logger.info({ agentId, toolId: tool.toolId }, 'Tool installation verified');
        } catch (verifyError) {
          const error = 'Installation verification failed';
          this.logger.warn(
            { agentId, toolId: tool.toolId, verifyError },
            error
          );
          return { success: false, error };
        }
      }

      this.logger.info({ agentId, toolId: tool.toolId }, 'Tool installed successfully');
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { err: error, agentId, toolId: tool.toolId },
        'Tool installation failed'
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * @description Uninstalls a tool based on its install_spec configuration.
   * Uses cleanupCommand if provided, otherwise uses method-specific defaults.
   * 
   * @param agentId - The UUID of the agent (for logging)
   * @param tool - The Tool object with install_spec
   * @returns Object with success status and optional error message
   */
  private async uninstallTool(
    agentId: string,
    tool: Tool
  ): Promise<{ success: boolean; error?: string }> {
    const { installSpec } = tool;
    const { method, cleanupCommand } = installSpec;

    this.logger.info(
      { agentId, toolId: tool.toolId, method, cleanupCommand },
      'Uninstalling tool'
    );

    // If no cleanup command, log warning and return success
    // (Tool may not support uninstallation or may require manual removal)
    if (!cleanupCommand) {
      this.logger.warn(
        { agentId, toolId: tool.toolId },
        'No cleanup command specified - marking as uninstalled without execution'
      );
      return { success: true };
    }

    try {
      // Execute cleanup command
      const { stdout, stderr } = await execAsync(cleanupCommand);

      this.logger.info(
        { agentId, toolId: tool.toolId, stdout, stderr },
        'Cleanup command output'
      );
      this.logger.info({ agentId, toolId: tool.toolId }, 'Tool uninstalled successfully');
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { err: error, agentId, toolId: tool.toolId },
        'Tool uninstallation failed'
      );
      return { success: false, error: errorMessage };
    }
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
   * @description Determines whether a named tool is currently enabled for an agent.
   *
   * @param agentId - The UUID of the agent
   * @param toolName - Stable tool registry name
   * @returns True when the tool is enabled (`auth_mode != off`)
   */
  async isToolEnabled(agentId: string, toolName: string): Promise<boolean> {
    const enabledTools = await this.getEnabledTools(agentId);
    return enabledTools.some((tool) => tool.name === toolName);
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
