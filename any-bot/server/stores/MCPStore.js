/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MCP Store - Manages MCP server configurations
 * Stores server definitions, connection status, and tool metadata
 */

const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

/**
 * @description Persistence layer for MCP (Model Context Protocol) server and tool
 * metadata. Exists so the rest of the application has a single, durable source of
 * truth for which MCP servers are configured, whether they are enabled/healthy, and
 * which tools they expose — surviving process restarts via a local SQLite database
 * rather than holding this state only in memory.
 */
class MCPStore {
  /**
   * @description Opens (or creates) the backing SQLite database and ensures the
   * required schema exists, so a freshly constructed store is immediately usable.
   * WAL journaling is enabled to allow concurrent reads while a write is in
   * progress, which suits the read-heavy access pattern of tool lookups.
   * @param {string} [dbPath] Filesystem path to the SQLite database file; defaults
   *   to the application's standard data location so callers normally omit it.
   */
  constructor(dbPath = path.join(__dirname, '../../data/cline.db')) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
  }

  /**
   * @description Creates the server and tool tables (and supporting indexes) if they
   * do not already exist, making the store safe to instantiate against either a brand
   * new or a previously populated database. Using IF NOT EXISTS keeps this idempotent
   * so it can run on every startup without risking existing data.
   */
  initializeTables() {
    // MCP servers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        port INTEGER,
        host TEXT DEFAULT 'localhost',
        enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'unknown',
        last_health_check INTEGER,
        tools_discovered INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
    `);

    // MCP tools table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tools (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'general',
        input_schema TEXT,
        requires_approval INTEGER DEFAULT 1,
        execution_count INTEGER DEFAULT 0,
        last_executed INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_tools_name ON mcp_tools(name);
    `);

    logger.info('MCPStore tables initialized');
  }

  /**
   * Register or update an MCP server
   */
  upsertServer(server) {
    const { id, name, port, host = 'localhost', enabled = true } = server;

    const stmt = this.db.prepare(`
      INSERT INTO mcp_servers (id, name, port, host, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        port = excluded.port,
        host = excluded.host,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `);

    stmt.run(id, name, port, host, enabled ? 1 : 0, Date.now());
    logger.info(`MCP server ${id} upserted`);
  }

  /**
   * Get server by ID
   */
  getServer(id) {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?');
    const server = stmt.get(id);
    
    if (server) {
      server.enabled = Boolean(server.enabled);
    }
    
    return server;
  }

  /**
   * Get all servers
   */
  getAllServers() {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name');
    const servers = stmt.all();
    
    return servers.map(s => ({
      ...s,
      enabled: Boolean(s.enabled)
    }));
  }

  /**
   * Get enabled servers
   */
  getEnabledServers() {
    const stmt = this.db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name');
    const servers = stmt.all();
    
    return servers.map(s => ({
      ...s,
      enabled: true
    }));
  }

  /**
   * Update server status
   */
  updateServerStatus(id, status) {
    const stmt = this.db.prepare(`
      UPDATE mcp_servers 
      SET status = ?, last_health_check = ?, updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(status, Date.now(), Date.now(), id);
  }

  /**
   * Update server enabled state
   */
  updateServerEnabled(id, enabled) {
    const stmt = this.db.prepare(`
      UPDATE mcp_servers 
      SET enabled = ?, updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(enabled ? 1 : 0, Date.now(), id);
  }

  /**
   * Register or update an MCP tool
   */
  upsertTool(tool) {
    const {
      id,
      server_id,
      name,
      description = '',
      category = 'general',
      input_schema = {},
      requires_approval = true
    } = tool;

    const stmt = this.db.prepare(`
      INSERT INTO mcp_tools (id, server_id, name, description, category, input_schema, requires_approval, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        category = excluded.category,
        input_schema = excluded.input_schema,
        requires_approval = excluded.requires_approval,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      id,
      server_id,
      name,
      description,
      category,
      JSON.stringify(input_schema),
      requires_approval ? 1 : 0,
      Date.now()
    );
  }

  /**
   * Get tool by ID
   */
  getTool(id) {
    const stmt = this.db.prepare('SELECT * FROM mcp_tools WHERE id = ?');
    const tool = stmt.get(id);
    
    if (tool) {
      tool.input_schema = JSON.parse(tool.input_schema || '{}');
      tool.requires_approval = Boolean(tool.requires_approval);
    }
    
    return tool;
  }

  /**
   * Get all tools for a server
   */
  getServerTools(server_id) {
    const stmt = this.db.prepare('SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name');
    const tools = stmt.all(server_id);
    
    return tools.map(t => ({
      ...t,
      input_schema: JSON.parse(t.input_schema || '{}'),
      requires_approval: Boolean(t.requires_approval)
    }));
  }

  /**
   * Get all tools
   */
  getAllTools() {
    const stmt = this.db.prepare(`
      SELECT t.*, s.name as server_name, s.status as server_status
      FROM mcp_tools t
      JOIN mcp_servers s ON t.server_id = s.id
      WHERE s.enabled = 1
      ORDER BY s.name, t.name
    `);
    
    const tools = stmt.all();
    
    return tools.map(t => ({
      ...t,
      input_schema: JSON.parse(t.input_schema || '{}'),
      requires_approval: Boolean(t.requires_approval)
    }));
  }

  /**
   * Update tool execution stats
   */
  recordToolExecution(id) {
    const stmt = this.db.prepare(`
      UPDATE mcp_tools 
      SET execution_count = execution_count + 1,
          last_executed = ?,
          updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(Date.now(), Date.now(), id);
  }

  /**
   * Update server tools count
   */
  updateServerToolsCount(server_id, count) {
    const stmt = this.db.prepare(`
      UPDATE mcp_servers 
      SET tools_discovered = ?, updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(count, Date.now(), server_id);
  }

  /**
   * Delete server and its tools
   */
  deleteServer(id) {
    const stmt = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?');
    stmt.run(id);
    logger.info(`MCP server ${id} deleted`);
  }

  /**
   * Delete tool
   */
  deleteTool(id) {
    const stmt = this.db.prepare('DELETE FROM mcp_tools WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Get server statistics
   */
  getServerStats(server_id) {
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as tool_count,
        SUM(execution_count) as total_executions,
        MAX(last_executed) as last_tool_execution
      FROM mcp_tools
      WHERE server_id = ?
    `);
    
    return stmt.get(server_id);
  }

  /**
   * Clear all MCP data
   */
  clear() {
    this.db.exec('DELETE FROM mcp_tools');
    this.db.exec('DELETE FROM mcp_servers');
    logger.info('MCPStore cleared');
  }

  /**
   * Close database connection
   */
  close() {
    this.db.close();
  }
}

module.exports = MCPStore;
