/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): assessAndRoute phase/depth routing decision tree, mesh-broadcast bid routing, and routeToAgent dispatch hand-off
 */

/**
 * TicketRoutingEngine — agent-selection and routing decision tree of the queue manager.
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
const { getPlaneUserId, getQueueManagerUserId } = require('./AgentPlaneUserMap');

/**
 * @description Agent-selection and routing decision tree of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class TicketRoutingEngine {
  /**
   * Assess ticket and route to appropriate agent
   * FIX 6: Circuit breaker — max 3 routing attempts per ticket
   */
  static async assessAndRoute(svc, client, ticket) {
    try {
      // SMART CIRCUIT BREAKER: Detect stale loops (3 consecutive no-progress)
      // Instead of a dumb counter at 50, we track content hashes of recent responses.
      // If the last 3 responses are identical (same hash), the ticket is looping.
      const routeCountKey = `qm:route_count:${ticket.id}`;
      const responseHashKey = `qm:response_hashes:${ticket.id}`;
      let routeCount = 0;
      try {
        const countStr = await svc.redis.get(routeCountKey);
        routeCount = countStr ? parseInt(countStr) : 0;
      } catch (e) {
        logger.warn(`Failed to check route count for ${ticket.id}: ${e.message}`);
      }

      // Check for consecutive no-progress (stale loop detection)
      let isStaleLoop = false;
      try {
        const hashesStr = await svc.redis.get(responseHashKey);
        if (hashesStr) {
          const hashes = JSON.parse(hashesStr);
          // If we have 3+ hashes and the last 3 are identical → stale loop
          if (hashes.length >= 3) {
            const last3 = hashes.slice(-3);
            isStaleLoop = last3[0] === last3[1] && last3[1] === last3[2];
            if (isStaleLoop) {
              logger.warn(`🔄 Stale loop detected for ticket ${ticket.id}: last 3 responses identical (hash: ${last3[0]})`);
            }
          }
        }
      } catch (e) {
        logger.debug(`Failed to check response hashes for ${ticket.id}: ${e.message}`);
      }

      // Circuit breaker: stale loop OR hard cap at 3 (emergency fix from runaway ticket loop)
      // PHASE_00_SESSION_05: Reduced from 20 to 3 to prevent infinite retry loops
      if (isStaleLoop || routeCount >= 3) {
        const reason = isStaleLoop 
          ? `3 consecutive identical responses detected (agents are repeating themselves)`
          : `${routeCount} routing attempts without resolution`;
        
        logger.warn(`🛑 Circuit breaker triggered for ticket ${ticket.id}: ${reason}`);
        
        const circuitBreakerComment = svc.commentFormatter.circuitBreakerComment(reason, routeCount);

        await svc.postComment(client, ticket, circuitBreakerComment);
        await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
        
        // Clean up tracking keys
        try {
          await svc.redis.del(routeCountKey);
          await svc.redis.del(responseHashKey);
        } catch (e) { /* best effort cleanup */ }
        
        return;
      }

      // ⭐ PHASE_17: Check if this ticket has a pending approval that was granted
      // Human moved ticket from "Approval Required" back to "Todo" → inject approval context
      try {
        const approvalContext = await svc.checkAndConsumeApproval(ticket.id);
        if (approvalContext) {
          logger.info(`[ApprovalGranted] Ticket ${ticket.id}: injecting approval context into dispatch`);
          // Store approval context on ticket object so routeToAgent() can inject it into phasePrompt
          ticket._approvalContext = approvalContext;
        }
      } catch (approvalErr) {
        logger.debug(`[ApprovalGranted] Approval check failed (non-fatal): ${approvalErr.message}`);
      }

      // Extract ticket description text
      const description = svc.extractDescription(ticket);
      
      // Analyze ticket (action categories, complexity, priority — used for RANKING, not filtering)
      const analysis = svc.capabilityMatcher.analyzeTicket(description);
      logger.info(`Ticket analysis: categories=[${(analysis.categories || []).join(', ')}], hints=[${analysis.capabilities.join(', ')}], complexity=${analysis.complexity}, priority=${analysis.priority}`);

      // ⭐ HIERARCHICAL ROUTING: Check ticket depth to determine routing strategy
      // Depth 0 (root tickets) → ALWAYS project-manager first (triage + decompose)
      // Depth 1+ (subtasks) → Use CapabilityMatcher for specialist routing
      let ticketDepth = 0;
      try {
        // Check Redis for decomposition depth
        const depthKey = `qm:decomp_depth:${ticket.id}`;
        const depthStr = await svc.redis.get(depthKey);
        ticketDepth = depthStr ? parseInt(depthStr) : 0;
        
        // Also check if ticket has a parent in DB (if Redis missed it)
        if (ticketDepth === 0) {
          const parentCheck = await client.query(
            'SELECT parent_id FROM issues WHERE id = $1', [ticket.id]
          );
          if (parentCheck.rows[0]?.parent_id) {
            ticketDepth = 1; // Has parent = at least depth 1
          }
        }
      } catch (depthErr) {
        logger.debug(`Depth check for ${ticket.id}: ${depthErr.message}`);
      }

      // Context window budget based on depth (tokens)
      const CONTEXT_BUDGETS = { 0: 125000, 1: 100000, 2: 50000, 3: 25000, 4: 15000 };
      const contextBudget = CONTEXT_BUDGETS[Math.min(ticketDepth, 4)] || 15000;
      
      // Store context budget on analysis for downstream use
      analysis.contextBudget = contextBudget;
      analysis.ticketDepth = ticketDepth;

      // ⭐ TICKET LIFECYCLE: Initialize or read current phase from Redis
      // Root tickets (depth 0) use the 6-phase lifecycle; subtasks skip straight to execution
      let currentPhaseData = null;
      if (ticketDepth === 0) {
        currentPhaseData = await svc.phaseManager.getPhase(ticket.id);
        if (!currentPhaseData) {
          // New ticket — initialize at INTAKE, then auto-advance to PLANNING
          const complexity = analysis.complexity || 'medium';
          await svc.phaseManager.setPhase(ticket.id, PHASES.INTAKE, { complexity });
          currentPhaseData = await svc.phaseManager.advancePhase(ticket.id);
          logger.info(`📋 Ticket ${ticket.id}: Lifecycle initialized → Phase ${currentPhaseData.phase} (${currentPhaseData.phaseName}), complexity=${complexity}`);
          
          // Post phase entry comment
          const phaseComment = svc.phaseManager.getPhaseComment(currentPhaseData.phase, 'entering', 
            `Ticket entered phased processing pipeline. Complexity: **${complexity}**`);
          await svc.postComment(client, ticket, phaseComment, getQueueManagerUserId());
        } else {
          logger.info(`📋 Ticket ${ticket.id}: Resuming at Phase ${currentPhaseData.phase} (${currentPhaseData.phaseName})`);
        }
      }
      
      const currentPhase = currentPhaseData?.phase || null;
      analysis.currentPhase = currentPhase;
      analysis.phaseData = currentPhaseData;

      // Query ALL agents in this workspace
      const allAgents = await svc.agentRegistry.query({
        workspace: ticket.workspace_id
      });

      if (allAgents.length === 0) {
        await svc.escalateToHuman(client, ticket, `No agents registered for workspace ${ticket.workspace_id}`);
        return;
      }

      let agent;

      if (ticketDepth === 0 && currentPhase) {
        // ⭐ PHASE_18/19: RALF LIFECYCLE — Competency-ranked multi-round orchestration
        // Phases 2-5 use PhaseRoundOrchestrator for 2 mandatory rounds per phase
        // Phase 6 (REVIEW) uses PhaseReviewCycle for consensus-driven review (more mature)
        // Phase 1 (INTAKE) and 7 (DELIVERY) are automated single-pass
        const orchestratorEligible = currentPhase >= PHASES.PLANNING && currentPhase <= PHASES.TESTING;
        let roundOrchestratorActive = false;

        if (orchestratorEligible) {
          logger.info(`[RALF] Checking PhaseRoundOrchestrator.isActive() for ticket ${ticket.id} phase ${currentPhase}...`);
          roundOrchestratorActive = await svc.phaseRoundOrchestrator.isActive(ticket.id, currentPhase);
          logger.info(`[RALF] isActive(${ticket.id}, ${currentPhase}) = ${roundOrchestratorActive}`);
        }

        // ⭐ PHASE_19 FIX (GAP #1): If orchestrator NOT active for eligible phase, INITIALIZE it now
        // This is the critical wiring that was missing — initPhaseRounds() was never called
        if (!roundOrchestratorActive && orchestratorEligible) {
          try {
            logger.info(`[RALF] Initializing PhaseRoundOrchestrator for ticket ${ticket.id} phase ${currentPhase}...`);
            
            // Step 1: Competency-rank ALL agents for this phase
            const rankedAgents = await svc.competencyRanker.rankAgentsForPhase(
              ticket, analysis, currentPhase, allAgents, {
                excludeAgents: [],
                executorAgentId: currentPhaseData?.executingAgent || null,
              }
            );
            logger.info(`[RALF] CompetencyRanker returned ${rankedAgents.length} ranked agents for phase ${currentPhase}: ${rankedAgents.slice(0, 5).map(r => `${r.agentId}(${r.confidence.toFixed(2)}/${r.role})`).join(', ')}`);

            if (rankedAgents.length > 0) {
              // Step 2: Take top N agents (N = maxRounds for this phase)
              const maxRounds = svc.phaseRoundOrchestrator.getMaxRounds(currentPhase);
              const topAgents = rankedAgents.slice(0, maxRounds);
              
              // Step 3: Initialize round tracking in Redis
              const roundState = await svc.phaseRoundOrchestrator.initPhaseRounds(
                ticket.id, currentPhase, topAgents, {
                  complexity: analysis.complexity || 'medium',
                  executorAgentId: currentPhaseData?.executingAgent || null,
                }
              );
              logger.info(`[RALF] ✅ PhaseRoundOrchestrator initialized: ${maxRounds} rounds, agents=${topAgents.map(a => a.agentId).join(',')}`);

              // Step 4: Store role assignments for this ticket lifecycle
              const roles = {};
              topAgents.forEach(a => { roles[a.role] = a.agentId; });
              await svc.competencyRanker.storeRoleAssignments(ticket.id, roles);
              logger.info(`[RALF] Stored role assignments: ${JSON.stringify(roles)}`);

              roundOrchestratorActive = true;
            } else {
              logger.warn(`[RALF] CompetencyRanker returned 0 agents — cannot init orchestrator, falling back to legacy routing`);
            }
          } catch (initErr) {
            logger.warn(`[RALF] PhaseRoundOrchestrator init failed (falling back to legacy): ${initErr.message}`);
            roundOrchestratorActive = false;
          }
        }

        if (roundOrchestratorActive) {
          // ⭐ MULTI-ROUND: Orchestrator is managing this phase — route to current round's agent
          const roundAgent = await svc.phaseRoundOrchestrator.getCurrentRoundAgent(ticket.id, currentPhase);
          if (roundAgent) {
            agent = allAgents.find(a => a.agent_id === roundAgent.agentId);
            if (!agent) {
              // Assigned agent not in registry — use first available
              agent = allAgents[0];
              logger.warn(`[RALF] Round agent ${roundAgent.agentId} not in registry, using ${agent.agent_id}`);
            }
            logger.info(`🔄 [RALF] Ticket ${ticket.id} Phase ${currentPhase} Round ${roundAgent.round}/${roundAgent.maxRounds} → ${agent.agent_id} (role: ${roundAgent.role})`);
          } else {
            logger.warn(`[RALF] getCurrentRoundAgent() returned null for ${ticket.id} phase ${currentPhase}, falling back to legacy`);
            roundOrchestratorActive = false; // Force legacy fallback
          }
        }
        
        // If orchestrator didn't select an agent, use legacy routing as fallback
        if (!agent && currentPhase === PHASES.DELIVERY) {
          // Phase 6 (DELIVERY) is automated — package and move to Customer Action
          logger.info(`📦 Phase 6 (DELIVERY): Auto-completing ticket ${ticket.id}`);

          // PHASE_37: Include workspace link + file scan in delivery comment
          const workspaceSection = ticket.task_id ? svc.commentFormatter._scanWorkspaceStructured(ticket.task_id) : '';
          const workspaceUrl = ticket.task_id ? `\n\n📂 **Workspace:** http://localhost:3010/workspace/${ticket.task_id}/` : '';
          const deliveryComment = svc.phaseManager.getPhaseComment(PHASES.DELIVERY, 'entering',
            `All phases complete. Packaging deliverable for customer review.${workspaceUrl}${workspaceSection ? '\n\n' + workspaceSection : ''}`);
          await svc.postComment(client, ticket, deliveryComment, getQueueManagerUserId());
          await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);
          
          // Clean up phase tracking
          try { await svc.redis.del(`qm:ticket_phase:${ticket.id}`); } catch (e) { /* best effort */ }
          return;
        }
        
        if (currentPhase === PHASES.PLANNING) {
          // Phase 2: PLANNING → Mesh Broadcast primary, LLM Router secondary, PM tertiary
          // ⭐ MESH BROADCAST (Phase 3): Broadcast BID_REQUEST to all agents
          agent = await svc.meshBroadcastRoute(ticket, analysis, allAgents, { phase: 'PLANNING' });
          if (agent) {
            logger.info(`📡 Phase 2 (MESH BID): ${ticket.id} → ${agent.agent_id}`);
          }
          // Fallback 1: LLM-powered agent selection
          if (!agent) {
            try {
              const llmResult = await svc.llmRouter.selectAgent(ticket, allAgents);
              if (llmResult && llmResult.agentId) {
                agent = allAgents.find(a => a.agent_id === llmResult.agentId);
                if (agent) {
                  logger.info(`🧠 Phase 2 (LLM ROUTING fallback): ${ticket.id} → ${agent.agent_id} (confidence: ${llmResult.confidence})`);
                }
              }
            } catch (llmErr) {
              logger.warn(`[LLMRouter] Phase 2 LLM routing failed: ${llmErr.message}`);
            }
          }
          // Fallback 2: project-manager (original behavior)
          if (!agent) {
            agent = allAgents.find(a => a.agent_id === 'project-manager') || allAgents[0];
            logger.info(`📝 Phase 2 (PLANNING fallback): ${ticket.id} → ${agent.agent_id}`);
          }
          
        } else if (currentPhase === PHASES.SPECIALIST_INPUT) {
          // Phase 3: SPECIALIST_INPUT → Mesh broadcast primary, phaseManager fallback
          agent = await svc.meshBroadcastRoute(ticket, analysis, allAgents, { phase: 'SPECIALIST_INPUT', excludeAgents: ['project-manager'] });
          if (agent) {
            logger.info(`📡 Phase 3 (MESH BID): ${ticket.id} → ${agent.agent_id}`);
          }
          if (!agent) {
            agent = svc.phaseManager.selectAgentForPhase(PHASES.SPECIALIST_INPUT, allAgents, currentPhaseData, analysis);
          }
          if (!agent) agent = allAgents.find(a => a.agent_id !== 'project-manager') || allAgents[0];
          logger.info(`🔍 Phase 3 (SPECIALIST): ${ticket.id} → ${agent.agent_id}`);
          
        } else if (currentPhase === PHASES.EXECUTION) {
          // Phase 4: EXECUTION — routing priority order:
          // 1. PM-assigned agent (explicit assignment from planning phase)
          // 2. LLM Router PRIMARY — reads all agents' selector_descriptor + routing_keywords dynamically
          // 3. Mesh broadcast — self-nomination (bots claim what they want)
          // 4. CapabilityMatcher — last resort keyword scoring fallback
          //
          // ⭐ LLM Router is PRIMARY because it reads each agent's selector_descriptor
          // and routing_keywords from the registry dynamically — no hardcoding needed.
          // With 30 bots, only the LLM can semantically match ticket intent to agent domain.

          // Step 1: PM-assigned agent (explicit assignment from planning phase)
          const pmAssignments = await svc.getPMAgentAssignments(ticket);
          if (pmAssignments && pmAssignments.length > 0) {
            const primaryAssignment = pmAssignments[0]; // Order 1 = primary
            const pmAgent = allAgents.find(a => a.agent_id === primaryAssignment.agentId);
            if (pmAgent) {
              agent = pmAgent;
              logger.info(`🎯 PM-ASSIGNED: ${agent.agent_id} for ticket ${ticket.id} (reason: ${primaryAssignment.reason || 'PM decision'})`);
            } else {
              logger.warn(`⚠️ PM assigned ${primaryAssignment.agentId} but agent not found in registry, falling back to LLM router`);
            }
          }
          // Step 2: LLM Router PRIMARY — semantically matches ticket to agent using selector_descriptor
          // This is the intelligent path: LLM sees all 30 agents with their self-descriptions
          if (!agent) {
            try {
              const llmResult = await svc.llmRouter.selectAgent(ticket, allAgents);
              if (llmResult && llmResult.agentId) {
                agent = allAgents.find(a => a.agent_id === llmResult.agentId);
                if (agent) {
                  logger.info(`🧠 Phase 4 (LLM ROUTING PRIMARY): ${ticket.id} → ${agent.agent_id} (confidence: ${llmResult.confidence}, reason: ${llmResult.reason})`);
                }
              }
            } catch (llmErr) {
              logger.warn(`[LLMRouter] Phase 4 LLM routing failed: ${llmErr.message}`);
            }
          }
          // Step 3: Mesh broadcast — let bots self-nominate (parallel with LLM, used as override if bots claim it)
          if (!agent) {
            agent = await svc.meshBroadcastRoute(ticket, analysis, allAgents, { phase: 'EXECUTION' });
            if (agent) {
              logger.info(`📡 Phase 4 (MESH BID fallback): ${ticket.id} → ${agent.agent_id}`);
            }
          }
          // Step 4: CapabilityMatcher — last resort keyword scoring (dynamic routing_keywords still apply)
          if (!agent) {
            agent = svc.capabilityMatcher.findBestMatch(allAgents, {
              capabilities: analysis.capabilities,
              priority: analysis.priority,
              ticketId: ticket.id,
              ticketDescription: description,
            });
            if (!agent) agent = allAgents[0];
            logger.info(`⚡ Phase 4 (CAPABILITY MATCHER last resort): ${ticket.id} → ${agent.agent_id}`);
          }
          // Store executing agent ID so review phase can pick a DIFFERENT agent
          await svc.phaseManager.setPhase(ticket.id, PHASES.EXECUTION, {
            complexity: currentPhaseData.complexity,
            executingAgent: agent.agent_id
          });
          logger.info(`⚡ Phase 4 (EXECUTION): ${ticket.id} → ${agent.agent_id}`);
          
        } else if (currentPhase === PHASES.TESTING) {
          // Phase 5: TESTING → Route to a DIFFERENT agent than executor (fresh eyes)
          const testExecutor = currentPhaseData?.executingAgent;
          
          // Try Mesh Broadcast first — let agents bid on testing
          agent = await svc.meshBroadcastRoute(ticket, analysis, allAgents, { 
            phase: 'TESTING', 
            excludeAgents: [testExecutor, 'project-manager'].filter(Boolean) 
          });
          if (agent) {
            logger.info(`📡 Phase 5 (MESH BID TESTING): ${ticket.id} → ${agent.agent_id}`);
          }
          
          // Fallback: phaseManager selects a different agent than executor
          if (!agent) {
            agent = svc.phaseManager.selectAgentForPhase(PHASES.TESTING, allAgents, currentPhaseData, analysis);
          }
          
          // Last resort: any agent that isn't the executor or PM
          if (!agent) {
            agent = allAgents.find(a => a.agent_id !== testExecutor && a.agent_id !== 'project-manager') 
                    || allAgents.find(a => a.agent_id !== testExecutor) 
                    || allAgents[0];
          }
          
          logger.info(`🧪 Phase 5 (TESTING): ${ticket.id} → ${agent.agent_id} (executor was ${testExecutor})`);
          
        } else if (currentPhase === PHASES.REVIEW) {
          // Phase 6: REVIEW → Consensus-driven round-robin review cycle
          // ⭐ PHASE_12: Check if a review cycle is active for this ticket
          const cycleActive = await svc.reviewCycle.isActive(ticket.id, PHASES.REVIEW);
          
          if (cycleActive) {
            const cycleState = await svc.reviewCycle.getCycleState(ticket.id, PHASES.REVIEW);
            
            if (cycleState && cycleState.state === 'awaiting_revision') {
              // REVISION NEEDED: Route back to executor to address feedback
              agent = allAgents.find(a => a.agent_id === cycleState.executorAgentId);
              if (!agent) agent = allAgents[0];
              logger.info(`🔧 Phase 5 (REVIEW CYCLE): Routing back to executor ${agent.agent_id} for revision (round ${cycleState.currentRound})`);
            } else {
              // IN PROGRESS: Route to next pending reviewer
              const nextReviewerId = await svc.reviewCycle.getNextReviewer(ticket.id, PHASES.REVIEW);
              if (nextReviewerId) {
                agent = allAgents.find(a => a.agent_id === nextReviewerId);
                if (!agent) {
                  // Reviewer not found in registry, skip to next
                  logger.warn(`[ReviewCycle] Reviewer ${nextReviewerId} not in registry, using fallback`);
                  agent = allAgents.find(a => a.agent_id !== currentPhaseData?.executingAgent && a.agent_id !== 'project-manager') || allAgents[0];
                }
                logger.info(`🔄 Phase 5 (REVIEW CYCLE): ${ticket.id} → reviewer ${agent.agent_id} (round ${cycleState.currentRound}, ${cycleState.pendingReviewers.length} pending)`);
              } else {
                // No pending reviewers — cycle should have been resolved. Force advance.
                logger.warn(`⚠️ Phase 5 (REVIEW CYCLE): No pending reviewers for ${ticket.id}, forcing phase advance`);
                const nextPhaseData = await svc.phaseManager.advancePhase(ticket.id);
                if (nextPhaseData) {
                  await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
                }
                return;
              }
            }
          } else {
            // No active cycle — fall back to single-reviewer (legacy behavior)
            agent = svc.phaseManager.selectAgentForPhase(PHASES.REVIEW, allAgents, currentPhaseData, analysis);
            if (!agent) agent = allAgents.find(a => a.agent_id !== currentPhaseData?.executingAgent) || allAgents[0];
            logger.info(`✅ Phase 5 (REVIEW single): ${ticket.id} → ${agent.agent_id} (executor was ${currentPhaseData?.executingAgent})`);
          }
          
        } else {
          // Unknown phase — fallback to PM
          agent = allAgents.find(a => a.agent_id === 'project-manager') || allAgents[0];
          logger.warn(`⚠️ Unknown phase ${currentPhase} for ticket ${ticket.id}, defaulting to ${agent.agent_id}`);
        }
      } else if (ticketDepth === 0) {
        // Root ticket without phase data (shouldn't happen, but fallback)
        agent = allAgents.find(a => a.agent_id === 'project-manager');
        if (agent) {
          logger.info(`📋 HIERARCHICAL ROUTING: Root ticket (depth 0) → project-manager (triage + decompose)`);
        } else {
          logger.warn(`⚠️ project-manager not found in registry, falling back to CapabilityMatcher`);
          agent = svc.capabilityMatcher.findBestMatch(allAgents, {
            capabilities: analysis.capabilities,
            priority: analysis.priority,
            ticketId: ticket.id
          });
        }
      } else {
        // ⭐ DEPTH 1+: Subtask routing — LLM Router PRIMARY (reads selector_descriptor dynamically)
        // Priority: LLM Router → Mesh bid (self-nomination) → CapabilityMatcher (last resort)
        // With 30 bots, only the LLM can semantically match ticket intent to agent domain.
        logger.info(`🔧 HIERARCHICAL ROUTING: Subtask (depth ${ticketDepth}) → LLM Router → Mesh bid → CapabilityMatcher (budget: ${contextBudget} tokens)`);

        // Step 1: LLM Router PRIMARY — semantically matches ticket to agent using selector_descriptor
        try {
          const llmResult = await svc.llmRouter.selectAgent(ticket, allAgents);
          if (llmResult && llmResult.agentId) {
            agent = allAgents.find(a => a.agent_id === llmResult.agentId);
            if (agent) {
              logger.info(`🧠 Subtask (LLM ROUTING PRIMARY): ${ticket.id} → ${agent.agent_id} (confidence: ${llmResult.confidence}, reason: ${llmResult.reason})`);
            }
          }
        } catch (llmErr) {
          logger.warn(`[LLMRouter] Subtask LLM routing failed: ${llmErr.message}`);
        }

        // Step 2: Mesh broadcast — self-nomination (bots claim what they want)
        if (!agent) {
          agent = await svc.meshBroadcastRoute(ticket, analysis, allAgents, { phase: 'SUBTASK' });
          if (agent) {
            logger.info(`📡 Subtask (MESH BID fallback): ${ticket.id} → ${agent.agent_id}`);
          }
        }

        // Step 3: CapabilityMatcher — last resort (dynamic routing_keywords still apply)
        if (!agent) {
          agent = svc.capabilityMatcher.findBestMatch(allAgents, {
            capabilities: analysis.capabilities,
            priority: analysis.priority,
            ticketId: ticket.id,
            ticketDescription: description,
          });
          if (agent) {
            logger.info(`⚡ Subtask (CAPABILITY MATCHER last resort): ${ticket.id} → ${agent.agent_id}`);
          }
        }
      }

      if (!agent) {
        logger.error('CRITICAL: No agent selected. Picking first available.');
        agent = allAgents[0];
      }

      // FIX 6: Increment routing count before routing (TTL 1 hour)
      try {
        await svc.redis.incr(routeCountKey);
        await svc.redis.expire(routeCountKey, 3600);
      } catch (e) {
        logger.warn(`Failed to increment route count for ${ticket.id}: ${e.message}`);
      }

      // Record this agent's assignment for round-robin tracking
      svc.capabilityMatcher.recordAgentWork(ticket.id, agent.agent_id);

      // ⭐ ROUTING DECISION LOG: Record this routing decision for full transparency
      // This is the single place where we know the final selected agent AND all candidates
      try {
        const PHASE_NAMES = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };
        const phaseName = currentPhase ? (PHASE_NAMES[currentPhase] || `Phase ${currentPhase}`) : null;

        // Score all agents for the routing log (so we can see why email-bot was/wasn't picked)
        const scoredAgents = allAgents.map(a => ({
          ...a,
          score: svc.capabilityMatcher.scoreAgent(a, analysis.capabilities || [], {
            priority: analysis.priority,
            ticketId: ticket.id,
            ticketDescription: description,
          })
        }));

        // Detect warnings: specialist agents with matching keywords that weren't selected
        const warnings = [];
        for (const a of allAgents) {
          if (a.agent_id === agent.agent_id) continue;
          if (a.routing_keywords && a.routing_keywords.length > 0) {
            const ticketLower = description.toLowerCase();
            const kwMatches = a.routing_keywords.filter(kw => ticketLower.includes(kw.toLowerCase()));
            if (kwMatches.length > 0) {
              warnings.push(`${a.agent_id} has ${kwMatches.length} routing_keyword match(es) [${kwMatches.slice(0,3).join(', ')}] but was NOT selected — selected ${agent.agent_id} instead`);
            }
          }
        }

        // Build whyOthersSkipped map
        const whyOthersSkipped = {};
        for (const a of allAgents) {
          if (a.agent_id === agent.agent_id) continue;
          if (ticketDepth === 0 && !currentPhase) {
            whyOthersSkipped[a.agent_id] = 'Root ticket without phase — always routes to project-manager for triage';
          } else if (ticketDepth === 0 && currentPhase === 2) {
            whyOthersSkipped[a.agent_id] = 'Phase 2 PLANNING: mesh bid → LLM router → PM fallback chain';
          } else if (ticketDepth > 0) {
            whyOthersSkipped[a.agent_id] = `Subtask (depth ${ticketDepth}): mesh bid → CapabilityMatcher fallback chain`;
          }
        }

        // Determine routing method used
        let routingMethod = 'UNKNOWN';
        if (ticketDepth === 0 && !currentPhase) routingMethod = 'HIERARCHICAL_ROOT_NO_PHASE';
        else if (ticketDepth === 0 && currentPhase) routingMethod = `PHASE_${currentPhase}_${phaseName || 'UNKNOWN'}`;
        else routingMethod = `SUBTASK_DEPTH_${ticketDepth}`;

        // Get taskId for workspace file writing (may not exist yet at this point)
        let logTaskId = null;
        try { logTaskId = await svc.getTicketTaskId(client, ticket.id); } catch (e) { /* best effort */ }

        await svc.routingLog.record({
          ticketId: ticket.id,
          ticketTitle: ticket.name || '',
          ticketDescription: description,
          phase: currentPhase,
          phaseName,
          ticketDepth,
          selectedAgent: agent.agent_id,
          routingMethod,
          allAgentsConsidered: scoredAgents,
          whySelected: `Agent ${agent.agent_id} selected via ${routingMethod}. Categories: [${(analysis.categories || []).join(', ')}]. Capability hints: [${(analysis.capabilities || []).join(', ')}].`,
          whyOthersSkipped,
          ticketKeywords: (analysis.categories || []),
          capabilityHints: (analysis.capabilities || []),
          warnings,
          taskId: logTaskId,
        }).catch(logErr => logger.debug(`[RoutingLog] Non-fatal log error: ${logErr.message}`));
      } catch (logErr) {
        logger.debug(`[RoutingLog] Routing log failed (non-fatal): ${logErr.message}`);
      }

      // Resolve Plane user ID for this agent (for comment attribution + assignment)
      const agentPlaneUserId = getPlaneUserId(agent.agent_id);

      // Route to selected agent (inclusive — everyone gets a turn)
      await svc.routeToAgent(client, ticket, agent, analysis, agentPlaneUserId);

    } catch (error) {
      logger.error(`Failed to assess/route ticket ${ticket.id}:`, error.message);
      
      // ⭐ PHASE_00_SESSION_05 FIX (Bug #1): Mark ticket as processed even on failure
      // This prevents infinite retry loops when assessAndRoute() throws
      // Store with 1-hour cooldown to prevent immediate re-processing
      try {
        await svc.setProcessed(ticket, 'queue-manager', 'medium');
        logger.info(`🛑 Ticket ${ticket.id} marked as processed despite error (1h cooldown) to prevent infinite retry`);
      } catch (markErr) {
        logger.warn(`Failed to mark failed ticket ${ticket.id} as processed: ${markErr.message}`);
      }
      
      // Post error comment to Plane so it's visible
      try {
        const errorComment = `⚠️ **Queue Manager Error**\n\nFailed to route ticket: ${error.message}\n\n**Action**: Ticket will be retried after cooldown period.\n\n---\n*Queue Manager — Error Handler*`;
        const { Client } = require('pg');
        const errorClient = new Client(svc.dbConfig);
        await errorClient.connect();
        await svc.postComment(errorClient, ticket, errorComment, getQueueManagerUserId());
        await errorClient.end();
      } catch (commentErr) {
        logger.debug(`Failed to post error comment for ${ticket.id}: ${commentErr.message}`);
      }
    }
  }

  /**
   * Mesh Broadcast Route — broadcast BID_REQUEST to all agents, return winning agent
   * Used as primary routing in Phase 3 of Mesh Broadcast Network.
   * Falls back to null (caller uses CapabilityMatcher/LLMRouter as fallback).
   * 
   * @param {Object} ticket - Plane ticket
   * @param {Object} analysis - CapabilityMatcher analysis
   * @param {Object[]} allAgents - All registered agents
   * @param {Object} [options] - { phase, excludeAgents }
   * @returns {Promise<Object|null>} Best agent from allAgents array, or null
   */
  static async meshBroadcastRoute(svc, ticket, analysis, allAgents, options = {}) {
    if (!svc.meshBroadcast || !svc.meshBroadcast.enabled) {
      return null;
    }

    try {
      const broadcastResult = await svc.meshBroadcast.broadcastBidRequest(ticket, analysis, options);

      if (!broadcastResult || !broadcastResult.lead) {
        logger.info(`[MeshRoute] No claims for ticket ${ticket.id} — falling back to legacy routing`);
        return null;
      }

      // Validate lead claimant exists in allAgents
      const leadAgentId = broadcastResult.lead.agent_id;
      const leadAgent = allAgents.find(a => a.agent_id === leadAgentId);

      if (!leadAgent) {
        logger.warn(`[MeshRoute] Lead claimant ${leadAgentId} not found in agent list — falling back`);
        return null;
      }

      logger.info(`[MeshRoute] ✅ Mesh bid winner: ${leadAgentId} (confidence: ${broadcastResult.lead.confidence.toFixed(2)}, reason: "${broadcastResult.lead.reason}", ${broadcastResult.responded}/${broadcastResult.total_agents} responded, ${broadcastResult.elapsed_ms}ms)`);

      // ⭐ PHASE_21 GAP B: Record bid results for ALL participating agents
      if (svc.agentMetrics && broadcastResult.bids) {
        for (const bid of broadcastResult.bids) {
          const won = bid.agent_id === leadAgentId;
          svc.agentMetrics.recordBidResult(bid.agent_id, ticket.id, won, bid.confidence).catch(() => {});
        }
      } else if (svc.agentMetrics) {
        // At minimum record the winner
        svc.agentMetrics.recordBidResult(leadAgentId, ticket.id, true, broadcastResult.lead.confidence).catch(() => {});
      }

      return leadAgent;
    } catch (error) {
      logger.warn(`[MeshRoute] Broadcast failed: ${error.message} — falling back to legacy routing`);
      return null;
    }
  }

  /**
   * Route ticket to selected agent AND process it
   * @param {string|null} agentPlaneUserId - Plane user UUID for the agent (for attribution)
   */
  static async routeToAgent(svc, client, ticket, agent, analysis, agentPlaneUserId = null) {
    try {
      // Update ticket status to Routing
      await svc.updateTicketStatus(client, ticket.id, 'Routing', ticket.project_id);

      // PHASE_26 FIX 1: Post full Task Brief ONLY on Phase 1 (INTAKE) or first assignment
      // Subsequent phases get a short routing notice — prevents 10-14x duplication of the full brief
      const currentPhase = analysis.currentPhase || null;
      const ticketDescription = svc.extractDescription(ticket);
      
      if (!currentPhase || currentPhase <= 1) {
        // First assignment: post the full structured task brief
        const routingComment = svc.commentFormatter.routingComment(
          agent.agent_id, analysis.capabilities, analysis.priority,
          ticket.name, ticketDescription, analysis.complexity,
          currentPhase
        );
        await svc.postComment(client, ticket, routingComment, getQueueManagerUserId());
      } else {
        // Subsequent phases: post SHORT routing notice only (no task brief duplication)
        const PHASE_NAMES = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'REVIEW', 6: 'TESTING', 7: 'DELIVERY' };
        const phaseName = PHASE_NAMES[currentPhase] || `Phase ${currentPhase}`;
        const shortRouting = `📡 **Routing to @agent:${agent.agent_id}** for Phase ${currentPhase}: ${phaseName}\n\n| Field | Value |\n|-------|-------|\n| **Agent** | ${agent.agent_id} |\n| **Skills** | ${analysis.capabilities.join(', ')} |\n| **Phase** | ${currentPhase} — ${phaseName} |\n\n*Read the original Task Brief (first comment) and previous agent work above for context.*\n\n---\n*Queue Manager — Phase Transition*`;
        await svc.postComment(client, ticket, shortRouting, getQueueManagerUserId());
        logger.info(`📡 PHASE_26: Short routing notice for phase ${currentPhase} (skipped full task brief re-post)`);
      }

      // Assign ticket to the agent's Plane user so it shows in Plane UI
      if (agentPlaneUserId) {
        await svc.assignTicketToAgent(client, ticket.id, agentPlaneUserId);
      }

      // Increment agent load (with workspace tracking)
      await svc.agentRegistry.incrementLoad(agent.agent_id, ticket.workspace_id);

      logger.info(`✓ Ticket ${ticket.id} routed to agent: ${agent.agent_id} (workspace: ${ticket.workspace_id})`);

      // Process ticket with agent — PARALLEL for HTTP dispatch, SEQUENTIAL for local
      if (svc.taskController) {
        const agentEndpoint = agent.endpoint;
        if (agentEndpoint && agentEndpoint !== 'local') {
          // ⭐ PARALLEL: Fire HTTP dispatch without blocking poll loop
          // Create dedicated DB connection for async completion handling
          logger.info(`🚀 PARALLEL dispatch: ${agent.agent_id} → ticket ${ticket.id} (non-blocking)`);
          svc._dispatchParallel(ticket, agent, analysis, agentPlaneUserId).catch(err => {
            logger.error(`Parallel dispatch error for ticket ${ticket.id}: ${err.message}`);
          });
        } else {
          // LOCAL: Sequential processing (only if no HTTP endpoint)
          await svc.processWithAgent(client, ticket, agent, agentPlaneUserId);
        }
      } else {
        logger.warn('TaskController not available - ticket routed but not processed');
      }

    } catch (error) {
      logger.error(`Failed to route ticket ${ticket.id}:`, error.message);
    }
  }
}

module.exports = TicketRoutingEngine;
