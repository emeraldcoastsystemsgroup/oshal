/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentResponseMonitor - Monitors agent completion and routes back to team
 * Watches for agent completion comments and validates work
 */

const { Client } = require('pg');
const logger = require('../../utils/logger');

class AgentResponseMonitor {
  /**
   * @description Initializes the monitor with its database configuration and the
   * agent registry it consults, and seeds an in-memory set used to de-duplicate
   * already-handled completion comments so the same completion is not processed twice.
   * @param {Object} dbConfig - PostgreSQL connection configuration.
   * @param {Object} agentRegistry - Registry of known agents used to validate and
   * track agent load during completion routing.
   */
  constructor(dbConfig, agentRegistry) {
    this.dbConfig = dbConfig;
    this.agentRegistry = agentRegistry;
    this.processedComments = new Set(); // Track processed comments
  }

  /**
   * Monitor tickets in "Routing" or "In Progress" for agent completion
   * @param {Object} client - PostgreSQL client
   * @param {string} workspaceId - Workspace ID
   * @returns {Promise<Object[]>} Tickets with agent completion
   */
  async monitorAgentCompletions(client, workspaceId) {
    try {
      // Find tickets in Routing or In Progress with agent completion comments
      const query = `
        SELECT DISTINCT 
          i.id, i.name, i.project_id, i.workspace_id, 
          s.name as status,
          c.id as comment_id,
          c.comment_stripped as comment_text,
          c.created_at as comment_date
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        LEFT JOIN issue_comments c ON c.issue_id = i.id
        WHERE (s.name = 'Routing' OR s.name = 'In Progress')
        AND i.workspace_id = $1
        AND i.deleted_at IS NULL
        AND c.comment_stripped LIKE '%@queue-manager%'
        AND c.comment_stripped LIKE '%STATUS: completed%'
        ORDER BY c.created_at DESC
      `;

      const result = await client.query(query, [workspaceId]);
      return result.rows;

    } catch (error) {
      logger.error('Monitor agent completions failed:', error.message);
      return [];
    }
  }

  /**
   * Process agent completion comment
   * @param {Object} client - PostgreSQL client
   * @param {Object} ticket - Ticket with completion
   * @param {string} commentText - Agent completion comment
   * @returns {Promise<boolean>} Success status
   */
  async processCompletion(client, ticket, commentText) {
    try {
      // Skip if already processed
      if (this.processedComments.has(ticket.comment_id)) {
        return false;
      }

      // Parse agent ID from comment
      const agentIdMatch = commentText.match(/AGENT:\s*(\S+)/i);
      if (!agentIdMatch) {
        logger.warn(`No agent ID found in completion comment for ticket ${ticket.id}`);
        return false;
      }

      const agentId = agentIdMatch[1];
      logger.info(`Processing completion from agent: ${agentId} for ticket: ${ticket.id}`);

      // Extract result/artifacts from comment
      const resultMatch = commentText.match(/RESULT:\s*(.+?)(?=\n|$)/i);
      const result = resultMatch ? resultMatch[1] : 'Work completed';

      // Update ticket status to Agent Review
      await this.updateTicketStatus(client, ticket.id, 'Agent Review', ticket.project_id);

      // Post validation comment
      const validationComment = `🤖 **Queue Manager: Work Validated**

Agent **${agentId}** has completed their work on this ticket.

**Result:** ${result}

**Status Update:** Routing → Agent Review

The work is now ready for human review. If approved, the ticket can be moved to "Done". If changes are needed, please comment with instructions and the agent can make updates.

---
*Queue Manager v1.0 - Agent Coordination*`;

      await this.postComment(client, ticket, validationComment);

      // Decrement agent load
