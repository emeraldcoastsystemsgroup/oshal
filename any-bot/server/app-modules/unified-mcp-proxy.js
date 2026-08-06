/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): UnifiedMCPProxy (PHASE_70) — merges stdio + HTTP MCP service interfaces behind one facade
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: route execution through one canonical ToolRegistry snapshot with exact caller/tool scopes; raw stdio/HTTP service calls are no longer exposed.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Make transport and registry references private so proxy consumers cannot reach below the authorization seam.
 */

'use strict';

const {
  canonicalMcpToolName,
  requireMcpCallerContext,
} = require('../services/mcp-tool-authorization');

/**
 * @description Unified facade over the stdio (MCPServiceV2) and HTTP (MCPService) MCP
 * services so controllers/services do not need to know which transport a tool uses.
 * Behavior is identical to the original in-app.js class (PHASE_70).
 */
// ═══════════════════════════════════════════════════════════════════
// PHASE_70: Unified MCP Service Proxy
// Merges stdio (MCPServiceV2) and HTTP (MCPService) interfaces
// so controllers/services don't need to know which transport a tool uses
// ═══════════════════════════════════════════════════════════════════
class UnifiedMCPProxy {
  #stdio;
  #http;
  #toolRegistry;

  constructor(stdioService, httpService, toolRegistry) {
    this.#stdio = stdioService;
    this.#http = httpService;
    this.#toolRegistry = toolRegistry;
  }

  hasServer(serverName) {
    if (this.#stdio && typeof this.#stdio.hasServer === 'function'
      && this.#stdio.hasServer(serverName)) return true;
    if (this.#http && typeof this.#http.hasServer === 'function'
      && this.#http.hasServer(serverName)) return true;
    return false;
  }

  getServerTools(serverName) {
    if (this.#stdio && this.#stdio.hasServer(serverName)) return this.#stdio.getServerTools(serverName);
    if (this.#http && this.#http.hasServer(serverName)) return this.#http.getServerTools(serverName);
    return null;
  }

  getAvailableTools() {
    const stdioTools = this.#stdio ? this.#stdio.getAvailableTools() : [];
    const httpTools = this.#http ? this.#http.getAvailableTools() : [];
    return [...stdioTools, ...httpTools];
  }

  async executeTool(serverName, toolName, args, context) {
    const capabilityName = canonicalMcpToolName(serverName, toolName);
    const caller = requireMcpCallerContext(context, capabilityName);
    if (!this.hasServer(serverName)) throw new Error(`MCP server not found: ${serverName}`);
    if (!this.#toolRegistry || typeof this.#toolRegistry.capture !== 'function'
      || typeof this.#toolRegistry.executeSnapshot !== 'function') {
      const error = new Error('MCP ToolRegistry authorization is unavailable.');
      error.code = 'MCP_TOOL_AUTHORIZATION_DENIED';
      throw error;
    }
    const snapshot = this.#toolRegistry.capture(capabilityName);
    if (!snapshot) {
      const error = new Error(`MCP tool is not registered: ${capabilityName}`);
      error.code = 'MCP_TOOL_AUTHORIZATION_DENIED';
      throw error;
    }
    return this.#toolRegistry.executeSnapshot(snapshot, args, {
      approved: false,
      userSub: caller.userSub,
      agentId: caller.agentId,
      taskId: caller.taskId,
      allowedTools: caller.allowedTools,
      authorizedScopes: caller.authorizedScopes,
      taskWorkspace: caller.taskWorkspace,
      extraEnv: { OSHAL_USER_SUB: caller.userSub },
    });
  }

  // Add more methods if needed (e.g. registerTool for DynamicToolManager)
  registerTool(toolDef) {
    // Default to HTTP service for dynamic tools (since they are HTTP based)
    if (this.#http && typeof this.#http.registerTool === 'function') {
      return this.#http.registerTool(toolDef);
    } else if (this.#stdio && typeof this.#stdio.registerTool === 'function') {
      return this.#stdio.registerTool(toolDef);
    }
  }

  unregisterTool(toolName) {
    let removed = false;
    if (this.#http && typeof this.#http.unregisterTool === 'function') {
      removed = this.#http.unregisterTool(toolName) || removed;
    }
    if (this.#stdio && typeof this.#stdio.unregisterTool === 'function') {
      removed = this.#stdio.unregisterTool(toolName) || removed;
    }
    return removed;
  }
}

module.exports = { UnifiedMCPProxy };
