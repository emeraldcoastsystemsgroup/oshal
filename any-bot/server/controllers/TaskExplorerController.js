/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

/**
 * TaskExplorerController - API endpoints for the Task Explorer UI
 * Provides ticket hierarchy, activity timeline, workspace file browsing, and metrics
 * 
 * PHASE_03 Issue #009: Ticket Hierarchy Explorer
 */

const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const config = require('../utils/config');

class TaskExplorerController {
  /**
   * @param {Object} options
   * @param {import('../services/queue-manager/PlaneDatabase')} options.planeDatabase
   * @param {import('../services/queue-manager/AgentRegistry')} options.agentRegistry
   * @param {Object} options.redisClient
   */
  constructor({ planeDatabase, agentRegistry, redisClient }) {
    this.planeDatabase = planeDatabase;
    this.agentRegistry = agentRegistry;
    this.redisClient = redisClient;
    
    // ⭐ PHASE_54 SESSION_05: Track error state to prevent log spam
    this._planeDbErrorLogged = false;
    this._lastErrorTime = 0;
    this._ERROR_LOG_COOLDOWN_MS = 5 * 60 * 1000; // Only log once per 5 minutes
  }

  // ─────────────────────────────────────────────
  // 0. GET /api/v1/projects
  // ─────────────────────────────────────────────
  async getProjects(req, res) {
    let client;
    try {
      client = this.planeDatabase.createClient();
      await client.connect();

      const query = `
        SELECT p.id, p.name, p.identifier, p.created_at,
          (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id AND i.deleted_at IS NULL AND i.archived_at IS NULL) as ticket_count
        FROM projects p
        WHERE p.deleted_at IS NULL
        ORDER BY p.name ASC
      `;
      const result = await client.query(query);

      res.json({
        success: true,
        data: result.rows.map(r => ({
          id: r.id,
          name: r.name,
          identifier: r.identifier,
          createdAt: r.created_at,
          ticketCount: parseInt(r.ticket_count) || 0
        })),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[TaskExplorer] Projects error:', error.message);
      res.status(500).json({ error: 'Failed to load projects', details: error.message });
    } finally {
      if (client) try { await client.end(); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────
  // 1. GET /api/v1/tickets/hierarchy
  // ─────────────────────────────────────────────
  async getTicketHierarchy(req, res) {
    let client;
    try {
      client = this.planeDatabase.createClient();
      await client.connect();

      let projectId = req.query.projectId || process.env.PLANE_PROJECT_ID;
      if (!projectId) {
        // Auto-discover: use first project in DB
        projectId = await this._autoDiscoverProjectId(client);
      }
      if (!projectId) {
        return res.status(400).json({ error: 'No projects found in Plane DB' });
      }

      // Get project identifier for display
      const projResult = await client.query('SELECT identifier FROM projects WHERE id = $1', [projectId]);
      const projectIdentifier = projResult.rows[0]?.identifier || 'TC';

      const rows = await this._queryHierarchy(client, projectId);
      const tree = this._buildTree(rows);

      // Get workspace slug for Plane URLs
      const workspaceQuery = 'SELECT slug FROM workspaces LIMIT 1';
      const wsResult = await client.query(workspaceQuery);
      const workspaceSlug = wsResult.rows[0]?.slug || process.env.PLANE_WORKSPACE_SLUG || 'multi-agent';

      // ⭐ PHASE_54 SESSION_05: Reset error flag on success
      this._planeDbErrorLogged = false;

      res.json({
        success: true,
        data: tree,
        total: rows.length,
        projectIdentifier,
        workspaceSlug,
        projectId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // ⭐ PHASE_54 SESSION_05: Graceful degradation - only log once per cooldown period
      const now = Date.now();
      const shouldLog = !this._planeDbErrorLogged || (now - this._lastErrorTime) > this._ERROR_LOG_COOLDOWN_MS;
      
      if (shouldLog) {
        logger.error('[TaskExplorer] Hierarchy error:', error.message);
        logger.info('[TaskExplorer] Plane DB unavailable - will retry silently (log cooldown: 5min)');
        this._planeDbErrorLogged = true;
        this._lastErrorTime = now;
      }
      
      // Return graceful error response instead of 500
      res.status(503).json({ 
        success: false,
        error: 'Plane DB unavailable', 
        details: 'Task Explorer requires Plane database connection',
        retry: true
      });
    } finally {
      if (client) try { await client.end(); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────
  // 2. GET /api/v1/tickets/:id/activity
  // ─────────────────────────────────────────────
  async getTicketActivity(req, res) {
    let client;
    try {
      const ticketId = req.params.id;
      client = this.planeDatabase.createClient();
      await client.connect();

      // Parallel: ticket details, comments, redis processing state
      const [ticketDetail, comments, processingState, routeCount] = await Promise.all([
        this._getTicketDetail(client, ticketId),
        this.planeDatabase.getRecentComments(client, ticketId, 50),
        this._getProcessingState(ticketId),
        this._getRouteCount(ticketId)
      ]);

      if (!ticketDetail) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      // Build activity timeline from comments
      const timeline = this._buildTimeline(comments, processingState);

      // Get activityStats from Redis if available
      const activityStats = await this._getActivityStats(ticketId);

      res.json({
        success: true,
        data: {
          ticket: ticketDetail,
          timeline,
          processing: processingState,
          routeCount: routeCount || 0,
          activityStats,
          cost: this._estimateCost(activityStats)
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[TaskExplorer] Activity error:', error.message);
      res.status(500).json({ error: 'Failed to load ticket activity', details: error.message });
    } finally {
      if (client) try { await client.end(); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────
  // 3. GET /api/v1/workspace/:ticketId/files
  // ─────────────────────────────────────────────
  async getWorkspaceFiles(req, res) {
    try {
      const ticketId = req.params.ticketId;
      const workspaceBase = config.filesystem?.workspaceDir || path.join(__dirname, '../../workspace');

      // Try multiple workspace path patterns
      const possiblePaths = [
        path.join(workspaceBase, ticketId),
        path.join(workspaceBase, `task_${ticketId.substring(0, 8)}`),
      ];

      // Also scan for any directory matching this ticket ID
      let workspacePath = null;
      for (const p of possiblePaths) {
        try {
          const stat = await fs.stat(p);
          if (stat.isDirectory()) {
            workspacePath = p;
            break;
          }
        } catch (_) {}
      }

      // Fallback: scan workspace dir for matching directories
      if (!workspacePath) {
        try {
          const entries = await fs.readdir(workspaceBase);
          for (const entry of entries) {
            if (entry.includes(ticketId.substring(0, 8))) {
              const fullPath = path.join(workspaceBase, entry);
              const stat = await fs.stat(fullPath);
              if (stat.isDirectory()) {
                workspacePath = fullPath;
                break;
              }
            }
          }
        } catch (_) {}
      }

      if (!workspacePath) {
        return res.json({
          success: true,
          data: { path: `workspace/${ticketId}`, children: [], exists: false },
          timestamp: new Date().toISOString()
        });
      }

      const tree = await this._walkDirectory(workspacePath, workspacePath);

      res.json({
        success: true,
        data: {
          path: path.relative(path.join(__dirname, '../..'), workspacePath),
          children: tree,
          exists: true
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[TaskExplorer] Workspace files error:', error.message);
      res.status(500).json({ error: 'Failed to load workspace files', details: error.message });
    }
  }

  // ─────────────────────────────────────────────
  // 4. GET /api/v1/workspace/:ticketId/files/*
  // ─────────────────────────────────────────────
  async getFileContent(req, res) {
    try {
      const ticketId = req.params.ticketId;
      // Express wildcard: req.params[0] contains the rest of the path
      const filePath = req.params[0] || '';
      const workspaceBase = config.filesystem?.workspaceDir || path.join(__dirname, '../../workspace');

      // Resolve workspace directory (same logic as getWorkspaceFiles)
      const possiblePaths = [
        path.join(workspaceBase, ticketId),
        path.join(workspaceBase, `task_${ticketId.substring(0, 8)}`),
      ];

      let workspacePath = null;
      for (const p of possiblePaths) {
        try {
          const stat = await fs.stat(p);
          if (stat.isDirectory()) { workspacePath = p; break; }
        } catch (_) {}
      }

      if (!workspacePath) {
        // Scan fallback
        try {
          const entries = await fs.readdir(workspaceBase);
          for (const entry of entries) {
            if (entry.includes(ticketId.substring(0, 8))) {
              const fullPath = path.join(workspaceBase, entry);
              const stat = await fs.stat(fullPath);
              if (stat.isDirectory()) { workspacePath = fullPath; break; }
            }
          }
        } catch (_) {}
      }

      if (!workspacePath) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      const fullFilePath = path.join(workspacePath, filePath);

      // Security: ensure path doesn't escape workspace
      if (!fullFilePath.startsWith(workspacePath)) {
        return res.status(403).json({ error: 'Path traversal denied' });
      }

      const stat = await fs.stat(fullFilePath);
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Not a file' });
      }

      // Size limit: 500KB
      if (stat.size > 512 * 1024) {
        return res.json({
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            truncated: true,
            content: `[File too large: ${this._formatSize(stat.size)}. Download to view.]`
          }
        });
      }

      const content = await fs.readFile(fullFilePath, 'utf-8');
      const ext = path.extname(fullFilePath).toLowerCase().replace('.', '');

      res.json({
        success: true,
        data: {
          path: filePath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          language: this._extToLanguage(ext),
          content
        }
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      logger.error('[TaskExplorer] File content error:', error.message);
      res.status(500).json({ error: 'Failed to read file', details: error.message });
    }
  }

  // ─────────────────────────────────────────────
  // 5. GET /api/v1/metrics/summary
  // ─────────────────────────────────────────────
  async getMetricsSummary(req, res) {
    let client;
    try {
      client = this.planeDatabase.createClient();
      await client.connect();

      let projectId = req.query.projectId || process.env.PLANE_PROJECT_ID;
      if (!projectId) {
        projectId = await this._autoDiscoverProjectId(client);
      }
      if (!projectId) {
        return res.status(400).json({ error: 'No projects found in Plane DB' });
      }

      // Get state counts from Plane DB
      const stateCountsQuery = `
        SELECT s.name as state, COUNT(*) as count
        FROM issues i
        JOIN states s ON i.state_id = s.id
        WHERE i.project_id = $1
        AND i.deleted_at IS NULL
        AND i.archived_at IS NULL
        GROUP BY s.name
        ORDER BY s.name
      `;
      const stateResult = await client.query(stateCountsQuery, [projectId]);

      // Get agents from registry
      let agents = [];
      try {
        agents = await this.agentRegistry.getAll();
      } catch (_) {}

      // Aggregate processing stats from Redis
      const processingStats = await this._getGlobalProcessingStats();

      // Build state map
      const stateCounts = {};
      let total = 0;
      for (const row of stateResult.rows) {
        stateCounts[row.state] = parseInt(row.count);
        total += parseInt(row.count);
      }

      // Get recent tickets for avg processing time
      const recentQuery = `
        SELECT i.id, i.created_at, i.updated_at, s.name as state
        FROM issues i
        JOIN states s ON i.state_id = s.id
        WHERE i.project_id = $1
        AND s.name IN ('Done', 'In Review')
        AND i.deleted_at IS NULL
        ORDER BY i.updated_at DESC
        LIMIT 20
      `;
      const recentResult = await client.query(recentQuery, [projectId]);
      const avgProcessingTime = this._calcAvgProcessingTime(recentResult.rows);

      // ⭐ PHASE_54 SESSION_05: Reset error flag on success
      this._planeDbErrorLogged = false;

      res.json({
        success: true,
        data: {
          stateCounts,
          total,
          queue: (stateCounts['Todo'] || 0) + (stateCounts['Backlog'] || 0),
          inProgress: stateCounts['In Progress'] || 0,
          review: stateCounts['In Review'] || 0,
          done: stateCounts['Done'] || 0,
          agents: {
            total: agents.length,
            idle: agents.filter(a => a.status === 'idle').length,
            busy: agents.filter(a => a.status === 'busy').length,
            offline: agents.filter(a => a.status === 'offline').length,
            list: agents.map(a => ({
              id: a.agent_id,
              status: a.status,
              currentLoad: a.current_load || 0,
              maxConcurrent: a.max_concurrent || 1,
              capabilities: a.capabilities || []
            }))
          },
          processingStats: processingStats,
          avgProcessingTimeMs: avgProcessingTime,
          avgProcessingTimeFormatted: this._formatDuration(avgProcessingTime),
          estimatedTotalCost: processingStats.estimatedTotalCost || 0
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // ⭐ PHASE_54 SESSION_05: Graceful degradation - only log once per cooldown period
      const now = Date.now();
      const shouldLog = !this._planeDbErrorLogged || (now - this._lastErrorTime) > this._ERROR_LOG_COOLDOWN_MS;
      
      if (shouldLog) {
        logger.error('[TaskExplorer] Metrics error:', error.message);
        logger.info('[TaskExplorer] Plane DB unavailable - will retry silently (log cooldown: 5min)');
        this._planeDbErrorLogged = true;
        this._lastErrorTime = now;
      }
      
      // Return graceful error response with empty data
      res.status(503).json({ 
        success: false,
        error: 'Plane DB unavailable',
        details: 'Task Explorer requires Plane database connection',
        retry: true
      });
    } finally {
      if (client) try { await client.end(); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────
  // 6. GET /api/v1/workspace/browse (all workspaces)
  // ─────────────────────────────────────────────
  async getAllWorkspaces(req, res) {
    try {
      const workspaceBase = config.filesystem?.workspaceDir || path.join(__dirname, '../../workspace');
      const entries = await fs.readdir(workspaceBase, { withFileTypes: true });
      
      const workspaces = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        
        const fullPath = path.join(workspaceBase, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          // Count files inside
          const children = await fs.readdir(fullPath);
          const fileCount = children.filter(c => !c.startsWith('.')).length;
          
          workspaces.push({
            name: entry.name,
            path: entry.name,
            created: stat.birthtime || stat.ctime,
            modified: stat.mtime,
            fileCount
          });
        } catch (_) {}
      }
      
      // Sort by modified date, newest first
      workspaces.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      
      res.json({
        success: true,
        data: {
          basePath: path.relative(path.join(__dirname, '../..'), workspaceBase),
          workspaces,
          total: workspaces.length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('[TaskExplorer] Browse workspaces error:', error.message);
      res.status(500).json({ error: 'Failed to browse workspaces', details: error.message });
    }
  }

  // ═══════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════

  /**
   * Auto-discover projectId from Plane DB when PLANE_PROJECT_ID is not set.
   * Caches result for subsequent calls.
   */
  async _autoDiscoverProjectId(client) {
    if (this._cachedProjectId) return this._cachedProjectId;
    try {
      const result = await client.query('SELECT id FROM projects ORDER BY created_at ASC LIMIT 1');
      if (result.rows.length > 0) {
        this._cachedProjectId = result.rows[0].id;
        logger.info(`[TaskExplorer] Auto-discovered projectId: ${this._cachedProjectId}`);
        return this._cachedProjectId;
      }
    } catch (err) {
      logger.warn(`[TaskExplorer] Failed to auto-discover projectId: ${err.message}`);
    }
    return null;
  }

  async _queryHierarchy(client, projectId) {
    const query = `
      SELECT 
        i.id,
        i.name,
        i.description_stripped,
        i.parent_id,
        i.priority,
        i.sequence_id,
        i.created_at,
        i.updated_at,
        s.name as state,
        s.color as state_color,
        (SELECT COUNT(*) FROM issues c WHERE c.parent_id = i.id AND c.deleted_at IS NULL) as child_count
      FROM issues i
      LEFT JOIN states s ON i.state_id = s.id
      WHERE i.project_id = $1
      AND i.deleted_at IS NULL
      AND i.archived_at IS NULL
      ORDER BY i.created_at DESC
    `;
    const result = await client.query(query, [projectId]);
    return result.rows;
  }

  _buildTree(rows) {
    const idMap = {};
    const roots = [];

    // Index all tickets
    for (const row of rows) {
      idMap[row.id] = {
        id: row.id,
        name: row.name,
        description: (row.description_stripped || '').substring(0, 200),
        parentId: row.parent_id,
        priority: row.priority,
        sequenceId: row.sequence_id,
        state: row.state || 'Unknown',
        stateColor: row.state_color || '#666',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        taskId: row.task_id,
        childCount: parseInt(row.child_count) || 0,
        children: []
      };
    }

    // Build parent→child relationships
    for (const row of rows) {
      const node = idMap[row.id];
      if (row.parent_id && idMap[row.parent_id]) {
        idMap[row.parent_id].children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async _getTicketDetail(client, ticketId) {
    const query = `
      SELECT 
        i.id, i.name, i.description_stripped, i.priority,
        i.sequence_id, i.parent_id,
        i.created_at, i.updated_at,
        s.name as state, s.color as state_color,
        p.identifier as project_identifier
      FROM issues i
      LEFT JOIN states s ON i.state_id = s.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.id = $1
    `;
    const result = await client.query(query, [ticketId]);
    return result.rows[0] || null;
  }

  _buildTimeline(comments, processingState) {
    const events = [];

    for (const comment of comments) {
      const text = comment.comment_stripped || '';
      let type = 'comment';
      
      // Detect system events from QM comments
      if (text.includes('Queue Manager') || text.includes('🤖')) type = 'system';
      if (text.includes('Ticket Routed') || text.includes('Agent:')) type = 'routing';
      if (text.includes('STALL') || text.includes('stall')) type = 'stall';
      if (text.includes('CONTINUATION')) type = 'continuation';
      if (text.includes('TASK BRIEF')) type = 'brief';
      if (text.includes('✅') || text.includes('COMPLETE')) type = 'completion';

      events.push({
        timestamp: comment.created_at,
        type,
        summary: text.substring(0, 300),
        fullText: text
      });
    }

    // Add processing state info if available
    if (processingState) {
      if (processingState.startedAt) {
        events.push({
          timestamp: new Date(processingState.startedAt).toISOString(),
          type: 'processing_start',
          summary: `Processing started by ${processingState.agentId || 'unknown agent'}`
        });
      }
    }

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return events;
  }

  async _getProcessingState(ticketId) {
    if (!this.redisClient) return null;
    try {
      const key = `qm:processed:${ticketId}`;
      const data = await this.redisClient.get(key);
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async _getRouteCount(ticketId) {
    if (!this.redisClient) return 0;
    try {
      const key = `qm:route_count:${ticketId}`;
      const count = await this.redisClient.get(key);
      return count ? parseInt(count) : 0;
    } catch (_) {
      return 0;
    }
  }

  async _getActivityStats(ticketId) {
    if (!this.redisClient) return null;
    try {
      const key = `qm:activity_stats:${ticketId}`;
      const data = await this.redisClient.get(key);
      let stats = null;
      
      if (data) {
        stats = JSON.parse(data);
      } else {
        // Fallback: check processing state for embedded stats
        const procKey = `qm:processed:${ticketId}`;
        const procData = await this.redisClient.get(procKey);
        if (procData) {
          const parsed = JSON.parse(procData);
          stats = parsed.activityStats || null;
        }
      }

      // ⭐ PHASE_67: Use per-ticket cost from AgentMetricsService (Redis HASH)
      // This is the authoritative source — accumulated across all phases/agents
      try {
        const ticketCostKey = `metrics:ticket:${ticketId}:cost`;
        const ticketCostData = await this.redisClient.hgetall(ticketCostKey);
        if (ticketCostData && Object.keys(ticketCostData).length > 0) {
          if (!stats) stats = {};
          stats.totalTokens = parseInt(ticketCostData.totalTokens || 0);
          stats.inputTokens = parseInt(ticketCostData.inputTokens || 0);
          stats.outputTokens = parseInt(ticketCostData.outputTokens || 0);
          stats.estimatedCost = parseFloat(ticketCostData.totalCost || 0);
          stats.requestCount = parseInt(ticketCostData.dispatchCount || 0);
          stats.realCostData = true;
          logger.debug(`PHASE_67: Real ticket cost for ${ticketId.substring(0,8)}: $${stats.estimatedCost.toFixed(4)} (${stats.totalTokens} tokens, ${stats.requestCount} dispatches)`);
        }
      } catch (ticketCostErr) {
        logger.debug(`PHASE_67: Ticket cost lookup failed (non-fatal): ${ticketCostErr.message}`);
      }

      // Fallback: PHASE_34 legacy path (qm:task_metrics) if PHASE_67 data not available
      if (!stats || !stats.realCostData) {
        try {
          const taskId = await this._getTaskIdForTicket(ticketId);
          if (taskId) {
            const taskMetricsKey = `qm:task_metrics:${taskId}`;
            const taskMetricsData = await this.redisClient.get(taskMetricsKey);
            if (taskMetricsData) {
              const taskMetrics = JSON.parse(taskMetricsData);
              if (!stats) stats = {};
              stats.totalTokens = taskMetrics.totalTokens || 0;
              stats.inputTokens = Math.floor(taskMetrics.totalTokens * 0.3);
              stats.outputTokens = Math.floor(taskMetrics.totalTokens * 0.7);
              stats.estimatedCost = taskMetrics.totalCost || 0;
              stats.requestCount = taskMetrics.requestCount || 0;
              stats.cacheHits = taskMetrics.cacheHits || 0;
              stats.realCostData = true;
              logger.debug(`PHASE_34: Merged real cost data for ticket ${ticketId}: $${taskMetrics.totalCost.toFixed(4)}`);
            }
          }
        } catch (taskMetricsErr) {
          logger.debug(`PHASE_34: Task metrics lookup failed (non-fatal): ${taskMetricsErr.message}`);
        }
      }

      // ⭐ PHASE_67: Subtask cost rollup using per-ticket cost keys
      // Much faster than the old PHASE_33 approach (no DB queries per subtask)
      try {
        let client;
        try {
          client = this.planeDatabase.createClient();
          await client.connect();
          const childResult = await client.query(
            'SELECT id FROM issues WHERE parent_id = $1 AND deleted_at IS NULL', [ticketId]
          );
          if (childResult.rows.length > 0) {
            let subtaskTotalCost = 0;
            let subtaskTotalTokens = 0;
            let subtasksWithCost = 0;
            
            for (const row of childResult.rows) {
              const childCostKey = `metrics:ticket:${row.id}:cost`;
              const childData = await this.redisClient.hgetall(childCostKey);
              if (childData && childData.totalCost) {
                subtaskTotalCost += parseFloat(childData.totalCost || 0);
                subtaskTotalTokens += parseInt(childData.totalTokens || 0);
                subtasksWithCost++;
              }
            }
            
            if (childResult.rows.length > 0) {
              if (!stats) stats = {};
              stats.subtaskCount = childResult.rows.length;
              stats.subtasksWithCost = subtasksWithCost;
              stats.subtaskTokens = subtaskTotalTokens;
              stats.subtaskCost = parseFloat(subtaskTotalCost.toFixed(6));
              stats.totalTokens = (stats.totalTokens || 0) + subtaskTotalTokens;
              stats.aggregatedCost = parseFloat(((stats.estimatedCost || 0) + subtaskTotalCost).toFixed(6));
            }
          }
        } finally {
          if (client) try { await client.end(); } catch (_) {}
        }
      } catch (subtaskErr) {
        logger.debug(`PHASE_67: Subtask cost rollup failed (non-fatal): ${subtaskErr.message}`);
      }

      return stats;
    } catch (_) {
      return null;
    }
  }

  /**
   * Get task ID for a ticket (from Plane DB or Redis)
   * PHASE_34: Helper to bridge ticket→task for cost lookup
   * @private
   */
  async _getTaskIdForTicket(ticketId) {
    try {
      // Try Redis first (fast)
      const redisKey = `qm:ticket_task:${ticketId}`;
      const taskId = await this.redisClient.get(redisKey);
      if (taskId) return taskId;

      // Fallback: Try Plane DB task_id column
      let client;
      try {
        client = this.planeDatabase.createClient();
        await client.connect();
        const result = await client.query('SELECT task_id FROM issues WHERE id = $1', [ticketId]);
        if (result.rows[0]?.task_id) {
          return result.rows[0].task_id;
        }
      } finally {
        if (client) try { await client.end(); } catch (_) {}
      }

      return null;
    } catch (err) {
      logger.debug(`PHASE_34: Task ID lookup failed for ticket ${ticketId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get aggregated costs from all subtasks of a parent ticket.
   * PHASE_33: Cost rollup for hierarchical tickets
   * PHASE_34: Enhanced to use real cost data from TaskStore
   * @param {string} parentTicketId - Parent ticket ID
   * @returns {Promise<Object>} { totalSubtasks, totalTokens, totalCost }
   */
  async _getSubtaskCosts(parentTicketId) {
    if (!this.redisClient) return { totalSubtasks: 0, totalTokens: 0, totalCost: 0 };
    
    try {
      // Get all subtask IDs from Plane DB
      let client;
      try {
        client = this.planeDatabase.createClient();
        await client.connect();
        
        const query = `
          SELECT id FROM issues 
          WHERE parent_id = $1 
          AND deleted_at IS NULL
        `;
        const result = await client.query(query, [parentTicketId]);
        
        if (result.rows.length === 0) {
          return { totalSubtasks: 0, totalTokens: 0, totalCost: 0 };
        }

        let totalTokens = 0;
        let totalCost = 0;
        let subtasksWithStats = 0;

        // Fetch stats for each subtask
        for (const row of result.rows) {
          const subtaskId = row.id;
          
          // ⭐ PHASE_34: Try real task metrics first (from TaskStore)
          let hasRealCost = false;
          try {
            const subtaskTaskId = await this._getTaskIdForTicket(subtaskId);
            if (subtaskTaskId) {
              const taskMetricsKey = `qm:task_metrics:${subtaskTaskId}`;
              const taskMetricsData = await this.redisClient.get(taskMetricsKey);
              if (taskMetricsData) {
                const taskMetrics = JSON.parse(taskMetricsData);
                totalTokens += taskMetrics.totalTokens || 0;
                totalCost += taskMetrics.totalCost || 0;
                subtasksWithStats++;
                hasRealCost = true;
                logger.debug(`PHASE_34: Subtask ${subtaskId.substring(0,8)} real cost: $${(taskMetrics.totalCost || 0).toFixed(4)}`);
              }
            }
          } catch (taskErr) {
            logger.debug(`PHASE_34: Task metrics lookup failed for subtask ${subtaskId}: ${taskErr.message}`);
          }

          // Fallback: Use activity_stats estimates if no real cost data
          if (!hasRealCost) {
            const statsKey = `qm:activity_stats:${subtaskId}`;
            const statsData = await this.redisClient.get(statsKey);
            
            let subtaskStats = null;
            if (statsData) {
              subtaskStats = JSON.parse(statsData);
            } else {
              // Fallback: check processed key
              const procKey = `qm:processed:${subtaskId}`;
              const procData = await this.redisClient.get(procKey);
              if (procData) {
                const parsed = JSON.parse(procData);
                subtaskStats = parsed.activityStats || null;
              }
            }

            if (subtaskStats) {
              subtasksWithStats++;
              // Sum tokens
              const inputTokens = subtaskStats.inputTokens || 0;
              const outputTokens = subtaskStats.outputTokens || 0;
              totalTokens += inputTokens + outputTokens;
              
              // Calculate cost if not already present
              if (subtaskStats.estimatedCost) {
                totalCost += subtaskStats.estimatedCost;
              } else {
                // Estimate: Claude 3.5 Sonnet pricing
                const cost = (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
                totalCost += cost;
              }
            }
          }
        }

        return {
          totalSubtasks: result.rows.length,
          subtasksWithStats,
          totalTokens,
          totalCost: parseFloat(totalCost.toFixed(4))
        };
      } finally {
        if (client) try { await client.end(); } catch (_) {}
      }
    } catch (err) {
      logger.warn(`[TaskExplorer] Failed to aggregate subtask costs for ${parentTicketId}: ${err.message}`);
      return { totalSubtasks: 0, totalTokens: 0, totalCost: 0 };
    }
  }

  _estimateCost(activityStats) {
    if (!activityStats) return { totalTokens: 0, estimatedCost: 0 };
    
    const inputTokens = activityStats.inputTokens || activityStats.totalMessages * 500 || 0;
    const outputTokens = activityStats.outputTokens || activityStats.toolUseCount * 200 || 0;
    
    // Claude 3.5 Sonnet pricing (Bedrock): $3/M input, $15/M output
    const inputCost = (inputTokens / 1_000_000) * 3.0;
    const outputCost = (outputTokens / 1_000_000) * 15.0;

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCost: parseFloat((inputCost + outputCost).toFixed(4))
    };
  }

  async _getGlobalProcessingStats() {
    if (!this.redisClient) return { ticketsProcessed: 0, estimatedTotalCost: 0, realCostCount: 0 };
    try {
      // Scan for all processed ticket keys
      let cursor = '0';
      let totalProcessed = 0;
      let totalCost = 0;
      let realCostCount = 0;

      do {
        const [nextCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', 'qm:processed:*', 'COUNT', 100);
        cursor = nextCursor;
        totalProcessed += keys.length;

        // For each processed ticket, try to get real cost data first
        for (const key of keys) {
          try {
            const data = await this.redisClient.get(key);
            if (data) {
              const parsed = JSON.parse(data);
              const ticketId = parsed.ticket_id;
              
              // ⭐ PHASE_34: Try real cost data first
              let hasRealCost = false;
              if (ticketId) {
                try {
                  const taskId = await this._getTaskIdForTicket(ticketId);
                  if (taskId) {
                    const taskMetricsKey = `qm:task_metrics:${taskId}`;
                    const taskMetricsData = await this.redisClient.get(taskMetricsKey);
                    if (taskMetricsData) {
                      const taskMetrics = JSON.parse(taskMetricsData);
                      totalCost += taskMetrics.totalCost || 0;
                      realCostCount++;
                      hasRealCost = true;
                    }
                  }
                } catch (_) {}
              }
              
              // Fallback to estimates if no real cost
              if (!hasRealCost && parsed.activityStats) {
                const cost = this._estimateCost(parsed.activityStats);
                totalCost += cost.estimatedCost;
              }
            }
          } catch (_) {}
        }
      } while (cursor !== '0');

      logger.info(`[TaskExplorer] Global stats: ${totalProcessed} tickets, $${totalCost.toFixed(2)} total (${realCostCount} with real data)`);

      return {
        ticketsProcessed: totalProcessed,
        estimatedTotalCost: parseFloat(totalCost.toFixed(2)),
        realCostCount
      };
    } catch (_) {
      return { ticketsProcessed: 0, estimatedTotalCost: 0, realCostCount: 0 };
    }
  }

  _calcAvgProcessingTime(recentDoneTickets) {
    if (!recentDoneTickets || recentDoneTickets.length === 0) return 0;
    
    let totalMs = 0;
    let count = 0;
    for (const t of recentDoneTickets) {
      const created = new Date(t.created_at).getTime();
      const updated = new Date(t.updated_at).getTime();
      const diffMs = updated - created;
      if (diffMs > 0 && diffMs < 24 * 60 * 60 * 1000) { // Cap at 24h
        totalMs += diffMs;
        count++;
      }
    }
    return count > 0 ? Math.round(totalMs / count) : 0;
  }

  async _walkDirectory(dirPath, basePath, depth = 0) {
    if (depth > 5) return []; // Max depth safety

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      // Skip hidden files, node_modules, .git
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        const children = await this._walkDirectory(fullPath, basePath, depth + 1);
        result.push({
          name: entry.name,
          type: 'directory',
          path: relativePath,
          children,
          size: 0
        });
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          result.push({
            name: entry.name,
            type: 'file',
            path: relativePath,
            size: stat.size,
            sizeFormatted: this._formatSize(stat.size),
            modified: stat.mtime.toISOString(),
            extension: path.extname(entry.name).toLowerCase().replace('.', '')
          });
        } catch (_) {
          result.push({
            name: entry.name,
            type: 'file',
            path: relativePath,
            size: 0,
            sizeFormatted: '0 B',
            extension: path.extname(entry.name).toLowerCase().replace('.', '')
          });
        }
      }
    }

    // Sort: directories first, then files, both alphabetical
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  _formatDuration(ms) {
    if (!ms || ms === 0) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  _extToLanguage(ext) {
    const map = {
      js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby',
      java: 'java', go: 'go', rs: 'rust', sh: 'bash', bash: 'bash',
      md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
      html: 'html', css: 'css', sql: 'sql', xml: 'xml',
      txt: 'text', log: 'text', csv: 'text',
      dockerfile: 'dockerfile'
    };
    return map[ext] || 'text';
  }
}

module.exports = TaskExplorerController;
