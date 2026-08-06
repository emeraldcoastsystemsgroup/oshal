/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Moved the inline auto-approval expression to controllers/tool-approval-policy.js and called it here. No behaviour change — the extraction exists because this is the only gate between an injected prompt and shell execution on the unattended path, it was a bare one-liner with a misleading flag name (callers pass `execute_command`, this read `commandExecution`), and this file is at the size cap so the rule could not be documented in place. The policy module carries the explanation and tests/unit/tool-approval-policy.spec.ts pins it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: enforce request-scoped tool allowlists and fence tool/error output before it returns to the model loop.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: enforce exact operation scopes over request-start handler snapshots, remove model-readable GitLab credentials, and make completion side-effect free.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: revalidate captured handler generations immediately before provider and tool execution.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: bind MCP handler attestations to the exact request user, agent, task, tool allowlist, and operation scopes already authorized at dispatch.
 */

/**
 * Agentic Controller
 * Implements multi-turn LLM conversation loop with autonomous tool execution
 */

const { getClineSystemPrompt, getMinimalSystemPrompt, requiresFullPrompt } = require('../services/llm/ClineSystemPrompt');
const ToolUseParser = require('../services/llm/ToolUseParser');
const PromptTokenManager = require('../services/llm/PromptTokenManager');
const logger = require('../utils/logger');
const { normalizeAllowedTools, wrapUntrustedContent } = require('../utils/untrusted-content');
// Token Chase (ADR-046) per-call capture lane. Dark by default (TOKEN_CHASE_CAPTURE unset =>
// every entry point is a no-op and this call site is byte-identical to before). See
// services/token-chase/TokenChaseCapture.js for the zero-impact contract.
const { tokenChase } = require('../services/token-chase/TokenChaseCapture');
const { shouldAutoApproveTool } = require('./tool-approval-policy');
const {
  authorizeCapability,
  captureDispatchCapabilities,
  assertDispatchCapabilitiesCurrent,
  normalizeAuthorizedScopes,
} = require('../utils/dispatch-capabilities');

function normalizeRuntimeIdentity(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

/**
 * @description Orchestrates the autonomous agentic loop that drives a task to completion:
 * it repeatedly asks an LLM provider for the next action, executes any requested tool,
 * feeds the result back into the conversation, and stops on attempt_completion (or a
 * plain text reply). It exists to decouple the "think -> act -> observe" control flow
 * from any single LLM backend, so the same loop works across Bedrock, Cline CLI, and
 * Claude Code providers while handling persona injection, swarm-roster awareness,
 * provider fallback and streaming/broadcast of progress.
 */
class AgenticController {
  /**
   * @description Wires the controller to its collaborators and normalizes the provider
   * input, accepting either a single legacy provider or a provider map so older and
   * newer call sites can both construct it. Defaults the active provider selection to
   * cline-cli (the mandated agent provider) and caps turns to guard against runaway loops.
   * @param {Object} providers - Either a provider map ({ bedrockProvider, clineProvider, claudeCodeProvider, getCurrentProvider }) or a single legacy provider instance.
   * @param {Object} toolRegistry - Registry used to look up, validate, and execute tools the LLM requests.
   * @param {Object} streamController - Broadcaster used to stream turn/tool/completion events to subscribed clients.
   * @param {Object|null} [taskController=null] - Task store used to load the task, persist messages, and update metrics.
   */
  constructor(providers, toolRegistry, streamController, taskController = null) {
    // Support both old (single provider) and new (provider map) initialization
    if (providers.bedrockProvider || providers.clineProvider || providers.claudeCodeProvider || providers.codexProvider) {
      // New format: { bedrockProvider, clineProvider, claudeCodeProvider, codexProvider, getCurrentProvider }
      this.bedrockProvider = providers.bedrockProvider;
      this.clineProvider = providers.clineProvider;
      this.claudeCodeProvider = providers.claudeCodeProvider || null;
      this.codexProvider = providers.codexProvider || null;
      // MANDATORY: Default agent provider is ALWAYS cline-cli (per oshal-agent-provider-rules.md)
      this.getCurrentProvider = providers.getCurrentProvider || (() => 'cline-cli');
    } else {
      // Legacy format: single provider passed directly
      this.bedrockProvider = providers;
      this.clineProvider = null;
      this.codexProvider = null;
      // MANDATORY: Default agent provider is ALWAYS cline-cli (per oshal-agent-provider-rules.md)
      this.getCurrentProvider = () => 'cline-cli';
    }
    
    this.tools = toolRegistry;
    this.stream = streamController;
    this.taskController = taskController;
    this.maxTurns = 25; // Prevent infinite loops
  }
  
  /**
   * Get the active LLM provider based on configured default.
   * Respects getCurrentProvider() for ALL sources (dashboard, tickets, etc.)
   * 
   * ⭐ PHASE_65 FIX: Removed dashboard-specific BedrockProvider override.
   * BedrockProvider direct calls fail in GovCloud with "invalid model identifier"
   * because the us-gov. prefix handling is broken. Cline CLI (with GovCloud patch)
   * handles Bedrock calls correctly via its internal config (globalState.json).
   * 
   * @returns {Object} Active provider (ClineProvider preferred, BedrockProvider fallback)
   */
  getActiveProvider(source) {
    const providerName = this.getCurrentProvider();
    // Codex CLI provider when selected (openai-codex / codex-cli).
    if ((providerName === 'openai-codex' || providerName === 'codex-cli') && this.codexProvider) {
      return this.codexProvider;
    }
    // PHASE_10: Claude Code CLI provider takes priority when selected
    if (providerName === 'claude-code' && this.claudeCodeProvider) {
      return this.claudeCodeProvider;
    }
    if (providerName === 'cline-cli' && this.clineProvider) {
      return this.clineProvider;
    }
    return this.bedrockProvider;
  }

  /**
   * Process message with agentic loop
   * Continues calling LLM and executing tools until attempt_completion
   * 
   * ⭐ PHASE_58: Unified Cline CLI Path
   * @param {string} taskId - Task ID
   * @param {string} userMessage - User message
   * @param {Array} conversationHistory - Conversation history
   * @param {Object} autoApprove - Auto-approval settings
   * @param {Object} options - Additional options (e.g., agentId for dynamic persona)
   */
  async processAgenticTask(taskId, userMessage, conversationHistory = [], autoApprove = {}, options = {}) {
    logger.info(`Starting agentic task processing for task ${taskId}`);
    const dispatchAllowedTools = normalizeAllowedTools(options.allowedTools);
    const dispatchAuthorizedScopes = normalizeAuthorizedScopes(options.authorizedScopes);

    // Get task object to access workspace_dir
    const task = await this.taskController.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // ⭐ PHASE_58: Extract dynamic agentId from options (for ticket processing)
    const dynamicAgentId = options.agentId || null;
    
    if (dynamicAgentId && dynamicAgentId !== process.env.AGENT_ID) {
      logger.info(`🎭 Processing with dynamic persona: ${dynamicAgentId} (container default: ${process.env.AGENT_ID})`);
    }

    const history = [...conversationHistory];
    let turnCount = 0;
    let isComplete = false;
    let finalResult = null;
    const capturedProviderRecords = new Map();
    let lastActualProvider = null;
    let lastActualModel = null;

    // Track API metrics
    const apiMetrics = {
      totalTokens: 0,
      totalCost: 0,
      requestCount: 0,
      cacheHits: 0,
    };

    // ⭐ PHASE_56 FIX: For cline-cli, add user message to history BUT also pass it via options.
    // ClineProvider._messagesToTask() uses messages[last].content to get the current message.
    // We still need at least one message in the array so _messagesToTask can extract it.
    // The key difference from Bedrock: we pass empty conversationHistory (no prior messages),
    // so the history array only contains the current user message (no duplicates).
    const providerName = this.getCurrentProvider();
    // Always add the current user message — it's needed by ClineProvider to write to README
    history.push({
      role: 'user',
      content: userMessage,
    });
    if (providerName === 'cline-cli') {
      logger.info(`[AgenticController] cline-cli provider: user message added to history for README extraction (history length: ${history.length})`);
    }

    // Get available tools list with parameter schemas
    // Use full tool names to avoid collisions (ToolRegistry alias system handles lookups)
    const dispatchCapabilities = captureDispatchCapabilities(
      this.tools, dispatchAllowedTools, dispatchAuthorizedScopes,
    );
    const availableTools = dispatchCapabilities.definitions;

    // Detect if this is a simple conversation or complex task
    const needsFullPrompt = requiresFullPrompt(userMessage);
    
    // Get system prompt - use minimal for simple messages, full for complex tasks
    
    // DEBUG: Log token configuration without exposing token material.
    
    const agentId = process.env.AGENT_ID || 'Agent';
    
    // Extract identity for minimal prompt
    const personaConfig = require('../utils/config').persona;
    let personaIdentity = null;
    if (personaConfig && personaConfig.perspective) {
      // Keep identity SHORT (300 chars) to avoid E2BIG with Cline CLI
      const identitySection = personaConfig.perspective.split('\n\n')[0].substring(0, 300);
      personaIdentity = `## YOUR IDENTITY\nYou are **${personaConfig.name}** — ${personaConfig.role}.\n\n${identitySection}`;
      logger.info(`✅ Extracted persona identity for minimal prompt (${personaIdentity.length} chars)`);
    } else {
      logger.warn(`⚠️ NO persona config found or no perspective field`);
    }
    
    const systemPrompt = needsFullPrompt
      ? getClineSystemPrompt({
          taskId: taskId,
          currentWorkingDirectory: task.workspace_dir || '/app/workspace',
          currentDateTime: new Date().toISOString(),
          taskDescription: userMessage,
          availableTools: availableTools,
          agentId: agentId,
        })
      : getMinimalSystemPrompt({
          taskDescription: userMessage,
          currentDateTime: new Date().toISOString(),
          agentId: agentId,
          personaIdentity: personaIdentity,  // Pass identity to minimal prompt
        });
    
    // ═══ PHASE_43 (Issue #047): Conditional persona injection for TICKETS ONLY ═══
    // Dashboard chat: Identity already in systemPrompt (via personaIdentity parameter)
    // Plane tickets: Add full persona with orchestration behavior
    // ⭐ SESSION_06 FIX: options.source is the live value from the HTTP request.
    //    task.source is often undefined (never saved to task object from options).
    //    Use options.source as the authoritative check, with task.source as fallback.
    const isDashboardChat = options.source === 'dashboard' || (!task.ticketId && !options.source) || task.source === 'dashboard';

    // ⭐ SWARM ROSTER: Fetch live agent registry for dashboard chat (personal-assistant needs this).
    // Builds a markdown roster and replaces {{SWARM_ROSTER}} in finalSystemPrompt (works for ALL providers).
    // Only fetches for dashboard chat — ticket processing doesn't need live roster.
    let swarmRoster = options.swarmRoster || null;
    let swarmRosterMd = null;

    // Static fallback roster — used when Redis / AgentRegistry not available locally
    const STATIC_FALLBACK_ROSTER = [
      { agent_id: 'project-manager', capabilities: ['project-management', 'coordination', 'routing', 'planning'], status: 'unknown' },
      { agent_id: 'task-manager', capabilities: ['task-tracking', 'workflow'], status: 'unknown' },
      { agent_id: 'worker-general', capabilities: ['general-tasks', 'research', 'writing'], status: 'unknown' },
      { agent_id: 'code-reviewer', capabilities: ['code-review', 'security', 'quality'], status: 'unknown' },
      { agent_id: 'rca-specialist', capabilities: ['root-cause-analysis', 'debugging', 'troubleshooting'], status: 'unknown' },
      { agent_id: 'presentation-bot', capabilities: ['presentations', 'slides', 'visualization'], status: 'unknown' },
      { agent_id: 'documentation-bot', capabilities: ['documentation', 'technical-writing', 'readme'], status: 'unknown' },
      { agent_id: 'research-bot', capabilities: ['research', 'analysis', 'deep-dive'], status: 'unknown' },
      { agent_id: 'devops-bot', capabilities: ['devops', 'kubernetes', 'docker', 'cloud', 'infrastructure'], status: 'unknown' },
      { agent_id: 'general-bot', capabilities: ['general-purpose', 'q&a'], status: 'unknown' },
      { agent_id: 'security-auditor-bot', capabilities: ['security', 'audit', 'compliance'], status: 'unknown' },
      { agent_id: 'data-extraction-bot', capabilities: ['data-extraction', 'parsing', 'etl'], status: 'unknown' },
      { agent_id: 'weather-bot', capabilities: ['weather', 'forecasts', 'climate'], status: 'unknown' },
      { agent_id: 'log-analyzer-bot', capabilities: ['log-analysis', 'monitoring', 'observability'], status: 'unknown' },
      { agent_id: 'self-healing-bot', capabilities: ['self-healing', 'auto-remediation', 'monitoring'], status: 'unknown' },
    ];

    if (isDashboardChat) {
      try {
        // Priority 1: Live Redis AgentRegistry (K8s/production)
        if (this.taskController && this.taskController.queueManagerService && this.taskController.queueManagerService.agentRegistry) {
          const allAgents = await this.taskController.queueManagerService.agentRegistry.getAll();
          if (allAgents && allAgents.length > 0) {
            swarmRoster = allAgents.map(a => ({
              agent_id: a.agent_id,
              capabilities: Array.isArray(a.capabilities) ? a.capabilities : (a.capabilities ? JSON.parse(a.capabilities) : []),
              status: a.status || 'unknown',
            }));
            logger.info(`[AgenticController] ✅ Live swarm roster fetched from Redis: ${swarmRoster.length} agents`);
          }
        }
      } catch (rosterErr) {
        logger.warn(`[AgenticController] Failed to fetch swarm roster from Redis (non-fatal): ${rosterErr.message}`);
        swarmRoster = null;
      }

      // Priority 2: Local metrics API — reads YAML files, always available (local dev + production)
      if (!swarmRoster || swarmRoster.length === 0) {
        try {
          const http = require('http');
          const port = process.env.PORT || 5000;
          const metricsData = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: 'localhost', port, path: '/api/v1/metrics/summary', method: 'GET', timeout: 3000 }, (res) => {
              let data = '';
              res.on('data', chunk => { data += chunk; });
              res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
          });
          const agentList = metricsData?.agents?.list || metricsData?.data?.agents?.list;
          if (agentList && agentList.length > 0) {
            swarmRoster = agentList.map(a => ({
              agent_id: a.id || a.agent_id,
              capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
              status: a.status || 'idle',
            }));
            logger.info(`[AgenticController] ✅ Swarm roster fetched from metrics API: ${swarmRoster.length} agents`);
          }
        } catch (metricsErr) {
          logger.warn(`[AgenticController] Failed to fetch swarm roster from metrics API (non-fatal): ${metricsErr.message}`);
          swarmRoster = null;
        }
      }

      // Priority 3: Static fallback (hardcoded) when neither Redis nor metrics API available
      if (!swarmRoster || swarmRoster.length === 0) {
        swarmRoster = STATIC_FALLBACK_ROSTER;
        logger.warn(`[AgenticController] ⚠️ Using static fallback roster (${swarmRoster.length} agents)`);
      }

      swarmRosterMd = swarmRoster.map(a => {
        const caps = Array.isArray(a.capabilities) ? a.capabilities.slice(0, 4).join(', ') : (a.capabilities || 'general');
        const status = a.status === 'idle' ? '🟢' : a.status === 'busy' ? '🟡' : '⚪';
        return `- ${status} **${a.agent_id}** — ${caps}`;
      }).join('\n');
      logger.info(`[AgenticController] ✅ Swarm roster markdown built (${swarmRoster.length} agents)`);
    }

    let finalSystemPrompt;
    if (personaConfig && !isDashboardChat) {
      // Tickets: Full persona with orchestration behavior
      finalSystemPrompt = personaConfig.systemPromptPrefix + systemPrompt;
      logger.info(`Ticket processing: Using FULL persona with orchestration behavior`);
    } else {
      // Dashboard: systemPrompt already has identity (from personaIdentity parameter)
      finalSystemPrompt = systemPrompt;
      logger.info(`Dashboard chat: Identity included in ${needsFullPrompt ? 'FULL' : 'MINIMAL'} prompt`);
    }

    // ⭐ SWARM ROSTER INJECTION: Replace {{SWARM_ROSTER}} placeholder in finalSystemPrompt.
    // This works for ALL providers (Bedrock + ClineProvider) since we inject before the LLM call.
    // ClineProvider also has its own injection for the context file — belt-and-suspenders.
    if (swarmRosterMd && finalSystemPrompt.includes('{{SWARM_ROSTER}}')) {
      finalSystemPrompt = finalSystemPrompt.replace('{{SWARM_ROSTER}}', swarmRosterMd);
      logger.info(`[AgenticController] ✅ {{SWARM_ROSTER}} replaced in finalSystemPrompt`);
    }

    logger.info(`Using ${needsFullPrompt ? 'FULL' : 'MINIMAL'} system prompt for: "${userMessage.substring(0, 50)}..."`);
    
    try {
      while (!isComplete && turnCount < this.maxTurns) {
        turnCount++;
        logger.info(`Agentic turn ${turnCount}/${this.maxTurns}`);

        // Broadcast API request started
        const apiReqStartTime = Date.now();
        this.stream.broadcast(taskId, 'api_req_started', {
          turn: turnCount,
          ts: apiReqStartTime,
        });
        
        // Save api_req_started message
        if (this.taskController) {
          await this.taskController.addMessage(taskId, {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({ turn: turnCount }),
            ts: apiReqStartTime,
          });
        }

        // Broadcast thinking state
        this.stream.broadcast(taskId, 'llm_processing', {
          status: 'Thinking...',
          turn: turnCount,
        });

        // Get active provider based on getCurrentProvider() setting
        // ⭐ PHASE_65: All sources (dashboard, tickets) respect getCurrentProvider()
        const llmProvider = this.getActiveProvider(options.source);
        const providerName = this.getCurrentProvider();
        
        logger.info(`Using LLM provider: ${providerName} (source: ${options.source || 'none'})`);
        
        // ═══ ISSUE #011: Safety net — prevent 200K token overflow ═══
        const safeHistory = PromptTokenManager.safetyTruncate(history);
        if (safeHistory.length < history.length) {
          history.length = 0;
          history.push(...safeHistory);
        }

        // ⭐ PHASE_58: Pass dynamicAgentId to ClineProvider for persona loading
        // Call LLM with tools (use finalSystemPrompt which includes persona if available)
        // ⭐ SESSION_06 FIX: Use options.source (from HTTP request) not task.source (often undefined)
        // ⭐ SESSION_06 BEDROCK FALLBACK: If Bedrock fails (e.g. invalid model in local dev),
        //    fall back to Cline CLI so dashboard chat still works locally.
        let response;
        // Recheck the exact request-start handler generation immediately before the provider
        // receives its schemas. A revoked/replaced capability invalidates the whole request.
        assertDispatchCapabilitiesCurrent(this.tools, dispatchCapabilities);
        // Open a Token Chase frame just before the call. No-op + null when the flag is off;
        // when on, this is a microsecond shallow snapshot and the durable write runs in the
        // background during the await below — zero added latency to the LLM call.
        const __tcFrame = tokenChase.beginFrame({
          taskId,
          seq: turnCount,
          agentId: dynamicAgentId,
          workspaceDir: task.workspace_dir,
          providerName,
          systemPrompt: finalSystemPrompt,
          tools: availableTools,
          history,
          source: options.source || task.source,
          userSub: options.extraEnv && options.extraEnv.OSHAL_USER_SUB,
        });
        try {
          response = await llmProvider.generateResponse(history, {
            systemPrompt: finalSystemPrompt,
            tools: availableTools,
            workspaceDir: task.workspace_dir,
            source: options.source || task.source || 'agentic-controller',
            agentId: dynamicAgentId,
            swarmRoster, // ⭐ Live roster for personal-assistant {{SWARM_ROSTER}} injection
            extraEnv: options.extraEnv,
            enforceToolBoundary: true,
            authorizedScopes: options.authorizedScopes,
          });
        } catch (llmError) {
          // If Bedrock failed for dashboard chat AND cline-cli is available, fall back
          const isBedrockError = llmError.message && (
            llmError.message.includes('invalid model') ||
            llmError.message.includes('model identifier') ||
            llmError.message.includes('ValidationException') ||
            llmError.message.includes('AccessDeniedException')
          );
          if (options.source === 'dashboard' && isBedrockError && this.clineProvider) {
            logger.warn(`[AgenticController] Bedrock failed for dashboard chat (${llmError.message}), falling back to Cline CLI`);
            // ⭐ Use 'cline-fallback' (not 'dashboard') so -y flag IS included
            // Without -y, Cline CLI pauses waiting for tool approval that never comes
            response = await this.clineProvider.generateResponse(history, {
              systemPrompt: finalSystemPrompt,
              tools: availableTools,
              workspaceDir: task.workspace_dir,
              source: 'cline-fallback', // NOT 'dashboard' — needs -y for tool auto-approval
              agentId: dynamicAgentId,
              swarmRoster, // ⭐ Live roster for personal-assistant {{SWARM_ROSTER}} injection
              enforceToolBoundary: true,
              authorizedScopes: options.authorizedScopes,
            });
          } else {
            throw llmError; // Re-throw for non-recoverable errors
          }
        }
        // Close the Token Chase frame with the response that actually fired (records per-call
        // tokens + latency in the background). No-op when the frame is null (flag off).
        tokenChase.endFrame(__tcFrame, response);

        // Provider/model accountability comes only from the structured provider
        // response. Never derive these labels from assistant text or request fields.
        // A multi-turn tool loop reports the identity of the provider that produced
        // its last turn (including ProviderFailoverProvider's actual fallback).
        lastActualProvider = normalizeRuntimeIdentity(response && response.provider, 128);
        lastActualModel = normalizeRuntimeIdentity(response && response.model, 256);

        // Only CodexProvider's post-model command-event channel may contribute provider records.
        // Other providers (including BYO/OpenAI) can emit arbitrary text but cannot set this marker.
        if (response.providerRecordCapture === 'codex-command-events-v1' && Array.isArray(response.providerRecords)) {
          for (const record of response.providerRecords.slice(0, 8)) {
            if (record && typeof record === 'object' && typeof record.sourceRef === 'string') {
              capturedProviderRecords.set(record.sourceRef, record);
            }
          }
        }

        const responseText = response.content;
        const responseBlocks = response.contentBlocks || []; // Extended thinking may have multiple blocks
        
        // Update metrics from LLM response
        if (response.usage) {
          apiMetrics.totalTokens += response.usage.totalTokens || (response.usage.inputTokens + response.usage.outputTokens) || 0;
          apiMetrics.totalCost += response.cost || 0;  // Cost is in response.cost, not response.usage.cost
          apiMetrics.requestCount += 1;
          apiMetrics.cacheHits += (response.usage.cacheReads > 0) ? 1 : 0;
          
          logger.info(`Turn ${turnCount} metrics: ${response.usage.totalTokens || 0} tokens, $${(response.cost || 0).toFixed(6)}`);
        }

        // Check if response contains tool use
        // With extended thinking, tool_use comes as a separate block (type="tool_use")
        const toolUseBlock = responseBlocks.find(block => block.type === 'tool_use');
        const hasTools = toolUseBlock || ToolUseParser.hasToolUse(responseText);

        if (hasTools) {
          // Parse tool use from block or XML
          let toolUse;
          if (toolUseBlock) {
            // Extended thinking format: tool_use block has name, input, id
            toolUse = {
              name: toolUseBlock.name,
              input: toolUseBlock.input || {},
              id: toolUseBlock.id || 'tool_use_1'
            };
            logger.info(`Tool use from block: ${toolUse.name}`);
          } else {
            // Fallback to XML parsing
            toolUse = ToolUseParser.parseToolUse(responseText);
          }
          
          if (!toolUse) {
            logger.warn('Tool detected but parsing failed');
            isComplete = true;
            finalResult = {
              success: false,
              error: 'Tool parsing failed',
              response: responseText,
            };
            break;
          }

          const { name: toolName, input: toolInput, id: toolId } = toolUse;
          logger.info(`Tool requested: ${toolName}`);

          const capability = authorizeCapability(dispatchCapabilities, toolName);
          if (!capability.allowed) {
            logger.warn(`Denied non-allowlisted tool request for task ${taskId}`);
            history.push({ role: 'assistant', content: responseText });
            history.push({
              role: 'user',
              content: wrapUntrustedContent('unauthorized-tool-request', {
                requestedTool: toolName,
                error: capability.error,
              }),
            });
            continue;
          }

          // Extract thinking text before tool use
          const thinkingText = ToolUseParser.extractThinking(responseText);
          
          if (thinkingText) {
            // Generate timestamp ONCE for both broadcast and database
            const reasoningTimestamp = Date.now();
            
            // Broadcast reasoning with timestamp
            this.stream.broadcast(taskId, 'reasoning', {
              text: thinkingText,
              ts: reasoningTimestamp,
            });
            
            // Save reasoning message with SAME timestamp
            if (this.taskController) {
              await this.taskController.addMessage(taskId, {
                type: 'say',
                say: 'reasoning',
                text: thinkingText,
                ts: reasoningTimestamp, // Use same timestamp
              });
            }
          }

          // Completion is a protocol control, not an implicit shell/git capability.
          if (toolName === 'attempt_completion') {
            const completionResult = toolInput.result || responseText;
            isComplete = true;
            finalResult = {
              success: true,
              result: completionResult,
              command: toolInput.command,
            };
            this.stream.broadcast(taskId, 'completion_result', { text: completionResult });
            if (this.taskController) {
              await this.taskController.addMessage(taskId, {
                type: 'say', say: 'completion_result', text: completionResult, ts: Date.now(),
              });
            }
            break;
          }
          const toolSnapshot = capability.snapshot;
          const requiresApproval = toolSnapshot.tool.requiresApproval === true;

          // Check if we should auto-approve. Policy (and the reason the flag name looks wrong)
          // lives in tool-approval-policy.js — read it before changing anything here.
          const shouldAutoApprove = shouldAutoApproveTool(autoApprove, toolName, requiresApproval);

          // Generate timestamp ONCE for both broadcast and database
          const toolUseTimestamp = Date.now();

          // Broadcast tool use with timestamp
          this.stream.broadcast(taskId, 'tool_use', {
            tool: toolName,
            input: toolInput,
            requiresApproval,
            autoApproved: shouldAutoApprove,
            ts: toolUseTimestamp,
          });
          
          // Save tool use message with SAME timestamp
          if (this.taskController) {
            await this.taskController.addMessage(taskId, {
              type: 'tool_use',
              say: 'tool_use',
              text: `Tool: ${toolName}`,
              ts: toolUseTimestamp, // Use same timestamp
              tool: {
                name: toolName,
                input: toolInput,
                approved: shouldAutoApprove,
              },
            });
          }

          if (requiresApproval && !shouldAutoApprove) {
            const approvalMsg = `Tool ${toolName} requires approval before execution.`;
            logger.warn(approvalMsg);
            history.push({
              role: 'assistant',
              content: responseText,
            });
            history.push({
              role: 'user',
              content: `[${toolName}] Result:\n${approvalMsg}`,
            });
            this.stream.broadcast(taskId, 'tool_result', {
              tool: toolName,
              success: false,
              result: { requiresApproval: true, message: approvalMsg },
              ts: Date.now(),
            });
            continue;
          }

          // Execute tool after approval policy has allowed it
          let toolResult;
          try {
            logger.info(`Executing tool: ${toolName}`);
            assertDispatchCapabilitiesCurrent(this.tools, dispatchCapabilities);
            
            // Pass task workspace to tool execution
            // Include both parameter names for compatibility with different tools
            const toolInputWithWorkspace = {
              ...toolInput,
              taskWorkspace: task.workspace_dir,
              workspace_dir: task.workspace_dir // AWS diagrams expects this parameter name
            };
            
            toolResult = await this.tools.executeSnapshot(toolSnapshot, toolInputWithWorkspace, {
              approved: shouldAutoApprove,
              taskWorkspace: task.workspace_dir,
              userSub: options.extraEnv?.OSHAL_USER_SUB,
              agentId: dynamicAgentId,
              taskId,
              allowedTools: options.allowedTools,
              authorizedScopes: options.authorizedScopes,
              // Trusted request context; ToolRegistry re-sanitizes before handlers receive it.
              extraEnv: options.extraEnv,
            });
            
            logger.info(`Tool execution successful: ${toolName}`);
            
            // Generate timestamp ONCE for both broadcast and database
            const toolResultTimestamp = Date.now();
            
            // Broadcast tool result with timestamp
            this.stream.broadcast(taskId, 'tool_result', {
              tool: toolName,
              success: true,
              result: toolResult,
              ts: toolResultTimestamp,
            });
            
            // Save tool result message with SAME timestamp
            if (this.taskController) {
              await this.taskController.addMessage(taskId, {
                type: 'tool_result',
                say: 'tool_result',
                text: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2),
                ts: toolResultTimestamp, // Use same timestamp
                tool: {
                  name: toolName,
                  success: true,
                },
              });
            }

          } catch (error) {
            logger.error(`Tool execution failed: ${error.message}`);
            toolResult = {
              success: false,
              error: error.message,
            };

            // Generate timestamp ONCE for both broadcast and database
            const toolErrorTimestamp = Date.now();

            // Broadcast tool error with timestamp
            this.stream.broadcast(taskId, 'tool_result', {
              tool: toolName,
              success: false,
              error: error.message,
              ts: toolErrorTimestamp,
            });
            
            // Save tool error message with SAME timestamp
            if (this.taskController) {
              await this.taskController.addMessage(taskId, {
                type: 'tool_result',
                say: 'tool_result',
                text: `Error: ${error.message}`,
                ts: toolErrorTimestamp, // Use same timestamp
                tool: {
                  name: toolName,
                  success: false,
                  error: error.message,
                },
              });
            }
          }

          // Add assistant message and tool result to history
          history.push({
            role: 'assistant',
            content: responseText,
          });

          // Add workspace reminder to tool results
          const workspaceReminder = `\n\n⚠️ REMINDER: Your workspace is ${task.workspace_dir || '/app/workspace'}. All files MUST be created there.`;
          
          history.push({
            role: 'user',
            content: `${wrapUntrustedContent(`tool-result:${toolName}`, toolResult)}${workspaceReminder}`,
          });

          // Broadcast API request finished (marks end of this turn)
          const apiReqFinishTime = Date.now();
          this.stream.broadcast(taskId, 'api_req_finished', {
            turn: turnCount,
            ts: apiReqFinishTime,
            tokensUsed: response.usage?.totalTokens || 0,
            cost: response.cost || 0,
          });
          
          // Save api_req_finished message
          if (this.taskController) {
            await this.taskController.addMessage(taskId, {
              type: 'say',
              say: 'api_req_finished',
              text: JSON.stringify({
                turn: turnCount,
                tokensUsed: response.usage?.totalTokens || 0,
                cost: response.cost || 0,
              }),
              ts: apiReqFinishTime,
            });
          }

          // Continue loop - LLM will see tool result and decide next action

        } else {
          // No tool use - this is a text response (or ClineProvider completion)
          // ClineProvider runs its own agentic loop and returns the final result.
          // Detect ClineProvider responses by checking for clineMetadata.
          const isClineProviderResponse = !!(response.clineMetadata || response.claudeCodeMetadata);
          const broadcastType = isClineProviderResponse ? 'completion_result' : 'text';
          const sayType = isClineProviderResponse ? 'completion_result' : 'text';
          
          logger.info(`No tool use detected — broadcasting as '${broadcastType}' (clineProvider: ${isClineProviderResponse})`);
          logger.info(`Response length: ${responseText ? responseText.length : 0}, preview: ${responseText ? responseText.substring(0, 200) : 'EMPTY'}`);
          
          // Broadcast response with correct event type
          this.stream.broadcast(taskId, broadcastType, {
            text: responseText,
          });
          
          // Save message to database with correct say type
          if (this.taskController) {
            const textTimestamp = Date.now();
            await this.taskController.addMessage(taskId, {
              type: 'say',
              say: sayType,
              text: responseText,
              ts: textTimestamp,
            });
            logger.info(`Saved ${sayType} message to database (${responseText.length} chars)`);
          }

          // Add to history
          history.push({
            role: 'assistant',
            content: responseText,
          });

          // End loop (no more tool use means task is done)
          isComplete = true;
          finalResult = {
            success: true,
            result: responseText,
          };
        }
      }

      if (turnCount >= this.maxTurns) {
        logger.warn(`Reached max turns (${this.maxTurns})`);
        finalResult = {
          success: false,
          error: `Reached maximum turns (${this.maxTurns})`,
          partialResult: history[history.length - 1]?.content || 'No result',
        };
      }

      logger.info(`Agentic task completed in ${turnCount} turns`);
      
      // Update task metrics in database
      if (this.taskController && apiMetrics.totalTokens > 0) {
        await this.taskController.updateMetrics(taskId, apiMetrics);
        logger.info(`Task metrics updated: ${apiMetrics.totalTokens} tokens, $${apiMetrics.totalCost.toFixed(6)}`);
      }
      
      return {
        success: finalResult?.success || false,
        result: finalResult,
        turns: turnCount,
        history,
        apiMetrics, // Include metrics in response
        provider: lastActualProvider,
        model: lastActualModel,
        providerRecords: [...capturedProviderRecords.values()],
      };

    } catch (error) {
      logger.error(`Agentic task failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = AgenticController;
