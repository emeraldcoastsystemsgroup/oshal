/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): processWithAgent completion stage — subtask decomposition handling, RALF round completion, escalation + peer-command parsing, phase-gate/review-cycle progression, and completion metrics/memory wrap-up
 */

/**
 * DispatchCompletionHandler — post-response completion stage of processWithAgent.
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
const { getQueueManagerUserId } = require('./AgentPlaneUserMap');

/**
 * @description Post-response completion stage of processWithAgent. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class DispatchCompletionHandler {
  /**
   * Completion stage of processWithAgent — everything that happens after the agent
   * produced a response: subtask decomposition, RALF round completion, escalation and
   * peer-command parsing, phase-gate / review-cycle progression, and metrics wrap-up.
   * Body is verbatim from QueueManagerService.processWithAgent (post-response half).
   * @param {Object} svc - QueueManagerService instance
   * @param {Object} client - Connected pg client for the Plane DB
   * @param {Object} ticket - Plane ticket row
   * @param {Object} agent - Selected agent registry entry
   * @param {string|null} agentPlaneUserId - Plane user UUID for comment attribution
   * @param {Object} state - Dispatch-stage outputs: { taskId, result, agentResponse, metricsStartMs }
   * @returns {Promise<void>} Resolves when the ticket lifecycle step is fully recorded
   */
  static async completeDispatch(svc, client, ticket, agent, agentPlaneUserId, state) {
    let { taskId, result, agentResponse } = state;
    const _metricsStartMs = state.metricsStartMs;
      // ⭐ SUBTASK DECOMPOSITION: Check if agent requested task breakdown
      // PHASE_39 FIX: Check BOTH response text AND workspace files for decomposition marker
      // PM often writes plans to workspace files via write_to_file instead of inline response
      let subtaskDecomposition = svc.detectSubtaskDecomposition(agentResponse);
      
      // If not found in response text, scan workspace files for the marker
      if (!subtaskDecomposition && taskId) {
        try {
          const fs = require('fs');
          const path = require('path');
          const wsDir = path.join('/app/workspace', taskId);
          if (fs.existsSync(wsDir)) {
            const files = fs.readdirSync(wsDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
            for (const file of files) {
              if (file.startsWith('_')) continue; // Skip _meta.json etc
              const filePath = path.join(wsDir, file);
              const stat = fs.statSync(filePath);
              if (stat.isFile() && stat.size < 50000) { // Skip huge files
                const content = fs.readFileSync(filePath, 'utf8');
                if (content.includes('## SUBTASK DECOMPOSITION')) {
                  logger.info(`📂 PHASE_39: Found SUBTASK DECOMPOSITION marker in workspace file: ${file}`);
                  subtaskDecomposition = svc.detectSubtaskDecomposition(content);
                  if (subtaskDecomposition) {
                    logger.info(`📂 PHASE_39: Extracted ${subtaskDecomposition.length} subtasks from workspace file: ${file}`);
                    break;
                  }
                }
              }
            }
            // Also scan subdirectories (notes/, deliverables/)
            if (!subtaskDecomposition) {
              const subdirs = ['notes', 'deliverables'];
              for (const subdir of subdirs) {
                const subdirPath = path.join(wsDir, subdir);
                if (fs.existsSync(subdirPath)) {
                  const subFiles = fs.readdirSync(subdirPath).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
                  for (const file of subFiles) {
                    const filePath = path.join(subdirPath, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && stat.size < 50000) {
                      const content = fs.readFileSync(filePath, 'utf8');
                      if (content.includes('## SUBTASK DECOMPOSITION')) {
                        logger.info(`📂 PHASE_39: Found SUBTASK DECOMPOSITION marker in workspace file: ${subdir}/${file}`);
                        subtaskDecomposition = svc.detectSubtaskDecomposition(content);
                        if (subtaskDecomposition) {
                          logger.info(`📂 PHASE_39: Extracted ${subtaskDecomposition.length} subtasks from workspace file: ${subdir}/${file}`);
                          break;
                        }
                      }
                    }
                  }
                  if (subtaskDecomposition) break;
                }
              }
            }
          }
        } catch (wsErr) {
          logger.debug(`PHASE_39: Workspace scan error: ${wsErr.message}`);
        }
      }
      
      if (subtaskDecomposition && subtaskDecomposition.length >= 2 && subtaskDecomposition.length <= 10) {
        logger.info(`🔀 Subtask decomposition detected for ticket ${ticket.id}: ${subtaskDecomposition.length} subtasks`);
        
        // ⭐ ISSUE #031 FIX + PHASE_51 FIX: Hard decomposition enforcement
        // DECOMPOSITION_CUTOFF = 1: ONLY root tickets (depth 0) can decompose.
        // Any ticket at depth 1+ MUST execute directly — no exceptions.
        // Previous code used MAX_SUBTASK_DEPTH=4 which was too permissive and allowed
        // agents to recursively re-decompose subtasks, creating exponential ticket trees.
        const DECOMPOSITION_CUTOFF = 1; // HARD LIMIT: Only depth 0 → 1 decomposition allowed
        const MAX_SUBTASK_DEPTH = 4; // Absolute ceiling (unreachable now, but kept as safety net)
        let currentDepth = 0;
        try {
          // AUTHORITATIVE: Walk parent chain in DB (not Redis — Redis keys expire)
          const parentQuery = `
            WITH RECURSIVE ancestors AS (
              SELECT id, parent_id, 0 as depth FROM issues WHERE id = $1
              UNION ALL
              SELECT i.id, i.parent_id, a.depth + 1
              FROM issues i JOIN ancestors a ON i.id = a.parent_id
              WHERE a.depth < 10
            )
            SELECT MAX(depth) as max_depth FROM ancestors
          `;
          const depthResult = await client.query(parentQuery, [ticket.id]);
          currentDepth = parseInt(depthResult.rows[0]?.max_depth || 0);
          
          // Also check Redis as secondary (may have more recent info)
          const depthKey = `qm:decomp_depth:${ticket.id}`;
          const redisDepthStr = await svc.redis.get(depthKey);
          const redisDepth = redisDepthStr ? parseInt(redisDepthStr) : 0;
          currentDepth = Math.max(currentDepth, redisDepth);
          
          logger.info(`📏 ISSUE #031: Ticket ${ticket.id} depth = ${currentDepth} (DB: ${depthResult.rows[0]?.max_depth || 0}, Redis: ${redisDepth})`);
        } catch (depthErr) {
          logger.debug(`Depth check error for ${ticket.id}: ${depthErr.message}`);
        }
        
        if (currentDepth >= DECOMPOSITION_CUTOFF) {
          // ⭐ PHASE_51 FIX: Block decomposition at CUTOFF (1), not MAX_DEPTH (4)
          // This is the actual fix for the recursive ticket explosion.
          // Only root tickets (depth 0) are allowed to create subtasks.
          // Anything at depth 1+ MUST execute directly.
          logger.warn(`🛑 PHASE_51: Decomposition BLOCKED at depth ${currentDepth} (cutoff=${DECOMPOSITION_CUTOFF}) for ticket ${ticket.id}. Only root tickets can decompose.`);
          // Post warning comment so it's visible in Plane
          try {
            const overDecompComment = svc.commentFormatter.overDecompositionWarning 
              ? svc.commentFormatter.overDecompositionWarning(currentDepth, MAX_SUBTASK_DEPTH)
              : `⚠️ **Decomposition Blocked** — Ticket at depth ${currentDepth}/${MAX_SUBTASK_DEPTH}. Max decomposition depth reached. Agent must execute directly.`;
            await svc.postComment(client, ticket, overDecompComment, getQueueManagerUserId());
          } catch (commentErr) {
            logger.debug(`Failed to post over-decomposition warning: ${commentErr.message}`);
          }
        } else {
          // ⭐ ISSUE #031 FIX 2: Duplicate sibling detection — prevent creating same-named subtasks
          // ⭐ PHASE_50 FIX: Count only ACTIVE children for the 7-subtask cap
          // Done/Customer Action/Cancelled children don't count — allows iterative re-decomposition
          let existingChildNames = [];
          let activeChildCount = 0;
          try {
            const existingChildren = await svc.planeDb.getChildIssues(client, ticket.id);
            existingChildNames = existingChildren.map(c => c.name.toLowerCase().trim());
            
            // Count only ACTIVE children (not Done, Customer Action, or Cancelled)
            const COMPLETED_STATES = ['done', 'customer action', 'cancelled'];
            activeChildCount = existingChildren.filter(c => {
              const status = (c.status || '').toLowerCase();
              return !COMPLETED_STATES.includes(status);
            }).length;
            
            if (existingChildNames.length > 0) {
              logger.info(`📋 ISSUE #031: Parent ${ticket.id} has ${existingChildNames.length} total children (${activeChildCount} active): [${existingChildNames.join(', ')}]`);
            }
          } catch (childErr) {
            logger.debug(`Child lookup failed for ${ticket.id}: ${childErr.message}`);
          }
          
          // Filter out duplicates and sentinel titles
          const SENTINEL_PATTERNS = [
            /^this ticket requires/i,
            /^decompos/i,
            /^requires decomposition/i,
            /^needs to be broken/i,
            /^needs decomposition/i,
            /^multi-disciplinary/i,
            /^further decomposition/i,
          ];
          
          const filteredSubtasks = subtaskDecomposition.filter(subtask => {
            const titleLower = subtask.title.toLowerCase().trim();
            
            // ISSUE #031 FIX 3: Reject sentinel meta-descriptions
            for (const pattern of SENTINEL_PATTERNS) {
              if (pattern.test(titleLower)) {
                logger.warn(`🛑 ISSUE #031: Rejecting sentinel subtask title: "${subtask.title}"`);
                return false;
              }
            }
            
            // ISSUE #031 FIX 2: Reject duplicate names (already exists as sibling)
            if (existingChildNames.includes(titleLower)) {
              logger.warn(`🛑 ISSUE #031: Rejecting duplicate subtask: "${subtask.title}" (already exists under parent)`);
              return false;
            }
            
            // ISSUE #031 FIX 4: Reject subtasks whose title is nearly identical to parent
            const parentName = ticket.name ? ticket.name.toLowerCase().trim() : '';
            if (parentName && titleLower === parentName) {
              logger.warn(`🛑 ISSUE #031: Rejecting self-referential subtask: "${subtask.title}" (identical to parent name)`);
              return false;
            }
            
            return true;
          });
          
          // ⭐ PHASE_50: Cap based on ACTIVE children, not total children
          // This allows iterative re-decomposition after completing previous subtasks
          const MAX_ACTIVE_SUBTASKS = 7;
          const availableSlots = MAX_ACTIVE_SUBTASKS - activeChildCount;
          
          if (availableSlots <= 0) {
            logger.warn(`🛑 PHASE_50: Active subtask cap reached (${activeChildCount}/${MAX_ACTIVE_SUBTASKS} active). Skipping decomposition — complete existing subtasks first.`);
            try {
              await svc.postComment(client, ticket, 
                `⚠️ **Decomposition Deferred** — ${activeChildCount} active subtasks already in progress (max ${MAX_ACTIVE_SUBTASKS}). Complete or close existing subtasks before creating new ones.\n\n---\n*Queue Manager — Active Subtask Cap*`,
                getQueueManagerUserId());
            } catch (e) { /* best effort */ }
          } else if (filteredSubtasks.length < 2) {
            logger.warn(`🛑 ISSUE #031: After filtering, only ${filteredSubtasks.length} valid subtasks remain (need ≥2). Skipping decomposition.`);
          } else {
            // ⭐ PHASE_50: Trim new subtasks to fit within active cap
            if (filteredSubtasks.length > availableSlots) {
              logger.info(`📋 PHASE_50: Trimming ${filteredSubtasks.length} new subtasks to ${availableSlots} (active cap: ${activeChildCount}+${availableSlots}=${MAX_ACTIVE_SUBTASKS})`);
              filteredSubtasks.splice(availableSlots);
            }
            
            // Replace subtaskDecomposition with filtered list for the creation loop below
            subtaskDecomposition = filteredSubtasks;
          const childIds = [];
          const parentDescription = svc.extractDescription(ticket);
          
          for (const subtask of subtaskDecomposition) {
            // Build rich task brief for the child issue description
            // ⭐ PHASE_32: Pass all subtasks as siblingInfo so each child knows its siblings
            const taskBrief = await svc._buildChildTaskBrief(subtask, ticket, parentDescription, currentDepth, subtaskDecomposition);
            
            const childId = await svc.planeDb.createSubIssue(
              client, ticket.id, subtask.title, taskBrief, ticket.project_id, ticket.workspace_id
            );
            if (childId) {
              childIds.push({ id: childId, title: subtask.title });
              // Track depth for children
              try {
                await svc.redis.set(`qm:decomp_depth:${childId}`, String(currentDepth + 1), 'EX', 86400);
              } catch (e) { /* best effort */ }
              
              // ⭐ PHASE_45 FIX: Pre-seed child→ROOT workspace mapping so ALL descendants share the ROOT folder
              // Previously (PHASE_33) mapped child→parent, but 3+ levels deep would only merge one level up.
              // Now we walk up to the root ticket and map child→root's workspace, ensuring all deliverables
              // end up in one shared folder regardless of nesting depth.
              if (taskId) {
                try {
                  // Find the ROOT ticket's workspace (may be this ticket, or its ancestor)
                  let rootWorkspaceTaskId = taskId;
                  try {
                    const { rootId } = await svc.findRootTicketId(client, ticket.id);
                    const rootTaskId = await svc.getTicketTaskId(client, rootId);
                    if (rootTaskId) {
                      rootWorkspaceTaskId = rootTaskId;
                      logger.info(`📂 PHASE_45: Root ticket ${rootId.substring(0,8)} has workspace ${rootTaskId}, mapping child to root`);
                    }
                  } catch (rootErr) {
                    logger.debug(`PHASE_45: Root lookup failed, using parent workspace: ${rootErr.message}`);
                  }
                  
                  // Store BOTH: child→rootTaskId AND ensure parent→rootTaskId exists
                  await svc.redis.set(`qm:ticket_task:${childId}`, rootWorkspaceTaskId, 'EX', 86400);
                  await svc.redis.set(`qm:ticket_task:${ticket.id}`, rootWorkspaceTaskId, 'EX', 86400);
                  logger.info(`📂 PHASE_45: Pre-seeded shared workspace: child ${childId} → root workspace ${rootWorkspaceTaskId}`);
                } catch (e) {
                  logger.warn(`Failed to pre-seed workspace for child ${childId}: ${e.message}`);
                }
              }
            }
          }

          if (childIds.length > 0) {
            // Post decomposition comment on parent
            const decompComment = svc.commentFormatter.decompositionComment(childIds, currentDepth + 1);

            await svc.postComment(client, ticket, decompComment);
            await svc.updateTicketStatus(client, ticket.id, 'In Review', ticket.project_id);
            
            // Release lock and return — children will be processed as separate Todo tickets
            await svc.releaseTaskLock(taskId);
            await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
            await svc.setProcessed(ticket, agent.agent_id);
            
            logger.info(`✓ Ticket ${ticket.id} decomposed into ${childIds.length} subtasks (depth ${currentDepth + 1}), parent set to In Review`);
            return; // Exit — children enter queue independently
          }
        } // end else (filteredSubtasks >= 2)
        } // end else (currentDepth < MAX_SUBTASK_DEPTH)
      } // end if (subtaskDecomposition)

      // Store taskId on ticket for workspace URL generation in comments
      ticket._taskId = taskId;

      // ⭐ PHASE_44 FIX 3: Append workspace URL + file listing to agent response
      // Ensures every agent completion comment visible in Plane includes a clickable workspace link.
      // Previously, workspace URLs only appeared in DELIVERY phase or generateUserSummary (non-phased path).
      // Now it's appended BEFORE phased/non-phased branching so it appears in ALL completion comments.
      if (taskId && agentResponse.length > 100 && !agentResponse.includes('/workspace/')) {
        const workspaceSection = svc.commentFormatter._scanWorkspaceStructured(taskId);
        const baseUrl = process.env.WORKSPACE_BASE_URL || 'http://localhost:3010';
        let wsFooter = `\n\n---\n📂 **Workspace:** [${baseUrl}/workspace/${taskId}/](${baseUrl}/workspace/${taskId}/)`;
        if (workspaceSection) {
          wsFooter += `\n${workspaceSection}`;
        }
        agentResponse += wsFooter;
        logger.info(`📂 PHASE_44 FIX 3: Appended workspace URL to agent response for ticket ${ticket.id}`);
      }

      // ⭐ HANDOVER QUALITY GATE: DISABLED - was causing infinite rejection loops
      // TODO: Re-enable with better detection logic that doesn't block progress
      const hasHandover = true; // DISABLED - always pass
      const hasHandover_DISABLED = agentResponse.includes('Developer Handover') || 
                          agentResponse.includes('## 🔄') ||
                          agentResponse.includes('What I Did') ||
                          agentResponse.includes('What I Produced');
      
      if (false && !hasHandover && agentResponse.length > 500) {
        // Check rejection count — don't loop forever (max 1 rejection per ticket per agent)
        const rejectionKey = `qm:handover_rejected:${ticket.id}:${agent.agent_id}`;
        let alreadyRejected = false;
        try {
          alreadyRejected = await svc.redis.get(rejectionKey);
        } catch (e) { /* ignore */ }
        
        if (!alreadyRejected) {
          logger.warn(`❌ HANDOVER QUALITY GATE: Ticket ${ticket.id} rejected — agent ${agent.agent_id} did NOT include Developer Handover section`);
          
          const rejectionComment = `❌ **HANDOVER REJECTED — Missing Developer Handover**

Agent **${agent.agent_id}** completed work but did NOT include the mandatory Developer Handover section.

**RALF Requirement:** Every agent completion MUST end with:

\`\`\`
## 🔄 Developer Handover
**Agent:** [your-id]
**Status:** [Complete | Partial]
### What I Did
### What I Produced  
### What's Left To Do
### Key Context for Next Agent
\`\`\`

**Why this matters:** The next agent reads your handover to understand the thread. Without it, work gets lost and repeated.

**Action:** Ticket returned to queue. The next agent will be instructed to complete the work AND write a proper handover.

---
*Queue Manager — Handover Quality Gate*`;
          
          await svc.postComment(client, ticket, rejectionComment, getQueueManagerUserId());
          
          // Mark as rejected (so we don't infinite loop — only reject once per agent)
          try {
            await svc.redis.set(rejectionKey, '1', 'EX', 3600); // 1 hour TTL
          } catch (e) { /* ignore */ }
          
          // Still save the agent's work as a comment (don't lose it!) but keep ticket in Todo
          await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
          await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
          await svc.releaseTaskLock(taskId);
          await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
          await svc.setProcessed(ticket, agent.agent_id);
          
          logger.info(`🔄 Ticket ${ticket.id} returned to Todo — handover quality gate failed`);
          return; // Exit — ticket will be re-routed on next poll
        } else {
          logger.info(`⚠️ Handover quality gate: already rejected once for ${agent.agent_id} on ${ticket.id}, accepting this time`);
        }
      }

      // ⭐ PHASE_19 (GAP #4): completeRound() — advance the round orchestrator BEFORE the phase gate
      // If orchestrator is active, completing a round may produce NEXT_ROUND (skip gate) or PHASE_COMPLETE (run gate)
      let roundCompletionResult = null;
      let currentPhaseForRounds = null;
      try {
        const livePhaseForRounds = await svc.phaseManager.getPhase(ticket.id);
        if (livePhaseForRounds && livePhaseForRounds.phase) {
          currentPhaseForRounds = livePhaseForRounds.phase;
          const orchActive = currentPhaseForRounds >= PHASES.PLANNING && currentPhaseForRounds <= PHASES.TESTING
            ? await svc.phaseRoundOrchestrator.isActive(ticket.id, currentPhaseForRounds)
            : false;
          
          if (orchActive) {
            logger.info(`[RALF] completeRound() — ticket ${ticket.id} phase ${currentPhaseForRounds}, agent ${agent.agent_id}`);
            roundCompletionResult = await svc.phaseRoundOrchestrator.completeRound(
              ticket.id, currentPhaseForRounds, agent.agent_id, agentResponse, taskId
            );
            logger.info(`[RALF] completeRound() result: ${roundCompletionResult?.action} for ticket ${ticket.id}`);

            if (roundCompletionResult?.action === 'NEXT_ROUND') {
              // ⭐ NEXT_ROUND: Post agent's work, status comment, return to Todo for Round 2 — SKIP phase gate
              logger.info(`[RALF] 🔄 NEXT_ROUND: ticket ${ticket.id} phase ${currentPhaseForRounds} → Round ${roundCompletionResult.state.currentRound}`);
              await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
              
              const statusComment = svc.phaseRoundOrchestrator.formatStatusComment(roundCompletionResult.state);
              await svc.postComment(client, ticket, statusComment, getQueueManagerUserId());
              
              await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
              
              // Release resources and return — next poll picks up Round 2 agent via orchestrator
              await svc.releaseTaskLock(taskId);
              await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
              await svc.setProcessed(ticket, agent.agent_id);
              
              logger.info(`[RALF] ✅ Ticket ${ticket.id} returned to Todo for Round ${roundCompletionResult.state.currentRound}`);
              return; // EXIT — phase gate skipped, round 2 agent picks up on next poll
            }
            // If PHASE_COMPLETE, fall through to normal phase gate below
            logger.info(`[RALF] All rounds complete for ticket ${ticket.id} phase ${currentPhaseForRounds} → proceeding to phase gate`);
          }
        }
      } catch (roundErr) {
        logger.warn(`[RALF] completeRound() error (non-fatal, continuing to gate): ${roundErr.message}`);
      }

      // ⭐ PHASE_19 (GAP #6): Escalation marker parsing — scan agent response for escalation requests
      // This must run BEFORE the phase gate so escalations can intercept normal flow
      try {
        if (agentResponse && agentResponse.length > 200) {
          // Check for REQUEST_EXTRA_ROUND
          const extraRoundMatch = agentResponse.match(/^##\s*ESCALATION:\s*REQUEST_EXTRA_ROUND/m);
          if (extraRoundMatch) {
            logger.warn(`[RALF] 🚨 ESCALATION: REQUEST_EXTRA_ROUND detected in ticket ${ticket.id} by ${agent.agent_id}`);
            await svc.postComment(client, ticket, 
              `🚨 **Escalation: Extra Round Requested** by **${agent.agent_id}**\n\nThe agent believes this phase needs additional work. An extra round has been logged.\n\n---\n*RALF Escalation Protocol*`,
              getQueueManagerUserId()
            );
            // NOTE: Extra round logic can be implemented later — for now, log and continue
          }

          // Check for REGRESS_TO_PHASE_[N]
          const regressMatch = agentResponse.match(/^##\s*ESCALATION:\s*REGRESS_TO_PHASE_(\d+)/m);
          if (regressMatch) {
            const targetPhase = parseInt(regressMatch[1]);
            logger.warn(`[RALF] 🚨 ESCALATION: REGRESS_TO_PHASE_${targetPhase} detected in ticket ${ticket.id} by ${agent.agent_id}`);
            
            if (targetPhase >= PHASES.PLANNING && targetPhase < (currentPhaseForRounds || 99)) {
              const regressionData = await svc.phaseManager.regressPhase(ticket.id, targetPhase);
              if (regressionData) {
                await svc.postComment(client, ticket,
                  `🚨 **Escalation: Phase Regression** by **${agent.agent_id}**\n\nRegressing to Phase ${targetPhase} (${regressionData.phaseName}). Reason: Agent found fundamental issues requiring rework.\n\n---\n*RALF Escalation Protocol*`,
                  getQueueManagerUserId()
                );
                await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
                await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                await svc.releaseTaskLock(taskId);
                await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
                await svc.setProcessed(ticket, agent.agent_id);
                logger.info(`[RALF] Phase regressed to ${targetPhase} for ticket ${ticket.id}`);
                return; // EXIT — regression handled
              }
            }
          }

          // Check for HUMAN_REVIEW_REQUIRED
          const humanMatch = agentResponse.match(/^##\s*ESCALATION:\s*HUMAN_REVIEW_REQUIRED/m);
          if (humanMatch) {
            logger.warn(`[RALF] 🚨 ESCALATION: HUMAN_REVIEW_REQUIRED detected in ticket ${ticket.id} by ${agent.agent_id}`);
            await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
            await svc.escalateToHuman(client, ticket, `Agent ${agent.agent_id} explicitly requested human review via RALF Escalation Protocol`);
            await svc.releaseTaskLock(taskId);
            await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
            await svc.setProcessed(ticket, agent.agent_id);
            return; // EXIT — escalated to human
          }
        }
      } catch (escalationErr) {
        logger.warn(`[RALF] Escalation parsing error (non-fatal): ${escalationErr.message}`);
      }

      // ⭐ PHASE_28: PEER command parsing — scan agent response for peer communication requests
      // This runs AFTER escalation parsing but BEFORE phase gate so peers get notified immediately
      try {
        if (agentResponse && agentResponse.length > 200) {
          
          // HELP_REQUEST: ## PEER: HELP_REQUEST\nTopic: [topic]
          const helpMatch = agentResponse.match(/^##\s*PEER:\s*HELP_REQUEST\s*\n(?:Topic:\s*)?(.+?)(?:\n|$)/m);
          if (helpMatch) {
            const topic = helpMatch[1].trim();
            logger.info(`[PEER] 🆘 HELP_REQUEST from ${agent.agent_id}: "${topic}"`);
            await svc.peerCommunication.requestHelp({
              fromAgentId: agent.agent_id,
              ticketId: ticket.id,
              topic,
              context: agentResponse.substring(0, 1000),
            });
            // Log to Plane comment
            await svc.postComment(client, ticket, 
              `🆘 **Peer Help Request** by **${agent.agent_id}**\n\nTopic: ${topic}\n\n*Broadcasting to swarm — responses will be posted here.*\n\n---\n*Swarm Mesh — Peer Communication*`,
              getQueueManagerUserId());
          }
          
          // KNOWLEDGE_SHARE: ## PEER: KNOWLEDGE_SHARE\nTopic: [topic]\nContent: [content]
          const knowledgeMatch = agentResponse.match(/^##\s*PEER:\s*KNOWLEDGE_SHARE\s*\n(?:Topic:\s*)?(.+?)\n(?:Content:\s*)?(.+?)(?:\n##|\n---|$)/ms);
          if (knowledgeMatch) {
            const topic = knowledgeMatch[1].trim();
            const content = knowledgeMatch[2].trim();
            logger.info(`[PEER] 📚 KNOWLEDGE_SHARE from ${agent.agent_id}: "${topic}"`);
            await svc.peerCommunication.shareKnowledge({
              fromAgentId: agent.agent_id,
              ticketId: ticket.id,
              topic,
              content: content.substring(0, 2000),
            });
          }
          
          // DIRECT_MESSAGE: ## PEER: DIRECT_MESSAGE @[agent-id]\nMessage: [text]
          const dmMatch = agentResponse.match(/^##\s*PEER:\s*DIRECT_MESSAGE\s+@(\S+)\s*\n(?:Message:\s*)?(.+?)(?:\n##|\n---|$)/ms);
          if (dmMatch) {
            const targetAgent = dmMatch[1].trim();
            const message = dmMatch[2].trim();
            logger.info(`[PEER] 💬 DIRECT_MESSAGE from ${agent.agent_id} → @${targetAgent}`);
            await svc.peerCommunication.sendDirectMessage({
              fromAgentId: agent.agent_id,
              toAgentId: targetAgent,
              ticketId: ticket.id,
              message: message.substring(0, 2000),
            });
          }
          
          // CREATE_MESH: ## PEER: CREATE_MESH @agent1 @agent2 "topic"
          const meshMatch = agentResponse.match(/^##\s*PEER:\s*CREATE_MESH\s+(.+)/m);
          if (meshMatch) {
            const args = meshMatch[1].trim();
            const agentIds = (args.match(/@(\S+)/g) || []).map(a => a.substring(1));
            const topicMatch = args.match(/"([^"]+)"/);
            const meshTopic = topicMatch ? topicMatch[1] : `Mesh for ticket ${ticket.id}`;
            logger.info(`[PEER] 🔗 CREATE_MESH by ${agent.agent_id}: agents=[${agentIds.join(',')}], topic="${meshTopic}"`);
            // PrivateMeshManager is on app.js — call via HTTP or instantiate here
            // For now, log and post to Plane
            await svc.postComment(client, ticket,
              `🔗 **Private Mesh Created** by **${agent.agent_id}**\n\nTopic: ${meshTopic}\nMembers: ${agentIds.map(a => `@${a}`).join(', ')}\n\n---\n*Swarm Mesh — Private Channel*`,
              getQueueManagerUserId());
          }
          
          // MESH_MESSAGE: ## PEER: MESH_MESSAGE mesh_id "message"
          const meshMsgMatch = agentResponse.match(/^##\s*PEER:\s*MESH_MESSAGE\s+(\S+)\s+"([^"]+)"/m);
          if (meshMsgMatch) {
            const meshId = meshMsgMatch[1];
            const meshMsg = meshMsgMatch[2];
            logger.info(`[PEER] 📨 MESH_MESSAGE from ${agent.agent_id} to mesh ${meshId}: "${meshMsg.substring(0, 100)}"`);
          }
          
          // MESH_DELEGATE: ## PEER: MESH_DELEGATE mesh_id @agent "task"
          const delegateMatch = agentResponse.match(/^##\s*PEER:\s*MESH_DELEGATE\s+(\S+)\s+@(\S+)\s+"([^"]+)"/m);
          if (delegateMatch) {
            const meshId = delegateMatch[1];
            const targetAgent = delegateMatch[2];
            const delegatedTask = delegateMatch[3];
            logger.info(`[PEER] 📋 MESH_DELEGATE from ${agent.agent_id}: @${targetAgent} → "${delegatedTask}"`);
            await svc.postComment(client, ticket,
              `📋 **Task Delegated** by **${agent.agent_id}** → **@${targetAgent}**\n\nTask: ${delegatedTask}\nMesh: ${meshId}\n\n---\n*Swarm Mesh — Delegation*`,
              getQueueManagerUserId());
          }
          
          // DISSOLVE_MESH: ## PEER: DISSOLVE_MESH mesh_id
          const dissolveMatch = agentResponse.match(/^##\s*PEER:\s*DISSOLVE_MESH\s+(\S+)/m);
          if (dissolveMatch) {
            const meshId = dissolveMatch[1];
            logger.info(`[PEER] 🔚 DISSOLVE_MESH by ${agent.agent_id}: ${meshId}`);
          }
          
          // Save any peer communication log to task workspace
          if (taskId && (helpMatch || knowledgeMatch || dmMatch || meshMatch || delegateMatch)) {
            try {
              const fs = require('fs');
              const path = require('path');
              const peerLogDir = path.join('/app/workspace', taskId, 'mesh-transcripts');
              fs.mkdirSync(peerLogDir, { recursive: true });
              const logFile = path.join(peerLogDir, `peer-comms-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
              const logContent = `# Peer Communication Log\n\n**Agent:** ${agent.agent_id}\n**Ticket:** ${ticket.id}\n**Timestamp:** ${new Date().toISOString()}\n\n## Communication Extracted\n\n${agentResponse.split('\n').filter(l => l.match(/^##\s*PEER:/)).join('\n')}\n`;
              fs.writeFileSync(logFile, logContent);
              logger.info(`[PEER] 📝 Saved peer communication log to ${logFile}`);
            } catch (logErr) {
              logger.debug(`[PEER] Failed to save peer log: ${logErr.message}`);
            }
          }
        }
      } catch (peerErr) {
        logger.warn(`[PEER] Peer command parsing error (non-fatal): ${peerErr.message}`);
      }

      // ⭐ PHASE GATE CHECK: If ticket is in phased lifecycle, check phase gate before advancing
      // FIX Phase 24: Read phase directly from Redis (analysis variable is not in scope here)
      let currentPhaseForGate = null;
      let phaseDataForGate = null;
      try {
        const livePhaseData = await svc.phaseManager.getPhase(ticket.id);
        if (livePhaseData && livePhaseData.phase) {
          currentPhaseForGate = livePhaseData.phase;
          phaseDataForGate = livePhaseData;
          logger.info(`📍 Phase gate: ticket ${ticket.id} is at phase ${currentPhaseForGate} (${livePhaseData.phaseName})`);
        }
      } catch (phaseErr) {
        logger.warn(`Phase gate lookup failed for ${ticket.id}: ${phaseErr.message}`);
      }
      
      if (currentPhaseForGate && phaseDataForGate) {
        // ⭐ PHASE_40 FIX: Workspace file recovery for empty responses
        // When PM writes plan to workspace files but agentResponse is empty/default,
        // scan workspace files and use the best file content as the agentResponse
        if (agentResponse.length < 100 && taskId) {
          try {
            const fs = require('fs');
            const path = require('path');
            const wsDir = path.join('/app/workspace', taskId);
            if (fs.existsSync(wsDir)) {
              let bestContent = '';
              let bestFile = '';
              // Scan root .md files
              const scanDir = (dir, prefix = '') => {
                try {
                  const files = fs.readdirSync(dir).filter(f => 
                    (f.endsWith('.md') || f.endsWith('.txt')) && !f.startsWith('_')
                  );
                  for (const file of files) {
                    try {
                      const filePath = path.join(dir, file);
                      const stat = fs.statSync(filePath);
                      if (stat.isFile() && stat.size < 50000) {
                        const content = fs.readFileSync(filePath, 'utf8');
                        if (content.length > bestContent.length) {
                          bestContent = content;
                          bestFile = prefix ? `${prefix}/${file}` : file;
                        }
                      }
                    } catch (e) { /* skip */ }
                  }
                } catch (e) { /* skip */ }
              };
              scanDir(wsDir);
              scanDir(path.join(wsDir, 'notes'), 'notes');
              scanDir(path.join(wsDir, 'deliverables'), 'deliverables');
              
              if (bestContent.length > 200) {
                logger.info(`📂 PHASE_40: Recovered ${bestContent.length} chars from workspace file: ${bestFile} (original response was ${agentResponse.length} chars)`);
                agentResponse = bestContent;
              }
            }
          } catch (wsErr) {
            logger.debug(`PHASE_40: Workspace recovery error: ${wsErr.message}`);
          }
        }
        
        // ⭐ REVIEW CYCLE VERDICT RECORDING: If REVIEW phase with active cycle,
        // use PhaseReviewCycle consensus engine instead of simple checkGate()
        if (currentPhaseForGate === PHASES.REVIEW) {
          const reviewCycleActive = await svc.reviewCycle.isActive(ticket.id, PHASES.REVIEW);
          
          if (reviewCycleActive) {
            // Post agent's work as a comment
            await svc.postComment(client, ticket, agentResponse, agentPlaneUserId);
            
            const cycleState = await svc.reviewCycle.getCycleState(ticket.id, PHASES.REVIEW);
            
            if (cycleState && cycleState.state === 'awaiting_revision') {
              // ── EXECUTOR REVISION COMPLETE ─────────────────────────────
              // The executor just addressed reviewer feedback. Start next round.
              logger.info(`🔧 Review cycle: Executor ${agent.agent_id} completed revision for ticket ${ticket.id}, starting next round`);
              
              const nextRoundState = await svc.reviewCycle.startNextRound(ticket.id, PHASES.REVIEW);
              const roundComment = svc.reviewCycle.formatCycleComment(nextRoundState);
              await svc.postComment(client, ticket, roundComment, getQueueManagerUserId());
              
              // Return to Todo — next poll will route to first pending reviewer
              await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
            } else {
              // ── REVIEWER VERDICT ───────────────────────────────────────
              // A reviewer just completed their review. Parse and record verdict.
              const { verdict, feedback } = svc.reviewCycle.parseVerdict(agentResponse);
              logger.info(`📝 Review cycle: ${agent.agent_id} verdict=${verdict} for ticket ${ticket.id} (round ${cycleState.currentRound})`);
              
              const updatedState = await svc.reviewCycle.recordVerdict(
                ticket.id, PHASES.REVIEW, agent.agent_id, verdict, feedback
              );
              
              // Post cycle status comment
              const cycleComment = svc.reviewCycle.formatCycleComment(updatedState);
              await svc.postComment(client, ticket, cycleComment, getQueueManagerUserId());
              
              if (updatedState.action === 'CONSENSUS') {
                // 🎉 All reviewers approved — advance to next phase (DELIVERY)
                logger.info(`✅ Review cycle CONSENSUS for ticket ${ticket.id} — advancing to DELIVERY`);
                
                const consensusComment = `✅ **Review Cycle Complete — Consensus Reached**\n\nAll ${cycleState.reviewerAgentIds.length} reviewers approved the work in round ${updatedState.currentRound}.\n\n---\n*Phase Review Cycle v1.0*`;
                await svc.postComment(client, ticket, consensusComment, getQueueManagerUserId());
                
                const nextPhaseData = await svc.phaseManager.advancePhase(ticket.id);
                
                if (nextPhaseData && nextPhaseData.phase === PHASES.DELIVERY) {
                  // DELIVERY is automated — complete immediately
                  const delivWorkspaceSection = ticket.task_id || ticket._taskId ? svc.commentFormatter._scanWorkspaceStructured(ticket.task_id || ticket._taskId) : '';
                  const delivWorkspaceUrl = ticket.task_id || ticket._taskId ? `\n\n📂 **Workspace:** http://localhost:3010/workspace/${ticket.task_id || ticket._taskId}/` : '';
                  const deliveryComment = svc.phaseManager.getPhaseComment(PHASES.DELIVERY, 'entering',
                    `All reviews passed. Delivering to customer.${delivWorkspaceUrl}${delivWorkspaceSection ? '\n\n' + delivWorkspaceSection : ''}`);
                  await svc.postComment(client, ticket, deliveryComment, getQueueManagerUserId());
                  await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
                  try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
                } else if (nextPhaseData) {
                  const nextPhaseComment = svc.phaseManager.getPhaseComment(nextPhaseData.phase, 'entering',
                    `Review consensus reached. Advancing to ${nextPhaseData.phaseName}.`);
                  await svc.postComment(client, ticket, nextPhaseComment, getQueueManagerUserId());
                  await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                } else {
                  // End of lifecycle
                  await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
                  try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
                }
                
              } else if (updatedState.action === 'REVISE') {
                // 🔧 Reviewers want changes — route back to executor
                logger.info(`🔧 Review cycle REVISE for ticket ${ticket.id} — routing back to executor ${cycleState.executorAgentId}`);
                
                const revisionRequests = updatedState.revisionRequests || [];
                const revisionPrompt = svc.reviewCycle.buildRevisionPrompt(updatedState, revisionRequests);
                
                // Store revision prompt in Redis so it's available when executor is dispatched
                try {
                  await svc.redis.set(`qm:revision_prompt:${ticket.id}`, revisionPrompt, 'EX', 86400);
                } catch (e) { logger.debug(`Failed to cache revision prompt: ${e.message}`); }
                
                const reviseComment = `🔧 **Revision Requested** — Round ${updatedState.currentRound}\n\n${revisionRequests.length} reviewer(s) requested changes. Routing back to executor **${cycleState.executorAgentId}**.\n\n---\n*Phase Review Cycle v1.0*`;
                await svc.postComment(client, ticket, reviseComment, getQueueManagerUserId());
                
                // Return to Todo — assessAndRoute will detect awaiting_revision and route to executor
                await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                
              } else if (updatedState.action === 'CONTINUE_ROUND') {
                // More reviewers pending — return to Todo for next reviewer pickup
                logger.info(`🔄 Review cycle: ${updatedState.pendingReviewers.length} reviewers remaining for ticket ${ticket.id}`);
                await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                
              } else if (updatedState.action === 'MAX_ROUNDS') {
                // ⏱️ Max rounds hit — advance with warning
                logger.warn(`⏱️ Review cycle MAX_ROUNDS for ticket ${ticket.id} — forcing advancement`);
                
                const maxRoundsComment = `⏱️ **Review Cycle — Max Rounds Reached**\n\nReview cycle reached ${updatedState.maxRounds} rounds without full consensus. Advancing with best effort.\n\n---\n*Phase Review Cycle v1.0*`;
                await svc.postComment(client, ticket, maxRoundsComment, getQueueManagerUserId());
                
                const nextPhaseData = await svc.phaseManager.advancePhase(ticket.id);
                
                if (nextPhaseData && nextPhaseData.phase === PHASES.DELIVERY) {
                  const delivWorkspaceSection = ticket.task_id || ticket._taskId ? svc.commentFormatter._scanWorkspaceStructured(ticket.task_id || ticket._taskId) : '';
                  const delivWorkspaceUrl = ticket.task_id || ticket._taskId ? `\n\n📂 **Workspace:** http://localhost:3010/workspace/${ticket.task_id || ticket._taskId}/` : '';
                  const deliveryComment = svc.phaseManager.getPhaseComment(PHASES.DELIVERY, 'entering',
                    `Review cycle complete (max rounds). Delivering to customer.${delivWorkspaceUrl}${delivWorkspaceSection ? '\n\n' + delivWorkspaceSection : ''}`);
                  await svc.postComment(client, ticket, deliveryComment, getQueueManagerUserId());
                  await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
                  try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
                } else if (nextPhaseData) {
                  await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                } else {
                  await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
                  try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
                }
              }
            }
            
            // Skip the normal gate logic below — review cycle handled everything
          } else {
            // No active review cycle — use normal gate logic (legacy single-reviewer path)
            // Fall through to standard phase gate handling below
            await svc._handleStandardPhaseGate(client, ticket, agent, agentPlaneUserId, agentResponse, currentPhaseForGate, phaseDataForGate);
          }
        } else {
          // ── STANDARD PHASE GATE (non-REVIEW phases) ────────────────
          await svc._handleStandardPhaseGate(client, ticket, agent, agentPlaneUserId, agentResponse, currentPhaseForGate, phaseDataForGate);
        }
      } else {
        // NON-PHASED FLOW (subtasks or legacy): Use original evaluation logic
        const evaluation = await svc.evaluateAgentCompletion(agentResponse, ticket, result);
        
        logger.info(`Ticket ${ticket.id} evaluation: ${evaluation.status} (reason: ${evaluation.reason || 'complete'})`);
        
        if (evaluation.status === 'CUSTOMER_ACTION') {
          // ⭐ TWO-FACED SUMMARIES: Parent tickets get customer-facing, leaf tickets get technical
          let finalSummary = evaluation.summary;
          try {
            const isParent = await svc.planeDb.hasChildren(client, ticket.id);
            if (isParent) {
              logger.info(`🎭 Two-faced summary: Ticket ${ticket.id} is a PARENT — using customer-facing summary`);
              finalSummary = svc.commentFormatter.customerSummary(agentResponse);
            } else {
              logger.info(`🔧 Two-faced summary: Ticket ${ticket.id} is a LEAF — using full technical detail`);
              finalSummary = svc.commentFormatter.completionComment(agent.agent_id, evaluation.summary, false, ticket.task_id);
            }
          } catch (twoFacedErr) {
            logger.warn(`Two-faced summary check failed for ${ticket.id}, using default: ${twoFacedErr.message}`);
          }

          // Work is complete - move to Customer Action with appropriate summary
          await svc.postComment(client, ticket, finalSummary, agentPlaneUserId);
          await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
          
          logger.info(`✅ Ticket ${ticket.id} marked complete, moved to Customer Action`);

          // ⭐ PHASE_31 FIX: When a subtask completes, post results on parent + trigger immediate check
          try {
            const parentCheck = await client.query(
              'SELECT parent_id FROM issues WHERE id = $1', [ticket.id]
            );
            const parentId = parentCheck.rows[0]?.parent_id;
            
            if (parentId) {
              logger.info(`📤 Subtask ${ticket.id} completed (non-phased) — posting results to parent ${parentId}`);
              
              const parentInfo = await client.query(
                'SELECT id, name, project_id, workspace_id FROM issues WHERE id = $1', [parentId]
              );
              
              if (parentInfo.rows.length > 0) {
                const parent = parentInfo.rows[0];
                const subtaskSummary = `📋 **Subtask Completed** — ${ticket.name || 'Subtask'}

**Agent:** ${agent.agent_id}
**Status:** ✅ Complete

**Summary:**
${(finalSummary || agentResponse || '').substring(0, 1500)}${(finalSummary || agentResponse || '').length > 1500 ? '\n\n*(truncated)*' : ''}

---
*Subtask result auto-posted by Queue Manager — Subtask Aggregation Pipeline*`;
                
                await svc.postComment(
                  client,
                  { id: parent.id, project_id: parent.project_id, workspace_id: parent.workspace_id },
                  subtaskSummary,
                  getQueueManagerUserId()
                );
                
                logger.info(`✅ Posted subtask ${ticket.id} results on parent ${parentId}`);
                
                // Trigger IMMEDIATE parent completion check
                logger.info(`🔍 Triggering immediate parent completion check for ${parentId}`);
                await svc.checkParentCompletion(client);
              }
            }
          } catch (parentErr) {
            logger.warn(`Failed to post subtask results on parent for ${ticket.id}: ${parentErr.message}`);
          }
        } else {
          // More work needed - post detailed handoff and keep in Todo
          const handoffComment = svc.commentFormatter.handoffComment(agent.agent_id, agentResponse, evaluation.reason);

          await svc.postComment(client, ticket, handoffComment, agentPlaneUserId);
          await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
          
          logger.info(`🔄 Ticket ${ticket.id} needs more work, kept in Todo queue`);
        }
      } // end of phased vs non-phased if-else

      // ⭐ RELEASE LOCK: Agent completed successfully
      await svc.releaseTaskLock(taskId);

      // Decrement agent load (with workspace tracking)
      await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);

      // SMART CIRCUIT BREAKER: Track response content hash for stale loop detection
      try {
        const crypto = require('crypto');
        const responseHash = crypto.createHash('md5')
          .update(agentResponse.substring(0, 5000)) // Hash first 5KB for efficiency
          .digest('hex')
          .substring(0, 12); // Short hash is sufficient
        
        const responseHashKey = `qm:response_hashes:${ticket.id}`;
        const existingStr = await svc.redis.get(responseHashKey);
        const hashes = existingStr ? JSON.parse(existingStr) : [];
        hashes.push(responseHash);
        
        // Keep only last 5 hashes
        if (hashes.length > 5) hashes.splice(0, hashes.length - 5);
        
        await svc.redis.set(responseHashKey, JSON.stringify(hashes), 'EX', 7200); // 2h TTL
        logger.debug(`Response hash for ticket ${ticket.id}: ${responseHash} (${hashes.length} tracked)`);
      } catch (hashErr) {
        logger.debug(`Failed to track response hash for ${ticket.id}: ${hashErr.message}`);
      }

      // ⭐ PHASE_20 GAP F: Cross-Ticket Memory — store learnings on ticket completion
      // When ticket reaches Customer Action (substantive work done), extract and store learnings
      try {
        if (agentResponse && agentResponse.length > 500) {
          const ticketAnalysis = svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket));
          svc.swarmMemory.extractAndStore(ticket, agentResponse, {
            agentId: agent.agent_id,
            complexity: ticketAnalysis.complexity,
            categories: ticketAnalysis.categories || [],
            phase: currentPhaseForRounds || null,
          }).catch(memErr => logger.debug(`[SwarmMemory] Background store failed: ${memErr.message}`));
        }
      } catch (memErr) {
        logger.debug(`[SwarmMemory] Store setup failed (non-fatal): ${memErr.message}`);
      }

      // ⭐ PHASE_21 GAP B: Record response time + completion metrics
      if (svc.agentMetrics && typeof _metricsStartMs !== 'undefined') {
        const durationMs = Date.now() - _metricsStartMs;
        const currentPhaseStr = currentPhaseForRounds || currentPhaseForGate || 'unknown';
        svc.agentMetrics.recordResponseTime(agent.agent_id, ticket.id, currentPhaseStr, durationMs).catch(() => {});
        const isComplete = agentResponse && agentResponse.length > 500;
        svc.agentMetrics.recordCompletion(agent.agent_id, ticket.id, isComplete, currentPhaseStr).catch(() => {});
        logger.info(`📊 Metrics: ${agent.agent_id} → ${durationMs}ms, phase=${currentPhaseStr}, complete=${isComplete}`);
      }

      // Mark ticket as processed in Redis (for cooldown tracking with dynamic complexity)
      const ticketComplexity = svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket)).complexity || 'medium';
      await svc.setProcessed(ticket, agent.agent_id, ticketComplexity);

      logger.info(`✓ Agent processing complete for ticket ${ticket.id}`);
  }
}

module.exports = DispatchCompletionHandler;
