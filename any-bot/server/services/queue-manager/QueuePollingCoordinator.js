/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): roll-call protocol, Redis task locks/cooldowns, stalled-task recovery, Todo-queue polling (single + multi workspace), and reroute/completion detection
 */

/**
 * QueuePollingCoordinator — queue polling + recovery loop of the queue manager.
 *
 * Extracted verbatim from QueueManagerService for the 1000-code-line cap.
 * Every method is static and takes the live QueueManagerService instance
 * (`svc`) as its first argument — `svc` carries all state and collaborators
 * (redis, planeDb, phaseManager, commentFormatter, ...) exactly as `this` did
 * before extraction. QueueManagerService keeps same-named delegate methods, so
 * the public API and behavior (including dynamic dispatch through the class)
 * are unchanged.
 */

const { Client } = require('pg');
const logger = require('../../utils/logger');

/**
 * @description Queue polling + recovery loop of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class QueuePollingCoordinator {
  /**
   * Start roll call protocol - broadcasts every 10 minutes
   * Bots respond with status, QM logs roster summary
   * PHASE_48 Issue #051
   */
  static startRollCallProtocol(svc) {
    logger.info('[QM] Starting roll call protocol (every 10 minutes)');
    
    const rollCallInterval = setInterval(async () => {
      try {
        logger.info('[QM] 📢 Broadcasting roll call...');
        
        // Broadcast roll call
        await svc.redis.publish('swarm:roll-call', JSON.stringify({
          type: 'roll-call',
          timestamp: new Date().toISOString(),
          requestedBy: 'queue-manager',
          responseChannel: 'swarm:roll-call-response'
        }));
        
        // Wait 30 seconds for responses, then log summary
        setTimeout(async () => {
          try {
            const agents = await svc.agentRegistry.getAll();
            const activeCount = agents.filter(a => a.status === 'active' || a.status === 'idle').length;
            logger.info(`[QM] ✅ Roll call complete: ${activeCount}/${agents.length} agents active`);
            
            // Log agent details
            agents.forEach(a => {
              const caps = Array.isArray(a.capabilities) ? a.capabilities.join(', ') : a.capabilities;
              logger.info(`[QM]    - ${a.agent_id}: ${a.status || 'active'} (${caps})`);
            });
            
          } catch (summaryErr) {
            logger.error(`[QM] Roll call summary failed: ${summaryErr.message}`);
          }
        }, 30000);
        
      } catch (err) {
        logger.error(`[QM] Roll call broadcast failed: ${err.message}`);
      }
    }, 10 * 60 * 1000); // Every 10 minutes
    
    // Store interval for cleanup
    svc.rollCallInterval = rollCallInterval;
  }

  /**
   * Acquire task lock (prevents concurrent access by multiple agents)
   * @param {string} taskId - Task ID to lock
   * @param {string} agentId - Agent ID acquiring the lock
   * @returns {boolean} - true if lock acquired, false if already locked
   */
  static async acquireTaskLock(svc, taskId, agentId) {
    try {
      const key = `qm:task_lock:${taskId}`;
      const lockTTL = 3600; // 1 hour expiration
      const acquired = await svc.redis.set(key, agentId, 'NX', 'EX', lockTTL);
      
      if (acquired === 'OK') {
        logger.info(`✓ Task lock acquired: ${taskId} by ${agentId} (TTL: ${lockTTL}s)`);
        return true;
      } else {
        const owner = await svc.redis.get(key);
        logger.warn(`✗ Task lock failed: ${taskId} already locked by ${owner}`);
        return false;
      }
    } catch (error) {
      logger.error(`Failed to acquire task lock for ${taskId}:`, error.message);
      return false;
    }
  }

  /**
   * Release task lock
   * @param {string} taskId - Task ID to unlock
   * @returns {boolean} - true if released, false if error
   */
  static async releaseTaskLock(svc, taskId) {
    try {
      const key = `qm:task_lock:${taskId}`;
      await svc.redis.del(key);
      logger.info(`✓ Task lock released: ${taskId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to release task lock for ${taskId}:`, error.message);
      return false;
    }
  }

  /**
   * Check task lock ownership
   * @param {string} taskId - Task ID to check
   * @returns {string|null} - Agent ID that owns the lock, or null if not locked
   */
  static async checkTaskLock(svc, taskId) {
    try {
      const key = `qm:task_lock:${taskId}`;
      const owner = await svc.redis.get(key);
      return owner;
    } catch (error) {
      logger.error(`Failed to check task lock for ${taskId}:`, error.message);
      return null;
    }
  }

  /**
   * Get last processed info from Redis
   */
  static async getLastProcessed(svc, ticketId) {
    try {
      const key = `qm:processed:${ticketId}`;
      const data = await svc.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error(`Failed to get last processed for ticket ${ticketId}:`, error.message);
      return null;
    }
  }

  /**
   * Mark ticket as processed in Redis
   * @param {object} ticket - Ticket object
   * @param {string} agentId - Agent ID
   * @param {string} complexity - Ticket complexity from CapabilityMatcher (low/medium/high)
   */
  static async setProcessed(svc, ticket, agentId, complexity = 'medium') {
    try {
      const key = `qm:processed:${ticket.id}`;
      const data = {
        ticket_id: ticket.id,
        workspace_id: ticket.workspace_id,
        agent_id: agentId,
        processed_at: Date.now(),
        complexity: complexity
      };
      // Store with 1 hour TTL
      await svc.redis.set(key, JSON.stringify(data), 'EX', 3600);
      logger.debug(`Marked ticket ${ticket.id} as processed by ${agentId} (complexity: ${complexity})`);
    } catch (error) {
      logger.error(`Failed to set processed for ticket ${ticket.id}:`, error.message);
    }
  }

  /**
   * Get dynamic cooldown based on ticket complexity (Enhancement E12)
   * Low complexity: 60s, Medium: 180s, High: 300s
   * @param {string} complexity - 'low', 'medium', or 'high'
   * @returns {number} Cooldown in milliseconds
   */
  static getDynamicCooldown(svc, complexity) {
    const cooldowns = {
      low: 60000,     // 1 minute — simple questions, quick answers
      medium: 180000, // 3 minutes — moderate tasks
      high: 300000    // 5 minutes — complex multi-step work
    };
    return cooldowns[complexity] || svc.cooldownMs;
  }

  /**
   * Check for new activity since timestamp
   * FIX 4: Filter out QM's own comments so they don't bypass cooldown
   */
  static async hasNewActivity(svc, client, ticketId, sinceTimestamp) {
    try {
      const query = `
        SELECT COUNT(*) as count
        FROM issue_comments
        WHERE issue_id = $1
        AND created_at > $2
        AND comment_stripped NOT LIKE '%Queue Manager%'
        AND comment_stripped NOT LIKE '%Ticket Routed%'
        AND comment_stripped NOT LIKE '%Agent Work In Progress%'
        AND comment_stripped NOT LIKE '%Agent Processing Failed%'
        AND comment_stripped NOT LIKE '%Task Locked%'
        AND comment_stripped NOT LIKE '%Queue Manager v1.0%'
      `;
      const result = await client.query(query, [ticketId, new Date(sinceTimestamp)]);
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      logger.error(`Failed to check activity for ticket ${ticketId}:`, error.message);
      return false;
    }
  }

  /**
   * Detect and recover stalled tasks (In Progress >30 minutes)
   */
  static async detectStalledTasks(svc, client) {
    try {
      const stallTimeoutMs = parseInt(process.env.QUEUE_MANAGER_STALL_TIMEOUT || '1800000'); // 30 min default
      
      // Find tickets stuck in In Progress for too long
      const query = `
        SELECT i.id, i.name, i.description, i.project_id, i.workspace_id, 
               i.priority, s.name as status,
               EXTRACT(EPOCH FROM (NOW() - i.updated_at))::int as seconds_stalled
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        WHERE s.name = 'In Progress'
        AND i.deleted_at IS NULL
        AND i.updated_at < NOW() - INTERVAL '${Math.floor(stallTimeoutMs / 1000)} seconds'
        ORDER BY i.updated_at ASC
        LIMIT 20
      `;
      
      const result = await client.query(query);
      const stalledTickets = result.rows;
      
      if (stalledTickets.length > 0) {
        logger.warn(`Found ${stalledTickets.length} stalled tickets (In Progress >${Math.floor(stallTimeoutMs/60000)} minutes)`);
        
        for (const ticket of stalledTickets) {
          await svc.recoverStalledTicket(client, ticket);
        }
      }
    } catch (error) {
      logger.error('Failed to detect stalled tasks:', error.message);
    }
  }

  /**
   * Recover a stalled ticket by returning it to Todo
   */
  static async recoverStalledTicket(svc, client, ticket) {
    try {
      const secondsStalled = ticket.seconds_stalled;
      const minutesStalled = Math.floor(secondsStalled / 60);
      
      logger.info(`Recovering stalled ticket ${ticket.id}: ${ticket.name} (stalled ${minutesStalled} min)`);
      
      // Return ticket to Todo
      await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
      
      // Post timeout comment
      const stallTimeoutMinutes = Math.floor(parseInt(process.env.QUEUE_MANAGER_STALL_TIMEOUT || '1800000')/60000);
      const timeoutComment = svc.commentFormatter.recoveryComment(minutesStalled, stallTimeoutMinutes);
      
      await svc.postComment(client, ticket, timeoutComment);
      
      // Clear Redis tracking to allow immediate re-processing
      const key = `qm:processed:${ticket.id}`;
      await svc.redis.del(key);
      
      logger.info(`✓ Stalled ticket ${ticket.id} recovered and returned to Todo`);
      
    } catch (error) {
      logger.error(`Failed to recover stalled ticket ${ticket.id}:`, error.message);
    }
  }

  /**
   * Poll for tickets in Todo queue
   */
  static async poll(svc) {
    logger.info('Queue Manager: Polling Todo queue...');

    const client = new Client(svc.dbConfig);
    try {
      await client.connect();

      // First, detect and recover stalled tasks
      await svc.detectStalledTasks(client);

      if (svc.multiWorkspace) {
        // MULTI-TENANT MODE: Poll all active workspaces
        await svc.pollMultipleWorkspaces(client);
      } else {
        // SINGLE WORKSPACE MODE: Poll configured workspace only
        await svc.pollSingleWorkspace(client);
      }

      // Also check for re-route requests in In Progress tickets
      await svc.detectRerouteRequests(client);

      // Check parent tickets waiting for children to complete (subtask hierarchy)
      await svc.checkParentCompletion(client);

      await client.end();
    } catch (error) {
      logger.error('Polling failed:', error.message);
      if (client) {
        await client.end().catch(() => {});
      }
    }
  }

  /**
   * Poll tickets from a single workspace (legacy mode)
   */
  static async pollSingleWorkspace(svc, client) {
    // Get workspace ID
    const workspaceQuery = `SELECT id FROM workspaces WHERE slug = $1 LIMIT 1`;
    const workspaceResult = await client.query(workspaceQuery, [svc.workspaceSlug]);
    
    if (workspaceResult.rows.length === 0) {
      logger.warn(`Workspace ${svc.workspaceSlug} not found`);
      return;
    }
    
    const workspaceId = workspaceResult.rows[0].id;

    // Find ONLY tickets in Todo state (never touch Customer Action, Done, etc.)
    const query = `
      SELECT i.id, i.name, i.description, i.description_stripped, i.description_html,
             i.project_id, i.workspace_id, i.priority, s.name as status
      FROM issues i
      LEFT JOIN states s ON i.state_id = s.id  
      WHERE s.name = 'Todo'
      AND i.workspace_id = $1
      AND i.deleted_at IS NULL
      ORDER BY 
        CASE i.priority 
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        i.created_at ASC
      LIMIT 10
    `;

    const result = await client.query(query, [workspaceId]);
    const tickets = result.rows;

    logger.info(`Found ${tickets.length} Todo tickets in workspace: ${svc.workspaceSlug}`);

    for (const ticket of tickets) {
      // Check Redis for last processed info
      const lastProcessed = await svc.getLastProcessed(ticket.id);
      
      if (lastProcessed) {
        const elapsed = Date.now() - lastProcessed.processed_at;
        const dynamicCooldown = svc.getDynamicCooldown(lastProcessed.complexity || 'medium');
        
        if (elapsed < dynamicCooldown) {
          // In cooldown - check for new activity
          const hasNew = await svc.hasNewActivity(client, ticket.id, lastProcessed.processed_at);
          
          if (!hasNew) {
            logger.debug(`Ticket ${ticket.id} in cooldown (${Math.round(elapsed/1000)}s/${Math.round(dynamicCooldown/1000)}s, complexity=${lastProcessed.complexity || 'medium'}, no new activity), skipping`);
            continue;
          } else {
            logger.info(`Ticket ${ticket.id} has new activity after ${Math.round(elapsed/1000)}s, re-evaluating`);
          }
        } else {
          logger.info(`Ticket ${ticket.id} cooldown expired (${Math.round(elapsed/1000)}s/${Math.round(dynamicCooldown/1000)}s), available for re-evaluation`);
        }
      }

      // Concurrency gate: don't blow Bedrock rate limits by dispatching too many tickets at once
      if (svc.activeDispatches >= svc.maxConcurrentDispatches) {
        logger.info(`⏸️ Queue pacing: ${svc.activeDispatches}/${svc.maxConcurrentDispatches} active dispatches — ticket ${ticket.id} deferred to next poll cycle`);
        break; // Stop processing more tickets this cycle — they'll be picked up next poll
      }

      logger.info(`Processing ticket: ${ticket.id} - ${ticket.name}`);
      await svc.assessAndRoute(client, ticket);
    }
  }

  /**
   * Poll tickets from all active workspaces (multi-tenant mode)
   */
  static async pollMultipleWorkspaces(svc, client) {
    // Get all active workspaces
    const workspacesQuery = `
      SELECT id, slug, name 
      FROM workspaces 
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    
    const workspacesResult = await client.query(workspacesQuery);
    const workspaces = workspacesResult.rows;

    logger.info(`Polling ${workspaces.length} workspaces for Todo tickets`);

    for (const workspace of workspaces) {
      try {
        // Find Todo tickets in this workspace
        const query = `
          SELECT i.id, i.name, i.description, i.description_stripped, i.description_html,
                 i.project_id, i.workspace_id, i.priority, s.name as status
          FROM issues i
          LEFT JOIN states s ON i.state_id = s.id  
          WHERE s.name = 'Todo'
          AND i.workspace_id = $1
          AND i.deleted_at IS NULL
          ORDER BY 
            CASE i.priority 
              WHEN 'urgent' THEN 1
              WHEN 'high' THEN 2
              WHEN 'medium' THEN 3
              WHEN 'low' THEN 4
              ELSE 5
            END,
            i.created_at ASC
          LIMIT 10
        `;

        const result = await client.query(query, [workspace.id]);
        const tickets = result.rows;

        if (tickets.length > 0) {
          logger.info(`Found ${tickets.length} Todo tickets in workspace: ${workspace.slug}`);

          for (const ticket of tickets) {
            // Check Redis for last processed info
            const lastProcessed = await svc.getLastProcessed(ticket.id);
            
            if (lastProcessed) {
              const elapsed = Date.now() - lastProcessed.processed_at;
              const dynamicCooldown = svc.getDynamicCooldown(lastProcessed.complexity || 'medium');
              
              if (elapsed < dynamicCooldown) {
                // In cooldown - check for new activity
                const hasNew = await svc.hasNewActivity(client, ticket.id, lastProcessed.processed_at);
                
                if (!hasNew) {
                  logger.debug(`Ticket ${ticket.id} in cooldown (${Math.round(elapsed/1000)}s/${Math.round(dynamicCooldown/1000)}s, complexity=${lastProcessed.complexity || 'medium'}, no new activity), skipping`);
                  continue;
                } else {
                  logger.info(`Ticket ${ticket.id} has new activity after ${Math.round(elapsed/1000)}s, re-evaluating`);
                }
              } else {
                logger.info(`Ticket ${ticket.id} cooldown expired (${Math.round(elapsed/1000)}s/${Math.round(dynamicCooldown/1000)}s), available for re-evaluation`);
              }
            }

            // Concurrency gate: don't blow Bedrock rate limits by dispatching 10 tickets at once
            if (svc.activeDispatches >= svc.maxConcurrentDispatches) {
              logger.info(`⏸️ Queue pacing: ${svc.activeDispatches}/${svc.maxConcurrentDispatches} active dispatches — ticket ${ticket.id} deferred to next poll cycle`);
              break; // Stop processing more tickets this cycle — they'll be picked up next poll
            }

            logger.info(`Processing ticket: ${ticket.id} - ${ticket.name} (workspace: ${workspace.slug})`);
            await svc.assessAndRoute(client, ticket);
          }
        }
      } catch (error) {
        logger.error(`Failed to poll workspace ${workspace.slug}:`, error.message);
        // Continue with other workspaces
      }
    }
  }

  /**
   * Detect re-route requests in In Progress tickets
   * Also check Todo tickets that agents just returned for completion evaluation
   */
  static async detectRerouteRequests(svc, client) {
    try {
      // DEBUG: Log entry
      logger.debug('Detecting re-route requests...');
      // Find In Progress tickets with recent comments
      const inProgressQuery = `
        SELECT i.id, i.name, i.description, i.description_stripped, i.description_html,
               i.project_id, i.workspace_id, i.priority, s.name as status
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        LEFT JOIN issue_comments ic ON i.id = ic.issue_id
        WHERE s.name = 'In Progress'
        AND i.deleted_at IS NULL
        AND ic.created_at >= NOW() - INTERVAL '5 minutes'
        AND ic.comment_stripped LIKE '%@queue-manager%'
        AND ic.comment_stripped LIKE '%REQUEST%'
        Group BY i.id, i.name, i.description, i.description_stripped, i.description_html, i.project_id, i.workspace_id, i.priority, s.name
        ORDER BY MAX(ic.created_at) DESC
        LIMIT 20
      `;

      const inProgressResult = await client.query(inProgressQuery);
      const inProgressTickets = inProgressResult.rows;

      if (inProgressTickets.length > 0) {
        logger.info(`Checking ${inProgressTickets.length} In Progress tickets for re-route requests`);

        for (const ticket of inProgressTickets) {
          await svc.checkForRerouteRequest(client, ticket);
        }
      }

      // Also check Todo tickets with recent "Agent Completed" comments
      // These are tickets agents just returned to Todo
      const todoQuery = `
        SELECT i.id, i.name, i.description, i.description_stripped, i.description_html,
               i.project_id, i.workspace_id, i.priority, s.name as status
        FROM issues i
        LEFT JOIN states s ON i.state_id = s.id
        LEFT JOIN issue_comments ic ON i.id = ic.issue_id
        WHERE s.name = 'Todo'
        AND i.deleted_at IS NULL
        AND ic.created_at >= NOW() - INTERVAL '5 minutes'
        AND ic.comment_stripped LIKE '%Agent Completed Work%'
        GROUP BY i.id, i.name, i.description, i.description_stripped, i.description_html, i.project_id, i.workspace_id, i.priority, s.name
        ORDER BY MAX(ic.created_at) DESC
        LIMIT 20
      `;

      const todoResult = await client.query(todoQuery);
      const completedTickets = todoResult.rows;

      if (completedTickets.length > 0) {
        logger.info(`Checking ${completedTickets.length} completed tickets for further routing or human review`);

        for (const ticket of completedTickets) {
          await svc.evaluateTicketCompletion(client, ticket);
        }
      }
    } catch (error) {
      logger.error('Failed to detect re-route requests:', error.message || error.toString());
      logger.error('Full error object:', error);
    }
  }

  /**
   * Check specific ticket for re-route request in comments
   */
  static async checkForRerouteRequest(svc, client, ticket) {
    try {
      // Get recent comments for this ticket
      const commentsQuery = `
        SELECT id, comment_stripped, created_at
        FROM issue_comments
        WHERE issue_id = $1
        AND workspace_id = $2
        ORDER BY created_at DESC
        LIMIT 10
      `;

      const commentsResult = await client.query(commentsQuery, [ticket.id, ticket.workspace_id]);
      const comments = commentsResult.rows;

      // Check each comment for re-route request
      for (const comment of comments) {
        const rerouteRequest = svc.commentParser.parseRerouteRequest(comment.comment_stripped);

        if (rerouteRequest && svc.commentParser.validateRerouteRequest(rerouteRequest)) {
          // Found valid re-route request
          logger.info(`✓ Detected re-route request in ticket ${ticket.id}: ${rerouteRequest.target_agent}`);

          // Validate target agent can serve this workspace
          const canServe = await svc.agentRegistry.canServeWorkspace(
            rerouteRequest.target_agent,
            ticket.workspace_id
          );

          if (!canServe) {
            logger.error(`Re-route BLOCKED: Agent ${rerouteRequest.target_agent} cannot serve workspace ${ticket.workspace_id}`);
            await svc.postComment(client, ticket, 
              `❌ **Re-Route Request Denied**\n\nAgent ${rerouteRequest.target_agent} cannot serve this workspace.\n\n*Security: Cross-workspace routing blocked*`
            );
            continue;
          }

          // Execute re-route
          await svc.executeReroute(client, ticket, rerouteRequest);
          break; // Only process one re-route request per ticket
        }
      }
    } catch (error) {
      logger.error(`Failed to check re-route for ticket ${ticket.id}:`, error.message);
    }
  }

  /**
   * Evaluate if ticket is complete or needs more agents
   */
  static async evaluateTicketCompletion(svc, client, ticket) {
    try {
      logger.info(`Evaluating ticket completion: ${ticket.id}`);

      // Get all comments to analyze agent activity
      const commentsQuery = `
        SELECT comment_stripped, created_at
        FROM issue_comments
        WHERE issue_id = $1
        ORDER BY created_at ASC
      `;

      const commentsResult = await client.query(commentsQuery, [ticket.id]);
      const comments = commentsResult.rows;

      // Analyze ticket history
      const analysis = svc.commentParser.analyzeTicketComments(comments);

      logger.info(`Ticket ${ticket.id} analysis: ${analysis.agents_involved.length} agents involved, ${analysis.completed_work.length} completions`);

      // Check for explicit "DONE" or "COMPLETE" markers
      const lastComment = comments[comments.length - 1]?.comment_stripped || '';
      const explicitlyDone = lastComment.toLowerCase().includes('all work complete') || 
                           lastComment.toLowerCase().includes('ticket complete') ||
                           lastComment.toLowerCase().includes('ready for human');

      if (explicitlyDone) {
        // Ticket is complete, send to human review
        logger.info(`Ticket ${ticket.id} marked complete by agent, escalating to human`);
        await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
        
        const humanReviewComment = `✅ **Queue Manager: Work Complete**

**Agents Involved:** ${analysis.agents_involved.join(', ')}  
**Total Contributions:** ${analysis.completed_work.length}

**Summary:**
All agent work has been completed. This ticket is ready for human review.

---
*Queue Manager v1.0*`;

        await svc.postComment(client, ticket, humanReviewComment);
      } else {
        // Ticket returned to Todo but not explicitly done
        // Let normal routing logic handle it (may route to another agent)
        logger.info(`Ticket ${ticket.id} in Todo with ${analysis.agents_involved.length} agents so far, available for re-routing`);
        // Don't mark as processed - let it be picked up if another agent needed
      }

    } catch (error) {
      logger.error(`Failed to evaluate ticket completion for ${ticket.id}:`, error.message);
    }
  }

  /**
   * Execute validated re-route request
   */
  static async executeReroute(svc, client, ticket, rerouteRequest) {
    try {
      logger.info(`Executing re-route: ${ticket.id} → ${rerouteRequest.target_agent}`);

      // Get target agent
      const targetAgent = await svc.agentRegistry.getAgent(rerouteRequest.target_agent);

      if (!targetAgent) {
        logger.error(`Re-route failed: Target agent ${rerouteRequest.target_agent} not found`);
        await svc.postComment(client, ticket,
          `❌ **Re-Route Failed**\n\nTarget agent ${rerouteRequest.target_agent} not found in registry.`
        );
        return;
      }

      // Return ticket to Todo with context preserved
      await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);

      // Post context comment
      const contextComment = `🔄 **Re-Routing Requested**

**Previous Work Completed:**
${rerouteRequest.completed_work}

**Remaining Work:**
${rerouteRequest.remaining_work}

**Reason for Re-Route:**
${rerouteRequest.reason}

**Now routing to:** @agent:${rerouteRequest.target_agent}

---
*Ticket returned to Todo queue. Queue Manager will route to ${rerouteRequest.target_agent} on next poll cycle.*

*Queue Manager v1.0*`;

      await svc.postComment(client, ticket, contextComment);

      logger.info(`✓ Re-route executed: Ticket ${ticket.id} returned to Todo for ${rerouteRequest.target_agent}`);

    } catch (error) {
      logger.error(`Failed to execute re-route for ticket ${ticket.id}:`, error.message);
    }
  }
}

module.exports = QueuePollingCoordinator;
