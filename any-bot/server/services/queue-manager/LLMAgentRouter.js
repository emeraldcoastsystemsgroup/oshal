/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * LLMAgentRouter — AI-Powered Agent Selection
 *
 * Replaces hardcoded keyword matching with an LLM call that sees the full
 * agent registry and uses semantic reasoning to pick the best agent.
 * 
 * Like a tool call: the LLM sees available "tools" (agents) and decides
 * which one to invoke for a given ticket.
 * 
 * Falls back to CapabilityMatcher if LLM call fails or times out.
 */

const logger = require('../../utils/logger');
const FrontDoorClient = require('../FrontDoorClient');

const ROUTER_PROMPT = `You are the AI Swarm Router. Your job is to select the BEST agent for a ticket.

## Available Agents
Each agent below lists their ID, capabilities, and a selector descriptor that explains WHEN to pick them.

{AGENT_LIST}

## Ticket
**Title:** {TICKET_TITLE}
**Description:** {TICKET_DESCRIPTION}

## Instructions
Select the single best agent to handle this ticket. Use the selector_descriptor for each agent — it tells you exactly when that agent should be chosen.

Rules:
- Read each agent's selector_descriptor carefully — it is the authoritative guide for when to pick that agent
- Match the ticket's INTENT to the agent's domain (semantic meaning, not just keywords)
- Specialist agents ALWAYS beat generalists when the ticket is in their domain
- If the ticket involves sending email, SMTP, email templates, or email delivery → pick the email specialist
- If the ticket involves creating a new bot/agent → pick the agent-factory specialist
- If the ticket involves code review → pick the code-review specialist
- If the ticket involves presentations/slides → pick the presentation specialist
- If the ticket involves research/data → pick the research specialist
- If the ticket involves DevOps/infrastructure → pick the devops specialist
- If the ticket involves root cause analysis → pick the rca specialist
- Only pick project-manager if the ticket is about planning, coordination, or decomposition
- Only pick a generalist if NO specialist matches

Respond with ONLY a JSON object, no other text:
{"agentId": "agent-id-here", "reason": "one sentence why", "confidence": 0.95}`;

/**
 * @description Routes a ticket to the most suitable swarm agent by delegating the
 * decision to an LLM that reasons semantically over the live agent registry,
 * rather than relying on brittle keyword matching. Exists to make routing
 * adaptable as new agents/personas are added without code changes, and to defer
 * to richer persona context via the Front Door API (falling back to a legacy
 * provider, and ultimately to the caller's keyword matcher when the LLM is
 * unavailable). Specialist agents are preferred over generalists by design.
 */
class LLMAgentRouter {
  /**
   * @param {Object} options
   * @param {Object} options.llmProvider — BedrockProvider or compatible LLM (DEPRECATED - use front door)
   * @param {Object} options.agentRegistry — AgentRegistry instance
   * @param {number} options.timeoutMs — Max time for LLM routing call (default 8000ms)
   * @param {string} [options.frontDoorUrl] - Front door API URL (default: auto-detect)
   */
  constructor(options = {}) {
    this.llmProvider = options.llmProvider || null;
    this.agentRegistry = options.agentRegistry || null;
    this.timeoutMs = options.timeoutMs || 15000;
    this.enabled = !!this.llmProvider;
    
    // ⭐ PHASE_39 Issue #039: Front Door Pattern
    this.useFrontDoorAPI = process.env.USE_FRONT_DOOR_API !== 'false';
    this.frontDoorClient = new FrontDoorClient(options.frontDoorUrl, this.timeoutMs);
    
    if (this.useFrontDoorAPI) {
      logger.info('[LLMRouter] Using Front Door API (persona injection enabled)');
    }
  }

  /**
   * Select the best agent using LLM reasoning
   * 
   * @param {Object} ticket — { id, name, description_stripped }
   * @param {Object[]} agents — Array of agent objects from registry
   * @returns {Object|null} — { agentId, reason, confidence } or null if failed
   */
  async selectAgent(ticket, agents) {
    if (!this.enabled || !agents || agents.length === 0) {
      return null;
    }

    try {
      // Build agent list for prompt — include selector_descriptor so LLM knows WHEN to pick each agent
      // selector_descriptor is registered from persona YAML and stored in Redis agent record
      const agentList = agents
        .filter(a => a.agent_id !== 'worker-general') // Exclude generic fallback
        .map(a => {
          const caps = Array.isArray(a.capabilities) 
            ? a.capabilities.join(', ')
            : (typeof a.capabilities === 'string' ? a.capabilities : '');
          const keywords = Array.isArray(a.routing_keywords) && a.routing_keywords.length > 0
            ? ` routing_keywords=[${a.routing_keywords.slice(0, 8).join(', ')}]`
            : '';
          // selector_descriptor is the authoritative "when to pick me" description from persona YAML
          const descriptor = a.selector_descriptor
            ? `\n  selector: ${a.selector_descriptor.substring(0, 200).replace(/\n/g, ' ')}`
            : '';
          return `- **${a.agent_id}**: capabilities=[${caps}]${keywords}${descriptor}`;
        })
        .join('\n');

      // Build prompt
      const ticketTitle = (ticket.name || '').substring(0, 200);
      const ticketDesc = (ticket.description_stripped || ticket.name || '').substring(0, 500);
      
      const prompt = ROUTER_PROMPT
        .replace('{AGENT_LIST}', agentList)
        .replace('{TICKET_TITLE}', ticketTitle)
        .replace('{TICKET_DESCRIPTION}', ticketDesc);

      // Make LLM call with timeout
      const response = await Promise.race([
        this._callLLM(prompt),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('LLM router timeout')), this.timeoutMs)
        ),
      ]);

      if (!response) return null;

      // Parse JSON response
      const result = this._parseResponse(response);
      
      if (result && result.agentId) {
        // Validate agent exists in registry
        const validAgent = agents.find(a => a.agent_id === result.agentId);
        if (validAgent) {
          logger.info(`[LLMRouter] 🧠 Selected ${result.agentId} (confidence: ${result.confidence}) — ${result.reason}`);
          return result;
        } else {
          logger.warn(`[LLMRouter] LLM selected non-existent agent: ${result.agentId}`);
          return null;
        }
      }

      return null;
    } catch (error) {
      logger.warn(`[LLMRouter] Failed: ${error.message} — falling back to keyword matcher`);
      return null;
    }
  }

  /**
   * Call the LLM with a compact prompt (~300 tokens).
   * 
   * ⭐ PHASE_39 Issue #039: Routes through Front Door API for persona injection.
   * 
   * Uses FAST MODE (no extended thinking) — routing decisions need ~50 token JSON,
   * not 10K thinking budget. This reduces latency from 10-20s to 2-4s.
   */
  async _callLLM(prompt) {
    // ⭐ PHASE_39: Use Front Door API
    if (this.useFrontDoorAPI) {
      try {
        const taskResult = await this.frontDoorClient.createTask('Agent routing decision', 'act');
        const messageResult = await this.frontDoorClient.sendMessage(
          taskResult.task.id,
          prompt,
          { autoApprove: {}, agenticMode: true, source: 'llm-router' }
        );
        const response = this.frontDoorClient.extractResponse(messageResult);
        logger.info(`[LLMRouter] Front door routing complete (${response.length} chars)`);
        return response;
      } catch (error) {
        logger.warn(`[LLMRouter] Front door call failed: ${error.message}`);
        return null;
      }
    }
    
    // Legacy fallback
    if (!this.llmProvider) return null;

    try {
      logger.warn('[LLMRouter] Using LEGACY BedrockProvider (NO PERSONA)');
      const messages = [{ role: 'user', content: prompt }];
      const result = await this.llmProvider.generateResponse(messages, {
        maxTokens: 256,
        temperature: 0.3,
        disableExtendedThinking: true,
        systemPrompt: 'You are a routing AI. Respond ONLY with valid JSON.',
      });

      if (result && result.content) {
        if (Array.isArray(result.content)) {
          return result.content.map(c => c.text || '').join('');
        }
        return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      }
      return result?.text || result?.response || null;
    } catch (error) {
      logger.warn(`[LLMRouter] LLM call error: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse LLM response — extract JSON from potentially messy output
   */
  _parseResponse(text) {
    if (!text) return null;

    try {
      // Try direct JSON parse first
      const parsed = JSON.parse(text.trim());
      return {
        agentId: parsed.agentId || parsed.agent_id || parsed.agent,
        reason: parsed.reason || '',
        confidence: parsed.confidence || 0.5,
      };
    } catch {
      // Extract JSON from surrounding text
      const jsonMatch = text.match(/\{[^}]*"agentId"[^}]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            agentId: parsed.agentId || parsed.agent_id,
            reason: parsed.reason || '',
            confidence: parsed.confidence || 0.5,
          };
        } catch { /* fall through */ }
      }

      // Last resort: look for agent ID pattern in text
      const agentMatch = text.match(/"agentId"\s*:\s*"([a-z-]+)"/);
      if (agentMatch) {
        return { agentId: agentMatch[1], reason: 'Extracted from text', confidence: 0.3 };
      }

      return null;
    }
  }
}

module.exports = LLMAgentRouter;
