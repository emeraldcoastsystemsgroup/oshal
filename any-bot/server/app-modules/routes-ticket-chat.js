/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): Plane ticket list/details, hot-swap human-bot ticket chat, ticket state update, root UI route
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

/**
 * @description Active ticket list + ticket details from the Plane DB, the hot-swap human-to-bot ticket chat (posts both sides as Plane comments), cockpit ticket state updates, and the root (/) UI route. Must be the LAST registration call.
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

    // POST /api/tickets/:id/chat — Send human message, dispatch to assigned bot, log to Plane
    application.app.post('/api/tickets/:id/chat', async (req, res) => {
      try {
        const qms = application.queueManagerService;
        if (!qms || !qms.planeDb) {
          return res.status(503).json({ error: 'Queue Manager / Plane DB not available' });
        }
        
        const ticketId = req.params.id;
        const { message, targetAgent } = req.body;
        
        if (!message) {
          return res.status(400).json({ error: 'Message is required' });
        }
        
        const client = qms.planeDb.createClient();
        await client.connect();
        try {
          // Get ticket info
          const ticketResult = await client.query(
            'SELECT id, name, description_stripped FROM issues WHERE id = $1',
            [ticketId]
          );
          if (ticketResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
          }
          const ticket = ticketResult.rows[0];
          
          // Log human message as a Plane comment
          const humanComment = `**🧑 Human (Hot-Swap Chat):**\n\n${message}`;
          await qms.planeDb.postComment(client, { id: ticketId }, humanComment);
          logger.info(`💬 Human chat message logged to ticket ${ticketId}`);
          
          // Get recent comments for context
          const recentComments = await qms.planeDb.getRecentComments(client, ticketId, 10);
          
          // Find target agent — use specified or pick first available
          let agentId = targetAgent;
          if (!agentId) {
            const agents = await qms.agentRegistry.getAll();
            if (agents.length > 0) {
              // Prefer the project-manager or first idle agent
              const pm = agents.find(a => a.agent_id === 'swarm-project-manager');
              agentId = pm ? pm.agent_id : agents[0].agent_id;
            }
          }
          
          if (!agentId) {
            // Fallback: process locally
            agentId = 'local';
          }
          
          // Build prompt with ticket context + human instruction
          const previousWork = recentComments.length > 0
            ? `\n\n## Previous Comments (most recent):\n${recentComments.join('\n---\n')}`
            : '';
          
          const prompt = `You are agent ${agentId}. A human is having a live with you about this ticket.

**Ticket: ${ticket.name}**
${ticket.description_stripped || 'No description'}
${previousWork}

**Human says:** ${message}

Respond helpfully and concisely. If the human gives you instructions, follow them. If they ask a question, answer it. Your response will be posted as a comment on this ticket.

Use attempt_completion with your response.`;
          
          // Process via TaskController (same as process-ticket but for chat)
          // Apply 120s timeout to prevent infinite processing
          // Force cline-cli provider for chat — do NOT use direct Bedrock API
          const task = await application.taskController.createTask(
            `Chat: ${agentId} on ticket ${ticket.name}`, 'act'
          );
          
          const result = await Promise.race([
            application.taskController.processMessage(task.id, {
              text: prompt
            }, { agenticMode: true, source: 'dashboard', autoApprove: { 'use_mcp_tool': true } }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Chat processing timeout (120s)')), 120000)
            )
          ]);
          
          // Extract response
          let botResponse = 'I processed your message but could not generate a response.';
          if (result.messages && result.messages.length > 0) {
            const completionMsg = result.messages.find(msg =>
              msg.say === 'completion_result' && msg.text && msg.text.length > 20
            );
            if (completionMsg) {
              botResponse = completionMsg.text;
            } else {
              const textMsgs = result.messages.filter(msg =>
                msg.say === 'text' && msg.text && msg.text.length > 20
              );
              if (textMsgs.length > 0) {
                botResponse = textMsgs.map(m => m.text).join('\n\n');
              }
            }
          }
          
          // Log bot response as Plane comment
          const botComment = `**🤖 ${agentId} (Hot-Swap Chat):**\n\n${botResponse}`;
          await qms.planeDb.postComment(client, { id: ticketId }, botComment);
          logger.info(`🤖 Bot chat response logged to ticket ${ticketId} (${botResponse.length} chars)`);
          
          res.json({
            success: true,
            ticketId,
            agentId,
            humanMessage: message,
            botResponse,
          });
        } finally {
          await client.end();
        }
      } catch (err) {
        logger.error(`Ticket chat failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
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
