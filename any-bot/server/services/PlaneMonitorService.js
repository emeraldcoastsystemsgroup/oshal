/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PlaneMonitorService v2.3 - Response Extraction Fixed
 * Proper status workflow: TODO → IN PROGRESS → Customer Action
 * Direct database integration with internal Plane
 * Direct TaskController calls + proper attempt_completion extraction
 */

const { Client } = require('pg');
const logger = require('../utils/logger');

/**
 * @description Legacy direct-processing bridge between an internal Plane project
 * tracker and the bot's TaskController. It polls the Plane Postgres database for
 * Todo tickets, drives each one through a TODO -> IN PROGRESS -> Customer Action
 * status workflow, runs the work through the LLM agent, and writes results back
 * as ticket comments. It exists for deployments that do not run the QueueManager;
 * when the QueueManager is enabled it intentionally stands down so the single
 * queue owner can apply routing, locking, and collaboration safeguards.
 */
class PlaneMonitorServiceFixed {
  /**
   * @description Wires the service to its TaskController and resolves all runtime
   * settings (polling, workspace, database connection) from environment variables
   * so the same code can run in both Kubernetes and Docker Compose without changes.
   * @param {object} taskController - Controller used to create and process agent tasks for each ticket.
   * @param {object} [config={}] - Optional overrides reserved for future configuration; defaults come from environment variables.
   */
  constructor(taskController, config = {}) {
    this.taskController = taskController;
    this.config = {
      enabled: process.env.ENABLE_PLANE_MONITORING === 'true',
      pollInterval: parseInt(process.env.PLANE_POLL_INTERVAL || '60000'),
      workspaceSlug: process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-01',
      assigneeId: process.env.PLANE_USER_ID || 'admin',
      monitorStates: ['Todo', 'In Progress'], // Monitor TODO and IN PROGRESS
      chatApiUrl: process.env.CHAT_API_URL || 'http://localhost:5000'
    };

    // Database connection to Plane (works in both K8s and Docker Compose)
    this.dbConfig = {
      host: process.env.PLANE_DB_HOST || 'plane-plane-db-1',
      port: parseInt(process.env.PLANE_DB_PORT || '5432'),
      database: process.env.PLANE_DB_NAME || 'plane',
      user: process.env.PLANE_DB_USER || 'plane',
      password: process.env.PLANE_DB_PASSWORD || 'plane',
    };

    this.intervalId = null;
    this.trackedItems = new Map();
    
    logger.info('PlaneMonitorServiceFixed v2.3 initialized', {
      enabled: this.config.enabled,
      pollInterval: this.config.pollInterval,
      assigneeId: this.config.assigneeId
    });
  }

  /**
   * Start the monitoring service
   */
  async start() {
    if (!this.config.enabled) {
      logger.info('PlaneMonitorService disabled via ENABLE_PLANE_MONITORING=false');
      return;
    }

    // CRITICAL: When QueueManager is active, PlaneMonitorService must NOT process tickets
    // QueueManager is the single queue owner with intelligent routing, cooldown, locking, etc.
    // PlaneMonitorService is the legacy direct-processing path (no routing, no collaboration)
    if (process.env.ENABLE_QUEUE_MANAGER === 'true') {
      logger.info('⚠️ PlaneMonitorService DISABLED: QueueManager owns the Todo queue (ENABLE_QUEUE_MANAGER=true)');
      logger.info('   → QueueManager provides: intelligent routing, task locking, cooldown, multi-agent collaboration');
      logger.info('   → PlaneMonitorService would bypass all of these safeguards');
      return;
    }

    try {
      logger.info('Starting PlaneMonitorService v2.3...');
      
      // Test database connection
      await this.testDatabaseConnection();
      
      // Start polling
      await this.poll(); // Initial poll
      this.intervalId = setInterval(() => {
        this.poll().catch(err => {
          logger.error('Polling error:', err.message);
        });
      }, this.config.pollInterval);

      logger.info('✓ PlaneMonitorService v2.3 started successfully');
    } catch (error) {
      logger.error('Failed to start PlaneMonitorService:', error.message);
      throw error;
    }
  }

  /**
   * Test database connection
   */
  async testDatabaseConnection() {
    const client = new Client(this.dbConfig);
    try {
      await client.connect();
      const result = await client.query('SELECT COUNT(*) FROM issues');
      logger.info('✓ Database connection successful, found', result.rows[0].count, 'total issues');
      await client.end();
    } catch (error) {
      logger.error('Database connection failed:', error.message);
      throw error;
    }
  }

  /**
   * Poll for tickets to process
   */
  async poll() {
    logger.info('Polling for TODO tickets...');
    
    const client = new Client(this.dbConfig);
    try {
      await client.connect();

      // Find TODO tickets in the configured workspace
      const query = `
        SELECT i.id, i.name, i.description, i.project_id, i.workspace_id, s.name as status
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id  
        WHERE s.name = 'Todo'
        AND i.workspace_id = $1
        AND i.deleted_at IS NULL
        ORDER BY i.created_at DESC
        LIMIT 10
      `;

      // Get workspace ID from environment or use devopscloud-00
      const workspaceQuery = `SELECT id FROM workspaces WHERE slug = $1 LIMIT 1`;
      const workspaceResult = await client.query(workspaceQuery, [this.config.workspaceSlug]);
      
      if (workspaceResult.rows.length === 0) {
        logger.warn(`Workspace ${this.config.workspaceSlug} not found`);
        await client.end();
        return;
      }
      
      const workspaceId = workspaceResult.rows[0].id;
      const result = await client.query(query, [workspaceId]);
      const tickets = result.rows;

      logger.info(`Found ${tickets.length} TODO tickets to process`);

      for (const ticket of tickets) {
        if (!this.trackedItems.has(ticket.id)) {
          logger.info(`Processing new ticket: ${ticket.id} - ${ticket.name}`);
          await this.processTicket(client, ticket);
        }
      }

      await client.end();
    } catch (error) {
      logger.error('Polling failed:', error.message);
      if (client) {
        await client.end().catch(() => {}); // Cleanup on error
      }
    }
  }

  /**
   * Process a ticket with proper status workflow
   */
  async processTicket(client, ticket) {
    try {
      // STEP 1: Update status to IN PROGRESS
      await this.updateTicketStatus(client, ticket.id, 'In Progress');
      
      // STEP 2: Post "started processing" comment
      const startComment = `🤖 **Started Processing** (PlaneMonitorService v2.3)

I've picked up your ticket and am starting to work on it.
**Status updated:** TODO → IN PROGRESS

**Working on:** ${ticket.name}

I'll have a response ready shortly!

*PlaneMonitorService v2.3 - Full LLM Integration*`;

      await this.postComment(client, ticket, startComment);
      
      // Track this ticket
      this.trackedItems.set(ticket.id, {
        id: ticket.id,
        name: ticket.name,
        status: 'processing',
        startedAt: new Date()
      });

      // STEP 3: Generate response (simulate processing)
      const response = await this.generateBotResponse(ticket);

      // STEP 4: Update status to Customer Action (awaiting user review)
      await this.updateTicketStatus(client, ticket.id, 'Customer Action');

      // STEP 5: Post completion response
      await this.postComment(client, ticket, response);

      // STEP 6: Send to chat UI
      await this.sendToChatUI(ticket, response);

      // Update tracking
      this.trackedItems.set(ticket.id, {
        ...this.trackedItems.get(ticket.id),
        status: 'completed',
        completedAt: new Date()
      });

      logger.info(`✓ Ticket processing complete: ${ticket.id}`);

    } catch (error) {
      logger.error(`Failed to process ticket ${ticket.id}:`, error.message);
    }
  }

  /**
   * Update ticket status in database
   */
  async updateTicketStatus(client, ticketId, statusName) {
    try {
      // Get project_id for this ticket first
      const projectQuery = `SELECT project_id FROM issues WHERE id = $1`;
      const projectResult = await client.query(projectQuery, [ticketId]);
      
      if (projectResult.rows.length === 0) {
        logger.warn(`Ticket ${ticketId} not found`);
        return;
      }
      
      const projectId = projectResult.rows[0].project_id;
      
      // Update with project-scoped state
      const query = `
        UPDATE issues 
        SET state_id = (
          SELECT id FROM states 
          WHERE name = $1 AND project_id = $2 
          LIMIT 1
        ),
        updated_at = NOW()
        WHERE id = $3
      `;
      const result = await client.query(query, [statusName, projectId, ticketId]);
      
      if (result.rowCount === 1) {
        logger.info(`✓ Status updated: ${ticketId} → ${statusName}`);
      } else {
        logger.warn(`Status update failed for ${ticketId} (state '${statusName}' may not exist in project)`);
      }
    } catch (error) {
      logger.error(`Status update error:`, error.message);
    }
  }

  /**
   * Post comment to ticket
   */
  async postComment(client, ticket, comment) {
    try {
      const query = `
        INSERT INTO issue_comments (
          id, comment_stripped, comment_html, comment_json, 
          issue_id, project_id, workspace_id, 
          created_at, updated_at, attachments, access
        ) VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4, $5, $6,
          NOW(), NOW(), '{}', 'EXTERNAL'
        )
      `;

      const commentHtml = `<p>${comment.replace(/\n/g, '</p><p>')}</p>`;
      const commentJson = {
        type: "doc",
        content: [{
          type: "paragraph", 
          content: [{type: "text", text: comment}]
        }]
      };

      const result = await client.query(query, [
        comment, commentHtml, JSON.stringify(commentJson),
        ticket.id, ticket.project_id, ticket.workspace_id
      ]);

      if (result.rowCount === 1) {
        logger.info(`✓ Comment posted to ticket: ${ticket.id}`);
      } else {
        logger.warn(`Comment posting failed for ${ticket.id}`);
      }
    } catch (error) {
      logger.error(`Comment posting error:`, error.message);
    }
  }

  /**
   * Generate bot response by calling TaskController directly (v2.2 - FIXED)
   * No more HTTP self-calls - direct method invocation for reliability
   */
  async generateBotResponse(ticket) {
    try {
      // Extract ticket description text
      let descriptionText = 'No description provided';
      try {
        if (ticket.description && typeof ticket.description === 'object') {
          const desc = ticket.description.content?.[0]?.content?.[0]?.text;
          descriptionText = desc || JSON.stringify(ticket.description);
        }
      } catch (e) {
        // Use ticket name if description parse fails
        descriptionText = ticket.name;
      }

      // IMPORTANT: Instruct bot to update Plane ticket via MCP when done
      const taskPrompt = `Plane Ticket: ${ticket.name}

${descriptionText}

IMPORTANT INSTRUCTIONS:
1. Process this ticket and provide your response
2. When complete, use plane-mcp tools to post your response as a comment to Plane ticket ID: ${ticket.id}
3. Use plane-mcp update_issue or create_comment tool with:
   - Ticket ID: ${ticket.id}
   - Project ID: ${ticket.project_id}
   - Workspace ID: ${ticket.workspace_id}
4. ALWAYS post to Plane via MCP before marking complete`;

      // Create task via TaskController (direct method call - no HTTP)
      const task = await this.taskController.createTask(taskPrompt, 'act');
      logger.info(`✓ Task created for Plane ticket ${ticket.id}: ${task.id}`);

      // Process message with LLM (direct method call)
      const result = await this.taskController.processMessage(task.id, {
        text: taskPrompt
      }, {
        agenticMode: true,  // Enable autonomous tool execution
        autoApprove: {
          // Auto-approve plane-mcp tools for posting back to Plane
          'use_mcp_tool': true
        }
      });

      // Extract response text from messages (prioritize completion_result)
      let botResponse = 'Bot processed your request.';
      if (result.messages && result.messages.length > 0) {
        // First, look for attempt_completion result (most accurate)
        const completionMsg = result.messages.find(msg => msg.say === 'completion_result' && msg.text);
        if (completionMsg) {
          botResponse = completionMsg.text;
        } else {
          // Fallback: Find text messages from bot
          const textMessages = result.messages
            .filter(msg => (msg.say === 'text' || msg.say === 'say') && msg.text)
            .filter(msg => !msg.text.includes('IMPORTANT INSTRUCTIONS'));
          
          if (textMessages.length > 0) {
            botResponse = textMessages[textMessages.length - 1].text;
          }
        }
      }

      logger.info(`✓ Bot response generated for ticket ${ticket.id} (${botResponse.length} chars)`);

      // Return response with task ID for tracking
      return `🤖 **Bot Response:**

${botResponse}

---
*Task ID: ${task.id} | Plane Ticket: ${ticket.id}*`;

    } catch (error) {
      logger.error('Failed to generate bot response:', error.message);
      return `⚠️ **Bot Error:**

Failed to process ticket: ${error.message}

Please try again or contact support.`;
    }
  }

  /**
   * Send response to chat UI
   */
  async sendToChatUI(ticket, response) {
    try {
      const http = require('http');
      const postData = JSON.stringify({
        text: `Plane Ticket ${ticket.id}: ${response}`,
        mode: 'act',
        planeIntegration: true
      });

      const req = http.request({
        hostname: 'localhost',
        port: 5000,
        path: '/api/tasks',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        if (res.statusCode === 201) {
          logger.info(`✓ Response sent to chat UI for ticket: ${ticket.id}`);
        } else {
          logger.warn(`Chat UI post failed: ${res.statusCode}`);
        }
      });

      req.on('error', (err) => {
        logger.error('Chat UI error:', err.message);
      });

      req.write(postData);
      req.end();
    } catch (error) {
      logger.error('Send to chat UI failed:', error.message);
    }
  }

  /**
   * Stop the service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('PlaneMonitorService v2.3 stopped');
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      service: 'PlaneMonitorServiceFixed',
      version: '2.3',
      enabled: this.config.enabled,
      polling: !!this.intervalId,
      trackedItems: this.trackedItems.size,
      config: this.config
    };
  }
}

module.exports = PlaneMonitorServiceFixed;