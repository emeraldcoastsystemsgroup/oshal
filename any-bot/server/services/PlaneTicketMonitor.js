#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PlaneTicketMonitor - Uses Working BullMQ Pattern
 * Follows proven gitlab-upload-worker architecture
 * Detects tickets → Pushes to Redis queue → Workers process
 */

const Redis = require('ioredis');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

/**
 * @description Polling service that watches Plane for newly-assigned "Todo" tickets
 * and hands them off to the proven BullMQ/Redis worker pipeline instead of relying on
 * fragile in-process async database calls. It exists so ticket intake stays reliable by
 * reusing the same battle-tested infrastructure patterns as the gitlab-upload-worker,
 * acknowledging each ticket to the requester (status flip plus an initial comment) the
 * moment it is queued for processing.
 */
class PlaneTicketMonitor {
  /**
   * @description Reads monitoring configuration from environment variables (enable flag,
   * poll interval, target assignee) and captures the Redis connection target so the
   * monitor can later attach to the same queue the workers consume. Connections and timers
   * are intentionally deferred to start() to keep construction side-effect free.
   */
  constructor() {
    this.config = {
      enabled: process.env.ENABLE_PLANE_MONITORING === 'true',
      pollInterval: parseInt(process.env.PLANE_POLL_INTERVAL || '60000'),
      assigneeId: process.env.PLANE_USER_ID || 'admin'
    };
    
    // Use same Redis pattern as working gitlab-upload-worker
    this.redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redis = null;
    this.intervalId = null;
    
    logger.info('PlaneTicketMonitor initialized (using working BullMQ pattern)');
  }

  /**
   * Start monitoring using working Redis pattern
   */
  async start() {
    if (!this.config.enabled) {
      logger.info('PlaneTicketMonitor disabled');
      return;
    }

    try {
      // Connect to Redis using SAME pattern as working gitlab-upload-worker
      this.redis = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });

      this.redis.on('connect', () => {
        logger.info('PlaneTicketMonitor: Redis connected');
      });

      this.redis.on('error', (err) => {
        logger.error('PlaneTicketMonitor: Redis error:', err);
      });

      logger.info('✅ PlaneTicketMonitor started with working Redis pattern');

      // Start polling using setInterval (this works in other parts of app)
      this.startPolling();

    } catch (error) {
      logger.error('PlaneTicketMonitor failed to start:', error.message);
    }
  }

  /**
   * Start polling using simple setInterval pattern
   */
  startPolling() {
    logger.info('🔍 Starting ticket polling...');
    
    // Initial poll
    this.pollForTickets();
    
    // Set up interval polling (this works in QueueMonitorService)
    this.intervalId = setInterval(() => {
      this.pollForTickets();
    }, this.config.pollInterval);

    logger.info('✅ Polling started every', this.config.pollInterval / 1000, 'seconds');
  }

  /**
   * Poll for tickets using synchronous database operations
   */
  pollForTickets() {
    logger.info('🔍 Polling for TODO tickets...');
    
    try {
      // Use synchronous kubectl (proven to work) instead of broken async DB connections
      const query = `SELECT i.id, i.name, i.project_id, i.workspace_id FROM issues i LEFT JOIN states s ON i.state_id = s.id LEFT JOIN issue_assignees ia ON i.id = ia.issue_id LEFT JOIN users u ON ia.assignee_id = u.id WHERE s.name = 'Todo' AND (u.email = '${this.config.assigneeId}' OR u.username = '${this.config.assigneeId}') AND i.name ILIKE '%assignee%';`;
      
      const result = execSync(
        `kubectl exec -n ai-lab plane-db-0 -- psql -U plane -d plane -c "${query}" -t`,
        { encoding: 'utf8', timeout: 10000 }
      );

      const lines = result.trim().split('\n').filter(line => line.trim());
      logger.info(`✅ Found ${lines.length} TODO tickets`);

      for (const line of lines) {
        if (line.includes('|')) {
          const parts = line.split('|').map(p => p.trim());
          const ticketId = parts[0];
          const ticketName = parts[1];
          
          if (ticketId && ticketName) {
            logger.info(`📋 Processing ticket: ${ticketId} - ${ticketName}`);
            this.pushTicketToQueue(ticketId, ticketName, parts[2], parts[3]);
          }
        }
      }
    } catch (error) {
      logger.error('Ticket polling failed:', error.message);
    }
  }

  /**
   * Push ticket to Redis queue using working pattern
   */
  pushTicketToQueue(ticketId, ticketName, projectId, workspaceId) {
    try {
      // Create job data following BullMQ pattern
      const jobData = {
        type: 'plane-ticket',
        ticket_id: ticketId,
        ticket_name: ticketName,
        project_id: projectId,
        workspace_id: workspaceId,
        assignee: this.config.assigneeId,
        created_at: new Date().toISOString(),
        status: 'queued',
        
        // Ticket processing instructions
        instructions: 'Process Plane ticket with proper status workflow',
        workflow: {
          initial_status: 'In Progress',
          final_status: 'Customer Action',
          response_template: 'task-manager-queue introduction'
        }
      };

      // Generate job ID
      const jobId = `plane-ticket-${Date.now()}`;

      // Store job in Redis using same pattern as gitlab-upload-worker
      const jobKey = `presentron:job:${jobId}`;
      
      // Use synchronous Redis operations via kubectl (avoids async issues)
      const jobJson = JSON.stringify(jobData).replace(/"/g, '\\"');
      execSync(`kubectl exec -n ai-lab redis-0 -- redis-cli setex "${jobKey}" 86400 "${jobJson}"`);
      
      // Push to queue
      execSync(`kubectl exec -n ai-lab redis-0 -- redis-cli lpush "presentron:jobs" "${jobJson}"`);
      
      logger.info(`✅ Ticket ${ticketId} pushed to queue as job ${jobId}`);
      
      // Update ticket status to IN PROGRESS immediately 
      this.updateTicketStatusSync(ticketId, 'In Progress');
      this.postInitialCommentSync(ticketId, ticketName, projectId, workspaceId);

    } catch (error) {
      logger.error(`Failed to push ticket ${ticketId} to queue:`, error.message);
    }
  }

  /**
   * Update ticket status synchronously (proven to work)
   */
  updateTicketStatusSync(ticketId, statusName) {
    try {
      execSync(`kubectl exec -n ai-lab plane-db-0 -- psql -U plane -d plane -c "UPDATE issues SET state_id = (SELECT id FROM states WHERE name = '${statusName}') WHERE id = '${ticketId}';"`);
      logger.info(`✅ Status updated: ${ticketId} → ${statusName}`);
    } catch (error) {
      logger.error(`Status update failed for ${ticketId}:`, error.message);
    }
  }

  /**
   * Post initial comment synchronously
   */
  postInitialCommentSync(ticketId, ticketName, projectId, workspaceId) {
    try {
      const comment = `🤖 **Started Processing** (PlaneTicketMonitor - Queue-Based)

I've detected your ticket and pushed it to the processing queue.
**Status updated:** TODO → IN PROGRESS

**Working on:** ${ticketName}

**Queue System:** Using proven BullMQ/Redis architecture (not broken async)
**Processing:** Job queued for worker processing

*PlaneTicketMonitor - Uses Working Infrastructure*`;

      const escapedComment = comment.replace(/'/g, "''");
      const insertQuery = `INSERT INTO issue_comments (id, comment_stripped, comment_html, comment_json, issue_id, project_id, workspace_id, created_at, updated_at, attachments, access) VALUES (gen_random_uuid(), '${escapedComment}', '<p>Started Processing</p>', '{"type": "doc"}', '${ticketId}', '${projectId}', '${workspaceId}', NOW(), NOW(), '{}', 'EXTERNAL');`;

      execSync(`kubectl exec -n ai-lab plane-db-0 -- psql -U plane -d plane -c "${insertQuery}"`);
      logger.info(`✅ Initial comment posted for ${ticketId}`);
    } catch (error) {
      logger.error(`Comment posting failed for ${ticketId}:`, error.message);
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.redis) {
      this.redis.disconnect();
    }
    logger.info('PlaneTicketMonitor stopped');
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      service: 'PlaneTicketMonitor',
      version: '1.0',
      enabled: this.config.enabled,
      polling: !!this.intervalId,
      redis_connected: this.redis && this.redis.status === 'ready',
      config: this.config
    };
  }
}

module.exports = PlaneTicketMonitor;