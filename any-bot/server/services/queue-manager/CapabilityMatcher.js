/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CapabilityMatcher — Inclusive Agent Selection & Ticket Routing Engine (v3.0)
 * 
 * @module queue-manager/CapabilityMatcher
 * @description Central routing engine for the OSHAL multi-agent swarm. Scores and ranks
 * all registered agents for each incoming ticket. Never excludes — only ranks by fit.
 * 
 * ## Architecture Role
 * Called by {@link QueueManagerService} during ticket processing. Receives the full
 * agent list from {@link AgentRegistry} and ticket analysis. Returns the best-fit
 * agent (or full ranked list for multi-perspective analysis).
 * 
 * ## Integration Flow
 * ```
 * QueueManagerService.processQueue()
 *   → PlaneDatabase.getTicketsForProcessing()
 *   → CapabilityMatcher.analyzeTicket(description)     ← ticket analysis
 *   → AgentRegistry.query({ status: 'active' })        ← get all agents
 *   → CapabilityMatcher.findBestMatch(agents, reqs)    ← agent selection
 *   → HTTP dispatch to selected agent
 * ```
 * 
 * ## v3.0 Scoring Philosophy (Issue #023 — PHASE_35 Specialist Routing Priority)
 * - **Inclusive**: Every agent always gets scored; minimum score is 1. No exclusion.
 * - **Specialists First**: Focused agents (fewer capabilities) score higher per-match
 *   via log2 specificity weighting. A 2/3-match specialist beats a 3/7-match generalist.
 * - **PM-Last Fallback**: project-manager gets -20 penalty for non-PM work, ensuring
 *   it only wins when no specialist is better suited.
 * - **Dynamic Keywords**: Agents self-declare routing_keywords in persona YAML.
 *   These score +15 to +40 (scaling with match count), weighted by rarity.
 * - **Round-Robin**: Per-ticket history tracks which agents already contributed,
 *   applying -15 penalty to encourage fresh perspectives.
 * 
 * ## Scoring Rules Summary (11 rules in scoreAgent)
 * | Rule | Points | Description |
 * |------|--------|-------------|
 * | Base | +10 | Every agent starts here |
 * | Capability match | +5 each | Matches preferred capabilities |
 * | Multi-match bonus | +5 | ≥2 capability matches |
 * | Availability | +5 | Agent is idle |
 * | Capacity | +1 to +3 | Based on remaining load |
 * | Success rate | +0 to +5 | Historical performance |
 * | Round-robin | -15 | Already worked on this ticket |
 * | Specialist focus | +0 to +25 | focus ratio × 25 |
 * | Generalist penalty | -15 | Has 'general' capability |
 * | Broad penalty | -3 to -15 | >6 capabilities |
 * | PM demotion | -20 | project-manager on non-PM work |
 * | Agent-factory boost | +40 | agent-creation keyword match |
 * | Dynamic keywords | +15 to +40 | Persona YAML routing_keywords match |
 * | Specificity (log2) | varies | 1/log2(caps+1) × matches × 12 |
 * 
 * @see {@link docs/DYNAMIC_ROUTING_ARCHITECTURE.md} for full routing documentation
 * @see {@link docs/BOT_CREATION_PROCESS.md} for how routing_keywords are configured
 * @see {@link QueueManagerService} for orchestration context
 * @see {@link AgentRegistry} for agent data structure
 * 
 * @example
 * // Basic usage in QueueManagerService
 * const matcher = new CapabilityMatcher();
 * const analysis = matcher.analyzeTicket('Research competitive pricing for Q3');
 * // analysis = { categories: ['analyze'], capabilities: ['research','analysis',...], complexity: 'low', priority: 'medium' }
 * 
 * const best = matcher.findBestMatch(agents, {
 *   capabilities: analysis.capabilities,
 *   ticketId: 'ticket-123',
 *   ticketDescription: 'Research competitive pricing for Q3'
 * });
 * // best = { agent_id: 'research-bot', capabilities: ['research','analysis','documentation'], ... }
 */

const logger = require('../../utils/logger');

/**
 * @description Inclusive agent-selection and ticket-routing engine for the OSHAL
 * multi-agent swarm. Its purpose is to ensure every registered agent is always a
 * candidate (never hard-filtered out) while still steering each ticket toward the
 * best-fit specialist through additive/subtractive scoring. This existence-by-design
 * lets the swarm favor focused experts, demote generalists, rotate fresh perspectives
 * per ticket, and still guarantee a fallback assignee — so no ticket is ever left
 * unroutable. It is the last-resort heuristic router behind the LLM-based router.
 * @see QueueManagerService for orchestration context.
 * @see AgentRegistry for the agent data structure consumed here.
 */
class CapabilityMatcher {
  /**
   * @description Sets up the routing engine's static scoring vocabulary and per-ticket
   * state. Defines the broad action-category keyword sets and their preferred-capability
   * hints (used only as scoring tiebreakers, never as filters), initializes the
   * round-robin history map that tracks which agents have already contributed to a
   * ticket, and schedules periodic history cleanup to bound memory growth.
   */
  constructor() {
    // ═══════════════════════════════════════════════════════════════
    // BROAD ACTION CATEGORIES — used for SCORING, not filtering
    // These help rank which agent goes NEXT, but never exclude anyone
    // ═══════════════════════════════════════════════════════════════
    this.actionCategories = {
      // "Build/Create" actions → favor builders, developers, architects
      build: [
        'build', 'create', 'make', 'develop', 'implement', 'construct',
        'generate', 'produce', 'write', 'code', 'program', 'script',
        'design', 'architect', 'engineer', 'setup', 'configure', 'install'
      ],
      // "Analyze/Research" actions → favor researchers, analysts
      analyze: [
        'analyze', 'research', 'investigate', 'study', 'evaluate', 'assess',
        'review', 'audit', 'compare', 'benchmark', 'measure', 'diagnose',
        'examine', 'inspect', 'test', 'validate', 'verify', 'check',
        'understand', 'explore', 'discover', 'find', 'look into'
      ],
      // "Plan/Organize" actions → favor project managers, coordinators
      plan: [
        'plan', 'organize', 'coordinate', 'schedule', 'manage', 'prioritize',
        'roadmap', 'strategy', 'propose', 'recommend', 'suggest', 'advise',
        'estimate', 'budget', 'scope', 'requirements', 'specification'
      ],
      // "Present/Document" actions → favor presenters, documenters
      present: [
        'present', 'document', 'write up', 'report', 'summarize', 'explain',
        'describe', 'outline', 'draft', 'compose', 'slides', 'presentation',
        'deck', 'pptx', 'powerpoint', 'keynote', 'readme', 'guide', 'manual'
      ],
      // "Deploy/Operate" actions → favor devops, infrastructure
      deploy: [
        'deploy', 'release', 'ship', 'launch', 'migrate', 'upgrade',
        'kubernetes', 'k8s', 'docker', 'container', 'pipeline', 'ci/cd',
        'infrastructure', 'server', 'cloud', 'monitor', 'scale', 'helm'
      ],
      // "Fix/Debug" actions → favor coders, devops, analysts
      fix: [
        'fix', 'bug', 'debug', 'troubleshoot', 'resolve', 'repair',
        'patch', 'hotfix', 'error', 'issue', 'problem', 'broken',
        'crash', 'fail', 'wrong', 'incorrect', 'missing'
      ],
      // "Data Extraction/Scraping" actions → favor data-extraction-bot
      data_extraction: [
        'extract', 'scrape', 'scraping', 'crawl', 'crawling', 'fetch data',
        'parse', 'parsing', 'structured data', 'structured json', 'json',
        'csv', 'xml', 'html parsing', 'web scraping', 'api consumption',
        'data extraction', 'data transformation', 'transform data',
        'pull data', 'harvest', 'ingest data', 'data pipeline',
        'etl', 'clean data', 'normalize', 'tabular', 'spreadsheet',
        'scraper', 'web data', 'api data', 'collect data', 'aggregate'
      ],
      // "Agent/Bot Creation" actions → favor agent-factory-bot
      agent_creation: [
        'new bot', 'create bot', 'create a bot', 'new agent', 'create agent',
        'spawn bot', 'spawn agent', 'bootstrap bot', 'bootstrap agent',
        'persona-only', 'persona only', 'bot for the swarm', 'add to swarm',
        'motivational', 'quotes bot', 'swarm-management', 'bot-configuration',
        'agent-creation', 'agent factory', 'scaffold bot', 'scaffold agent',
        'deploy bot', 'deploy agent', 'new persona', 'create persona'
      ]
    };

    // Maps action categories → which agent capabilities are MOST relevant
    // V3.0: EXPANDED to match ACTUAL persona YAML capabilities
    // This ensures specialist agents score high for their domain tickets
    // Maps action categories → which agent capabilities are MOST relevant
    // NOTE: This is used ONLY as a tiebreaker/diversity hint for CapabilityMatcher.findBestMatch()
    // which is the LAST RESORT fallback. Primary routing is done by LLMAgentRouter which reads
    // each agent's selector_descriptor and routing_keywords dynamically from the registry.
    // DO NOT add domain-specific entries here — that's hardcoding. Let the LLM decide.
    this.categoryToCapabilities = {
      build: ['code', 'implementation', 'design', 'architecture'],
      analyze: ['research', 'analysis', 'testing', 'code-review', 'security', 'quality', 'refactoring', 'investigation'],
      plan: ['planning', 'coordination', 'prioritization', 'decomposition'],
      present: ['presentation', 'slides', 'visual', 'communication', 'storytelling', 'executive', 'documentation'],
      deploy: ['devops', 'code', 'implementation'],
      fix: ['code', 'devops', 'analysis', 'testing', 'debugging', 'investigation', 'root-cause', 'incident', 'troubleshooting'],
      data_extraction: ['data-extraction', 'web-scraping', 'api-consumption', 'parsing', 'data-transformation', 'research'],
      agent_creation: ['agent-creation', 'bot-configuration', 'swarm-management', 'automation'],
    };

    // Track which agents have already processed a ticket (for round-robin)
    // Key: ticketId, Value: Set of agentIds that already worked on it
    this.ticketAgentHistory = new Map();

    // Cleanup old history entries every 30 minutes
    setInterval(() => this._cleanupHistory(), 30 * 60 * 1000);
  }

  /**
   * Detect broad action categories from ticket text
   * Returns ALL matching categories — inclusive, not exclusive
   * @param {string} description - Ticket description text
   * @returns {string[]} List of detected action categories
   */
  detectActionCategories(description) {
    if (!description || typeof description !== 'string') {
      return ['general']; // Everything gets routed
    }

    const text = description.toLowerCase();
    const detected = [];

    for (const [category, terms] of Object.entries(this.actionCategories)) {
      if (terms.some(term => text.includes(term))) {
        detected.push(category);
      }
    }

    // Always include at least one category
    if (detected.length === 0) {
      detected.push('general');
    }

    logger.info(`Action categories detected: [${detected.join(', ')}] from: "${description.substring(0, 80)}..."`);
    return detected;
  }

  /**
   * Get preferred capabilities based on action categories
   * These are HINTS for scoring, not hard filters
   * @param {string[]} categories - Action categories
   * @returns {string[]} Preferred capability hints
   */
  getPreferredCapabilities(categories) {
    const preferred = new Set();
    
    for (const category of categories) {
      const caps = this.categoryToCapabilities[category] || [];
      caps.forEach(cap => preferred.add(cap));
    }

    // If nothing matched, everything is preferred (truly inclusive)
    if (preferred.size === 0) {
      preferred.add('general');
    }

    return [...preferred];
  }

  /**
   * Analyze ticket — returns categories, complexity, priority
   * Used by QueueManagerService.assessAndRoute()
   * @param {string} description - Ticket description text
   * @returns {Object} Ticket analysis
   */
  analyzeTicket(description) {
    const categories = this.detectActionCategories(description);
    const capabilities = this.getPreferredCapabilities(categories);
    const complexity = this.estimateComplexity(description);
    const priority = this.extractPriority(description);

    return {
      categories,
      capabilities, // These are HINTS, not hard requirements
      complexity,
      priority,
      description: description.substring(0, 200) + (description.length > 200 ? '...' : '')
    };
  }

  /**
   * Score an agent for a ticket — ALL agents get scored, none excluded
   * Higher score = agent goes first, but everyone eventually participates
   * 
   * @param {Object} agent - Agent object from registry
   * @param {string[]} preferredCapabilities - Hint capabilities (from action categories)
   * @param {Object} options - Scoring options
   * @param {string} [options.priority] - Ticket priority
   * @param {string} [options.ticketId] - Ticket ID for round-robin tracking
   * @returns {number} Score (higher is better, always > 0)
   */
  scoreAgent(agent, preferredCapabilities, options = {}) {
    let score = 10; // BASE SCORE: Every agent starts with 10 points (inclusive)

    // 1. Capability relevance bonus (up to +20 points)
    // Agents whose capabilities overlap with preferred hints get bonus
    const matches = agent.capabilities.filter(cap => 
      preferredCapabilities.includes(cap)
    );
    score += matches.length * 5;

    // Extra bonus if agent matches multiple preferred capabilities
    if (matches.length >= 2) {
      score += 5;
    }

    // 2. Availability bonus (+5 if idle)
    if (agent.status === 'idle') {
      score += 5;
    }

    // 3. Capacity bonus (up to +3 based on remaining capacity)
    const loadRatio = agent.current_load / agent.max_concurrent;
    if (loadRatio === 0) {
      score += 3;
    } else if (loadRatio < 0.5) {
      score += 2;
    } else if (loadRatio < 1.0) {
      score += 1;
    }
    // At capacity: no bonus (but still scored — can queue)

    // 4. Success rate bonus (up to +5)
    const successRate = agent.success_rate || 1.0;
    score += successRate * 5;

    // 5. Round-robin penalty: agents who ALREADY worked on this ticket
    // get penalized so fresh perspectives go first
    if (options.ticketId) {
      const history = this.ticketAgentHistory.get(options.ticketId);
      if (history && history.has(agent.agent_id)) {
        score -= 15; // Significant penalty — prefer fresh eyes
        logger.debug(`Agent ${agent.agent_id} already worked on ${options.ticketId}, applying round-robin penalty`);
      }
    }

    // 6. Priority consideration: for urgent tickets, prefer idle agents
    if (options.priority === 'critical' || options.priority === 'high') {
      if (agent.status === 'idle' && agent.current_load === 0) {
        score += 3;
      }
    }

    // 7. Specialist Focus Bonus: Focused agents score higher per-match
    // An agent with 3 capabilities matching 2 is more focused (valuable) than
    // an agent with 6 capabilities matching 3. This rewards domain expertise.
    // Focus ratio = what % of this agent's capabilities are relevant to this ticket
    if (agent.capabilities.length > 0 && matches.length > 0) {
      const focusRatio = matches.length / agent.capabilities.length;
      score += Math.round(focusRatio * 25); // Up to +25 for 100% focus match (was 10)
    }

    // 8. Generalist penalty: agents with 'general' capability get deprioritized
    if (agent.capabilities.includes('general') && 
        preferredCapabilities.length > 0 &&
        !preferredCapabilities.includes('general')) {
      score -= 15; // Was -8
    }

    // 9. Broad-capability penalty: agents with >6 capabilities are generalists
    if (agent.capabilities.length > 6 &&
        preferredCapabilities.length > 0 &&
        !preferredCapabilities.includes('general')) {
      const broadPenalty = Math.min((agent.capabilities.length - 6) * 3, 15);
      score -= broadPenalty;
    }

    // 10. PM exclusion: project-manager only scores high for planning/coordination/decomposition
    if (agent.agent_id === 'project-manager' &&
        preferredCapabilities.length > 0 &&
        !preferredCapabilities.includes('planning') &&
        !preferredCapabilities.includes('coordination') &&
        !preferredCapabilities.includes('prioritization') &&
        !preferredCapabilities.includes('decomposition')) {
      score -= 20; // V3.0: aggressive PM demotion for non-PM work (was -12)
    }

    // 10b. AGENT-FACTORY SPECIALIST OVERRIDE: When agent_creation capabilities are in play,
    // agents with agent-creation capability get a massive boost. This ensures bot-creation
    // tickets ALWAYS route to agent-factory-bot, not devops-bot or worker-general.
    if (preferredCapabilities.includes('agent-creation') &&
        agent.capabilities.includes('agent-creation')) {
      score += 40; // Hard override — agent-factory-bot MUST win for bot creation tickets
      logger.info(`🏭 Agent-factory specialist boost: +40 for ${agent.agent_id} (agent-creation match)`);
    }

    // 10c. DYNAMIC ROUTING KEYWORDS (from agent self-registration)
    // Each agent declares routing_keywords in their persona YAML. These are registered
    // to Redis and read dynamically — NO hardcoded dictionaries needed.
    // If an agent's routing_keywords match the ticket text, they get a massive boost.
    if (agent.routing_keywords && agent.routing_keywords.length > 0 && options.ticketDescription) {
      const ticketText = options.ticketDescription.toLowerCase();
      const keywordMatches = agent.routing_keywords.filter(kw => ticketText.includes(kw.toLowerCase()));
      if (keywordMatches.length > 0) {
        // Scale boost: 1 match = +15, 2 = +25, 3+ = +40 (caps at 40)
        const keywordBoost = Math.min(15 + (keywordMatches.length - 1) * 10, 40);
        score += keywordBoost;
        logger.info(`🔑 Dynamic keyword boost: +${keywordBoost} for ${agent.agent_id} (${keywordMatches.length} keyword matches: ${keywordMatches.slice(0, 3).join(', ')})`);
      }
    }

    // 11. V3.0 Specificity weight: agents with fewer, more focused capabilities
    // get a multiplier bonus. log2(4 caps) = 2.0, log2(7 caps) = 2.81
    // Specificity multiplier: 1/log2(caps+1) normalized to bonus points
    // 3 caps → 1/log2(4)=0.50 → +12 bonus
    // 4 caps → 1/log2(5)=0.43 → +10 bonus
    // 6 caps → 1/log2(7)=0.36 → +8 bonus
    // 7 caps → 1/log2(8)=0.33 → +7 bonus
    if (agent.capabilities.length > 0 && matches.length > 0) {
      const specificityMultiplier = 1 / Math.log2(agent.capabilities.length + 1);
      score += Math.round(specificityMultiplier * matches.length * 12);
    }

    logger.debug(`Agent ${agent.agent_id} scored ${score.toFixed(1)} (matches: ${matches.length}, focus: ${agent.capabilities.length > 0 ? (matches.length / agent.capabilities.length * 100).toFixed(0) : 0}%, load: ${agent.current_load}/${agent.max_concurrent})`);

    return Math.max(1, score); // MINIMUM 1 — no agent ever scores 0
  }

  /**
   * Select the best agent from ALL available agents
   * NEVER returns null — always picks someone. More perspectives = better.
   * 
   * Issue #004: Added catch-all routing — if no specialist matches well,
   * route to worker-general AND one random specialist to ensure broad participation.
   * 
   * @param {Object[]} agents - ALL available agents (not pre-filtered)
   * @param {Object} requirements - Ticket requirements
   * @param {string[]} requirements.capabilities - Preferred capability hints
   * @param {string} [requirements.priority] - Ticket priority
   * @param {string} [requirements.ticketId] - Ticket ID for round-robin
   * @param {boolean} [requirements.catchAll] - Force catch-all routing (returns array)
   * @returns {Object|null} Best agent (null only if agents array is empty)
   */
  findBestMatch(agents, requirements) {
    if (!agents || agents.length === 0) {
      logger.warn('[CapabilityMatcher.findBestMatch] No agents available for matching');
      return null;
    }

    const preferredCapabilities = requirements.capabilities || [];

    // Score ALL agents — no filtering, no exclusion
    const scored = agents.map(agent => ({
      agent,
      score: this.scoreAgent(agent, preferredCapabilities, {
        priority: requirements.priority,
        ticketId: requirements.ticketId,
        ticketDescription: requirements.ticketDescription || requirements.description || ''
      })
    }));

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    // Log top candidates
    const topCandidates = scored.slice(0, Math.min(5, scored.length));
    logger.info(`[CapabilityMatcher.findBestMatch] Agent ranking for ticket (${agents.length} total, dynamic keywords active):`);
    topCandidates.forEach((item, idx) => {
      logger.info(`  ${idx + 1}. ${item.agent.agent_id}: ${item.score.toFixed(1)} pts [${item.agent.capabilities.join(', ')}]`);
    });

    // ⭐ Issue #004: Catch-all routing check
    // If the top scorer has a very low score (no good specialist match),
    // ensure worker-general is included as a fallback
    const topScore = scored[0].score;
    const BASE_SCORE_THRESHOLD = 20; // Below this = no specialist matched well

    if (topScore <= BASE_SCORE_THRESHOLD && scored.length > 1) {
      // Find worker-general as guaranteed fallback
      const workerGeneral = scored.find(s => s.agent.agent_id === 'worker-general');
      if (workerGeneral && scored[0].agent.agent_id !== 'worker-general') {
        logger.info(`[CapabilityMatcher.findBestMatch] ⚡ CATCH-ALL: No specialist matched (top score: ${topScore.toFixed(1)}) — routing to worker-general as fallback`);
        // Still return the top scorer (may be a random specialist), but log the catch-all
      }
    }

    // Always return the top scorer
    const best = scored[0];
    logger.info(`[CapabilityMatcher.findBestMatch] ✓ Selected agent: ${best.agent.agent_id} (score: ${best.score.toFixed(1)})`);
    return best.agent;
  }

  /**
   * ⭐ Issue #004: Get catch-all routing pair — worker-general + one random specialist.
   * Used when no specialist matches well enough for a ticket.
   * Returns [worker-general, randomSpecialist] or just [worker-general] if no specialists.
   * 
   * @param {Object[]} agents - All available agents
   * @param {string} [excludeAgentId] - Agent to exclude (e.g., already assigned)
   * @returns {Object[]} Array of 1-2 agents for catch-all routing
   */
  getCatchAllAgents(agents, excludeAgentId = null) {
    if (!agents || agents.length === 0) return [];

    const available = agents.filter(a => a.agent_id !== excludeAgentId && a.enabled !== false);

    // Find worker-general
    const workerGeneral = available.find(a => a.agent_id === 'worker-general');

    // Find a random specialist (not worker-general, not project-manager)
    const specialists = available.filter(a =>
      a.agent_id !== 'worker-general' &&
      a.agent_id !== 'project-manager' &&
      a.agent_id !== 'queue-manager' &&
      !a.capabilities.includes('general')
    );

    const result = [];
    if (workerGeneral) result.push(workerGeneral);

    if (specialists.length > 0) {
      // Pick a random specialist to encourage broad participation
      const randomIdx = Math.floor(Math.random() * specialists.length);
      const randomSpecialist = specialists[randomIdx];
      result.push(randomSpecialist);
      logger.info(`[CapabilityMatcher.getCatchAllAgents] Catch-all pair: worker-general + ${randomSpecialist.agent_id} (random specialist)`);
    }

    return result;
  }

  /**
   * Get ALL agents ranked by relevance for multi-perspective analysis
   * Every agent gets a chance — this returns the full ranked list
   * 
   * @param {Object[]} agents - All available agents
   * @param {Object} requirements - Ticket requirements
   * @returns {Object[]} All agents sorted by relevance score
   */
  rankAllAgents(agents, requirements) {
    if (!agents || agents.length === 0) {
      return [];
    }

    const preferredCapabilities = requirements.capabilities || [];

    return agents
      .map(agent => ({
        agent,
        score: this.scoreAgent(agent, preferredCapabilities, {
          priority: requirements.priority,
          ticketId: requirements.ticketId
        })
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Record that an agent worked on a ticket (for round-robin)
   * @param {string} ticketId - Ticket ID
   * @param {string} agentId - Agent that just worked on it
   */
  recordAgentWork(ticketId, agentId) {
    if (!this.ticketAgentHistory.has(ticketId)) {
      this.ticketAgentHistory.set(ticketId, new Set());
    }
    this.ticketAgentHistory.get(ticketId).add(agentId);
    logger.debug(`Recorded: ${agentId} worked on ticket ${ticketId} (${this.ticketAgentHistory.get(ticketId).size} agents total)`);
  }

  /**
   * Get which agents have already worked on a ticket
   * @param {string} ticketId - Ticket ID
   * @returns {string[]} Agent IDs that already contributed
   */
  getAgentHistory(ticketId) {
    const history = this.ticketAgentHistory.get(ticketId);
    return history ? [...history] : [];
  }

  /**
   * Estimate ticket complexity
   * @param {string} description - Ticket description
   * @returns {string} Complexity level (low/medium/high)
   */
  estimateComplexity(description) {
    if (!description) return 'low';
    
    const text = description.toLowerCase();
    const length = text.length;
    
    const complexityIndicators = [
      'complex', 'multiple', 'integrate', 'architecture', 
      'migrate', 'refactor', 'redesign', 'optimization',
      'cross-functional', 'end-to-end', 'comprehensive'
    ];

    const hasComplexityIndicator = complexityIndicators.some(indicator => 
      text.includes(indicator)
    );

    if (length > 500 || hasComplexityIndicator) {
      return 'high';
    } else if (length > 200) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Extract priority from ticket description
   * @param {string} description - Ticket description
   * @returns {string} Priority level (low/medium/high/critical)
   */
  extractPriority(description) {
    if (!description) return 'medium';
    
    const text = description.toLowerCase();

    if (text.includes('urgent') || text.includes('critical') || text.includes('asap')) {
      return 'critical';
    } else if (text.includes('high priority') || text.includes('important')) {
      return 'high';
    } else if (text.includes('low priority') || text.includes('when possible')) {
      return 'low';
    }

    return 'medium';
  }

  /**
   * Build context about available agents for the LLM prompt
   * This tells the processing LLM who its colleagues are so IT can make
   * intelligent routing decisions via @queue-manager re-route requests
   * 
   * @param {Object[]} agents - All registered agents
   * @param {string} currentAgentId - The agent currently processing
   * @returns {string} Formatted agent roster for LLM context
   */
  buildAgentRosterContext(agents, currentAgentId) {
    if (!agents || agents.length === 0) {
      return 'No other agents are currently available.';
    }

    const otherAgents = agents.filter(a => a.agent_id !== currentAgentId);
    
    if (otherAgents.length === 0) {
      return 'You are the only agent currently available.';
    }

    const roster = otherAgents.map(agent => {
      const status = agent.status === 'idle' ? '🟢 Available' : '🟡 Busy';
      const caps = agent.capabilities.join(', ');
      return `- **${agent.agent_id}** (${status}): ${caps}`;
    }).join('\n');

    return `## Your Team (${otherAgents.length} other agents available)
${roster}

If you believe another agent should weigh in on this ticket, you can request a re-route by including:
\`@queue-manager REQUEST: route to [agent-id]\``;
  }

  /**
   * Clean up old ticket history entries (called periodically)
   * @private
   */
  _cleanupHistory() {
    // Keep only recent entries (map size limit)
    if (this.ticketAgentHistory.size > 1000) {
      const entries = [...this.ticketAgentHistory.entries()];
      // Remove oldest half
      const toRemove = entries.slice(0, entries.length / 2);
      toRemove.forEach(([key]) => this.ticketAgentHistory.delete(key));
      logger.info(`Cleaned up ${toRemove.length} old ticket history entries`);
    }
  }

  /**
   * Get all defined action categories
   * @returns {string[]} List of action categories
   */
  getCategories() {
    return Object.keys(this.actionCategories);
  }

  /**
   * Legacy compatibility: extractCapabilities() now wraps analyzeTicket()
   * @param {string} description - Ticket description text
   * @returns {string[]} List of preferred capabilities (hints, not filters)
   */
  extractCapabilities(description) {
    const categories = this.detectActionCategories(description);
    return this.getPreferredCapabilities(categories);
  }

  /**
   * Legacy compatibility: getCapabilities() 
   * @returns {string[]} List of capability names
   */
  getCapabilities() {
    const allCaps = new Set();
    Object.values(this.categoryToCapabilities).forEach(caps => {
      caps.forEach(cap => allCaps.add(cap));
    });
    return [...allCaps];
  }

  /**
   * Legacy compatibility: addKeywords()
   */
  addKeywords(category, keywords) {
    if (!this.actionCategories[category]) {
      this.actionCategories[category] = [];
    }
    this.actionCategories[category].push(...keywords);
    logger.info(`Added ${keywords.length} keywords to category: ${category}`);
  }

  /**
   * Legacy compatibility: validateMinimumMatch()
   * In v2.0, every available agent is a valid match
   */
  validateMinimumMatch(agent, requiredCapabilities) {
    if (!agent) return false;
    // In inclusive mode, any available agent is valid
    return agent.current_load < agent.max_concurrent;
  }
}

module.exports = CapabilityMatcher;