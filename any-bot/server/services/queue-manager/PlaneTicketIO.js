/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): Plane DB ticket I/O — task-id linkage (DB + Redis fallback), status updates, comment posting with ProseMirror conversion, and assignee writes
 */

/**
 * PlaneTicketIO — Plane database read/write helpers of the queue manager.
 *
 * Extracted verbatim from QueueManagerService for the 1000-code-line cap.
 * Every method is static and takes the live QueueManagerService instance
 * (`svc`) as its first argument — `svc` carries all state and collaborators
 * (redis, planeDb, phaseManager, commentFormatter, ...) exactly as `this` did
 * before extraction. QueueManagerService keeps same-named delegate methods, so
 * the public API and behavior (including dynamic dispatch through the class)
 * are unchanged.
 */

const logger = require('../../utils/logger');
const { getQueueManagerUserId } = require('./AgentPlaneUserMap');

/**
 * @description Plane database read/write helpers of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class PlaneTicketIO {
  /**
   * Get task ID for ticket (from Plane metadata)
   * Gracefully handles missing task_id column — uses Redis fallback
   */
  static async getTicketTaskId(svc, client, ticketId) {
    // Try Plane DB column first
    try {
      const query = `SELECT task_id FROM issues WHERE id = $1`;
      const result = await client.query(query, [ticketId]);
      if (result.rows[0]?.task_id) {
        return result.rows[0].task_id;
      }
    } catch (error) {
      // Column likely doesn't exist — suppress noisy log, use Redis fallback
      if (error.message.includes('task_id') || error.message.includes('column')) {
        logger.debug(`task_id column not available in Plane DB, using Redis fallback for ticket ${ticketId}`);
      } else {
        logger.warn(`DB error getting task_id for ${ticketId}: ${error.message}`);
      }
    }

    // Redis fallback: store task_id mapping in Redis
    try {
      const key = `qm:ticket_task:${ticketId}`;
      const taskId = await svc.redis.get(key);
      return taskId || null;
    } catch (redisErr) {
      logger.debug(`Redis fallback failed for task_id lookup: ${redisErr.message}`);
      return null;
    }
  }

  /**
   * Store task ID in ticket metadata
   * Gracefully handles missing task_id column — uses Redis fallback
   */
  static async setTicketTaskId(svc, client, ticketId, taskId) {
    // Try Plane DB column first
    try {
      const query = `UPDATE issues SET task_id = $1 WHERE id = $2`;
      const result = await client.query(query, [taskId, ticketId]);
      if (result.rowCount === 1) {
        logger.info(`✓ Task ${taskId} linked to ticket ${ticketId} (DB)`);
        // Also store in Redis as backup
        try {
          await svc.redis.set(`qm:ticket_task:${ticketId}`, taskId, 'EX', 86400); // 24h TTL
        } catch (e) { /* best effort */ }
        return true;
      }
    } catch (error) {
      if (error.message.includes('task_id') || error.message.includes('column')) {
        logger.debug(`task_id column not available in Plane DB, using Redis for ticket ${ticketId}`);
      } else {
        logger.warn(`DB error setting task_id for ${ticketId}: ${error.message}`);
      }
    }

    // Redis fallback
    try {
      await svc.redis.set(`qm:ticket_task:${ticketId}`, taskId, 'EX', 86400); // 24h TTL
      logger.info(`✓ Task ${taskId} linked to ticket ${ticketId} (Redis fallback)`);
      return true;
    } catch (redisErr) {
      logger.error(`Failed to set task_id via Redis for ${ticketId}: ${redisErr.message}`);
      return false;
    }
  }

  /**
   * Update ticket status in Plane
   */
  static async updateTicketStatus(svc, client, ticketId, statusName, projectId) {
    try {
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
        return true;
      } else {
        logger.warn(`Status update failed for ${ticketId} (state '${statusName}' may not exist)`);
        return false;
      }
    } catch (error) {
      logger.error(`Status update error:`, error.message);
      return false;
    }
  }

  /**
   * Post comment to ticket
   * @param {Client} client - DB client
   * @param {Object} ticket - Ticket object with id, project_id, workspace_id
   * @param {string} comment - Comment text
   * @param {string|null} actorUserId - Plane user UUID for comment attribution (bot or human).
   *                                     Falls back to queue-manager bot user, then first DB user.
   */
  static async postComment(svc, client, ticket, comment, actorUserId = null) {
    try {
      // PHASE_26 FIX 3: Cap comment size to prevent Plane DB bloat and E2BIG on subsequent reads
      // Agent responses can be 50-90KB; Plane comments should be max 5KB for readability
      // Full response is preserved in workspace files — the comment is just the executive summary
      const COMMENT_MAX_CHARS = 5000;
      let cappedComment = comment;
      if (comment && comment.length > COMMENT_MAX_CHARS) {
        // Preserve the first 5KB (executive summary) and add truncation notice
        cappedComment = comment.substring(0, COMMENT_MAX_CHARS) + 
          `\n\n---\n📎 **Comment truncated** (${comment.length} chars → ${COMMENT_MAX_CHARS}). Full response preserved in workspace files.\n*PHASE_26: Comment size cap to prevent ticket bloat*`;
        logger.info(`📎 PHASE_26 FIX 3: Comment truncated from ${comment.length} to ${COMMENT_MAX_CHARS} chars for ticket ${ticket.id}`);
      }

      // Resolve user ID for attribution: explicit > queue-manager bot > first user in DB
      let userId = actorUserId || getQueueManagerUserId();
      if (!userId) {
        const userQuery = `SELECT id FROM users LIMIT 1`;
        const userResult = await client.query(userQuery);
        userId = userResult.rows[0]?.id || null;
      }

      const query = `
        INSERT INTO issue_comments (
          id, comment_stripped, comment_html, comment_json, 
          issue_id, project_id, workspace_id, 
          created_by_id, updated_by_id, actor_id,
          created_at, updated_at, attachments, access
        ) VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4, $5, $6,
          $7, $7, $7,
          NOW(), NOW(), '{}', 'INTERNAL'
        )
      `;

      const commentHtml = svc.commentFormatter.toPlaneHtml(comment);
      const commentJson = svc._markdownToPlaneJson(comment);

      const result = await client.query(query, [
        comment, 
        commentHtml, 
        JSON.stringify(commentJson),
        ticket.id, 
        ticket.project_id, 
        ticket.workspace_id,
        userId
      ]);

      if (result.rowCount === 1) {
        logger.info(`✓ Comment posted to ticket: ${ticket.id}`);
        return true;
      } else {
        logger.warn(`Comment posting failed for ${ticket.id}`);
        return false;
      }
    } catch (error) {
      logger.error(`Comment posting error:`, error.message);
      return false;
    }
  }

  /**
   * Convert markdown to Plane's ProseMirror JSON format for comment_json
   * @private
   */
  static _markdownToPlaneJson(svc, markdown) {
    if (!markdown) return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] };
    const content = [];
    const paragraphs = markdown.split(/\n\n+/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      content.push({ type: 'paragraph', content: [{ type: 'text', text: trimmed }] });
    }
    if (content.length === 0) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: markdown }] });
    }
    return { type: 'doc', content };
  }

  /**
   * Assign a ticket to a Plane bot user (sets the assignees array)
   * Uses Plane's issue_assignees junction table
   * @param {Client} client - DB client
   * @param {string} ticketId - Issue UUID
   * @param {string} planeUserId - Plane user UUID to assign
   */
  static async assignTicketToAgent(svc, client, ticketId, planeUserId) {
    try {
      // Plane uses an issue_assignees junction table with project_id + workspace_id required
      // First get the ticket's project_id and workspace_id
      const ticketQuery = `SELECT project_id, workspace_id FROM issues WHERE id = $1`;
      const ticketResult = await client.query(ticketQuery, [ticketId]);
      if (ticketResult.rows.length === 0) {
        logger.warn(`Cannot assign ticket ${ticketId}: ticket not found`);
        return false;
      }
      const { project_id, workspace_id } = ticketResult.rows[0];

      try {
        const query = `
          INSERT INTO issue_assignees (id, issue_id, assignee_id, project_id, workspace_id, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
          ON CONFLICT DO NOTHING
        `;
        await client.query(query, [ticketId, planeUserId, project_id, workspace_id]);
        logger.info(`✓ Ticket ${ticketId} assigned to Plane user ${planeUserId} (junction table)`);
        return true;
      } catch (junctionErr) {
        logger.warn(`issue_assignees INSERT failed for ${ticketId}: ${junctionErr.message}`);
        return false;
      }
    } catch (error) {
      logger.error(`Failed to assign ticket ${ticketId}: ${error.message}`);
      return false;
    }
  }
}

module.exports = PlaneTicketIO;
