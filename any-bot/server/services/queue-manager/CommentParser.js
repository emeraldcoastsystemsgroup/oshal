/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CommentParser - Parse structured comments from agents for coordination
 * Detects re-route requests, status updates, and other agent-to-agent communication
 */

const logger = require('../../utils/logger');

/**
 * @description Centralizes interpretation of the free-form comment text agents
 * leave on tickets so the queue manager can coordinate hand-offs without a
 * structured side channel. By understanding the comment conventions (mentions,
 * re-route requests, status updates, completion markers) in one place, the rest
 * of the system can react to agent-to-agent intent rather than re-parse raw text.
 */
class CommentParser {
  /**
   * Parse a comment to detect if it's a re-route request
   * @param {string} comment - Comment text from ticket
   * @returns {Object|null} Parsed re-route request or null
   */
  parseRerouteRequest(comment) {
    if (!comment || typeof comment !== 'string') {
      return null;
    }

    // Check if comment contains @queue-manager REQUEST
    if (!comment.includes('@queue-manager') || !comment.includes('REQUEST')) {
      return null;
    }

    try {
      // Extract key information using regex patterns
      const routeToMatch = comment.match(/route\s+to\s+@?agent:?([a-z0-9-]+)/i);
      const workspaceMatch = comment.match(/WORKSPACE:\s*([a-z0-9-]+)/i);
      const projectMatch = comment.match(/PROJECT:\s*([a-z0-9-]+)/i);
      const completedMatch = comment.match(/COMPLETED:\s*([^\n]+)/i);
      const remainingMatch = comment.match(/REMAINING:\s*([^\n]+)/i);
      const reasonMatch = comment.match(/REASON:\s*([^\n]+)/i);

      if (!routeToMatch) {
        logger.warn('Re-route request found but missing target agent');
        return null;
      }

      const request = {
        type: 'REROUTE_REQUEST',
        target_agent: routeToMatch[1],
        workspace_id: workspaceMatch ? workspaceMatch[1] : null,
        project_id: projectMatch ? projectMatch[1] : null,
        completed_work: completedMatch ? completedMatch[1].trim() : 'Previous agent completed their portion',
        remaining_work: remainingMatch ? remainingMatch[1].trim() : 'Additional work needed',
        reason: reasonMatch ? reasonMatch[1].trim() : 'Need specialist assistance',
        timestamp: new Date().toISOString()
      };

      logger.info(`✓ Parsed re-route request: ${request.target_agent} (workspace: ${request.workspace_id})`);
      return request;

    } catch (error) {
      logger.error(`Failed to parse re-route request: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse agent status update comment
   * @param {string} comment - Comment text
   * @returns {Object|null} Status update or null
   */
  parseStatusUpdate(comment) {
    if (!comment || typeof comment !== 'string') {
      return null;
    }

    // Check for status update markers
    const statusMatch = comment.match(/STATUS:\s*(in-progress|complete|blocked|testing)/i);
    const agentMatch = comment.match(/AGENT:\s*([a-z0-9-]+)/i);
    const progressMatch = comment.match(/PROGRESS:\s*(\d+)%/i);

    if (!statusMatch) {
      return null;
    }

    return {
      type: 'STATUS_UPDATE',
      agent_id: agentMatch ? agentMatch[1] : null,
      status: statusMatch[1].toLowerCase(),
      progress: progressMatch ? parseInt(progressMatch[1], 10) : null,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Check if comment is from Queue Manager
   * @param {string} comment - Comment text
   * @returns {boolean} True if from Queue Manager
   */
  isQueueManagerComment(comment) {
    return comment && comment.includes('Queue Manager');
  }

  /**
   * Check if comment is an agent completion
   * @param {string} comment - Comment text
   * @returns {boolean} True if agent completion
   */
  isAgentCompletion(comment) {
    return comment && (
      comment.includes('Agent Completed Work') ||
      comment.includes('✅') ||
      comment.includes('STATUS: completed')
    );
  }

  /**
   * Extract agent ID from mention
   * @param {string} comment - Comment text
   * @returns {string|null} Agent ID or null
   */
  extractAgentMention(comment) {
    if (!comment) return null;

    const match = comment.match(/@agent:([a-z0-9-]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Parse ticket comments to find latest agent activity
   * @param {Object[]} comments - Array of comment objects
   * @returns {Object} Summary of agent activity
   */
  analyzeTicketComments(comments) {
    const activity = {
      agents_involved: new Set(),
      reroute_requests: [],
      status_updates: [],
      completed_work: [],
      latest_agent: null
    };

    if (!comments || !Array.isArray(comments)) {
      return activity;
    }

    for (const comment of comments) {
      const text = comment.comment_stripped || comment.comment || '';

      // Check for re-route request
      const rerouteReq = this.parseRerouteRequest(text);
      if (rerouteReq) {
        activity.reroute_requests.push({
          ...rerouteReq,
          comment_id: comment.id,
          created_at: comment.created_at
        });
      }

      // Check for status update
      const statusUpdate = this.parseStatusUpdate(text);
      if (statusUpdate) {
        activity.status_updates.push({
          ...statusUpdate,
          comment_id: comment.id,
          created_at: comment.created_at
        });
      }

      // Extract agent mentions
      const agentId = this.extractAgentMention(text);
      if (agentId) {
        activity.agents_involved.add(agentId);
        activity.latest_agent = agentId;
      }

      // Check for completion
      if (this.isAgentCompletion(text)) {
        activity.completed_work.push({
          agent_id: agentId,
          comment: text.substring(0, 200),
          created_at: comment.created_at
        });
      }
    }

    activity.agents_involved = Array.from(activity.agents_involved);

    return activity;
  }

  /**
   * Validate re-route request has required fields
   * @param {Object} request - Parsed re-route request
   * @returns {boolean} True if valid
   */
  validateRerouteRequest(request) {
    if (!request || request.type !== 'REROUTE_REQUEST') {
      return false;
    }

    // Must have target agent
    if (!request.target_agent) {
      logger.warn('Invalid re-route: missing target_agent');
      return false;
    }

    // Must have workspace context
    if (!request.workspace_id) {
      logger.warn('Invalid re-route: missing workspace_id');
      return false;
    }

    return true;
  }
}

module.exports = CommentParser;