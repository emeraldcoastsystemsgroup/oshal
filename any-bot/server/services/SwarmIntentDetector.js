/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Swarm Intent Detector
 * Detects when users want to initiate swarm sessions via natural language
 * PHASE_32 Issue #028: Natural Language Swarm Invocation
 */

const logger = require('../utils/logger');
const FrontDoorClient = require('./FrontDoorClient');

/**
 * @description Recognizes natural-language requests to start a multi-agent
 * "swarm" session, so users can summon bots conversationally instead of via
 * explicit commands. Prefers a Front Door API call (which injects persona
 * context) for high-quality intent classification, falls back to a direct LLM
 * call, and finally to deterministic keyword/regex matching when no model is
 * reachable. This layered strategy keeps invocation working even when upstream
 * services are degraded.
 */
class SwarmIntentDetector {
  /**
   * @description Wires up the detector's classification backends and decides,
   * from environment configuration, whether to route through the persona-aware
   * Front Door API. A FrontDoorClient is always constructed so the Front Door
   * path is available without re-instantiation.
   * @param {Object} llmProvider - LLM client used for the legacy direct-detection path; when absent the detector relies on Front Door and/or keyword fallback.
   */
  constructor(llmProvider) {
    this.llm = llmProvider;
    
    // ⭐ PHASE_39 Issue #039: Front Door Pattern
    this.useFrontDoorAPI = process.env.USE_FRONT_DOOR_API !== 'false';
    this.frontDoorClient = new FrontDoorClient(null, 15000);
    
    if (this.useFrontDoorAPI) {
      logger.info('[SwarmIntent] Using Front Door API (persona injection enabled)');
    }
  }

  /**
   * Detect if user message is requesting a swarm session
   * 
   * ⭐ PHASE_39 Issue #039: Routes through Front Door API for persona injection.
   * 
   * @param {string} userMessage - The user's message text
   * @returns {Promise<Object>} - { isSwarmRequest: boolean, requestedBots: string[], confidence: number, topic: string }
   */
  async detectSwarmIntent(userMessage) {
    // ⭐ PHASE_39: Use Front Door API
    if (this.useFrontDoorAPI) {
      try {
        const prompt = `Analyze this user message and determine if they want to start a conversation with specific bots/agents.

User message: "${userMessage}"

Respond with JSON only (no markdown, no explanation):
{
  "isSwarmRequest": true/false,
  "requestedBots": ["bot-name-1", "bot-name-2"],
  "confidence": 0.0-1.0,
  "topic": "brief topic description"
}

Swarm request indicators:
- "I want to talk to [bot]"
- "Can I chat with [bot]"
- "I need help from [bot]"
- "Set up a call with [bot]"
- "Connect me with [bot]"
- "I want to discuss [topic] with [bot]"

Bot name patterns:
- "video bot" → "video-bot"
- "security auditor" → "security-auditor-bot"
- "code reviewer" → "code-reviewer-bot"
- "research bot" → "research-bot"
- "devops bot" → "devops-bot"
- "task manager" → "task-manager"
- "project manager" → "project-manager"

If no specific bot mentioned but user wants help with a topic, set isSwarmRequest=false (let normal chat handle it).`;

        const taskResult = await this.frontDoorClient.createTask('Swarm intent detection', 'act');
        const messageResult = await this.frontDoorClient.sendMessage(
          taskResult.task.id,
          prompt,
          { autoApprove: {}, agenticMode: true, source: 'swarm-intent' }
        );
        
        const content = this.frontDoorClient.extractResponse(messageResult);
        
        // Extract JSON from response (handle markdown code blocks)
        let jsonText = content.trim();
        if (jsonText.startsWith('```')) {
          const match = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
          if (match) jsonText = match[1].trim();
        }

        const result = JSON.parse(jsonText);
        
        logger.info(`[SwarmIntent] Front door detection: ${result.isSwarmRequest ? 'YES' : 'NO'} (confidence: ${result.confidence}, bots: ${result.requestedBots?.join(', ') || 'none'})`);
        
        return {
          isSwarmRequest: result.isSwarmRequest || false,
          requestedBots: result.requestedBots || [],
          confidence: result.confidence || 0,
          topic: result.topic || userMessage.substring(0, 100),
        };
      } catch (err) {
        logger.warn(`[SwarmIntent] Front door detection failed: ${err.message}, using fallback`);
        return this._fallbackDetection(userMessage);
      }
    }
    
    // Legacy path
    if (!this.llm) {
      return this._fallbackDetection(userMessage);
    }

    try {
      logger.warn('[SwarmIntent] Using LEGACY LLM path (NO PERSONA)');
      const prompt = `Analyze this user message and determine if they want to start a conversation with specific bots/agents.

User message: "${userMessage}"

Respond with JSON only (no markdown, no explanation):
{
  "isSwarmRequest": true/false,
  "requestedBots": ["bot-name-1", "bot-name-2"],
  "confidence": 0.0-1.0,
  "topic": "brief topic description"
}

Swarm request indicators:
- "I want to talk to [bot]"
- "Can I chat with [bot]"
- "I need help from [bot]"
- "Set up a call with [bot]"
- "Connect me with [bot]"
- "I want to discuss [topic] with [bot]"

Bot name patterns:
- "video bot" → "video-bot"
- "security auditor" → "security-auditor-bot"
- "code reviewer" → "code-reviewer-bot"
- "research bot" → "research-bot"
- "devops bot" → "devops-bot"
- "task manager" → "task-manager"
- "project manager" → "project-manager"

If no specific bot mentioned but user wants help with a topic, set isSwarmRequest=false (let normal chat handle it).`;

      const response = await this.llm.generateResponse([
        { role: 'user', content: prompt }
      ], {
        systemPrompt: 'You are a JSON-only response bot. Output valid JSON with no markdown formatting.',
        maxTokens: 500,
        temperature: 0.3,
      });

      const content = response.content || response.text || '';
      
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = content.trim();
      if (jsonText.startsWith('```')) {
        const match = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (match) jsonText = match[1].trim();
      }

      const result = JSON.parse(jsonText);
      
      logger.info(`[SwarmIntent] Detected: ${result.isSwarmRequest ? 'YES' : 'NO'} (confidence: ${result.confidence}, bots: ${result.requestedBots?.join(', ') || 'none'})`);
      
      return {
        isSwarmRequest: result.isSwarmRequest || false,
        requestedBots: result.requestedBots || [],
        confidence: result.confidence || 0,
        topic: result.topic || userMessage.substring(0, 100),
      };
    } catch (err) {
      logger.warn(`[SwarmIntent] LLM detection failed: ${err.message}, using fallback`);
      return this._fallbackDetection(userMessage);
    }
  }

  /**
   * Fallback detection using simple keyword matching
   * @private
   */
  _fallbackDetection(userMessage) {
    const lower = userMessage.toLowerCase();
    
    // Swarm request keywords
    const swarmKeywords = [
      'talk to', 'chat with', 'call with', 'connect me with',
      'i need', 'help from', 'discuss with', 'work with',
      'bring in', 'invite', 'include'
    ];
    
    const hasSwarmKeyword = swarmKeywords.some(kw => lower.includes(kw));
    
    if (!hasSwarmKeyword) {
      return {
        isSwarmRequest: false,
        requestedBots: [],
        confidence: 0,
        topic: userMessage.substring(0, 100),
      };
    }

    // Extract bot names using common patterns
    const botPatterns = [
      /(?:video|presentation|presentron)[\s-]?bot/gi,
      /(?:security|auditor)[\s-]?bot/gi,
      /(?:code|review|reviewer)[\s-]?bot/gi,
      /(?:research|researcher)[\s-]?bot/gi,
      /(?:devops|deployment)[\s-]?bot/gi,
      /(?:task|project)[\s-]?manager/gi,
      /(?:documentation|doc)[\s-]?bot/gi,
      /(?:data|extraction)[\s-]?bot/gi,
      /(?:email|mail)[\s-]?bot/gi,
      /(?:gcp|google[\s-]?cloud)[\s-]?bot/gi,
    ];

    const requestedBots = [];
    for (const pattern of botPatterns) {
      const matches = userMessage.match(pattern);
      if (matches) {
        // Normalize bot name
        const botName = matches[0].toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/bot$/, '')
          .trim() + '-bot';
        if (!requestedBots.includes(botName)) {
          requestedBots.push(botName);
        }
      }
    }

    const isSwarmRequest = requestedBots.length > 0;
    const confidence = isSwarmRequest ? 0.7 : 0.3;

    logger.info(`[SwarmIntent] Fallback detection: ${isSwarmRequest ? 'YES' : 'NO'} (bots: ${requestedBots.join(', ') || 'none'})`);

    return {
      isSwarmRequest,
      requestedBots,
      confidence,
      topic: userMessage.substring(0, 100),
    };
  }

  /**
   * Normalize bot names to match agent registry format
   * @param {string[]} botNames - Raw bot names from detection
   * @param {Object[]} availableAgents - List of registered agents from AgentRegistry
   * @returns {string[]} - Normalized agent IDs
   */
  normalizeBotNames(botNames, availableAgents = []) {
    const normalized = [];
    
    for (const botName of botNames) {
      // Try exact match first
      const exactMatch = availableAgents.find(a => 
        a.agent_id === botName || a.agent_id === `swarm-${botName}`
      );
      
      if (exactMatch) {
        normalized.push(exactMatch.agent_id);
        continue;
      }

      // Try fuzzy match (contains)
      const fuzzyMatch = availableAgents.find(a => 
        a.agent_id.includes(botName.replace(/-bot$/, '')) ||
        botName.replace(/-bot$/, '').includes(a.agent_id.replace('swarm-', ''))
      );

      if (fuzzyMatch) {
        normalized.push(fuzzyMatch.agent_id);
        continue;
      }

      // No match found - use as-is (may fail later, but that's okay)
      normalized.push(botName);
    }

    return normalized;
  }
}

module.exports = SwarmIntentDetector;
