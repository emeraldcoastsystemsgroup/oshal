/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition: method bodies extracted to QueuePollingCoordinator, TicketRoutingEngine, PlaneTicketIO, AgentDispatchEngine (+DispatchCompletionHandler), CompletionReporter, SubtaskHierarchyManager, PhaseGateWorkflow; class methods now delegate — public API and behavior unchanged
 */

/**
 * QueueManagerService - Central coordinator for multi-agent ticket routing
 * Polls Plane Todo queue and routes tickets to specialized agents based on capabilities
 */

const { Client } = require('pg');
const logger = require('../../utils/logger');
const AgentRegistry = require('./AgentRegistry');
const CapabilityMatcher = require('./CapabilityMatcher');
const { buildSystemPrompt } = require('./AgentInstructions');
const CommentParser = require('./CommentParser');
const CommentFormatter = require('./CommentFormatter');
const PlaneDatabase = require('./PlaneDatabase');
const TicketProcessor = require('./TicketProcessor');
const CompletionEvaluator = require('./CompletionEvaluator');
const ClineIntegration = require('./ClineIntegration');
const PerspectiveEngine = require('./PerspectiveEngine');
const { getPlaneUserId, getQueueManagerUserId } = require('./AgentPlaneUserMap');
const { TicketPhaseManager, PHASES } = require('./TicketPhaseManager');
const CompetencyRanker = require('./CompetencyRanker');
const RALFHandoverManager = require('./RALFHandoverManager');
const { PhaseRoundOrchestrator } = require('./PhaseRoundOrchestrator');
const SwarmAwarenessPrompt = require('./SwarmAwarenessPrompt');
const SwarmMemoryService = require('./SwarmMemoryService');
const AgentMetricsService = require('./AgentMetricsService');
const PeerCommunicationService = require('./PeerCommunicationService');
const RoutingDecisionLog = require('./RoutingDecisionLog');
const StuckAgentWatchdog = require('./StuckAgentWatchdog');
const QueuePollingCoordinator = require('./QueuePollingCoordinator');
const TicketRoutingEngine = require('./TicketRoutingEngine');
const PlaneTicketIO = require('./PlaneTicketIO');
const AgentDispatchEngine = require('./AgentDispatchEngine');
const CompletionReporter = require('./CompletionReporter');
const SubtaskHierarchyManager = require('./SubtaskHierarchyManager');
const PhaseGateWorkflow = require('./PhaseGateWorkflow');

class QueueManagerService {
  constructor(planeDbConfig, redisClient, mcpService, taskController) {
    this.enabled = process.env.ENABLE_QUEUE_MANAGER === 'true';
    this.pollInterval = parseInt(process.env.QUEUE_MANAGER_POLL_INTERVAL || '60000'); // 60s default
    
    // Concurrency control: spread work to avoid Bedrock rate limits
    // Let each agent use full 200K context — pace the QUEUE not the LLM
    this.maxConcurrentDispatches = parseInt(process.env.MAX_CONCURRENT_DISPATCHES || '3');
    this.activeDispatches = 0;
    this.workspaceSlug = process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-01';
    this.multiWorkspace = process.env.QUEUE_MANAGER_MULTI_WORKSPACE === 'true'; // Enable multi-workspace
    this.cooldownMs = parseInt(process.env.QUEUE_MANAGER_COOLDOWN || '300000'); // 5 min default
    
    // Database config for Plane
    this.dbConfig = planeDbConfig || {
      host: process.env.PLANE_DB_HOST || 'plane-plane-db-1',
      port: parseInt(process.env.PLANE_DB_PORT || '5432'),
      database: process.env.PLANE_DB_NAME || 'plane',
      user: process.env.PLANE_DB_USER || 'plane',
      password: process.env.PLANE_DB_PASSWORD || 'plane',
    };

    // Initialize components
    this.redis = redisClient; // Redis for persistent tracking
    this.agentRegistry = new AgentRegistry(redisClient);
    this.capabilityMatcher = new CapabilityMatcher();
    this.commentParser = new CommentParser();
    this.commentFormatter = new CommentFormatter();
    this.mcp = mcpService; // For Plane MCP operations
    this.taskController = taskController; // For agent processing
    
    // Initialize helper modules
    this.planeDb = new PlaneDatabase(this.dbConfig);
    this.clineIntegration = new ClineIntegration();
    this.perspectiveEngine = new PerspectiveEngine();
    this.phaseManager = new TicketPhaseManager(redisClient);

    // LLM-powered agent router — uses AI reasoning instead of keyword matching
    const LLMAgentRouter = require('./LLMAgentRouter');
    this.llmRouter = new LLMAgentRouter({
      llmProvider: taskController?.llm || null,
      agentRegistry: this.agentRegistry,
    });

    // Phase Review Cycle — consensus-driven round-robin review within phases
    const PhaseReviewCycle = require('./PhaseReviewCycle');
    this.reviewCycle = new PhaseReviewCycle(redisClient, {
      maxRounds: parseInt(process.env.REVIEW_CYCLE_MAX_ROUNDS || '3'),
      minReviewers: parseInt(process.env.REVIEW_CYCLE_MIN_REVIEWERS || '2'),
      maxReviewers: parseInt(process.env.REVIEW_CYCLE_MAX_REVIEWERS || '4'),
    });

    // Mesh Broadcast Network — Phase 2: broadcast BID_REQUEST to all agents, collect bids
    const MeshBroadcastNetwork = require('./MeshBroadcastNetwork');
    this.meshBroadcast = new MeshBroadcastNetwork({
      agentRegistry: this.agentRegistry,
      redis: redisClient,
      bidWindowMs: parseInt(process.env.MESH_BID_WINDOW_MS || '10000'),
      requestTimeoutMs: parseInt(process.env.MESH_REQUEST_TIMEOUT_MS || '8000'),
    });

    // ⭐ PHASE_28: Peer Communication Service — bot-to-bot messaging
    // Enables agents to use ## PEER: markers for HELP_REQUEST, KNOWLEDGE_SHARE, DIRECT_MESSAGE, DELEGATE
    this.peerCommunication = new PeerCommunicationService({
      agentRegistry: this.agentRegistry,
      redis: redisClient,
      meshBroadcast: this.meshBroadcast,
      agentId: 'queue-manager', // QMS acts as coordinator
    });

    // ⭐ PHASE_18: RALF Lifecycle Modules — competency ranking, handover memory, multi-round orchestration
    this.competencyRanker = new CompetencyRanker({
      meshBroadcast: this.meshBroadcast,
      agentRegistry: this.agentRegistry,
      redis: redisClient,
    });

    this.handoverManager = new RALFHandoverManager({
      redis: redisClient,
      workspaceRoot: process.env.WORKSPACE_DIR || '/app/workspace',
    });

    this.phaseRoundOrchestrator = new PhaseRoundOrchestrator({
      redis: redisClient,
      defaultRounds: parseInt(process.env.PHASE_ROUNDS || '2'),
      competencyRanker: this.competencyRanker,
      handoverManager: this.handoverManager,
    });

    // ⭐ PHASE_20 GAP F: Cross-Ticket Organizational Memory
    // Extracts learnings from completed tickets → ChromaDB swarm-memory collection
    // Queries relevant memories on new ticket dispatch → injects into prompt
    this.swarmMemory = new SwarmMemoryService({
      redis: redisClient,
      chromaMcpUrl: process.env.CHROMA_MCP_URL || 'http://chroma-mcp:8091',
      collectionName: 'swarm-memory',
      enabled: process.env.ENABLE_SWARM_MEMORY !== 'false', // Enabled by default
    });

    // ⭐ ROUTING DECISION LOG: Transparent audit trail for every routing decision
    // Writes to Redis (last 100 decisions) + workspace ROUTING-DECISIONS.md
    // Answers "why didn't email-bot get this ticket?" and similar questions
    this.routingLog = new RoutingDecisionLog(redisClient, {
      workspaceRoot: process.env.WORKSPACE_DIR || '/app/workspace',
      writeToWorkspace: true,
      logToConsole: true,
    });

    this.intervalId = null;

    logger.info('QueueManagerService initialized', {
      enabled: this.enabled,
      pollInterval: this.pollInterval,
      cooldownMs: this.cooldownMs,
      workspaceSlug: this.workspaceSlug,
      multiWorkspace: this.multiWorkspace
    });
  }

  /**
   * @description Start the 10-minute roll-call broadcast loop (PHASE_48 Issue #051). Delegates to QueuePollingCoordinator.startRollCallProtocol (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See QueuePollingCoordinator.startRollCallProtocol.
   */
  startRollCallProtocol() {
    return QueuePollingCoordinator.startRollCallProtocol(this);
  }

  /**
   * Start the Queue Manager service
   */
  async start() {
    if (!this.enabled) {
      logger.info('QueueManagerService disabled (ENABLE_QUEUE_MANAGER != true)');
      return;
    }

    try {
      logger.info('Starting QueueManagerService...');

      // Test database connection
      await this.testDatabaseConnection();

      // Start polling
      await this.poll(); // Initial poll
      this.intervalId = setInterval(() => {
        this.poll().catch(err => {
          logger.error('Queue Manager polling error:', err.message);
        });
      }, this.pollInterval);

      // Check Cline CLI availability
      const clineStatus = await this.clineIntegration.checkAvailability();
      if (!clineStatus.available) {
        logger.warn('Cline CLI not available - falling back to AgenticController for ticket processing');
      } else {
        logger.info(`Cline CLI v${clineStatus.version} ready for ticket processing with codebase awareness`);
      }

      // ⭐ PHASE_48 Issue #051: Start roll call protocol
      this.startRollCallProtocol();

      // ⭐ ISSUE #026: HEALTH CHECKS PERMANENTLY DISABLED
      // DO NOT RE-ENABLE - Created 1525+ noise tickets, flooded Plane queue
      // 
      // Historical context:
      // - Health checks ran every 2-5 minutes
      // - Created Plane tickets for every service hiccup
      // - Resulted in 1525 tickets initially, then 57 more
      // - Blocked development work by saturating the queue
      // 
      // If you think you need health checks, create a NEW service with:
      // - Manual trigger only (no auto-polling)
      // - Separate Plane project (not main queue)
      // - Rate limiting (max 1 ticket per service per day)
      // - Human approval before ticket creation
      // - Nightly batch mode instead of real-time
      //
      // The code has been archived to: archive/health-checks-disabled-2026-02-19/
      // - HealthCheckScheduler.js
      // - AutonomousRemediator.js
      // - RunbookLibrary.js
      this.HEALTH_CHECKS_PERMANENTLY_DISABLED = true;
      
      // Enforcement: Log error if someone tries to enable via env var
      if (process.env.ENABLE_HEALTH_CHECKS === 'true') {
        logger.error('❌ HEALTH_CHECKS_PERMANENTLY_DISABLED - ignoring ENABLE_HEALTH_CHECKS env var');
        logger.error('❌ Health checks created 1525+ tickets. DO NOT RE-ENABLE.');
        logger.error('❌ See Issue #026 for details and alternative approaches.');
      }

      // ⭐ PHASE_21 GAP B: Initialize Agent Performance Metrics
      this.agentMetrics = new AgentMetricsService(this.redis);
      this.agentMetrics.start();
      logger.info('📊 AgentMetricsService initialized (24h rolling window)');

      // ⭐ Issue #009: Pre-populate metrics index with ALL known agents
      // This ensures all agents appear in the dashboard even before their first task
      try {
        const { getAllMappedAgentIds } = require('./AgentPlaneUserMap');
        const allAgentIds = getAllMappedAgentIds();
        const populated = await this.agentMetrics.prePopulateAllAgents(allAgentIds);
        logger.info(`📊 Pre-populated ${populated} agents in metrics index (Issue #009)`);
      } catch (prePopErr) {
        logger.warn(`[QM] Pre-populate agents failed (non-fatal): ${prePopErr.message}`);
      }

      // ⭐ Issue #001: Start StuckAgentWatchdog — detects agents stuck > 60min with no activity
      // Runs every 15 minutes, force-releases stuck agents, requeues their active tickets
      try {
        this.stuckAgentWatchdog = new StuckAgentWatchdog({
          agentRegistry: this.agentRegistry,
          planeDatabase: this.planeDb,
          agentMetrics: this.agentMetrics,
          redis: this.redis,
        });
        this.stuckAgentWatchdog.start();
        logger.info('🐕 StuckAgentWatchdog started (15-min interval, 60-min stuck threshold) — Issue #001');
      } catch (watchdogErr) {
        logger.warn(`[QM] StuckAgentWatchdog failed to start (non-fatal): ${watchdogErr.message}`);
      }

      logger.info('✓ QueueManagerService started successfully');
    } catch (error) {
      logger.error('Failed to start QueueManagerService:', error.message);
      throw error;
    }
  }

  /**
   * Stop the Queue Manager service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('QueueManagerService stopped');
    }
  }

  /**
   * Test database connection
   */
  async testDatabaseConnection() {
    const client = new Client(this.dbConfig);
    try {
      await client.connect();
      const result = await client.query('SELECT COUNT(*) FROM issues');
      logger.info('✓ Queue Manager database connection successful');
      await client.end();
    } catch (error) {
      logger.error('Queue Manager database connection failed:', error.message);
      throw error;
    }
  }

  /**
   * @description Acquire the Redis task lock for a task. Delegates to QueuePollingCoordinator.acquireTaskLock (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.acquireTaskLock.
   */
  async acquireTaskLock(taskId, agentId) {
    return QueuePollingCoordinator.acquireTaskLock(this, taskId, agentId);
  }

  /**
   * @description Release the Redis task lock. Delegates to QueuePollingCoordinator.releaseTaskLock (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.releaseTaskLock.
   */
  async releaseTaskLock(taskId) {
    return QueuePollingCoordinator.releaseTaskLock(this, taskId);
  }

  /**
   * @description Read the current task-lock owner. Delegates to QueuePollingCoordinator.checkTaskLock (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.checkTaskLock.
   */
  async checkTaskLock(taskId) {
    return QueuePollingCoordinator.checkTaskLock(this, taskId);
  }

  /**
   * @description Read last-processed tracking info from Redis. Delegates to QueuePollingCoordinator.getLastProcessed (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.getLastProcessed.
   */
  async getLastProcessed(ticketId) {
    return QueuePollingCoordinator.getLastProcessed(this, ticketId);
  }

  /**
   * @description Mark a ticket processed in Redis (cooldown tracking). Delegates to QueuePollingCoordinator.setProcessed (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.setProcessed.
   */
  async setProcessed(ticket, agentId, complexity = 'medium') {
    return QueuePollingCoordinator.setProcessed(this, ticket, agentId, complexity);
  }

  /**
   * @description Complexity-based cooldown in ms (Enhancement E12). Delegates to QueuePollingCoordinator.getDynamicCooldown (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See QueuePollingCoordinator.getDynamicCooldown.
   */
  getDynamicCooldown(complexity) {
    return QueuePollingCoordinator.getDynamicCooldown(this, complexity);
  }

  /**
   * @description Check for non-QM comment activity since a timestamp. Delegates to QueuePollingCoordinator.hasNewActivity (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.hasNewActivity.
   */
  async hasNewActivity(client, ticketId, sinceTimestamp) {
    return QueuePollingCoordinator.hasNewActivity(this, client, ticketId, sinceTimestamp);
  }

  /**
   * @description Detect and recover tickets stalled In Progress. Delegates to QueuePollingCoordinator.detectStalledTasks (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.detectStalledTasks.
   */
  async detectStalledTasks(client) {
    return QueuePollingCoordinator.detectStalledTasks(this, client);
  }

  /**
   * @description Return one stalled ticket to Todo. Delegates to QueuePollingCoordinator.recoverStalledTicket (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.recoverStalledTicket.
   */
  async recoverStalledTicket(client, ticket) {
    return QueuePollingCoordinator.recoverStalledTicket(this, client, ticket);
  }

  /**
   * @description One full Todo-queue poll cycle. Delegates to QueuePollingCoordinator.poll (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.poll.
   */
  async poll() {
    return QueuePollingCoordinator.poll(this);
  }

  /**
   * @description Poll the configured workspace for Todo tickets. Delegates to QueuePollingCoordinator.pollSingleWorkspace (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.pollSingleWorkspace.
   */
  async pollSingleWorkspace(client) {
    return QueuePollingCoordinator.pollSingleWorkspace(this, client);
  }

  /**
   * @description Poll all active workspaces (multi-tenant mode). Delegates to QueuePollingCoordinator.pollMultipleWorkspaces (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.pollMultipleWorkspaces.
   */
  async pollMultipleWorkspaces(client) {
    return QueuePollingCoordinator.pollMultipleWorkspaces(this, client);
  }

  /**
   * @description Detect re-route requests and completed-work returns. Delegates to QueuePollingCoordinator.detectRerouteRequests (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.detectRerouteRequests.
   */
  async detectRerouteRequests(client) {
    return QueuePollingCoordinator.detectRerouteRequests(this, client);
  }

  /**
   * @description Check one ticket for a valid re-route request. Delegates to QueuePollingCoordinator.checkForRerouteRequest (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.checkForRerouteRequest.
   */
  async checkForRerouteRequest(client, ticket) {
    return QueuePollingCoordinator.checkForRerouteRequest(this, client, ticket);
  }

  /**
   * @description Evaluate whether a returned ticket is complete. Delegates to QueuePollingCoordinator.evaluateTicketCompletion (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.evaluateTicketCompletion.
   */
  async evaluateTicketCompletion(client, ticket) {
    return QueuePollingCoordinator.evaluateTicketCompletion(this, client, ticket);
  }

  /**
   * @description Execute a validated re-route request. Delegates to QueuePollingCoordinator.executeReroute (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see QueuePollingCoordinator.executeReroute.
   */
  async executeReroute(client, ticket, rerouteRequest) {
    return QueuePollingCoordinator.executeReroute(this, client, ticket, rerouteRequest);
  }

  /**
   * @description Assess a ticket and route it to the best agent (circuit breaker + phases + hierarchy). Delegates to TicketRoutingEngine.assessAndRoute (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see TicketRoutingEngine.assessAndRoute.
   */
  async assessAndRoute(client, ticket) {
    return TicketRoutingEngine.assessAndRoute(this, client, ticket);
  }

  /**
   * @description Mesh BID_REQUEST broadcast routing; null on no winner. Delegates to TicketRoutingEngine.meshBroadcastRoute (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see TicketRoutingEngine.meshBroadcastRoute.
   */
  async meshBroadcastRoute(ticket, analysis, allAgents, options = {}) {
    return TicketRoutingEngine.meshBroadcastRoute(this, ticket, analysis, allAgents, options);
  }

  /**
   * @description Route a ticket to the selected agent and trigger processing. Delegates to TicketRoutingEngine.routeToAgent (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see TicketRoutingEngine.routeToAgent.
   */
  async routeToAgent(client, ticket, agent, analysis, agentPlaneUserId = null) {
    return TicketRoutingEngine.routeToAgent(this, client, ticket, agent, analysis, agentPlaneUserId);
  }

  /**
   * @description Get workspace task id for a ticket (DB column with Redis fallback). Delegates to PlaneTicketIO.getTicketTaskId (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PlaneTicketIO.getTicketTaskId.
   */
  async getTicketTaskId(client, ticketId) {
    return PlaneTicketIO.getTicketTaskId(this, client, ticketId);
  }

  /**
   * @description Store workspace task id on a ticket (DB column with Redis fallback). Delegates to PlaneTicketIO.setTicketTaskId (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PlaneTicketIO.setTicketTaskId.
   */
  async setTicketTaskId(client, ticketId, taskId) {
    return PlaneTicketIO.setTicketTaskId(this, client, ticketId, taskId);
  }

  /**
   * @description Process a ticket with the selected agent (workspace, dispatch, completion lifecycle). Delegates to AgentDispatchEngine.processWithAgent (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see AgentDispatchEngine.processWithAgent.
   */
  async processWithAgent(client, ticket, agent, agentPlaneUserId = null) {
    return AgentDispatchEngine.processWithAgent(this, client, ticket, agent, agentPlaneUserId);
  }

  /**
   * @description Decide CUSTOMER_ACTION vs TODO from the agent response. Delegates to CompletionReporter.evaluateAgentCompletion (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see CompletionReporter.evaluateAgentCompletion.
   */
  async evaluateAgentCompletion(agentResponse, ticket, result) {
    return CompletionReporter.evaluateAgentCompletion(this, agentResponse, ticket, result);
  }

  /**
   * @description Heuristic: is the response an outline/plan rather than executed work. Delegates to CompletionReporter._isJustAnOutline (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See CompletionReporter._isJustAnOutline.
   */
  _isJustAnOutline(text) {
    return CompletionReporter._isJustAnOutline(this, text);
  }

  /**
   * @description Build the user-facing completion summary (with workspace file recovery). Delegates to CompletionReporter.generateUserSummary (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See CompletionReporter.generateUserSummary.
   */
  generateUserSummary(agentResponse, ticket, result) {
    return CompletionReporter.generateUserSummary(this, agentResponse, ticket, result);
  }

  /**
   * @description Report agent completion back to Plane. Delegates to CompletionReporter.reportCompletion (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see CompletionReporter.reportCompletion.
   */
  async reportCompletion(client, ticket, agent, response, taskId) {
    return CompletionReporter.reportCompletion(this, client, ticket, agent, response, taskId);
  }

  /**
   * @description Escalate a ticket to human review (Customer Action). Delegates to CompletionReporter.escalateToHuman (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see CompletionReporter.escalateToHuman.
   */
  async escalateToHuman(client, ticket, reason) {
    return CompletionReporter.escalateToHuman(this, client, ticket, reason);
  }

  /**
   * @description Markdown summary of registered agents (for escalation comments). Delegates to CompletionReporter.getAgentSummary (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see CompletionReporter.getAgentSummary.
   */
  async getAgentSummary() {
    return CompletionReporter.getAgentSummary(this);
  }

  /**
   * @description Resolve a Plane project id to a slug. Delegates to CompletionReporter.getProjectSlug (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see CompletionReporter.getProjectSlug.
   */
  async getProjectSlug(client, projectId) {
    return CompletionReporter.getProjectSlug(this, client, projectId);
  }

  /**
   * @description Extract plain-text description from a Plane ticket. Delegates to CompletionReporter.extractDescription (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See CompletionReporter.extractDescription.
   */
  extractDescription(ticket) {
    return CompletionReporter.extractDescription(this, ticket);
  }

  /**
   * @description Update ticket state in Plane by state name. Delegates to PlaneTicketIO.updateTicketStatus (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PlaneTicketIO.updateTicketStatus.
   */
  async updateTicketStatus(client, ticketId, statusName, projectId) {
    return PlaneTicketIO.updateTicketStatus(this, client, ticketId, statusName, projectId);
  }

  /**
   * @description Post a comment to a Plane ticket with attribution. Delegates to PlaneTicketIO.postComment (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PlaneTicketIO.postComment.
   */
  async postComment(client, ticket, comment, actorUserId = null) {
    return PlaneTicketIO.postComment(this, client, ticket, comment, actorUserId);
  }

  /**
   * @description Parse ## SUBTASK DECOMPOSITION markers from an agent response. Delegates to SubtaskHierarchyManager.detectSubtaskDecomposition (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See SubtaskHierarchyManager.detectSubtaskDecomposition.
   */
  detectSubtaskDecomposition(response) {
    return SubtaskHierarchyManager.detectSubtaskDecomposition(this, response);
  }

  /**
   * @description LLM-summarized (Redis-cached) parent context for child briefs (ISSUE #032). Delegates to SubtaskHierarchyManager._getParentSummary (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see SubtaskHierarchyManager._getParentSummary.
   */
  async _getParentSummary(parentTicket, parentDescription) {
    return SubtaskHierarchyManager._getParentSummary(this, parentTicket, parentDescription);
  }

  /**
   * @description Build the rich markdown task brief for a child subtask issue. Delegates to SubtaskHierarchyManager._buildChildTaskBrief (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see SubtaskHierarchyManager._buildChildTaskBrief.
   */
  async _buildChildTaskBrief(subtask, parentTicket, parentDescription, depth, siblingInfo = []) {
    return SubtaskHierarchyManager._buildChildTaskBrief(this, subtask, parentTicket, parentDescription, depth, siblingInfo);
  }

  /**
   * @description Scan workspace files for a ticket to build a file manifest (ISSUE #033). Delegates to SubtaskHierarchyManager._scanWorkspaceFiles (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See SubtaskHierarchyManager._scanWorkspaceFiles.
   */
  _scanWorkspaceFiles(ticketId) {
    return SubtaskHierarchyManager._scanWorkspaceFiles(this, ticketId);
  }

  /**
   * @description Walk the parent chain to the root (depth-0) ticket (PHASE_45). Delegates to SubtaskHierarchyManager.findRootTicketId (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see SubtaskHierarchyManager.findRootTicketId.
   */
  async findRootTicketId(client, ticketId) {
    return SubtaskHierarchyManager.findRootTicketId(this, client, ticketId);
  }

  /**
   * @description Assemble parents in In Review whose children all completed. Delegates to SubtaskHierarchyManager.checkParentCompletion (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see SubtaskHierarchyManager.checkParentCompletion.
   */
  async checkParentCompletion(client) {
    return SubtaskHierarchyManager.checkParentCompletion(this, client);
  }

  /**
   * @description Convert markdown to Plane ProseMirror comment_json. Delegates to PlaneTicketIO._markdownToPlaneJson (extracted 2026-07-11, 1000-line cap).
   * @returns {*} See PlaneTicketIO._markdownToPlaneJson.
   */
  _markdownToPlaneJson(markdown) {
    return PlaneTicketIO._markdownToPlaneJson(this, markdown);
  }

  /**
   * @description Assign a ticket to a Plane bot user (issue_assignees). Delegates to PlaneTicketIO.assignTicketToAgent (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PlaneTicketIO.assignTicketToAgent.
   */
  async assignTicketToAgent(client, ticketId, planeUserId) {
    return PlaneTicketIO.assignTicketToAgent(this, client, ticketId, planeUserId);
  }

  /**
   * @description Non-blocking parallel dispatch with its own DB connection. Delegates to PhaseGateWorkflow._dispatchParallel (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PhaseGateWorkflow._dispatchParallel.
   */
  async _dispatchParallel(ticket, agent, analysis, agentPlaneUserId) {
    return PhaseGateWorkflow._dispatchParallel(this, ticket, agent, analysis, agentPlaneUserId);
  }

  /**
   * @description Parse the PM's AGENT_ASSIGNMENTS table from ticket comments. Delegates to PhaseGateWorkflow.getPMAgentAssignments (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PhaseGateWorkflow.getPMAgentAssignments.
   */
  async getPMAgentAssignments(ticket) {
    return PhaseGateWorkflow.getPMAgentAssignments(this, ticket);
  }

  /**
   * @description Standard (non-review-cycle) phase gate handling. Delegates to PhaseGateWorkflow._handleStandardPhaseGate (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PhaseGateWorkflow._handleStandardPhaseGate.
   */
  async _handleStandardPhaseGate(client, ticket, agent, agentPlaneUserId, agentResponse, currentPhaseForGate, phaseDataForGate) {
    return PhaseGateWorkflow._handleStandardPhaseGate(this, client, ticket, agent, agentPlaneUserId, agentResponse, currentPhaseForGate, phaseDataForGate);
  }

  /**
   * @description Request human approval for a tool command (PHASE_17). Delegates to PhaseGateWorkflow.requestApproval (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PhaseGateWorkflow.requestApproval.
   */
  async requestApproval(client, ticket, approvalRequest) {
    return PhaseGateWorkflow.requestApproval(this, client, ticket, approvalRequest);
  }

  /**
   * @description Consume a granted approval and return injection context (PHASE_17). Delegates to PhaseGateWorkflow.checkAndConsumeApproval (extracted 2026-07-11, 1000-line cap).
   * @returns {*} Promise — see PhaseGateWorkflow.checkAndConsumeApproval.
   */
  async checkAndConsumeApproval(ticketId) {
    return PhaseGateWorkflow.checkAndConsumeApproval(this, ticketId);
  }

  /**
   * @description Get service status snapshot for health/ops endpoints.
   * @returns {Object} { service, version, enabled, polling, pollInterval, cooldownMs, workspaceSlug }
   */
  getStatus() {
    return {
      service: 'QueueManagerService',
      version: '2.0',
      enabled: this.enabled,
      polling: !!this.intervalId,
      pollInterval: this.pollInterval,
      cooldownMs: this.cooldownMs,
      workspaceSlug: this.workspaceSlug
    };
  }
}

module.exports = QueueManagerService;
