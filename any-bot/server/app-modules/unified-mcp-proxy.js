/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): UnifiedMCPProxy (PHASE_70) — merges stdio + HTTP MCP service interfaces behind one facade
 */

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
  constructor(stdioService, httpService) {
    this.stdio = stdioService;
    this.http = httpService;
  }

  hasServer(serverName) {
    if (this.stdio && this.stdio.hasServer(serverName)) return true;
    if (this.http && this.http.hasServer(serverName)) return true;
    return false;
  }

  getServerTools(serverName) {
    if (this.stdio && this.stdio.hasServer(serverName)) return this.stdio.getServerTools(serverName);
    if (this.http && this.http.hasServer(serverName)) return this.http.getServerTools(serverName);
    return null;
  }

  getAvailableTools() {
    const stdioTools = this.stdio ? this.stdio.getAvailableTools() : [];
    const httpTools = this.http ? this.http.getAvailableTools() : [];
    return [...stdioTools, ...httpTools];
  }

  async executeTool(serverName, toolName, args) {
    if (this.stdio && this.stdio.hasServer(serverName)) {
      return await this.stdio.executeTool(serverName, toolName, args);
    }
    if (this.http && this.http.hasServer(serverName)) {
      return await this.http.executeTool(serverName, toolName, args);
    }
    throw new Error(`MCP server not found: ${serverName}`);
  }

  // Add more methods if needed (e.g. registerTool for DynamicToolManager)
  registerTool(toolDef) {
    // Default to HTTP service for dynamic tools (since they are HTTP based)
    if (this.http && typeof this.http.registerTool === 'function') {
      return this.http.registerTool(toolDef);
    } else if (this.stdio && typeof this.stdio.registerTool === 'function') {
      return this.stdio.registerTool(toolDef);
    }
  }

  unregisterTool(toolName) {
    let removed = false;
    if (this.http && typeof this.http.unregisterTool === 'function') {
      removed = this.http.unregisterTool(toolName) || removed;
    }
    if (this.stdio && typeof this.stdio.unregisterTool === 'function') {
      removed = this.stdio.unregisterTool(toolName) || removed;
    }
    return removed;
  }
}

module.exports = { UnifiedMCPProxy };
