/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): Plane ticket list/details, hot-swap human-bot ticket chat, ticket state update, root UI route
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: retire hot-swap model execution because it accepted target selection and created Plane/task side effects outside the canonical owner/capability/provider-preflight boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the unreachable retired chat implementation so unsafe prompt interpolation, auto-approval, task creation, and Plane-comment side effects cannot be copied back into service.
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Active ticket list + ticket details from the Plane DB, a stable 410 for the retired hot-swap chat surface, cockpit ticket state updates, and the root (/) UI route. Must be the LAST registration call.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerTicketChatRoutes(application) {
    // GET /api/tickets/active — List active tickets from Plane DB
    application.app.get('/api/tickets/active', async (req, res) => {
      try {
        const qms = application.queueManagerService;
        if (!qms || !qms.planeDb) {
          return res.status(503).json({ error: 'Queue Manager / Plane DB not available' });
        }
        const client = qms.planeDb.createClient();
        await client.connect();
        try {
          const limit = parseInt(req.query.limit) || 50;
          const stateFilter = req.query.state || null; // optional state name filter
          
          let query = `
            SELECT i.id, i.name, i.description_stripped, i.priority, i.sequence_id,
                   i.created_at, i.updated_at,
                   s.name as state_name, s.group as state_group
            FROM issues i
            LEFT JOIN states s ON s.id = i.state_id
            WHERE i.project_id = $1
              AND i.archived_at IS NULL
          `;
          const params = [qms.planeDb.projectId];
          
          if (stateFilter) {
            query += ` AND LOWER(s.name) = LOWER($${params.length + 1})`;
            params.push(stateFilter);
          }
          
          query += ` ORDER BY i.updated_at DESC LIMIT $${params.length + 1}`;
          params.push(limit);
          
          const result = await client.query(query, params);
          
          res.json({
            success: true,
            tickets: result.rows,
            count: result.rows.length,
          });
        } finally {
          await client.end();
        }
      } catch (err) {
        logger.error(`Get active tickets failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/tickets/:id/details — Get ticket + comment history
    application.app.get('/api/tickets/:id/details', async (req, res) => {
      try {
        const qms = application.queueManagerService;
        if (!qms || !qms.planeDb) {
          return res.status(503).json({ error: 'Queue Manager / Plane DB not available' });
        }
        const client = qms.planeDb.createClient();
        await client.connect();
        try {
          const ticketId = req.params.id;
          
          // Get ticket details
          const ticketResult = await client.query(`
            SELECT i.id, i.name, i.description_stripped, i.description_html,
                   i.priority, i.sequence_id, i.created_at, i.updated_at,
                   s.name as state_name, s.group as state_group
            FROM issues i
            LEFT JOIN states s ON s.id = i.state_id
            WHERE i.id = $1
          `, [ticketId]);
          
          if (ticketResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
          }
          
          // Get comments
          const commentsResult = await client.query(`
            SELECT ic.id, ic.comment_stripped, ic.comment_html,
                   ic.created_at, ic.updated_at,
                   u.display_name as author_name, u.avatar as author_avatar
            FROM issue_comments ic
            LEFT JOIN users u ON u.id = ic.actor_id
            WHERE ic.issue_id = $1
            ORDER BY ic.created_at ASC
          `, [ticketId]);
          
          res.json({
            success: true,
            ticket: ticketResult.rows[0],
            comments: commentsResult.rows,
          });
        } finally {
          await client.end();
        }
      } catch (err) {
        logger.error(`Get ticket details failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // POST /api/tickets/:id/chat — retired: callers must use the canonical signed execution path.
    application.app.post('/api/tickets/:id/chat', (_req, res) => {
      res.status(410).json({
        error: 'legacy_execution_route_retired',
        replacement: '/api/swarm-execute',
      });
    });

    // PUT /api/tickets/:ticketId/state — Update ticket status from Cockpit UI
    application.app.put('/api/tickets/:ticketId/state', async (req, res) => {
      try {
        const qms = application.queueManagerService;
        if (!qms || !qms.planeDb) {
          return res.status(503).json({ error: 'Queue Manager / Plane DB not available' });
        }
        const ticketId = req.params.ticketId;
        const { status, projectId: clientProjectId } = req.body;
        logger.info(`PUT /api/tickets/${ticketId}/state — body: ${JSON.stringify(req.body)}`);
        if (!status) {
          return res.status(400).json({ error: 'Missing status in request body', receivedBody: req.body });
        }
        const client = qms.planeDb.createClient();
        await client.connect();
        try {
          // Fetch projectId from ticket if not provided by client
          let projectId = clientProjectId;
          if (!projectId) {
            const ticketQuery = await client.query(
              'SELECT project_id FROM issues WHERE id = $1',
              [ticketId]
            );
            if (ticketQuery.rows.length === 0) {
              return res.status(404).json({ error: 'Ticket not found' });
            }
            projectId = ticketQuery.rows[0].project_id;
          }
          // Update ticket status in Plane DB
          const result = await qms.planeDb.updateTicketStatus(client, ticketId, status, projectId);
          logger.info(`Ticket ${ticketId} status updated to ${status}`);
          res.json({ success: true, ticketId, status, result });
        } finally {
          await client.end();
        }
      } catch (err) {
        logger.error(`Update ticket status failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // Serve UI (index at root)
    application.app.get('/', (req, res) => {
      res.sendFile(path.join(SERVER_ROOT, '../ui-enhanced/index.html'));
    });
}

module.exports = { registerTicketChatRoutes };
