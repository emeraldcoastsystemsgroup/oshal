/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): POST /api/process-ticket (QM HTTP dispatch) + the PHASE_48 enhanced ticket path helper
 */

const path = require('path');
const logger = require('../utils/logger');

/**
 * @description POST /api/process-ticket — Queue Manager HTTP dispatch entrypoint: persona/README/swarm-awareness prompt assembly, shared-workspace handling (PHASE_44B), legacy TaskController path, aggressive response extraction, and PHASE_66 cost metrics.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerProcessTicketRoute(application) {
    // ═══════════════════════════════════════════
    // HTTP Dispatch: Process ticket from Queue Manager
    // Swarm agents expose this so QM can dispatch work to them
    // ═══════════════════════════════════════════
    const taskController = application.taskController;
    application.app.post('/api/process-ticket', async (req, res) => {
      try {
        const { ticket, analysis, agentId, previousComments, attachmentsContext, linksContext, phasePrompt, currentPhase, parentWorkspaceTaskId, ralfRoundContext } = req.body;
        if (!ticket || !ticket.id) {
          return res.status(400).json({ error: 'Missing ticket data' });
        }
        
        logger.info(`📥 Received ticket dispatch: ${ticket.id} - ${ticket.name} (agent: ${agentId}, comments: ${(previousComments || []).length}${parentWorkspaceTaskId ? ', sharedWS: ' + parentWorkspaceTaskId : ''})`);
        
        const description = ticket.description_stripped || ticket.name || 'No description';
        
        // Build previous work section from comment history (if provided by QueueManager)
        let previousWorkSection = '';
        if (previousComments && Array.isArray(previousComments) && previousComments.length > 0) {
          const commentTexts = previousComments.join('\n---\n');
          if (commentTexts.trim()) {
            previousWorkSection = `\n\n## Previous Agent Work\nOther agents have already worked on this ticket. Review their contributions below and BUILD ON their work — do not repeat what's already been done:\n\n${commentTexts}\n`;
          }
          logger.info(`📜 Injecting ${previousComments.length} previous comments into prompt for ticket ${ticket.id}`);
        }

        // Inject attachments and links context from QMS (Enhancement E1/E2)
        let extraContext = '';
        if (attachmentsContext && attachmentsContext.trim()) {
          extraContext += `\n\n${attachmentsContext}`;
          logger.info(`📎 Injecting attachments context for ticket ${ticket.id}`);
        }
        if (linksContext && linksContext.trim()) {
          extraContext += `\n\n${linksContext}`;
          logger.info(`🔗 Injecting links context for ticket ${ticket.id}`);
        }
        
        // ⭐ SHARED WORKSPACE: If parentWorkspaceTaskId provided, reuse parent's workspace folder
        let task;
        if (parentWorkspaceTaskId) {
          task = await taskController.getTask(parentWorkspaceTaskId);
          if (!task) {
            // ⭐ PHASE_44B FIX: Task doesn't exist on THIS agent container (was created on project-manager)
            // Create a new task but FORCE it to use the parent's workspace directory
            // This ensures all agents write to the SAME folder for one Plane ticket
            logger.info(`📂 PHASE_44B: Parent task ${parentWorkspaceTaskId} not in local store — creating local task with SAME workspace dir`);
            task = await taskController.createTask(
              `Agent ${agentId} processing ticket ${ticket.id} (shared workspace)`, 'act',
              { forceTaskId: parentWorkspaceTaskId }
            );
            if (task.id !== parentWorkspaceTaskId) {
              // createTask didn't honor forceTaskId — manually fix the workspace reference
              logger.warn(`⚠️ PHASE_44B: createTask didn't honor forceTaskId, task.id=${task.id}, expected=${parentWorkspaceTaskId}. Patching task.id.`);
              task.id = parentWorkspaceTaskId;
            }
            logger.info(`📂 PHASE_44B: Local task created → workspace ${task.id} (shared with project-manager)`);
          } else {
            logger.info(`📂 HTTP Dispatch: Reusing parent workspace ${parentWorkspaceTaskId} for child ticket ${ticket.id}`);
          }
        } else {
          task = await taskController.createTask(
            `Agent ${agentId} processing ticket ${ticket.id}`, 'act'
          );
        }

        const workspaceUrl = `http://localhost:3010/workspace/${task.id}`;
        
        // ⭐ PHASE_18/19: Inject Swarm Awareness — every bot gets full situational context
        // PHASE_19 FIX (GAP #3): Use REAL values from ralfRoundContext instead of hardcoded 1/2/participant
        let swarmAwarenessBlock = '';
        try {
          const SwarmAwarenessPrompt = require('../services/queue-manager/SwarmAwarenessPrompt');

          // ⭐ PHASE_22: Fetch live swarm roster so every bot knows who the other bots are
          let swarmRoster = null;
          try {
            if (application.redisClient) {
              const { AgentRegistry } = require('../services/queue-manager');
              const tempRegistry = new AgentRegistry(application.redisClient);
              const allAgents = await tempRegistry.getAll();
              swarmRoster = allAgents.map(a => ({
                agent_id: a.agent_id,
                capabilities: Array.isArray(a.capabilities) ? a.capabilities : (a.capabilities ? JSON.parse(a.capabilities) : []),
                status: a.status || 'unknown',
              }));
            }
          } catch (rosterErr) {
            // Non-fatal — roster is nice-to-have
            logger.debug(`[RALF] Swarm roster fetch failed: ${rosterErr.message}`);
          }

          if (currentPhase) {
            const rc = ralfRoundContext || {}; // RALF round context from QMS dispatch
            swarmAwarenessBlock = SwarmAwarenessPrompt.build({
              agentId: agentId || 'worker',
              currentPhase: currentPhase,
              currentRound: rc.currentRound || 1,
              maxRounds: rc.maxRounds || 2,
              role: rc.role || 'participant',
              colleagues: rc.colleagues || [],
              roleAssignments: rc.roleAssignments || null,
              previousRoundAgent: rc.previousRoundAgent || null,
              previousRoundRole: rc.previousRoundRole || null,
              ticketName: ticket.name || 'Ticket',
              complexity: analysis?.complexity || 'medium',
              swarmRoster,
            });
            if (rc.currentRound) {
              logger.info(`[RALF] SwarmAwarenessPrompt built with REAL round context: R${rc.currentRound}/${rc.maxRounds}, role=${rc.role}`);
            }
          } else {
            swarmAwarenessBlock = SwarmAwarenessPrompt.buildMinimal(agentId || 'worker', ticket.name || 'Ticket');
          }
        } catch (swarmErr) {
          logger.debug(`SwarmAwareness prompt build failed (non-fatal): ${swarmErr.message}`);
        }

        // ── PERSONA INJECTION: Load this bot's persona YAML and prepend to prompt ──
        // loadPersona() reads BOT_PERSONA_FILE env var (set per-container in docker-compose)
        // Without this, every bot gets the generic "You are agent X" prompt — no identity.
        // The _processTicketEnhanced path does this correctly; this mirrors it for the LEGACY path.
        let personaPrefix = '';
        try {
          const { loadPersona } = require('../utils/personaLoader');
          const ticketPersona = loadPersona(agentId);
          if (ticketPersona && ticketPersona.perspective) {
            personaPrefix = `## YOUR IDENTITY AND ROLE\n\nYou are **${ticketPersona.name}** — ${ticketPersona.role}.\n\n${ticketPersona.perspective}\n\n---\n\n`;
            logger.info(`[Ticket] ✅ Persona injected for ${agentId}: ${ticketPersona.name} (${ticketPersona.perspective.length} chars)`);
          } else {
            logger.debug(`[Ticket] No persona found for ${agentId} — using generic identity`);
          }
        } catch (personaErr) {
          logger.debug(`[Ticket] Persona load failed (non-fatal): ${personaErr.message}`);
        }

        // ── README INJECTION: Load {agent-id}-readme.md if it exists ──────────────
        // agent-factory-bot creates {agent-id}-readme.md in /app/bot-configs/ when building a bot.
        // This file contains user-facing docs, usage examples, and domain knowledge.
        // Injecting it gives the bot additional context beyond the persona perspective.
        let readmeSection = '';
        try {
          const fs = require('fs');
          const readmePath = `/app/bot-configs/${agentId}-readme.md`;
          if (fs.existsSync(readmePath)) {
            const readmeContent = fs.readFileSync(readmePath, 'utf8');
            if (readmeContent && readmeContent.trim().length > 50) {
              readmeSection = `\n\n## YOUR REFERENCE DOCUMENTATION\n\n${readmeContent.trim()}\n\n---\n\n`;
              logger.info(`[Ticket] ✅ README injected for ${agentId}: ${readmePath} (${readmeContent.length} chars)`);
            }
          }
        } catch (readmeErr) {
          logger.debug(`[Ticket] README load failed (non-fatal): ${readmeErr.message}`);
        }
        // ── END README INJECTION ───────────────────────────────────────────────────

        const cleanPrompt = `${personaPrefix}${readmeSection}${swarmAwarenessBlock ? swarmAwarenessBlock + '\n\n' : ''}You are agent ${agentId || 'worker'}. A ticket has been dispatched to you.
${phasePrompt ? `\n${phasePrompt}\n` : ''}

**Plane Ticket #${ticket.id}: ${ticket.name}**

**Description:**
${description}
${previousWorkSection}${extraContext}

**Your Workspace:**
- Directory: /app/workspace/${task.id}/
- Public URL: ${workspaceUrl}

CRITICAL INSTRUCTIONS:
1. ANALYZE this ticket — what is the user actually asking for?
2. DO THE ACTUAL WORK — create the deliverable, not an outline.
3. WRITE deliverables to workspace files using write_to_file tool — organize into multiple files if needed.
4. USE your available MCP tools (Google Search, ChromaDB, Presentron) if the task benefits from external data, document retrieval, or presentation generation.

DELIVERABLE STRATEGY:
- **Small deliverables (<10KB):** Include inline in attempt_completion
- **Large deliverables (>10KB) or multi-file projects:** Write to workspace + return summary with links
  * Example link format: [filename.md](${workspaceUrl}/filename.md)
  * In your summary, list all files with descriptions and sizes

OUTPUT FORMAT for Large/Multi-File Deliverables:
- Write organized files to workspace (analysis.md, implementation.md, code files, etc.)
- In your attempt_completion, provide:
  1. High-level summary (2-3 paragraphs)
  2. Key findings/recommendations (bullets)
  3. List of files with links: [filename](${workspaceUrl}/filename) — Description (size)
  4. Next steps

SELF-ORIENTATION (read yourself in):
- Your persona YAML defines your specialty — trust it, that's why you were selected
- Previous comments on this ticket (above) show what colleagues already produced — DON'T repeat their work
- If "🧠 Organizational Memory" appears above, it contains learnings from similar past tickets — USE them
- You have access to project docs: /app/PROJECT_PLAN.md, /app/DEVELOPER_HANDOVER.md — read these if you need broader project context
- Your response becomes a Plane comment that the NEXT agent reads — write for your successor, not just the user

QUALITY SELF-CHECK (ask yourself before submitting):
- Is this my BEST, most complete response? Or am I rushing?
- Did I use available tools (search, RAG, file creation) to deepen my analysis?
- Would a senior professional find this response thorough and actionable?
- Did I write actual files with real content, not just describe what I would write?
- If I wrote workspace files, did I include links in my summary?
- Did I document my reasoning (WHY, not just WHAT)?
- Will the next agent in the pipeline understand what I did and what's left?

Zero tolerance for lazy responses. Follow best practices. Deliver excellence.

Use attempt_completion with your response (inline for small, summary+links for large).`;

        logger.info(`📏 Total prompt length for ticket ${ticket.id}: ${cleanPrompt.length} chars`);
        
        // ═══════════════════════════════════════════════════════════════════
        // ⭐ PHASE_48 Issue #049: Enhanced ticket processing path
        // ⭐ PHASE_52 Issue #052: Cline CLI cannot handle large prompts
        // Cline CLI stalls with 56K prompts (344 messages, then 180s silence)
        // Root cause: Cline CLI is interactive tool, not batch processor
        // Solution: Use Bedrock for enhanced path, Cline CLI for simple tasks only
        // ═══════════════════════════════════════════════════════════════════
        const useClineProvider = false; // DISABLED: Cline CLI stalls on large prompts (Issue #052)

        if (useClineProvider) {
          const enhancedResult = await processTicketEnhanced(application, 
            ticket, task, agentId, cleanPrompt, swarmAwarenessBlock
          );
          return res.json(enhancedResult);
        }

        // ═══════════════════════════════════════════════════════════════════
        // LEGACY PATH: Use TaskController (for Bedrock or fallback)
        // ═══════════════════════════════════════════════════════════════════
        logger.info(`[Ticket] Using LEGACY path (TaskController) for ticket ${ticket.id}`);
        
        const result = await taskController.processMessage(task.id, {
          text: cleanPrompt
        }, { agenticMode: true, autoApprove: { 'use_mcp_tool': true } });
        
        // Extract agent response — AGGRESSIVE extraction, never return empty default
        let agentResponse = 'Agent processed your request.';
        if (result.messages && result.messages.length > 0) {
          // DEBUG: Log message types for debugging response extraction
          const msgTypes = result.messages.map(m => `${m.say}(${(m.text||'').length})`).join(', ');
          logger.info(`📊 Response extraction for ticket ${ticket.id}: ${result.messages.length} messages [${msgTypes}]`);
          
          // PRIORITY 1: completion_result with ANY content (lowered from 100 to 20 chars)
          const completionMsg = result.messages.find(msg => 
            msg.say === 'completion_result' && msg.text && msg.text.length > 20
          );
          
          if (completionMsg) {
            agentResponse = completionMsg.text;
            logger.info(`📊 Extracted completion_result: ${agentResponse.length} chars`);
          } else {
            // PRIORITY 2: text messages (lowered from 50 to 20 chars)
            const textMessages = result.messages.filter(msg => 
              msg.say === 'text' && msg.text && 
              msg.text !== 'Agent processed your request.' &&
              msg.text.length > 20
            );
            if (textMessages.length > 0) {
              agentResponse = textMessages.map(msg => msg.text).join('\n\n');
              logger.info(`📊 Extracted ${textMessages.length} text messages: ${agentResponse.length} chars`);
            } else {
              // PRIORITY 3: ANY message with text content > 100 chars (excluding prompt echo and task messages)
              const anySubstantive = result.messages.filter(msg => 
                msg.text && msg.text.length > 100 && 
                msg.text !== 'Agent processed your request.' &&
                msg.say !== 'task' &&
                // Exclude the initial prompt echo (say message matching the cleanPrompt)
                !(msg.say === 'say' && msg.text === cleanPrompt)
              ).sort((a, b) => (b.text||'').length - (a.text||'').length);
              
              if (anySubstantive.length > 0) {
                agentResponse = anySubstantive[0].text;
                logger.info(`📊 Extracted from ${anySubstantive[0].say} message: ${agentResponse.length} chars`);
              } else {
                // PRIORITY 4: Try reading workspace files
                try {
                  const fs = require('fs');
                  const path = require('path');
                  const taskDir = path.join('/app/workspace', task.id);
                  if (fs.existsSync(taskDir)) {
                    const files = fs.readdirSync(taskDir).filter(f => 
                      f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.html')
                    );
                    for (const file of files) {
                      try {
                        const content = fs.readFileSync(path.join(taskDir, file), 'utf8');
                        if (content && content.length > agentResponse.length) {
                          agentResponse = content;
                        }
                      } catch (e) { /* skip unreadable */ }
                    }
                    if (agentResponse !== 'Agent processed your request.') {
                      logger.info(`📊 Extracted from workspace file: ${agentResponse.length} chars`);
                    }
                  }
                } catch (e) { /* workspace scan failed, use default */ }
                
                if (agentResponse === 'Agent processed your request.') {
                  // ⭐ PHASE_41 FIX: Fallback to result.result from AgenticController return value
                  const agenticResult = result.result?.result || result.result?.partialResult;
                  if (agenticResult && typeof agenticResult === 'string' && agenticResult.length > 50) {
                    agentResponse = agenticResult;
                    logger.info(`📊 PHASE_41: Extracted from result.result object: ${agentResponse.length} chars`);
                  } else {
                    logger.warn(`⚠️ Response extraction FAILED for ticket ${ticket.id} — all ${result.messages.length} messages were empty/short`);
                  }
                }
              }
            }
          }
        } else {
          // ⭐ PHASE_41 FIX: Even with no messages, try result.result
          const agenticResult = result?.result?.result || result?.result?.partialResult;
          if (agenticResult && typeof agenticResult === 'string' && agenticResult.length > 50) {
            agentResponse = agenticResult;
            logger.info(`📊 PHASE_41: Extracted from result.result (no messages path): ${agentResponse.length} chars`);
          } else {
            logger.warn(`⚠️ No messages returned from processMessage for ticket ${ticket.id}`);
          }
        }
        
        logger.info(`✅ Ticket ${ticket.id} processed by ${agentId} (${agentResponse.length} chars)`);

        // ⭐ PHASE_66: Include apiMetrics in response so QueueManager can record cost
        const taskObj = await taskController.getTask(task.id);
        const apiMetrics = taskObj?.apiMetrics || result?.apiMetrics || null;
        if (apiMetrics && apiMetrics.totalCost > 0) {
          logger.info(`💰 PHASE_66: Ticket ${ticket.id} cost: $${apiMetrics.totalCost.toFixed(4)} (${apiMetrics.totalTokens} tokens, ${apiMetrics.requestCount} requests)`);
        }

        res.json({ success: true, ticketId: ticket.id, agentId, response: agentResponse, result, apiMetrics });
      } catch (error) {
        logger.error(`❌ Process-ticket error: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
}

  /**
   * Process ticket with enhanced context (PHASE_48 Issue #049)
   * Aligns with dashboard chat pattern for quality parity
   * @private
   */
async function processTicketEnhanced(application, ticket, task, agentId, cleanPrompt, swarmAwarenessBlock) {
    logger.info(`[Ticket] Using ENHANCED path for ticket ${ticket.id}`);
    
    // 1. Load persona
    const { loadPersona } = require('../utils/personaLoader');
    const personaConfig = loadPersona(agentId || 'project-manager');
    
    // 2. Fetch agent roster
    let agentRosterSection = '';
    if (application.redisClient) {
      try {
        const { AgentRegistry } = require('../services/queue-manager');
        const registry = new AgentRegistry(application.redisClient);
        const allAgents = await registry.getAll();
        
        agentRosterSection = '\n\n## SWARM ROSTER\n\n';
        agentRosterSection += 'Available agents for collaboration:\n\n';
        allAgents.forEach(agent => {
          const caps = Array.isArray(agent.capabilities) 
            ? agent.capabilities.join(', ') 
            : (agent.capabilities || 'general');
          agentRosterSection += `- **${agent.agent_id}**: ${caps}\n`;
        });
        
        logger.info(`[Ticket] Injected ${allAgents.length} agents into roster`);
      } catch (rosterErr) {
        logger.warn(`[Ticket] Failed to fetch agent roster: ${rosterErr.message}`);
      }
    }
    
    // 3. Build complete prompt
    const promptParts = [];
    
    if (personaConfig) {
      promptParts.push('## YOUR IDENTITY AND ROLE');
      promptParts.push(`You are **${personaConfig.name}** — ${personaConfig.role}.`);
      promptParts.push('');
      if (personaConfig.perspective) {
        promptParts.push(personaConfig.perspective);
        promptParts.push('');
      }
      promptParts.push('---');
      promptParts.push('');
    }
    
    if (agentRosterSection) {
      promptParts.push(agentRosterSection);
      promptParts.push('---');
      promptParts.push('');
    }
    
    if (swarmAwarenessBlock) {
      promptParts.push(swarmAwarenessBlock);
      promptParts.push('');
      promptParts.push('---');
      promptParts.push('');
    }
    
    promptParts.push('## TICKET ASSIGNMENT');
    promptParts.push('');
    promptParts.push(cleanPrompt);
    promptParts.push('');
    promptParts.push('---');
    promptParts.push('');
    promptParts.push('## BATCH MODE');
    promptParts.push('');
    promptParts.push('This is a one-shot ticket execution. Complete the task fully and use attempt_completion when done.');
    promptParts.push('You have full autonomy to make decisions and use tools as needed.');
    promptParts.push('Focus on delivering a complete, high-quality result.');
    
    const completePrompt = promptParts.join('\n');
    
    logger.info(`[Ticket] Built enhanced prompt: ${completePrompt.length} chars (persona: ${!!personaConfig}, roster: ${!!agentRosterSection})`);
    
    // 4. Call ClineProvider directly
    const ClineProvider = require('../services/llm/ClineProvider');
    if (!application.clineProvider) {
      application.clineProvider = new ClineProvider({
        timeout: 300,
        inactivityTimeout: 180,
        model: process.env.LLM_MODEL,
        clineCommand: process.env.HOME + '/.local/bin/cline',
      });
    }
    
    const response = await application.clineProvider.generateResponse(
      [{ role: 'user', content: completePrompt }],
      {
        workspaceDir: task.workspace_dir,
        source: 'ticket',
      }
    );
    
    // 5. Extract and save response
    const agentResponse = response.content || 'Agent processed the ticket.';
    
    await application.messageStore.saveMessage(task.id, {
      type: 'say',
      say: 'completion_result',
      text: agentResponse,
      ts: Date.now(),
    });
    
    logger.info(`✅ Ticket ${ticket.id} processed via ENHANCED path (${agentResponse.length} chars)`);
    
    return {
      success: true,
      ticketId: ticket.id,
      agentId,
      response: agentResponse,
      enhancedPath: true,
    };
  }

module.exports = { registerProcessTicketRoute };
