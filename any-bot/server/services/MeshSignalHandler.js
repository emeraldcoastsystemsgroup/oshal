/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

 /**
 * MeshSignalHandler — Mesh Broadcast Network Signal Processor
 * 
 * Phase 1: Foundation — handles incoming mesh signals for this bot instance.
 * Each bot container runs its own MeshSignalHandler that processes signals
 * using the bot's persona + selector_descriptor + LLM self-evaluation.
 * 
 * ## Signal Types (Phase 1: BID_REQUEST only)
 * - BID_REQUEST: "Should I claim this work?" → { claim, confidence, reason }
 * - CAPABILITY_QUERY: (Phase 2) "Can you do X?"
 * - HELP_REQUEST: (Phase 3) "I need help with X"
 * - STATUS_BROADCAST: (Phase 3) "Here's my status"
 * - KNOWLEDGE_SHARE: (Phase 4) "I learned X"
 * - HEALTH_PING: (Phase 5) "Are you alive?"
 * - DELEGATION: (Phase 5) "Please handle this sub-task"
 * 
 * ## Architecture
 * ```
 * PM broadcasts BID_REQUEST → each bot's /mesh-signal endpoint
 *   → MeshSignalHandler.handleSignal()
 *     → evaluateBidRequest() uses LLM + persona + selector_descriptor
 *       → returns { claim: true/false, confidence: 0.0-1.0, reason }
 * ```
 * 
 * @see {@link docs/MESH_BROADCAST_NETWORK.md} for full design
 * @see {@link docs/AGENT_SELECTION_PHILOSOPHY.md} for bid routing model
 */

const logger = require('../utils/logger');
const config = require('../utils/config');
const FrontDoorClient = require('./FrontDoorClient');

/**
 * @description Canonical enumeration of mesh broadcast network signal types,
 * exported so producers and consumers agree on a single source of truth for the
 * string values used when emitting and routing signals (avoids magic strings and
 * typo-driven routing failures across bot instances and phases).
 */
// Valid signal types for the mesh broadcast network
const SIGNAL_TYPES = {
  BID_REQUEST: 'BID_REQUEST',
  CAPABILITY_QUERY: 'CAPABILITY_QUERY',
  HELP_REQUEST: 'HELP_REQUEST',
  STATUS_BROADCAST: 'STATUS_BROADCAST',
  KNOWLEDGE_SHARE: 'KNOWLEDGE_SHARE',
  HEALTH_PING: 'HEALTH_PING',
  DELEGATION: 'DELEGATION',
  // ⭐ PHASE_24 Issue #018: Private Mesh Protocol signal types
  MESH_INVITE: 'MESH_INVITE',
  MESH_ACCEPT: 'MESH_ACCEPT',
  MESH_DECLINE: 'MESH_DECLINE',
  MESH_MESSAGE: 'MESH_MESSAGE',
  MESH_DELEGATE: 'MESH_DELEGATE',
  MESH_RESULT: 'MESH_RESULT',
  MESH_LEAVE: 'MESH_LEAVE',
  MESH_DISSOLVE: 'MESH_DISSOLVE',
  MESH_HEARTBEAT: 'MESH_HEARTBEAT',
};

/**
 * @description Per-bot processor for the mesh broadcast network: receives mesh
 * signals addressed to this agent instance and decides how to respond using the
 * bot's persona, selector_descriptor, and LLM self-evaluation. It is the local
 * decision point for whether this bot should claim work (BID_REQUEST), how it
 * participates in private meshes (MESH_* protocol), and how it answers peer and
 * health signals — keeping routing decentralized so each bot self-selects rather
 * than relying on a central dispatcher.
 */
class MeshSignalHandler {
  /**
   * @param {Object} options
   * @param {Object} options.llmProvider - BedrockProvider or compatible LLM (DEPRECATED - use front door)
   * @param {string} [options.agentId] - This bot's agent ID
   * @param {number} [options.timeoutMs] - Max time for LLM evaluation (default 8000ms)
   * @param {string} [options.frontDoorUrl] - Front door API URL (default: auto-detect)
   */
  constructor(options = {}) {
    this.llmProvider = options.llmProvider || null;
    this.agentId = options.agentId || process.env.AGENT_ID || 'unknown-agent';
    this.timeoutMs = options.timeoutMs || 8000;

    // ⭐ PHASE_39 Issue #039: Front Door Pattern - route LLM calls through any-bot API
    this.useFrontDoorAPI = process.env.USE_FRONT_DOOR_API !== 'false'; // Default true
    this.frontDoorClient = new FrontDoorClient(options.frontDoorUrl, this.timeoutMs);

    // Load persona context from config singleton (parsed from YAML at startup)
    this.persona = config.persona || null;
    this.selectorDescriptor = this._loadSelectorDescriptor();

    logger.info(`[MeshSignal] Handler initialized for ${this.agentId}`);
    if (this.useFrontDoorAPI) {
      logger.info(`[MeshSignal] Using Front Door API (persona injection enabled)`);
    } else {
      logger.warn(`[MeshSignal] Using legacy BedrockProvider (persona injection DISABLED)`);
    }
    if (this.selectorDescriptor) {
      logger.info(`[MeshSignal] Selector descriptor loaded (${this.selectorDescriptor.length} chars)`);
    } else {
      logger.warn(`[MeshSignal] No selector_descriptor — bid evaluation will use capabilities only`);
    }
  }

  /**
   * Load selector_descriptor from the persona YAML file directly
   * (config.js only parses name/role/perspective, not selector_descriptor)
   * @returns {string} selector_descriptor or empty string
   */
  _loadSelectorDescriptor() {
    const personaFile = process.env.BOT_PERSONA_FILE;
    if (!personaFile) return '';

    try {
      const fs = require('fs');
      const yaml = require('js-yaml');
      if (!fs.existsSync(personaFile)) return '';
      const content = fs.readFileSync(personaFile, 'utf8');
      const parsed = yaml.load(content);
      return (parsed && parsed.selector_descriptor) || '';
    } catch (err) {
      logger.warn(`[MeshSignal] Failed to load selector_descriptor: ${err.message}`);
      return '';
    }
  }

  /**
   * Handle an incoming mesh signal
   * @param {Object} signal - The mesh signal
   * @param {string} signal.type - Signal type (BID_REQUEST, CAPABILITY_QUERY, etc.)
   * @param {Object} signal.payload - Signal-specific payload
   * @param {string} [signal.source] - Source agent/service that sent the signal
   * @param {string} [signal.signal_id] - Unique signal identifier for correlation
   * @returns {Promise<Object>} Signal response
   */
  async handleSignal(signal) {
    const { type, payload, source, signal_id } = signal;
    const startTime = Date.now();

    logger.info(`[MeshSignal] ${this.agentId} received ${type} from ${source || 'unknown'} (signal: ${signal_id || 'none'})`);

    try {
      switch (type) {
        case SIGNAL_TYPES.BID_REQUEST:
          return await this.evaluateBidRequest(payload, signal_id);

        case SIGNAL_TYPES.CAPABILITY_QUERY:
          return this.handleCapabilityQuery(payload);

        case SIGNAL_TYPES.HEALTH_PING:
          return this.handleHealthPing();

        // ⭐ PHASE_22 Issue #014: Peer Communication Signal Types
        case SIGNAL_TYPES.HELP_REQUEST:
          return this._handlePeerSignal('HELP_REQUEST', payload, signal_id, startTime);

        case SIGNAL_TYPES.KNOWLEDGE_SHARE:
          return this._handlePeerSignal('KNOWLEDGE_SHARE', payload, signal_id, startTime);

        case SIGNAL_TYPES.DELEGATION:
          return this._handlePeerSignal('DELEGATION', payload, signal_id, startTime);

        case 'DIRECT_MESSAGE':
          return this._handlePeerSignal('DIRECT_MESSAGE', payload, signal_id, startTime);

        // ⭐ PHASE_24 Issue #018: Private Mesh Protocol signal types
        case SIGNAL_TYPES.MESH_INVITE:
          return this._handleMeshInvite(signal, startTime);

        case SIGNAL_TYPES.MESH_ACCEPT:
        case SIGNAL_TYPES.MESH_DECLINE:
        case SIGNAL_TYPES.MESH_MESSAGE:
        case SIGNAL_TYPES.MESH_DELEGATE:
        case SIGNAL_TYPES.MESH_RESULT:
        case SIGNAL_TYPES.MESH_LEAVE:
        case SIGNAL_TYPES.MESH_DISSOLVE:
        case SIGNAL_TYPES.MESH_HEARTBEAT:
          return this._handleMeshSignal(type, signal, startTime);

        default:
          logger.warn(`[MeshSignal] Unsupported signal type: ${type}`);
          return {
            agent_id: this.agentId,
            signal_id,
            type,
            status: 'unsupported',
            message: `Signal type '${type}' not yet implemented`,
            latency_ms: Date.now() - startTime,
          };
      }
    } catch (error) {
      logger.error(`[MeshSignal] Error handling ${type}: ${error.message}`);
      return {
        agent_id: this.agentId,
        signal_id,
        type,
        status: 'error',
        error: error.message,
        latency_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * Evaluate a BID_REQUEST — the core mesh bid routing logic.
   * Uses LLM + persona + selector_descriptor to self-evaluate fitness.
   * 
   * @param {Object} payload
   * @param {string} payload.title - Ticket/job title
   * @param {string} payload.description - Ticket/job description (the "job posting")
   * @param {string[]} [payload.required_capabilities] - Explicit capability requirements
   * @param {string} [signal_id] - Signal correlation ID
   * @returns {Promise<Object>} Bid response { claim, confidence, reason, agent_id }
   */
  async evaluateBidRequest(payload, signal_id) {
    const startTime = Date.now();
    const { title = '', description = '', required_capabilities = [] } = payload;

    // Phase 1 fast path: if no LLM available, fall back to keyword matching
    if (!this.llmProvider) {
      logger.warn(`[MeshSignal] No LLM provider — using keyword fallback for bid evaluation`);
      return this._keywordFallbackBid(payload, signal_id, startTime);
    }

    // Build the self-evaluation prompt
    const prompt = this._buildBidEvaluationPrompt(title, description, required_capabilities);

    try {
      // Call LLM with timeout (must respond within bid window)
      const response = await Promise.race([
        this._callLLM(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Bid evaluation timeout')), this.timeoutMs)
        ),
      ]);

      if (!response) {
        logger.warn(`[MeshSignal] LLM returned empty response for bid evaluation`);
        return this._keywordFallbackBid(payload, signal_id, startTime);
      }

      // Parse JSON response from LLM
      const evaluation = this._parseBidResponse(response);

      const result = {
        agent_id: this.agentId,
        signal_id,
        type: SIGNAL_TYPES.BID_REQUEST,
        status: 'evaluated',
        claim: evaluation.claim || false,
        confidence: evaluation.confidence || 0.0,
        reason: evaluation.reason || 'No reason provided',
        capabilities_matched: evaluation.capabilities_matched || [],
        latency_ms: Date.now() - startTime,
        evaluation_method: 'llm',
      };

      const claimEmoji = result.claim ? '✅' : '⛔';
      logger.info(`[MeshSignal] ${claimEmoji} ${this.agentId} bid: claim=${result.claim}, confidence=${result.confidence.toFixed(2)}, reason="${result.reason}" (${result.latency_ms}ms)`);

      return result;
    } catch (error) {
      logger.warn(`[MeshSignal] LLM bid evaluation failed: ${error.message} — falling back to keywords`);
      return this._keywordFallbackBid(payload, signal_id, startTime);
    }
  }

  /**
   * Build the LLM prompt for bid self-evaluation
   * @param {string} title - Job title
   * @param {string} description - Job description
   * @param {string[]} requiredCapabilities - Required capabilities
   * @returns {string} Complete evaluation prompt
   */
  _buildBidEvaluationPrompt(title, description, requiredCapabilities) {
    const personaName = this.persona?.name || this.agentId;
    const personaRole = this.persona?.role || 'AI agent';
    const personaPerspective = this.persona?.perspective || '';
    const selectorDesc = this.selectorDescriptor || 'No selector descriptor available.';

    const capsList = requiredCapabilities.length > 0
      ? `\nRequired capabilities: ${requiredCapabilities.join(', ')}`
      : '';

    return `You are ${personaName} (${personaRole}). Evaluate whether you should claim this work.

## Your Selector Descriptor (WHEN to select you)
${selectorDesc}

## Your Perspective
${personaPerspective.substring(0, 500)}

## Job Posting
**Title:** ${title}
**Description:** ${description}${capsList}

## Evaluation Instructions
1. Compare the job to your selector_descriptor — do ANY of your skills overlap?
2. Think broadly: could you research, plan, write, analyze, or create PART of this deliverable?
3. Rate your confidence (0.0 to 1.0) that you can CONTRIBUTE MEANINGFULLY to this job
4. **CLAIM (claim=true) if confidence >= 0.5** — you don't need to be the perfect specialist, just able to add real value
5. Only set claim=false if you genuinely have NOTHING useful to contribute

**Scoring guide:**
- 0.9-1.0: This is exactly my specialty, I'm the best bot for this
- 0.7-0.89: Strong match — I can handle this well
- 0.5-0.69: I can contribute meaningfully — CLAIM THIS (claim=true)
- 0.3-0.49: Weak match, marginal contribution only
- 0.0-0.29: Cannot contribute anything useful

**IMPORTANT:** You are an AI agent with broad capabilities. Even if a task isn't your exact specialty, you can likely research, write, plan, or analyze aspects of it. Err on the side of CLAIMING — the routing system will pick the highest-confidence claimant.

Respond with ONLY a JSON object:
{"claim": true/false, "confidence": 0.0-1.0, "reason": "one sentence why", "capabilities_matched": ["cap1", "cap2"]}`;
  }

  /**
   * Call the LLM with a compact prompt for fast response.
   * 
   * ⭐ PHASE_39 Issue #039: Routes through Front Door API instead of direct BedrockProvider.
   * This ensures persona injection via AgenticController for mesh bid evaluations.
   * 
   * Uses FAST MODE (no extended thinking) — bid evaluations need ~50 token JSON,
   * not 10K thinking budget. This reduces latency from 10-20s to 2-4s.
   * 
   * @param {string} prompt - The evaluation prompt
   * @returns {Promise<string|null>} LLM response text
   */
  async _callLLM(prompt) {
    // ⭐ PHASE_39: Use Front Door API for persona injection
    if (this.useFrontDoorAPI) {
      try {
        // 1. Create ephemeral task for this LLM call
        const taskResult = await this.frontDoorClient.createTask(
          `Mesh evaluation for ${this.agentId}`,
          'act'
        );
        
        // 2. Send prompt through front door (routes through AgenticController with persona)
        const messageResult = await this.frontDoorClient.sendMessage(
          taskResult.task.id,
          prompt,
          {
            autoApprove: {},
            agenticMode: true,
            source: 'mesh-signal',
          }
        );
        
        // 3. Extract response
        const response = this.frontDoorClient.extractResponse(messageResult);
        logger.info(`[MeshSignal] Front door LLM call complete (${response.length} chars)`);
        return response;
      } catch (error) {
        logger.warn(`[MeshSignal] Front door LLM call failed: ${error.message}`);
        return null;
      }
    }
    
    // Legacy fallback: direct BedrockProvider call (NO PERSONA)
    if (!this.llmProvider) return null;

    try {
      logger.warn('[MeshSignal] Using LEGACY BedrockProvider (NO PERSONA - USE_FRONT_DOOR_API=false)');
      const messages = [{ role: 'user', content: prompt }];
      const result = await this.llmProvider.generateResponse(messages, {
        maxTokens: 256,                   // Only need ~50 tokens for JSON bid response
        temperature: 0.3,                 // Low temp for deterministic routing decisions
        disableExtendedThinking: true,    // FAST MODE — no 10K thinking budget overhead
        systemPrompt: 'You are a self-evaluation AI. Respond ONLY with valid JSON. No explanation, no markdown, just the JSON object.',
      });

      if (result && result.content) {
        if (Array.isArray(result.content)) {
          return result.content.map(c => c.text || '').join('');
        }
        return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      }
      return result?.text || result?.response || null;
    } catch (error) {
      logger.warn(`[MeshSignal] LLM call error: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse LLM bid evaluation response — extract JSON from potentially messy output
   * @param {string} text - LLM response
   * @returns {Object} { claim, confidence, reason, capabilities_matched }
   */
  _parseBidResponse(text) {
    if (!text) return { claim: false, confidence: 0, reason: 'Empty LLM response' };

    try {
      // Try direct JSON parse first
      const parsed = JSON.parse(text.trim());
      return {
        claim: !!parsed.claim,
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
        reason: parsed.reason || '',
        capabilities_matched: Array.isArray(parsed.capabilities_matched) ? parsed.capabilities_matched : [],
      };
    } catch {
      // Extract JSON from surrounding text (LLM sometimes wraps in markdown)
      const jsonMatch = text.match(/\{[\s\S]*?"claim"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            claim: !!parsed.claim,
            confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
            reason: parsed.reason || '',
            capabilities_matched: Array.isArray(parsed.capabilities_matched) ? parsed.capabilities_matched : [],
          };
        } catch { /* fall through */ }
      }

      // Last resort: look for claim pattern
      const claimMatch = text.match(/"claim"\s*:\s*(true|false)/);
      const confMatch = text.match(/"confidence"\s*:\s*([\d.]+)/);
      if (claimMatch) {
        return {
          claim: claimMatch[1] === 'true',
          confidence: confMatch ? parseFloat(confMatch[1]) : 0.3,
          reason: 'Extracted from partial response',
          capabilities_matched: [],
        };
      }

      return { claim: false, confidence: 0, reason: 'Failed to parse LLM response' };
    }
  }

  /**
   * Keyword-based fallback bid evaluation (no LLM needed)
   * Uses selector_descriptor text matching against job description
   * @param {Object} payload - Bid request payload
   * @param {string} signal_id - Signal ID
   * @param {number} startTime - Start timestamp
   * @returns {Object} Bid response
   */
  _keywordFallbackBid(payload, signal_id, startTime) {
    const { title = '', description = '', required_capabilities = [] } = payload;
    const jobText = `${title} ${description}`.toLowerCase();

    // Check selector_descriptor keywords against job text
    const selectorWords = this.selectorDescriptor
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3); // Only meaningful words

    let matchCount = 0;
    const matchedWords = [];
    for (const word of selectorWords) {
      if (jobText.includes(word)) {
        matchCount++;
        matchedWords.push(word);
      }
    }

    // Calculate confidence based on keyword overlap
    const confidence = selectorWords.length > 0
      ? Math.min(1.0, matchCount / Math.max(5, selectorWords.length * 0.3))
      : 0.1;

    const claim = confidence >= 0.5;

    const result = {
      agent_id: this.agentId,
      signal_id,
      type: SIGNAL_TYPES.BID_REQUEST,
      status: 'evaluated',
      claim,
      confidence: Math.round(confidence * 100) / 100,
      reason: claim
        ? `Keyword match: ${matchedWords.slice(0, 5).join(', ')}`
        : `Low keyword overlap (${matchCount} matches)`,
      capabilities_matched: matchedWords.slice(0, 5),
      latency_ms: Date.now() - startTime,
      evaluation_method: 'keyword_fallback',
    };

    const claimEmoji = result.claim ? '✅' : '⛔';
    logger.info(`[MeshSignal] ${claimEmoji} ${this.agentId} keyword-bid: claim=${result.claim}, confidence=${result.confidence} (${result.latency_ms}ms)`);

    return result;
  }

  /**
   * Handle CAPABILITY_QUERY — respond with this bot's capabilities
   * @param {Object} payload
   * @returns {Object} Capability response
   */
  handleCapabilityQuery(payload) {
    const personaFile = process.env.BOT_PERSONA_FILE;
    let capabilities = [];
    let routingKeywords = [];

    if (personaFile) {
      try {
        const fs = require('fs');
        const yaml = require('js-yaml');
        if (fs.existsSync(personaFile)) {
          const parsed = yaml.load(fs.readFileSync(personaFile, 'utf8'));
          capabilities = parsed.capabilities || [];
          routingKeywords = parsed.routing_keywords || [];
        }
      } catch { /* use empty arrays */ }
    }

    return {
      agent_id: this.agentId,
      type: SIGNAL_TYPES.CAPABILITY_QUERY,
      status: 'ok',
      capabilities,
      routing_keywords: routingKeywords,
      selector_descriptor: this.selectorDescriptor,
      persona_name: this.persona?.name || this.agentId,
      persona_role: this.persona?.role || 'unknown',
    };
  }

  /**
   * ⭐ PHASE_22 Issue #014: Handle peer communication signals
   * Delegates to PeerCommunicationService if available, otherwise acknowledges
   * @param {string} type - Signal type
   * @param {Object} payload - Signal payload
   * @param {string} signal_id - Signal ID
   * @param {number} startTime - Start timestamp
   * @returns {Object} Response
   */
  _handlePeerSignal(type, payload, signal_id, startTime) {
    logger.info(`[MeshSignal] ${this.agentId} handling peer signal: ${type} from ${payload.from_agent || payload.requesting_agent || payload.sharing_agent || 'unknown'}`);

    // If PeerCommunicationService is attached, delegate
    if (this.peerComm) {
      const result = this.peerComm.handleIncoming(type, payload);
      return {
        ...result,
        agent_id: this.agentId,
        signal_id,
        latency_ms: Date.now() - startTime,
      };
    }

    // Default acknowledgment without PeerCommunicationService
    return {
      agent_id: this.agentId,
      signal_id,
      type,
      status: 'acknowledged',
      message: `${this.agentId} received ${type} signal`,
      latency_ms: Date.now() - startTime,
    };
  }

  /**
   * Attach a PeerCommunicationService instance for handling peer signals
   * @param {Object} peerComm - PeerCommunicationService instance
   */
  setPeerCommunicationService(peerComm) {
    this.peerComm = peerComm;
    logger.info(`[MeshSignal] PeerCommunicationService attached for ${this.agentId}`);
  }

  /**
   * ⭐ PHASE_24 Issue #018: Attach PrivateMeshManager for handling mesh protocol signals
   * @param {Object} privateMeshManager - PrivateMeshManager instance
   */
  setPrivateMeshManager(privateMeshManager) {
    this.privateMeshManager = privateMeshManager;
    logger.info(`[MeshSignal] PrivateMeshManager attached for ${this.agentId}`);
  }

  /**
   * ⭐ PHASE_32 Issue #030: Handle MESH_INVITE — join mesh and subscribe to messages
   * Enhanced to subscribe to mesh messages and process them with LLM responses
   * @param {Object} signal - Full mesh signal envelope
   * @param {number} startTime
   * @returns {Promise<Object>} Response
   */
  async _handleMeshInvite(signal, startTime) {
    const { payload, source, signal_id, mesh_id } = signal;
    const topic = payload.topic || '';
    const capabilitiesNeeded = payload.capabilities_needed || [];

    logger.info(`[MeshSignal] ${this.agentId} received MESH_INVITE from ${source} for mesh ${mesh_id}: "${topic}"`);

    // Check if we have PrivateMeshManager to actually join
    if (!this.privateMeshManager) {
      logger.warn(`[MeshSignal] No PrivateMeshManager — cannot join mesh`);
      return {
        agent_id: this.agentId,
        signal_id,
        type: 'MESH_INVITE',
        status: 'declined',
        reason: 'PrivateMeshManager not initialized',
        latency_ms: Date.now() - startTime,
      };
    }

    // Evaluate fitness: check selector_descriptor against topic + capabilities
    const topicText = `${topic} ${capabilitiesNeeded.join(' ')}`.toLowerCase();
    const selectorWords = this.selectorDescriptor
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    let matchCount = 0;
    for (const word of selectorWords) {
      if (topicText.includes(word)) matchCount++;
    }

    // Auto-accept if ANY keyword overlap (meshes are targeted, not broadcast)
    const shouldAccept = matchCount > 0 || capabilitiesNeeded.length === 0;

    if (shouldAccept) {
      try {
        // 1. Join the mesh
        const joinResult = await this.privateMeshManager.joinMesh(mesh_id);
        if (!joinResult.success) {
          logger.error(`[MeshSignal] Failed to join mesh ${mesh_id}: ${joinResult.error}`);
          return {
            agent_id: this.agentId,
            signal_id,
            type: 'MESH_DECLINE',
            mesh_id,
            status: 'declined',
            reason: `Join failed: ${joinResult.error}`,
            latency_ms: Date.now() - startTime,
          };
        }

        // 2. Subscribe to mesh messages with handler
        await this.privateMeshManager.subscribeToMesh(mesh_id, async (message) => {
          await this.processIncomingMeshMessage(mesh_id, message);
        });

        // 3. Send greeting message
        const personaName = this.persona?.name || this.agentId;
        await this.privateMeshManager.sendMessage(
          mesh_id,
          this.agentId,
          `Hello! I'm ${personaName} and I've joined the conversation. I'm ready to help with: ${topic}`,
          'text'
        );

        logger.info(`[MeshSignal] ✅ ${this.agentId} joined and subscribed to mesh ${mesh_id}`);

        return {
          agent_id: this.agentId,
          signal_id,
          type: 'MESH_ACCEPT',
          mesh_id,
          status: 'accepted',
          reason: matchCount > 0
            ? `Capabilities match (${matchCount} keyword overlaps)`
            : 'No specific capabilities required — joining',
          latency_ms: Date.now() - startTime,
        };
      } catch (err) {
        logger.error(`[MeshSignal] Error accepting mesh invite: ${err.message}`);
        return {
          agent_id: this.agentId,
          signal_id,
          type: 'MESH_DECLINE',
          mesh_id,
          status: 'declined',
          reason: `Error: ${err.message}`,
          latency_ms: Date.now() - startTime,
        };
      }
    }

    return {
      agent_id: this.agentId,
      signal_id,
      type: 'MESH_DECLINE',
      mesh_id,
      status: 'declined',
      reason: `No capability overlap with topic "${topic}"`,
      latency_ms: Date.now() - startTime,
    };
  }

  /**
   * ⭐ PHASE_24 Issue #018: Handle generic MESH_* signals
   * Routes to PrivateMeshManager for processing
   * @param {string} type - Signal type
   * @param {Object} signal - Full signal envelope
   * @param {number} startTime
   * @returns {Object} Response
   */
  _handleMeshSignal(type, signal, startTime) {
    const { source, signal_id, mesh_id, payload } = signal;

    logger.info(`[MeshSignal] ${this.agentId} handling ${type} from ${source} for mesh ${mesh_id || 'unknown'}`);

    if (!this.privateMeshManager) {
      return {
        agent_id: this.agentId,
        signal_id,
        type,
        status: 'acknowledged',
        message: `${this.agentId} received ${type} but has no PrivateMeshManager`,
        latency_ms: Date.now() - startTime,
      };
    }

    // Route specific signal types to PrivateMeshManager
    switch (type) {
      case 'MESH_MESSAGE':
        if (mesh_id && payload?.message) {
          this.privateMeshManager.sendMessage(mesh_id, source, payload.message).catch(() => {});
        }
        break;
      case 'MESH_DELEGATE':
        if (mesh_id && payload?.task) {
          // Delegation received — this bot needs to process the task
          this.privateMeshManager.stats.delegationsReceived++;
          logger.info(`[MeshSignal] Delegation received in mesh ${mesh_id}: "${(payload.task || '').substring(0, 80)}"`);
        }
        break;
      case 'MESH_RESULT':
        if (mesh_id && payload?.result) {
          this.privateMeshManager.returnResult(mesh_id, source, payload.result).catch(() => {});
        }
        break;
      case 'MESH_LEAVE':
        // Note: handled by the leaving agent locally
        break;
      case 'MESH_DISSOLVE':
        // Mesh owner dissolved — clean up locally
        this.privateMeshManager.leaveMesh(mesh_id).catch(() => {});
        break;
      case 'MESH_HEARTBEAT':
        if (mesh_id) {
          this.privateMeshManager.store.refreshTTL(
            mesh_id, payload?.ttl_seconds || 1800
          ).catch(() => {});
        }
        break;
    }

    return {
      agent_id: this.agentId,
      signal_id,
      type,
      mesh_id,
      status: 'processed',
      message: `${type} handled by ${this.agentId}`,
      latency_ms: Date.now() - startTime,
    };
  }

  /**
   * ⭐ PHASE_32 Issue #030: Process incoming mesh messages and generate LLM responses
   * Called when a message arrives on a subscribed mesh channel
   * @param {string} meshId - Mesh ID
   * @param {Object} message - Message object from Redis pub/sub
   * @returns {Promise<void>}
   */
  async processIncomingMeshMessage(meshId, message) {
    try {
      // Skip own messages
      if (message.from === this.agentId) return;

      // Skip system messages
      if (message.type === 'system') return;

      logger.info(`[MeshSignal] Processing message in mesh ${meshId} from ${message.from}`);

      // Get mesh context
      const mesh = await this.privateMeshManager.getMeshState(meshId);
      if (!mesh) {
        logger.warn(`[MeshSignal] Mesh ${meshId} not found`);
        return;
      }

      // Get recent message history for context (last 10 messages)
      const history = await this.privateMeshManager.getHistory(meshId, 10);
      const conversationContext = history
        .map(m => `${m.from}: ${m.content}`)
        .join('\n');

      // Build system prompt for mesh conversation
      const personaName = this.persona?.name || this.agentId;
      const personaRole = this.persona?.role || 'AI agent';
      const personaPerspective = this.persona?.perspective || '';

      const systemPrompt = `You are ${personaName} (${personaRole}) participating in a mesh conversation.

Topic: ${mesh.topic}
Participants: ${mesh.members.join(', ')}

Your perspective:
${personaPerspective.substring(0, 500)}

Recent conversation:
${conversationContext}

Respond helpfully to the latest message. Be concise, relevant to the topic, and collaborative with other participants. If the message is directed at you or relates to your expertise, provide a detailed response. Otherwise, provide brief acknowledgment or relevant insights.`;

      // Generate response using LLM
      const response = await this._callLLM(systemPrompt + `\n\nLatest message from ${message.from}: ${message.content}\n\nYour response:`);

      if (!response || response.trim().length === 0) {
        logger.warn(`[MeshSignal] LLM returned empty response for mesh ${meshId}`);
        return;
      }

      // Clean up response (remove any JSON artifacts or markdown)
      let cleanResponse = response.trim();
      // Remove markdown code blocks if present
      cleanResponse = cleanResponse.replace(/```[a-z]*\n?/g, '').trim();
      // Remove leading/trailing quotes
      cleanResponse = cleanResponse.replace(/^["']|["']$/g, '').trim();

      // Send response back to mesh
      await this.privateMeshManager.sendMessage(
        meshId,
        this.agentId,
        cleanResponse,
        'text'
      );

      logger.info(`[MeshSignal] ✅ Sent response to mesh ${meshId} (${cleanResponse.length} chars)`);

    } catch (err) {
      logger.error(`[MeshSignal] Failed to process mesh message: ${err.message}`);
    }
  }

  /**
   * Handle HEALTH_PING — simple liveness check
   * @returns {Object} Health response
   */
  handleHealthPing() {
    return {
      agent_id: this.agentId,
      type: SIGNAL_TYPES.HEALTH_PING,
      status: 'alive',
      timestamp: new Date().toISOString(),
      has_llm: !!this.llmProvider,
      has_selector_descriptor: !!this.selectorDescriptor,
    };
  }
}

// Export handler and signal types
module.exports = MeshSignalHandler;
module.exports.SIGNAL_TYPES = SIGNAL_TYPES;
