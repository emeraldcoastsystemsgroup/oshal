/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): parallel dispatch wrapper, PM agent-assignment parsing, standard phase-gate handling, and the PHASE_17 tool-approval workflow
 */

/**
 * PhaseGateWorkflow — phase-gate and approval workflow helpers of the queue manager.
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
const { PHASES } = require('./TicketPhaseManager');

/**
 * @description Phase-gate and approval workflow helpers of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class PhaseGateWorkflow {
  /**
   * Dispatch ticket to agent in parallel (non-blocking)
   * Creates its own DB connection for async result handling
   * This allows the poll loop to continue dispatching other tickets while agents work
   */
  static async _dispatchParallel(svc, ticket, agent, analysis, agentPlaneUserId) {
    const { Client } = require('pg');
    const client = new Client(svc.dbConfig);
    
    // Increment active dispatch counter (paces the queue to avoid Bedrock rate limits)
    svc.activeDispatches++;
    logger.info(`📊 Active dispatches: ${svc.activeDispatches}/${svc.maxConcurrentDispatches}`);
    
    try {
      await client.connect();
      await svc.processWithAgent(client, ticket, agent, agentPlaneUserId);
    } catch (error) {
      logger.error(`Parallel dispatch failed for ticket ${ticket.id}: ${error.message}`);
      try {
        await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
        const errorComment = svc.commentFormatter.errorComment(agent.agent_id, `Parallel dispatch error: ${error.message}`);
        await svc.postComment(client, ticket, errorComment, agentPlaneUserId);
      } catch (cleanupErr) {
        logger.error(`Cleanup after parallel dispatch error failed: ${cleanupErr.message}`);
      }
    } finally {
      // Decrement active dispatch counter when agent finishes (success or failure)
      svc.activeDispatches = Math.max(0, svc.activeDispatches - 1);
      logger.info(`📊 Active dispatches: ${svc.activeDispatches}/${svc.maxConcurrentDispatches} (ticket ${ticket.id} finished)`);
      try { await client.end(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Parse PM's AGENT_ASSIGNMENTS from ticket comments
   * Scans recent comments for the ## AGENT_ASSIGNMENTS markdown table
   * Returns ordered array of {agentId, role, reason} or null
   */
  static async getPMAgentAssignments(svc, ticket) {
    try {
      const { Client } = require('pg');
      const client = new Client(svc.dbConfig);
      await client.connect();
      
      // Get recent comments (PM's planning output)
      const query = `
        SELECT comment_stripped FROM issue_comments 
        WHERE issue_id = $1 
        ORDER BY created_at DESC 
        LIMIT 15
      `;
      const result = await client.query(query, [ticket.id]);
      await client.end();
      
      for (const row of result.rows) {
        const text = row.comment_stripped || '';
        if (!text.includes('AGENT_ASSIGNMENTS')) continue;
        
        // Parse markdown table: | Order | Agent | Role | Reason |
        const lines = text.split('\n');
        const assignments = [];
        let inTable = false;
        
        for (const line of lines) {
          if (line.includes('AGENT_ASSIGNMENTS')) { inTable = true; continue; }
          if (!inTable) continue;
          if (line.includes('---') && line.includes('|')) continue; // Skip header separator
          if (line.includes('Order') && line.includes('Agent')) continue; // Skip header row
          
          const cells = line.split('|').map(c => c.trim()).filter(c => c);
          if (cells.length >= 3) {
            const order = parseInt(cells[0]);
            const agentId = cells[1].replace(/\*\*/g, '').trim();
            const role = cells[2] || '';
            const reason = cells[3] || '';
            
            if (agentId && agentId.length > 3 && !isNaN(order)) {
              assignments.push({ order, agentId, role, reason });
            }
          }
          
          // Stop at next section header
          if (line.startsWith('#') && !line.includes('AGENT_ASSIGNMENTS')) break;
        }
        
        if (assignments.length > 0) {
          assignments.sort((a, b) => a.order - b.order);
          logger.info(`🎯 PM AGENT_ASSIGNMENTS found for ticket ${ticket.id}: ${assignments.map(a => `${a.order}:${a.agentId}`).join(', ')}`);
          return assignments;
        }
      }
      
      return null; // No PM assignments found
    } catch (error) {
      logger.warn(`Failed to parse PM agent assignments for ticket ${ticket.id}: ${error.message}`);
      return null;
    }
  }

  /**
   * Standard phase gate handling — used for all non-REVIEW phases and legacy single-reviewer REVIEW.
   * Extracted to avoid duplication between the review-cycle path and the standard path.
   * @private
   */
  static async _handleStandardPhaseGate(svc, client, ticket, agent, agentPlaneUserId, agentResponse, currentPhaseForGate, phaseDataForGate) {
    const { getQueueManagerUserId } = require('./AgentPlaneUserMap');
    
    // PHASED LIFECYCLE: Check phase gate
    const gateResult = svc.phaseManager.checkGate(currentPhaseForGate, agentResponse, phaseDataForGate.complexity);
    logger.info(`📍 Phase ${currentPhaseForGate} gate check for ticket ${ticket.id}: ${gateResult.passed ? 'PASSED' : 'FAILED'} (${gateResult.reason})`);

    // ⭐ PHASE_21 GAP B: Record gate result metric
    if (svc.agentMetrics) {
      svc.agentMetrics.recordGateResult(agent.agent_id, ticket.id, currentPhaseForGate, gateResult.passed).catch(() => {});
    }
    
    // Post agent's work as a comment regardless of gate result
    await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
    
    if (gateResult.passed) {
      // Gate passed — post gate comment and advance to next phase
      const passComment = svc.phaseManager.getPhaseComment(currentPhaseForGate, 'passed', gateResult.reason);
      await svc.postComment(client, ticket, passComment, getQueueManagerUserId());
      
      const nextPhaseData = await svc.phaseManager.advancePhase(ticket.id);
      
      if (!nextPhaseData) {
        // No more phases — ticket is complete (reached end of path)
        logger.info(`✅ Ticket ${ticket.id}: All phases complete, moving to Customer Action`);
        
        // Generate customer-facing summary
        let finalSummary;
        try {
          const isParent = await svc.planeDb.hasChildren(client, ticket.id);
          finalSummary = isParent 
            ? svc.commentFormatter.customerSummary(agentResponse)
            : svc.commentFormatter.completionComment(agent.agent_id, agentResponse, false, ticket.task_id);
        } catch (e) {
          finalSummary = `✅ **All Phases Complete**\n\nTicket fully processed through ${currentPhaseForGate} phases.\n\n---\n*Ticket Lifecycle v1.0*`;
        }
        
        await svc.postComment(client, ticket, finalSummary, getQueueManagerUserId());
        await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
      } else if (nextPhaseData.phase === PHASES.REVIEW) {
        // ⭐ PHASE_12: Next phase is REVIEW → Initialize review cycle with multiple reviewers
        logger.info(`🔄 Ticket ${ticket.id}: Advancing to REVIEW — initializing consensus review cycle`);
        
        try {
          // Get all agents for reviewer selection
          const reviewAgents = await svc.agentRegistry.query({ workspace: ticket.workspace_id });
          const executorId = phaseDataForGate.executingAgent || agent.agent_id;
          const reviewAnalysis = svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket));
          
          // Select 2-4 reviewers (excludes executor + PM)
          const reviewerIds = svc.reviewCycle.selectReviewers(reviewAgents, executorId, reviewAnalysis);
          
          if (reviewerIds.length > 0) {
            // Initialize the review cycle
            const cycleState = await svc.reviewCycle.initCycle(ticket.id, PHASES.REVIEW, executorId, reviewerIds);
            
            // Post review cycle initialization comment
            const cycleComment = `🔄 **Review Cycle Initialized**\n\n**Executor:** ${executorId}\n**Reviewers:** ${reviewerIds.join(', ')}\n**Max Rounds:** ${cycleState.maxRounds}\n\nMultiple reviewers will evaluate the work. The cycle continues until all reviewers approve or max rounds are reached.\n\n---\n*Phase Review Cycle v1.0*`;
            await svc.postComment(client, ticket, cycleComment, getQueueManagerUserId());
            
            logger.info(`🔄 Review cycle initialized for ${ticket.id}: ${reviewerIds.length} reviewers, executor=${executorId}`);
          } else {
            logger.warn(`⚠️ No reviewers available for ${ticket.id}, skipping review cycle`);
          }
        } catch (cycleErr) {
          logger.warn(`Failed to initialize review cycle for ${ticket.id}: ${cycleErr.message}`);
        }
        
        const nextPhaseComment = svc.phaseManager.getPhaseComment(nextPhaseData.phase, 'entering',
          `Execution complete. Starting consensus review cycle.`);
        await svc.postComment(client, ticket, nextPhaseComment, getQueueManagerUserId());
        await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
      } else if (nextPhaseData.phase === PHASES.DELIVERY) {
        // Next phase is DELIVERY (automated) — complete immediately
        logger.info(`📦 Ticket ${ticket.id}: Advancing to DELIVERY (automated completion)`);
        
        // PHASE_37: Include workspace link + file scan in delivery comment
        const delivWorkspaceSection = ticket.task_id || ticket._taskId ? svc.commentFormatter._scanWorkspaceStructured(ticket.task_id || ticket._taskId) : '';
        const delivWorkspaceUrl = ticket.task_id || ticket._taskId ? `\n\n📂 **Workspace:** http://localhost:3010/workspace/${ticket.task_id || ticket._taskId}/` : '';
        const deliveryComment = svc.phaseManager.getPhaseComment(PHASES.DELIVERY, 'entering',
          `All agent work complete. Delivering to customer.${delivWorkspaceUrl}${delivWorkspaceSection ? '\n\n' + delivWorkspaceSection : ''}`);
        await svc.postComment(client, ticket, deliveryComment, getQueueManagerUserId());
        await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
        
        // Clean up phase tracking
        try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
      } else {
        // More phases to go — return to Todo for next phase agent
        logger.info(`📋 Ticket ${ticket.id}: Advanced to Phase ${nextPhaseData.phase} (${nextPhaseData.phaseName}), returning to Todo`);
        
        const nextPhaseComment = svc.phaseManager.getPhaseComment(nextPhaseData.phase, 'entering',
          `Previous phase complete. Routing to next agent for ${nextPhaseData.phaseName}.`);
        await svc.postComment(client, ticket, nextPhaseComment, getQueueManagerUserId());
        await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
      }
    } else {
      // Gate FAILED — post rejection comment
      logger.warn(`❌ Phase ${currentPhaseForGate} gate FAILED for ticket ${ticket.id}: ${gateResult.reason}`);
      
      const failComment = svc.phaseManager.getPhaseComment(currentPhaseForGate, 'failed', gateResult.reason);
      await svc.postComment(client, ticket, failComment, getQueueManagerUserId());
      
      // ⭐ PHASE_13: TESTING phase failure triggers regression to EXECUTION or PLANNING
      // Instead of retrying the TESTING phase, regress to the phase the tester specified
      if (currentPhaseForGate === PHASES.TESTING && gateResult.regressionTarget) {
        const regressionPhase = gateResult.regressionTarget;
        const regressionPhaseName = regressionPhase === PHASES.PLANNING ? 'PLANNING' : 'EXECUTION';
        
        logger.warn(`⏪ PHASE_13: TESTING gate failed — regressing ticket ${ticket.id} to ${regressionPhaseName} (phase ${regressionPhase})`);
        
        const regressionData = await svc.phaseManager.regressPhase(ticket.id, regressionPhase);
        
        if (regressionData) {
          const regressionComment = svc.phaseManager.getPhaseComment(regressionPhase, 'entering',
            `⏪ **Regression from TESTING** — Tests failed. Returning to ${regressionPhaseName} for rework.\n\nTest feedback:\n${gateResult.reason}`);
          await svc.postComment(client, ticket, regressionComment, getQueueManagerUserId());
        } else {
          logger.warn(`⚠️ PHASE_13: Regression to ${regressionPhaseName} failed for ticket ${ticket.id}, falling back to retry`);
        }
      }
      
      await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
    }
  }


  // ════════════════════════════════════════════════════════════
  // PHASE_17: Tool Authorization Approval Workflow
  // ════════════════════════════════════════════════════════════

  /**
   * Request human approval for a tool command that a bot wants to execute.
   * Called when cliTools returns { needsApproval: true, approvalRequest: {...} }.
   *
   * Flow:
   * 1. Post structured approval request comment to ticket
   * 2. Move ticket to "Approval Required" state
   * 3. Store pending approval in Redis (24h TTL)
   *
   * When human approves: they move ticket back to "Todo" in Plane.
   * On next poll, assessAndRoute() calls checkAndConsumeApproval() which detects
   * the pending key and injects "✅ APPROVAL GRANTED" context into the bot's prompt.
   *
   * @param {object} client - Plane DB client
   * @param {object} ticket - Plane ticket object
   * @param {object} approvalRequest - { tool, command, riskLevel, reason }
   */
  static async requestApproval(svc, client, ticket, approvalRequest) {
    const { tool, command, riskLevel, reason } = approvalRequest;
    const ticketId = ticket.id;

    logger.info(`[ApprovalRequired] Ticket ${ticketId}: ${tool} command needs approval`);

    const riskEmoji = riskLevel === 'high' ? '🔴' : riskLevel === 'medium' ? '🟡' : '🟢';
    const approvalComment = [
      `## 🔐 Tool Approval Required`,
      ``,
      `A bot has requested to execute a command that requires human authorization.`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Tool** | \`${tool}\` |`,
      `| **Command** | \`${command}\` |`,
      `| **Risk Level** | ${riskEmoji} ${riskLevel.toUpperCase()} |`,
      `| **Reason** | ${reason} |`,
      `| **Requested At** | ${new Date().toISOString()} |`,
      ``,
      `### To Approve`,
      `Move this ticket back to **Todo** state. The bot will automatically execute the command on next dispatch.`,
      ``,
      `### To Deny`,
      `Leave this ticket in **Approval Required** state, or move to **Cancelled**.`,
      ``,
      `> ⚠️ This ticket will remain paused until a human operator takes action.`,
    ].join('\n');

    try {
      await svc.postComment(client, ticket, approvalComment);
    } catch (err) {
      logger.warn(`[ApprovalRequired] Failed to post approval comment for ${ticketId}: ${err.message}`);
    }

    try {
      await svc.updateTicketStatus(client, ticketId, 'Approval Required', ticket.project_id);
      logger.info(`[ApprovalRequired] Ticket ${ticketId} moved to "Approval Required" state`);
    } catch (err) {
      logger.warn(`[ApprovalRequired] Could not move ticket ${ticketId} to "Approval Required" state: ${err.message}. Ensure this state exists in Plane.`);
    }

    try {
      await svc.redis.set(
        `qm:approval_pending:${ticketId}`,
        JSON.stringify({ tool, command, riskLevel, reason, requestedAt: new Date().toISOString(), ticketId }),
        'EX', 86400
      );
      logger.info(`[ApprovalRequired] Stored pending approval in Redis for ticket ${ticketId}`);
    } catch (err) {
      logger.warn(`[ApprovalRequired] Failed to store approval in Redis for ${ticketId}: ${err.message}`);
    }
  }

  /**
   * Check if a ticket has a pending approval that was granted (human moved it back to Todo).
   * If found, returns the approval context string to inject into the bot's prompt.
   * Also deletes the Redis key so it's only injected once.
   *
   * Called at the start of assessAndRoute() before routing.
   *
   * @param {string} ticketId
   * @returns {Promise<string|null>} Approval context string, or null if no pending approval
   */
  static async checkAndConsumeApproval(svc, ticketId) {
    try {
      const pendingApprovalStr = await svc.redis.get(`qm:approval_pending:${ticketId}`);
      if (!pendingApprovalStr) return null;

      const approval = JSON.parse(pendingApprovalStr);
      await svc.redis.del(`qm:approval_pending:${ticketId}`);

      logger.info(`[ApprovalGranted] Ticket ${ticketId}: approval consumed for command: ${approval.command}`);

      return [
        `## ✅ APPROVAL GRANTED`,
        ``,
        `Your previous request to run \`${approval.command}\` has been approved by a human operator.`,
        `You may now execute it.`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Tool** | \`${approval.tool}\` |`,
        `| **Command** | \`${approval.command}\` |`,
        `| **Approved At** | ${new Date().toISOString()} |`,
        ``,
        `**Proceed with executing the approved command.**`,
      ].join('\n');
    } catch (err) {
      logger.warn(`[ApprovalGranted] Failed to check approval for ${ticketId}: ${err.message}`);
      return null;
    }
  }
}

module.exports = PhaseGateWorkflow;
