/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat config persistence and activation validation from the oversized chat config modal controller
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched chat-agent profile persistence from broad /api/config merges to dedicated /api/agents/:agentId/profile writes
 */

import { normalizeToolConfig } from '/chat-assets/chat-tool-config-auth.mjs';
import { createUiLogger } from '../../shared/ui-debug.js';

const logger = createUiLogger('chat-config-persistence');

/**
 * @description Throws when any enabled tool is missing required configuration.
 * This keeps the same tool contract for save validation across all config sections.
 *
 * @param {object} params Validation dependencies.
 * @param {Array<Record<string, unknown>>} params.agentTools Agent tool rows.
 * @param {Map<string, string>} params.pendingToolModes Pending auth mode overrides.
 * @param {Map<string, Record<string, unknown>>} params.pendingToolConfigs Pending tool config overrides.
 * @param {Record<string, unknown>} params.agentConfig Effective agent profile config.
 * @param {(tools: Array<Record<string, unknown>>, modes: Map<string, string>, configs: Map<string, Record<string, unknown>>, agentConfig: Record<string, unknown>) => Array<{ name: string, reasons: string[] }>} params.collectToolActivationErrors Guardrail collector.
 * @param {(sectionId: string) => void} params.setActiveConfigSection Section switch helper.
 * @returns {void} Returns once validation passes.
 */
export function validateToolActivationState(params) {
  const issues = params.collectToolActivationErrors(
    params.agentTools,
    params.pendingToolModes,
    params.pendingToolConfigs,
    params.agentConfig,
  );

  if (issues.length === 0) {
    return;
  }

  params.setActiveConfigSection('tools');
  const summary = issues
    .slice(0, 4)
    .map((issue) => `${issue.name}: ${issue.reasons.join(', ')}`)
    .join(' | ');
  throw new Error(`Configure required tool settings before activation. ${summary}`);
}

/**
 * @description Persists narrow chat-agent profile settings plus MCP runtime JSON.
 * Profile writes stay scoped to one `agentId` instead of merging into the global config blob.
 *
 * @param {object} params Persistence dependencies.
 * @param {string} params.agentId Agent identifier.
 * @param {Record<string, unknown>} params.agentProfile Persistable agent-profile payload.
 * @param {Record<string, unknown>} params.mcpConfig MCP runtime settings object.
 * @param {(url: string, options?: RequestInit) => Promise<any>} params.requestJson JSON request helper.
 * @returns {Promise<void>} Completes after both save operations finish.
 */
export async function persistChatAndMcpConfig(params) {
  logger.info('Persisting chat agent profile and MCP config', {
    agentId: params.agentId,
  });
  await params.requestJson(`/api/agents/${params.agentId}/profile`, {
    method: 'PUT',
    body: JSON.stringify({
      profile: params.agentProfile,
    }),
  });

  await params.requestJson('/api/config/mcp', {
    method: 'POST',
    body: JSON.stringify(params.mcpConfig || { mcpServers: {} }),
  });
  logger.info('Persisted chat agent profile and MCP config', {
    agentId: params.agentId,
  });
}

/**
 * @description Persists only tool mode rows that changed in the switch framework.
 * @param {object} params Persistence dependencies.
 * @param {string} params.agentId Agent identifier.
 * @param {Array<Record<string, unknown>>} params.agentTools Agent tool rows.
 * @param {Map<string, string>} params.pendingToolModes Pending auth mode overrides.
 * @param {(url: string, options?: RequestInit) => Promise<any>} params.requestJson JSON request helper.
 * @returns {Promise<void>} Completes after all changed tool modes are saved.
 */
export async function persistToolModeUpdates(params) {
  const changedToolUpdates = params.agentTools.filter((tool) => {
    const nextMode = params.pendingToolModes.get(tool.toolId);
    return typeof nextMode === 'string' && nextMode !== tool.authMode;
  });

  for (const tool of changedToolUpdates) {
    await params.requestJson(`/api/agents/${params.agentId}/tools/${tool.toolId}`, {
      method: 'PUT',
      body: JSON.stringify({ authMode: params.pendingToolModes.get(tool.toolId) }),
    });
  }
  logger.info('Persisted chat tool mode updates', {
    agentId: params.agentId,
    changedCount: changedToolUpdates.length,
  });
}

/**
 * @description Persists only changed tool runtime/auth configuration rows.
 * Runtime side effects are applied after the core tool row is saved.
 *
 * @param {object} params Persistence dependencies.
 * @param {string} params.agentId Agent identifier.
 * @param {Array<Record<string, unknown>>} params.agentTools Agent tool rows.
 * @param {Map<string, Record<string, unknown>>} params.pendingToolConfigs Pending tool config overrides.
 * @param {(url: string, options?: RequestInit) => Promise<any>} params.requestJson JSON request helper.
 * @returns {Promise<void>} Completes after all changed tool configs are saved.
 */
export async function persistToolConfigUpdates(params) {
  const changedToolConfigUpdates = params.agentTools.filter((tool) => {
    if (!params.pendingToolConfigs.has(tool.toolId)) {
      return false;
    }
    const nextConfig = params.pendingToolConfigs.get(tool.toolId);
    const currentConfig = normalizeToolConfig(tool, tool.toolConfig);
    return JSON.stringify(nextConfig) !== JSON.stringify(currentConfig);
  });

  for (const tool of changedToolConfigUpdates) {
    const nextConfig = params.pendingToolConfigs.get(tool.toolId);
    await params.requestJson(`/api/agents/${params.agentId}/tools/${tool.toolId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ toolConfig: nextConfig }),
    });
    await persistToolRuntimeSideEffects({
      tool,
      nextConfig,
      requestJson: params.requestJson,
    });
  }
  logger.info('Persisted chat tool config updates', {
    agentId: params.agentId,
    changedCount: changedToolConfigUpdates.length,
  });
}

async function persistToolRuntimeSideEffects(params) {
  const toolName = readString(params.tool?.tool?.name || params.tool?.name);
  if (toolName !== 'presentron') {
    return;
  }

  await persistPresentronRuntimeConfig(params);
}

async function persistPresentronRuntimeConfig(params) {
  const config = normalizeToolConfig(params.tool, params.nextConfig);
  const endpoint = readString(config?.endpoint?.url);
  if (!endpoint) {
    return;
  }

  const healthcheckPath = readString(config?.metadata?.healthcheckPath) || '/health';
  const mcpUrl = readString(config?.metadata?.mcpUrl);
  await params.requestJson('/api/config/presentron', {
    method: 'POST',
    body: JSON.stringify({
      config: {
        endpoint,
        healthcheckPath,
        mcpUrl,
      },
    }),
  });
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
