/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): processWithAgent dispatch stage — shared-workspace resolution, context gathering (comments/attachments/links/memory), HTTP dispatch to bot containers, local Cline/AgenticController fallback, and workspace response recovery
 */

/**
 * AgentDispatchEngine — agent execution stage of processWithAgent.
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
const TicketProcessor = require('./TicketProcessor');
const { PHASES } = require('./TicketPhaseManager');
const DispatchCompletionHandler = require('./DispatchCompletionHandler');

/**
 * @description Agent execution stage of processWithAgent. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class AgentDispatchEngine {
  /**
   * Process ticket with specialized agent
   * @param {string|null} agentPlaneUserId - Plane user UUID for comment/assignment attribution
   */
  static async processWithAgent(svc, client, ticket, agent, agentPlaneUserId = null) {
    let taskId = null; // Declare outside try for catch block access
    try {
      logger.info(`Starting agent processing: ${agent.agent_id} → ticket ${ticket.id}`);
      const _metricsStartMs = Date.now(); // ⭐ PHASE_21 GAP B: Start timing

      // Update status to In Progress
      await svc.updateTicketStatus(client, ticket.id, 'In Progress', ticket.project_id);

      // 1. Check if ticket already has a shared task
      // ⭐ SHARED WORKSPACE: If this is a child ticket, use the PARENT's workspace
      let parentId = null;
      try {
        parentId = await svc.planeDb.getParentId(client, ticket.id);
      } catch (e) {
        logger.debug(`Parent lookup failed for ${ticket.id}: ${e.message}`);
      }

      if (parentId) {
        // CHILD TICKET: Use parent's workspace for shared context
        taskId = await svc.getTicketTaskId(client, parentId);
        if (taskId) {
          logger.info(`📂 SHARED WORKSPACE: Child ${ticket.id} using parent ${parentId}'s workspace (task: ${taskId})`);
        } else {
          // Parent doesn't have a task yet — create one and store on parent
          const parentTask = await svc.taskController.createTask(
            `🤝 Shared Workspace for Parent Ticket ${parentId}`,
            'act',
            { ticketId: parentId }
          );
          taskId = parentTask.id;
          await svc.setTicketTaskId(client, parentId, taskId);
          logger.info(`📂 SHARED WORKSPACE: Created workspace ${taskId} for parent ${parentId} (child: ${ticket.id})`);
        }
        // Also store the task mapping on the child for quick lookup
        await svc.setTicketTaskId(client, ticket.id, taskId);
      } else {
        // ROOT TICKET: Normal task creation/reuse
        taskId = await svc.getTicketTaskId(client, ticket.id);
      }
      
      let task;
      
      if (!taskId) {
        // First agent: Create new GENERIC shared task (agent-agnostic)
        // Task should be a neutral container, not bound to any specific agent
        // PHASE_33B FIX: If Redis has a pre-seeded workspace mapping (from decomposition),
        // use that taskId directly instead of creating a new folder.
        // This is the CRITICAL path for shared workspaces — without it, each child gets its own folder.
        let mappedTaskId = null;
        try {
          mappedTaskId = await svc.redis.get(`qm:ticket_task:${ticket.id}`);
        } catch (e) { /* Redis lookup failed */ }
        
        if (mappedTaskId) {
          // Child ticket with pre-seeded workspace → REUSE parent's task
          logger.info(`📂 PHASE_33B: Ticket ${ticket.id.substring(0,8)} mapped to shared workspace ${mappedTaskId} — REUSING (not creating new)`);
          task = await svc.taskController.getTask(mappedTaskId);
          if (task) {
            taskId = mappedTaskId;
            logger.info(`✅ SHARED WORKSPACE: Ticket ${ticket.id.substring(0,8)} → reused existing task ${taskId}`);
          } else {
            logger.warn(`⚠️ Mapped task ${mappedTaskId} not found, falling back to new task creation`);
            mappedTaskId = null; // Fall through to create new
          }
        }
        
        if (!mappedTaskId) {
        // No pre-seeded mapping — create new task as normal
        task = await svc.taskController.createTask(
          `🤝 Multi-Agent Shared Workspace for Plane Ticket ${ticket.id}`,
          'act',
          { ticketId: ticket.id }
        );
        taskId = task.id;
        
        // Store task_id in Plane database
        await svc.setTicketTaskId(client, ticket.id, taskId);
        
        logger.info(`✓ Created shared task ${taskId} for ticket ${ticket.id}`);
        } // end if (!mappedTaskId) — new task creation
      } else {
        // Subsequent agents: Reuse existing shared task
        task = await svc.taskController.getTask(taskId);
        
        if (!task) {
          logger.warn(`Task ${taskId} not found, creating new generic shared task`);
          // Fallback: create new GENERIC task if referenced one doesn't exist
          task = await svc.taskController.createTask(
            `🤝 Multi-Agent Shared Workspace for Plane Ticket ${ticket.id} (Recovery)`,
            'act',
            { ticketId: ticket.id }
          );
          taskId = task.id;
          await svc.setTicketTaskId(client, ticket.id, taskId);
        }
        
        logger.info(`✓ Reusing shared task ${taskId} for ticket ${ticket.id} (agent: ${agent.agent_id})`);
      }

      // ⭐ WORKSPACE METADATA: Write _meta.json for workspace context
      try {
        const fs = require('fs');
        const path = require('path');
        // SOP-compliant workspace path: /app/swarm-workspace/{taskId}
        const swarmWorkspaceRoot = path.join('/app', 'swarm-workspace');
        const workspaceDir = path.join(swarmWorkspaceRoot, taskId);
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        // Create SOP folders: notes/, deliverables/, developer-handovers/
        const notesDir = path.join(workspaceDir, 'notes');
        if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
        const deliverablesDir = path.join(workspaceDir, 'deliverables');
        if (!fs.existsSync(deliverablesDir)) fs.mkdirSync(deliverablesDir, { recursive: true });
        const handoverDir = path.join(workspaceDir, 'developer-handovers');
        if (!fs.existsSync(handoverDir)) {
          fs.mkdirSync(handoverDir, { recursive: true });
          logger.info(`📂 PHASE_46: Created developer-handovers/ folder in workspace ${taskId}`);
        }
        // Write SOP _meta.json
        const metaPath = path.join(workspaceDir, '_meta.json');
        const meta = {
          ticketId: ticket.id,
          parentId: parentId,
          ticketName: ticket.name,
          agentId: agent.agent_id,
          isSubtask: !!parentId,
          sharedWorkspace: !!parentId,
          createdAt: new Date().toISOString(),
          workspaceDir: workspaceDir,
          workspaceVersion: '1.0-sop-compliant'
        };
        // Append to existing meta or create new
        let existingMeta = {};
        if (fs.existsSync(metaPath)) {
          try { existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { /* ignore */ }
        }
        existingMeta.lastAgent = agent.agent_id;
        existingMeta.lastTicket = ticket.id;
        existingMeta.parentId = parentId || existingMeta.parentId;
        existingMeta.agents = existingMeta.agents || [];
        if (!existingMeta.agents.includes(agent.agent_id)) {
          existingMeta.agents.push(agent.agent_id);
        }
        existingMeta.tickets = existingMeta.tickets || [];
        if (!existingMeta.tickets.includes(ticket.id)) {
          existingMeta.tickets.push(ticket.id);
        }
        existingMeta.updatedAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(existingMeta, null, 2));
        logger.debug(`📂 Workspace metadata written: ${metaPath}`);
      } catch (metaErr) {
        logger.debug(`Workspace metadata write failed (non-fatal): ${metaErr.message}`);
      }

      // ⭐ PHASE_44B: Redis task lock REMOVED — filesystem handles concurrent writes natively
      // Multiple agents writing to different files in the same workspace is safe.
      // The lock was blocking sibling subtasks from processing simultaneously.
      logger.info(`📂 Workspace ${taskId} — no lock needed, filesystem handles concurrency`);

      // 2. Load project config for multi-perspective analysis
      const projectSlug = await svc.getProjectSlug(client, ticket.project_id);
      const projectConfig = svc.perspectiveEngine.loadProjectConfig(projectSlug);
      const perspectiveDepth = svc.perspectiveEngine.getDepthForComplexity(
        svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket)).complexity
      );
      
      logger.info(`Ticket ${ticket.id}: project=${projectSlug}, perspectiveDepth=${perspectiveDepth}, perspectives=${svc.perspectiveEngine.getPerspectiveCount()}`);

      // 2b. Fetch previous comments for context — PHASE_26 FIX 2: Summarize to prevent exponential bloat
      // Old behavior: 100K char budget → each agent got 100K of previous comments → produced 50-90K response
      // → next agent got 100K (including previous 50-90K response) → exponential growth → E2BIG
      // New behavior: 10KB budget, each comment summarized to max 500 chars
      let previousComments = [];
      try {
        const recentComments = await svc.planeDb.getRecentComments(client, ticket.id, 50);
        if (recentComments && recentComments.length > 0) {
          const filtered = recentComments
            .filter(c => !c.comment_stripped.includes('Queue Manager v1.0') &&
                        !c.comment_stripped.includes('Routed to @agent:') &&
                        !c.comment_stripped.includes('⏸️ Queue pacing') &&
                        !c.comment_stripped.includes('🔄 Ticket Routed') &&
                        !c.comment_stripped.includes('Queue Manager — Phase Transition') &&
                        !c.comment_stripped.includes('📡 **Routing to'));
          
          // PHASE_26 FIX 2: Summarized thread budget — 10KB max (was 100KB)
          // Each comment truncated to 500 chars with agent/phase attribution
          const THREAD_BUDGET = 10000;
          const COMMENT_MAX = 500;
          let totalChars = 0;
          
          for (let i = 0; i < filtered.length; i++) {
            const text = filtered[i].comment_stripped;
            
            // Extract agent name and phase from comment for attribution
            const agentMatch = text.match(/\*\*Agent:\*\*\s*(\S+)/i) || text.match(/@agent:(\S+)/i);
            const phaseMatch = text.match(/Phase\s+(\d+)/i);
            const agent = agentMatch ? agentMatch[1] : 'unknown';
            const phase = phaseMatch ? `Phase ${phaseMatch[1]}` : '';
            
            // Summarize: take first 500 chars of substantive content
            const summary = text.length > COMMENT_MAX 
              ? text.substring(0, COMMENT_MAX) + '...\n*[truncated — full response in Plane comment thread]*'
              : text;
            
            const attributed = `**${agent}** ${phase ? `(${phase})` : `(comment ${i + 1}/${filtered.length})`}:\n${summary}`;
            
            if (totalChars + attributed.length > THREAD_BUDGET) {
              previousComments.push(`\n---\n*[${filtered.length - i} more comments omitted — thread budget reached. Read full thread in Plane.]*`);
              break;
            }
            
            previousComments.push(attributed);
            totalChars += attributed.length;
          }
          logger.info(`📜 PHASE_26: Summarized ${previousComments.length}/${filtered.length} comments for ticket ${ticket.id} (${totalChars} chars, budget ${THREAD_BUDGET})`);
        }
      } catch (historyErr) {
        logger.warn(`Failed to get comment history for ticket ${ticket.id}: ${historyErr.message}`);
      }

      // 2c. Fetch ticket attachments (Enhancement E1)
      let attachmentsContext = '';
      try {
        const attachments = await svc.planeDb.getTicketAttachments(client, ticket.id);
        attachmentsContext = svc.planeDb.formatAttachmentsForPrompt(attachments);
        if (attachmentsContext) {
          logger.info(`📎 Fetched ${attachments.length} attachment(s) for ticket ${ticket.id}`);
        }
      } catch (attErr) {
        logger.warn(`Failed to get attachments for ticket ${ticket.id}: ${attErr.message}`);
      }

      // 2d. Fetch ticket links (Enhancement E2)
      let linksContext = '';
      try {
        const links = await svc.planeDb.getTicketLinks(client, ticket.id);
        linksContext = svc.planeDb.formatLinksForPrompt(links);
        if (linksContext) {
          logger.info(`🔗 Fetched ${links.length} linked issue(s) for ticket ${ticket.id}`);
        }
      } catch (linkErr) {
        logger.warn(`Failed to get ticket links for ticket ${ticket.id}: ${linkErr.message}`);
      }

      // 2e. ⭐ PHASE_20 GAP F: Query Swarm Memory for relevant past experiences
      // Inject organizational memory from completed tickets into the dispatch context
      let swarmMemoryContext = '';
      try {
        const memAnalysis = svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket));
        swarmMemoryContext = await svc.swarmMemory.queryRelevantMemories(ticket, memAnalysis);
        if (swarmMemoryContext) {
          logger.info(`🧠 [SwarmMemory] Injecting ${swarmMemoryContext.length} chars of organizational memory for ticket ${ticket.id}`);
        }
      } catch (memQueryErr) {
        logger.debug(`[SwarmMemory] Memory query failed (non-fatal): ${memQueryErr.message}`);
      }

      // 3. Check if agent has its own container endpoint (HTTP dispatch for true parallelism)
      const agentEndpoint = agent.endpoint;
      let result;
      let agentResponse = 'Agent processed your request.';

      if (agentEndpoint && agentEndpoint !== 'local') {
        // ⭐ TRUE MULTI-AGENT: Dispatch to agent's own container via HTTP
        logger.info(`🌐 HTTP Dispatch: Sending ticket ${ticket.id} to ${agent.agent_id} at ${agentEndpoint}`);
        try {
          const http = require('http');
          const url = new URL(`${agentEndpoint}/api/process-ticket`);
          
          // Generate phase prompt for HTTP dispatch (if ticket is in phased lifecycle)
          let httpPhasePrompt = '';
          let httpCurrentPhase = null;
          try {
            if (svc.phaseManager) {
              const phaseState = await svc.phaseManager.getPhase(ticket.id);
              if (phaseState && phaseState.phase) {
                httpCurrentPhase = phaseState.phase;
                httpPhasePrompt = svc.phaseManager.getPhasePrompt(phaseState.phase, ticket, agent.agent_id);
                
                // ⭐ PHASE_13 Edit 4: Review cycle prompt injection
                // When REVIEW phase has an active cycle, override the default REVIEW prompt
                // with the cycle-aware prompt that includes round info, previous feedback, and verdict format
                if (phaseState.phase === PHASES.REVIEW && svc.reviewCycle) {
                  try {
                    const cycleActive = await svc.reviewCycle.isActive(ticket.id, PHASES.REVIEW);
                    if (cycleActive) {
                      const cycleState = await svc.reviewCycle.getCycleState(ticket.id, PHASES.REVIEW);
                      if (cycleState) {
                        if (cycleState.state === 'awaiting_revision') {
                          // REVISION MODE: Inject revision prompt with reviewer feedback
                          try {
                            const cachedRevisionPrompt = await svc.redis.get(`qm:revision_prompt:${ticket.id}`);
                            if (cachedRevisionPrompt) {
                              httpPhasePrompt = cachedRevisionPrompt;
                              logger.info(`🔧 PHASE_13 Edit 4: Injected revision prompt for executor ${agent.agent_id} on ticket ${ticket.id}`);
                            }
                          } catch (e) { logger.debug(`Revision prompt cache miss: ${e.message}`); }
                        } else {
                          // REVIEWER MODE: Inject review cycle prompt with round context
                          httpPhasePrompt = svc.reviewCycle.buildReviewPrompt(cycleState, agent.agent_id, '');
                          logger.info(`🔄 PHASE_13 Edit 4: Injected review cycle prompt for reviewer ${agent.agent_id} on ticket ${ticket.id} (round ${cycleState.currentRound})`);
                        }
                      }
                    }
                  } catch (cycleErr) {
                    logger.debug(`Review cycle prompt injection failed (using default): ${cycleErr.message}`);
                  }
                }
              }
            }
          } catch (phaseErr) {
            logger.warn(`Phase lookup failed for HTTP dispatch: ${phaseErr.message}`);
          }

          // ⭐ PHASE_43 FIX: ALWAYS pass workspace taskId to HTTP dispatch — not just subtasks
          // Before this fix, workspace was only shared for subtasks (parentId && taskId).
          // For phase transitions (PLANNING→SPECIALIST→EXECUTION→REVIEW), parentId is null,
          // so each phase got a NEW workspace. Now ALL dispatches share the ticket's workspace.
          let parentWorkspaceTaskId = taskId || null;
          if (parentWorkspaceTaskId) {
            logger.info(`📂 HTTP Dispatch: Sharing workspace ${taskId} for ticket ${ticket.id}${parentId ? ' (subtask of ' + parentId + ')' : ' (phase transition)'}`);
          }

          // ⭐ PHASE_10B: Inject workspace file listing so subtask agents see existing files
          // This prevents type mismatches by giving each agent visibility into what's already been created
          let workspaceFilesContext = '';
          if (parentWorkspaceTaskId) {
            try {
              const fs = require('fs');
              const path = require('path');
              const wsDir = path.join('/app/workspace', parentWorkspaceTaskId);
              if (fs.existsSync(wsDir)) {
                const walkDir = (dir, prefix = '') => {
                  const entries = fs.readdirSync(dir, { withFileTypes: true });
                  const files = [];
                  for (const e of entries) {
                    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
                    const relPath = prefix ? `${prefix}/${e.name}` : e.name;
                    if (e.isDirectory()) {
                      files.push(...walkDir(path.join(dir, e.name), relPath));
                    } else {
                      const stat = fs.statSync(path.join(dir, e.name));
                      files.push({ path: relPath, size: stat.size });
                    }
                  }
                  return files;
                };
                const wsFiles = walkDir(wsDir);
                if (wsFiles.length > 0) {
                  workspaceFilesContext = `\n\n## Existing Workspace Files (from sibling agents)\nThese files already exist in the shared workspace. READ them before creating new files to ensure consistency:\n${wsFiles.map(f => `- ${f.path} (${f.size} bytes)`).join('\n')}\n\n**CRITICAL:** If type definitions, interfaces, or shared contracts exist in these files, you MUST use the EXACT SAME names and structures. Do NOT create conflicting types.`;
                  logger.info(`📂 PHASE_10B: Injecting ${wsFiles.length} workspace file listing for ticket ${ticket.id}`);
                }
              }
            } catch (wsErr) {
              logger.debug(`Workspace file listing failed: ${wsErr.message}`);
            }
          }

          // ⭐ PHASE_19 (GAP #2, #3): Enrich dispatch payload with RALF round context
          // So app.js can pass REAL values to SwarmAwarenessPrompt instead of hardcoded 1/2/participant
          let ralfRoundContext = null;
          try {
            if (httpCurrentPhase && httpCurrentPhase >= 2 && httpCurrentPhase <= 5) {
              const orchActiveForDispatch = await svc.phaseRoundOrchestrator.isActive(ticket.id, httpCurrentPhase);
              if (orchActiveForDispatch) {
                const roundAgent = await svc.phaseRoundOrchestrator.getCurrentRoundAgent(ticket.id, httpCurrentPhase);
                const roundState = await svc.phaseRoundOrchestrator.getState(ticket.id, httpCurrentPhase);
                const roleAssignments = await svc.competencyRanker.getRoleAssignments(ticket.id);
                
                if (roundAgent && roundState) {
                  ralfRoundContext = {
                    currentRound: roundAgent.round,
                    maxRounds: roundAgent.maxRounds,
                    role: roundAgent.role,
                    colleagues: roundState.rounds.map(r => ({ agentId: r.agentId, role: r.role, round: r.round })),
                    roleAssignments: roleAssignments,
                    previousRoundAgent: roundState.currentRound > 1 ? roundState.rounds[roundState.currentRound - 2]?.agentId : null,
                    previousRoundRole: roundState.currentRound > 1 ? roundState.rounds[roundState.currentRound - 2]?.role : null,
                  };
                  logger.info(`[RALF] Enriched HTTP dispatch with round context: R${roundAgent.round}/${roundAgent.maxRounds}, role=${roundAgent.role}`);
                }
              }
            }
          } catch (roundCtxErr) {
            logger.debug(`[RALF] Round context enrichment failed (non-fatal): ${roundCtxErr.message}`);
          }

          const postData = JSON.stringify({
            ticket: {
              id: ticket.id,
              name: ticket.name,
              description_stripped: svc.extractDescription(ticket) + workspaceFilesContext,
              project_id: ticket.project_id,
              workspace_id: ticket.workspace_id,
              priority: ticket.priority
            },
            analysis: svc.capabilityMatcher.analyzeTicket(svc.extractDescription(ticket)),
            agentId: agent.agent_id,
            previousComments: previousComments,
            attachmentsContext: attachmentsContext,
            linksContext: linksContext,
            phasePrompt: httpPhasePrompt,
            currentPhase: httpCurrentPhase,
            parentWorkspaceTaskId: parentWorkspaceTaskId,
            ralfRoundContext: ralfRoundContext,
          });
          
          const dispatchResult = await new Promise((resolve, reject) => {
            const timeoutMs = parseInt(process.env.AGENT_DISPATCH_TIMEOUT || '300000'); // 5 min default
            const req = http.request({
              hostname: url.hostname,
              port: url.port || 5000,
              path: url.pathname,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              },
              timeout: timeoutMs
            }, (res) => {
              let data = '';
              res.on('data', chunk => { data += chunk; });
              res.on('end', () => {
                try {
                  resolve(JSON.parse(data));
                } catch (e) {
                  reject(new Error(`Invalid JSON from agent: ${data.substring(0, 200)}`));
                }
              });
            });
            
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Agent dispatch timeout')); });
            req.write(postData);
            req.end();
          });
          
          if (dispatchResult.success) {
            agentResponse = dispatchResult.response || 'Agent processed your request.';
            // ALWAYS construct result with completion_result from the extracted response
            // The agent's raw result.messages may only contain tool_result/reasoning (no completion_result)
            // which causes evaluateAgentCompletion to default to TODO
            result = { messages: [{ say: 'completion_result', text: agentResponse }] };
            logger.info(`✅ HTTP Dispatch success: ${agent.agent_id} processed ticket ${ticket.id} (${agentResponse.length} chars)`);

            // ⭐ PHASE_66: Record cost from HTTP dispatch response
            // The remote bot's /api/process-ticket now returns apiMetrics with totalCost, totalTokens
            if (svc.agentMetrics && dispatchResult.apiMetrics) {
              const metrics = dispatchResult.apiMetrics;
              if (metrics.totalCost > 0 || metrics.totalTokens > 0) {
                svc.agentMetrics.recordCost(agent.agent_id, ticket.id, {
                  input_tokens: metrics.totalTokens ? Math.floor(metrics.totalTokens * 0.7) : 0, // Estimate 70/30 split
                  output_tokens: metrics.totalTokens ? Math.ceil(metrics.totalTokens * 0.3) : 0,
                  cost_usd: metrics.totalCost || 0,
                  model: 'bedrock-via-cline-cli',
                  phase: httpCurrentPhase ? String(httpCurrentPhase) : 'unknown',
                }).catch(costErr => logger.warn(`[PHASE_66] Cost recording failed: ${costErr.message}`));
                logger.info(`💰 PHASE_66: Recorded cost for ${agent.agent_id} on ticket ${ticket.id}: $${(metrics.totalCost || 0).toFixed(4)} (${metrics.totalTokens || 0} tokens)`);

                // ⭐ PHASE_67: Record per-ticket cost (accumulates across phases/agents)
                svc.agentMetrics.recordTicketCost(ticket.id, {
                  cost_usd: metrics.totalCost || 0,
                  input_tokens: metrics.totalTokens ? Math.floor(metrics.totalTokens * 0.7) : 0,
                  output_tokens: metrics.totalTokens ? Math.ceil(metrics.totalTokens * 0.3) : 0,
                  phase: httpCurrentPhase ? String(httpCurrentPhase) : 'unknown',
                  agentId: agent.agent_id,
                  model: 'bedrock-via-cline-cli',
                  projectId: ticket.project_id || null,
                  parentTicketId: ticket.parent_id || null,
                }).catch(costErr => logger.warn(`[PHASE_67] Ticket cost recording failed: ${costErr.message}`));
              }
            }

            // PHASE_16 FIX B: If response is the default empty placeholder, retry with workspace file scan
            const isDefaultResponse = agentResponse === 'Agent processed your request.' || agentResponse.length < 50;
            if (isDefaultResponse) {
              logger.warn(`⚠️ HTTP Dispatch returned default/empty response for ticket ${ticket.id}, attempting workspace file recovery (5s delay)...`);
              await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s for async file writes
              
              try {
                const fs = require('fs');
                const path = require('path');
                const workspaceDir = '/app/workspace';
                
                if (fs.existsSync(workspaceDir)) {
                  // Scan most recently modified task dirs (created in last 10 minutes)
                  const taskDirs = fs.readdirSync(workspaceDir)
                    .filter(d => d.startsWith('task_'))
                    .map(d => ({ name: d, mtime: fs.statSync(path.join(workspaceDir, d)).mtime }))
                    .filter(d => (Date.now() - d.mtime.getTime()) < 600000) // Last 10 min
                    .sort((a, b) => b.mtime - a.mtime);
                  
                  let bestContent = '';
                  for (const dir of taskDirs.slice(0, 3)) { // Check top 3 most recent
                    const dirPath = path.join(workspaceDir, dir.name);
                    try {
                      const files = fs.readdirSync(dirPath).filter(f => 
                        f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.html')
                      );
                      for (const file of files) {
                        try {
                          const content = fs.readFileSync(path.join(dirPath, file), 'utf8');
                          if (content && content.length > bestContent.length) {
                            bestContent = content;
                            logger.info(`📂 Workspace recovery: Found ${file} in ${dir.name} (${content.length} chars)`);
                          }
                        } catch (e) { /* skip */ }
                      }
                    } catch (e) { /* skip */ }
                  }
                  
                  if (bestContent.length > 100) {
                    agentResponse = bestContent;
                    result = { messages: [{ say: 'completion_result', text: agentResponse }] };
                    logger.info(`✅ Workspace recovery successful for ticket ${ticket.id}: ${agentResponse.length} chars recovered`);
                  } else {
                    logger.warn(`⚠️ Workspace recovery found no substantive content for ticket ${ticket.id}`);
                  }
                }
              } catch (recoveryErr) {
                logger.warn(`Workspace recovery scan failed for ticket ${ticket.id}: ${recoveryErr.message}`);
              }
            }
          } else {
            throw new Error(dispatchResult.error || 'Agent returned failure');
          }
        } catch (dispatchErr) {
          logger.warn(`⚠️ HTTP Dispatch failed for ${agent.agent_id}: ${dispatchErr.message}. Falling back to local processing.`);
          // Fall through to local processing below
          agentResponse = 'Agent processed your request.';
          result = null;
        }
      }

      // Fallback: Local processing (if HTTP dispatch not available or failed)
      if (!result) {
      // Check if Cline CLI is available for codebase-aware processing
      const clineStatus = await svc.clineIntegration.checkAvailability();

      if (clineStatus.available) {
        // ⭐ PHASE_58_SESSION_04: Route through Front Door API (unified path)
        // Both dashboard chat and ticket processing now use the same code path
        logger.info(`Using Cline CLI v${clineStatus.version} for ticket ${ticket.id} via Front Door API`);
        try {
          // Build ticket prompt (no persona - Front Door adds it)
          const ticketPrompt = TicketProcessor.buildTicketPrompt(ticket, task);
          
          // Route through Front Door API with dynamic agentId
          result = await svc.taskController.processMessage(task.id, {
            text: ticketPrompt
          }, {
            agenticMode: true,
            agentId: agent.agent_id, // Front Door will inject this agent's persona
            autoApprove: {
              'use_mcp_tool': true,
              'execute_command': true,
              'write_to_file': true,
              'read_file': true
            }
          });
          
          // Extract agent response from result
          if (result && result.messages) {
            const completionMsg = result.messages.find(msg => msg.say === 'completion_result');
            if (completionMsg && completionMsg.text) {
              agentResponse = completionMsg.text;
            }
          }
          
          logger.info(`✓ Front Door API completed ticket ${ticket.id} (${agentResponse.length} chars)`);
        } catch (cliError) {
          // Fallback to AgenticController if Front Door fails
          logger.warn(`Front Door API failed for ticket ${ticket.id}, falling back to AgenticController: ${cliError.message}`);
          clineStatus.available = false; // Mark as unavailable for this ticket
        }
      }
      
      if (!clineStatus.available) {
        // Fallback: Use AgenticController (standard processing)
        logger.info(`Using AgenticController for ticket ${ticket.id} (CLI not available)`);
        
        const description = svc.extractDescription(ticket);

        // FIX 7: Get recent comments for context (previous agent work)
        let previousWorkSection = '';
        try {
          const recentComments = await svc.planeDb.getRecentComments(client, ticket.id, 5);
          if (recentComments && recentComments.length > 0) {
            const commentTexts = recentComments
              .filter(c => !c.comment_stripped.includes('Queue Manager v1.0') && 
                          !c.comment_stripped.includes('Routed to @agent:'))
              .map(c => c.comment_stripped.substring(0, 2000))
              .join('\n---\n');
            if (commentTexts.trim()) {
              previousWorkSection = `\n\n## Previous Agent Work\nOther agents have already worked on this ticket. Review their contributions below and BUILD ON their work — do not repeat what's already been done:\n\n${commentTexts}\n`;
            }
          }
        } catch (historyErr) {
          logger.warn(`Failed to get comment history for ticket ${ticket.id}: ${historyErr.message}`);
        }

        // FIX 1: Explicit instruction to put deliverables INLINE, not in files
        // Build extra context sections for attachments and links
        let extraContext = '';
        if (attachmentsContext) extraContext += `\n\n${attachmentsContext}`;
        if (linksContext) extraContext += `\n\n${linksContext}`;

        // ⭐ PHASE PROMPT: Get phase-specific instructions if ticket is in phased lifecycle
        const phasePromptBlock = (analysis.currentPhase && analysis.phaseData) 
          ? svc.phaseManager.getPhasePrompt(analysis.currentPhase, ticket, agent.agent_id)
          : '';

        const cleanPrompt = `You are agent "${agent.agent_id}" — part of a MULTI-AGENT PROCESS CHAIN on Plane Ticket #${ticket.id}.
${phasePromptBlock ? `\n${phasePromptBlock}\n` : ''}
═══════════════════════════════════════════
PROCESS CHAIN AWARENESS
═══════════════════════════════════════════

You are NOT working alone. You are one agent in a relay chain:
1. The Queue Manager assigns this ticket to you
2. You do YOUR work and write a DEVELOPER HANDOVER in your completion
3. Your completion is saved as a Plane comment on this ticket
4. The next agent reads ALL previous comments (the full thread) before starting
5. The chain continues until the ticket is fully resolved

**YOUR COMPLETION = THE NEXT AGENT'S BRIEFING**
Everything you write in attempt_completion is saved permanently as a Plane comment.
The next agent will read it. A human reviewer will read it. Write accordingly.

═══════════════════════════════════════════
TICKET
═══════════════════════════════════════════

**Plane Ticket #${ticket.id}: ${ticket.name}**

**Description:**
${description}
${previousWorkSection}${extraContext}

═══════════════════════════════════════════
YOUR INSTRUCTIONS
═══════════════════════════════════════════

1. **READ THE THREAD ABOVE** — Previous agents may have already done work. Do NOT repeat it. BUILD ON IT.
2. **DO THE ACTUAL WORK** — If the ticket asks for a proposal, CREATE it. If it asks for code, WRITE it. If it asks a question, ANSWER it thoroughly.
3. **INCLUDE FULL DELIVERABLE INLINE** — Users and other agents can ONLY see what you put in attempt_completion. Do NOT reference workspace files.
4. **USE MCP TOOLS** — Google Search, ChromaDB, Presentron are available if the task benefits from them.

═══════════════════════════════════════════
MANDATORY: DEVELOPER HANDOVER FORMAT
═══════════════════════════════════════════

Your attempt_completion response MUST end with a structured handover section.
This is how the next agent (or human reviewer) understands what you did.

**Required format at the END of your response:**

---
## 🔄 Developer Handover

**Agent:** ${agent.agent_id}
**Status:** [Complete | Partial — needs X]

### What I Did
- [Bullet list of concrete actions taken]

### What I Produced
- [List of deliverables with brief descriptions]

### What's Left To Do
- [List remaining work, or "Nothing — ticket fully resolved"]

### Key Context for Next Agent
- [Any important findings, decisions, or blockers the next agent must know]
---

QUALITY SELF-CHECK:
- Does this response contain REAL deliverable content, not just an outline?
- Did I include the Developer Handover section at the end?
- Would the next agent be able to continue my work without asking questions?

Zero tolerance for lazy responses. Deliver excellence.`;

        logger.info(`Processing ticket ${ticket.id} with clean prompt (no pollution)`);

        // Process with AgenticController - SAME PATH AS UI
        result = await svc.taskController.processMessage(task.id, {
          text: cleanPrompt
        }, {
          agenticMode: true,
          autoApprove: {
            'use_mcp_tool': true,       // Auto-approve MCP tool usage
            'execute_command': true,     // Auto-approve shell commands (docker, npm, pip, etc.)
            'write_to_file': true,       // Auto-approve file creation
            'read_file': true            // Auto-approve file reading
          }
        });
      }

      // Extract ALL agent work (not just completion) - only if not already set by Cline CLI
      if (!agentResponse || agentResponse === 'Agent processed your request.') {
        agentResponse = 'Agent processed your request.';
      }
      if (result.messages && result.messages.length > 0) {
        // Get completion_result first (highest quality), then text messages
        // EXCLUDE tool_result — those contain raw JSON artifacts that look ugly in Plane
        const completionMsg = result.messages.find(msg => 
          msg.say === 'completion_result' && msg.text && msg.text.length > 100
        );
        
        if (completionMsg) {
          // Use the completion result directly — this is the agent's final deliverable
          agentResponse = completionMsg.text;
        } else {
          // Fall back to text messages (exclude tool_result JSON artifacts)
          const textMessages = result.messages.filter(msg => 
            msg.say === 'text' && msg.text && 
            msg.text !== 'Agent processed your request.' &&
            msg.text.length > 50 // Skip short status messages
          );
          
          if (textMessages.length > 0) {
            agentResponse = textMessages.map(msg => msg.text).join('\n\n');
          }
        }
      }

      } // end of if (!result) — local processing fallback

      // ⭐ PHASE_44 FIX 1: Targeted workspace file recovery BEFORE decomposition check
      // Previous recovery attempts (PHASE_16, PHASE_40) either scan too broadly (all recent dirs)
      // or run too late (inside phase gate block that subtasks never reach).
      // This targeted scan uses the EXACT workspace dir for this ticket's known taskId.
      if (taskId && (agentResponse === 'Agent processed your request.' || agentResponse.length < 100)) {
        try {
          const fs = require('fs');
          const path = require('path');
          const wsDir = path.join('/app/workspace', taskId);
          if (fs.existsSync(wsDir)) {
            let bestContent = '';
            let bestFile = '';
            const scanDirForRecovery = (dir, prefix = '') => {
              try {
                const files = fs.readdirSync(dir).filter(f => 
                  (f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.html')) && !f.startsWith('_')
                );
                for (const file of files) {
                  try {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && stat.size < 100000) {
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
            scanDirForRecovery(wsDir);
            scanDirForRecovery(path.join(wsDir, 'notes'), 'notes');
            scanDirForRecovery(path.join(wsDir, 'deliverables'), 'deliverables');
            
            if (bestContent.length > 200) {
              logger.info(`📂 PHASE_44 FIX 1: Workspace recovery for ticket ${ticket.id}: ${bestContent.length} chars from ${bestFile} (was: ${agentResponse.length} chars)`);
              agentResponse = bestContent;
              result = { messages: [{ say: 'completion_result', text: agentResponse }] };
            } else {
              logger.debug(`PHASE_44 FIX 1: No substantive workspace content found for ticket ${ticket.id} in ${wsDir}`);
            }
          }
        } catch (wsRecoveryErr) {
          logger.debug(`PHASE_44 FIX 1: Workspace recovery error for ticket ${ticket.id}: ${wsRecoveryErr.message}`);
        }
      }

      // Hand off to the completion stage (decomposition, RALF rounds, escalations,
      // peer commands, phase gate, metrics wrap-up) — extracted to
      // DispatchCompletionHandler for the 1000-code-line cap. The call runs inside
      // this try block so completion-stage errors hit the same catch below,
      // exactly as when this was one method body.
      return await DispatchCompletionHandler.completeDispatch(svc, client, ticket, agent, agentPlaneUserId, {
        taskId,
        result,
        agentResponse,
        metricsStartMs: _metricsStartMs,
      });
    } catch (error) {
      logger.error(`Failed to process ticket ${ticket.id} with agent:`, error.message);
      
      // ⭐ RELEASE LOCK: Release on error to prevent permanent locking
      if (taskId) {
        await svc.releaseTaskLock(taskId);
      }
      
      // On error, return ticket to Todo and decrement load
      try {
        await svc.updateTicketStatus(client, ticket.id, 'Todo', ticket.project_id);
        await svc.agentRegistry.decrementLoad(agent.agent_id, ticket.workspace_id);
        
        const errorComment = svc.commentFormatter.errorComment(agent.agent_id, error.message);
        
        await svc.postComment(client, ticket, errorComment, agentPlaneUserId);
      } catch (cleanupError) {
        logger.error(`Failed to cleanup after processing error:`, cleanupError.message);
      }
    }
  }
}

module.exports = AgentDispatchEngine;
