/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PlaneProjectConfigSync — Ensures all Plane projects have correct configuration
 *
 * Loops through every project in the configured workspace and ensures:
 *   1. Required STATES exist (with correct group, color, description)
 *   2. Required LABELS exist (with correct color and description)
 *   3. Project DESCRIPTION is set (if missing)
 *
 * Uses the Plane REST API directly (same pattern as plane-mcp/src/index.ts).
 * Idempotent — safe to run multiple times. Only creates what's missing.
 *
 * Usage:
 *   const sync = new PlaneProjectConfigSync();
 *   const result = await sync.syncAll();
 *
 * Or via API endpoint:
 *   POST /api/plane-config/sync
 *   GET  /api/plane-config/status
 */

const axios = require('axios');
const logger = require('../utils/logger');

// ============================================================
// REQUIRED CONFIGURATION — edit these to match your standards
// ============================================================

/**
 * States that every project must have.
 * group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
 */
const REQUIRED_STATES = [
  // ── Unstarted ──────────────────────────────────────────
  {
    name: 'Todo',
    group: 'unstarted',
    color: '#e2e8f0',
    description: 'Work item is ready to be picked up by an agent or human.',
    default: true,
  },
  {
    name: 'Approval Required',
    group: 'unstarted',
    color: '#f97316',
    description: '🔐 A bot has requested human approval before executing a tool command (AWS, kubectl, gcloud). Move back to Todo to approve.',
  },
  // ── Started ────────────────────────────────────────────
  {
    name: 'In Progress',
    group: 'started',
    color: '#3b82f6',
    description: 'An agent is actively working on this ticket.',
  },
  {
    name: 'Routing',
    group: 'started',
    color: '#8b5cf6',
    description: 'Queue Manager is routing this ticket to the appropriate agent.',
  },
  {
    name: 'In Review',
    group: 'started',
    color: '#f59e0b',
    description: 'Work is complete and waiting for child subtasks to finish, or under peer review.',
  },
  // ── Completed ──────────────────────────────────────────
  {
    name: 'Customer Action',
    group: 'completed',
    color: '#10b981',
    description: 'Agent work is complete. Awaiting human review, feedback, or sign-off.',
  },
  {
    name: 'Done',
    group: 'completed',
    color: '#22c55e',
    description: 'Ticket is fully resolved and closed.',
  },
  // ── Cancelled ──────────────────────────────────────────
  {
    name: 'Cancelled',
    group: 'cancelled',
    color: '#6b7280',
    description: 'Ticket was cancelled and will not be worked on.',
  },
];

/**
 * Labels that every project must have.
 * These are used by agents to categorize their work.
 */
const REQUIRED_LABELS = [
  // ── Priority / Urgency ─────────────────────────────────
  { name: 'urgent', color: '#ef4444', description: 'Requires immediate attention — blocking production or critical path.' },
  { name: 'bug', color: '#f97316', description: 'Something is broken or not working as expected.' },
  { name: 'enhancement', color: '#3b82f6', description: 'Improvement to existing functionality.' },
  { name: 'feature', color: '#8b5cf6', description: 'New capability or feature request.' },
  // ── Work Type ──────────────────────────────────────────
  { name: 'research', color: '#06b6d4', description: 'Investigation, analysis, or discovery work.' },
  { name: 'documentation', color: '#64748b', description: 'Writing, updating, or improving documentation.' },
  { name: 'infrastructure', color: '#f59e0b', description: 'DevOps, CI/CD, Kubernetes, cloud infrastructure work.' },
  { name: 'security', color: '#dc2626', description: 'Security audit, vulnerability fix, or access control work.' },
  { name: 'automation', color: '#10b981', description: 'Scripting, workflow automation, or bot task.' },
  // ── Agent Workflow ─────────────────────────────────────
  { name: 'agent-task', color: '#6366f1', description: 'Task assigned to and processed by an AI agent.' },
  { name: 'needs-human', color: '#ec4899', description: 'Requires human input, decision, or approval to proceed.' },
  { name: 'approval-pending', color: '#f97316', description: 'Waiting for human approval of a bot-requested action (tool authorization).' },
  { name: 'multi-agent', color: '#0ea5e9', description: 'Involves coordination between multiple AI agents.' },
  { name: 'subtask', color: '#a78bfa', description: 'Child ticket created by decomposition of a parent task.' },
];

/**
 * Default project description template (used when a project has no description).
 * {projectName} is replaced with the actual project name.
 */
const DEFAULT_PROJECT_DESCRIPTION = (projectName) =>
  `${projectName} — Managed by the AI Agent Swarm.\n\n` +
  `**Workflow:**\n` +
  `- New work items go to **Todo** state\n` +
  `- Queue Manager routes tickets to specialist agents automatically\n` +
  `- Agents post progress as comments and move tickets through states\n` +
  `- Human review happens in **Customer Action** state\n\n` +
  `**States:** Todo → Routing → In Progress → In Review → Customer Action → Done\n\n` +
  `**Tool Approval:** If an agent needs to run AWS/kubectl/gcloud, it moves the ticket to **Approval Required**. ` +
  `Move it back to Todo to approve the command.`;

// ============================================================
// SERVICE CLASS
// ============================================================

/**
 * @description Idempotent configuration reconciler for Plane projects. It exists so
 *   the AI Agent Swarm can rely on every project sharing a consistent set of workflow
 *   states, categorization labels, and an explanatory description — without an operator
 *   manually configuring each project. Calling syncAll() (or enabling the optional
 *   polling scheduler) discovers all projects in the workspace and creates only what is
 *   missing, so it is safe to run repeatedly. Talks to the Plane REST API directly and
 *   supports a dryRun mode for previewing changes.
 */
class PlaneProjectConfigSync {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Plane API key (defaults to PLANE_API_KEY env var)
   * @param {string} options.baseUrl - Plane base URL (defaults to PLANE_BASE_URL env var)
   * @param {string} options.workspaceSlug - Workspace slug (defaults to PLANE_WORKSPACE_SLUG env var)
   * @param {boolean} options.dryRun - If true, log what would be done but don't create anything
   * @param {number} options.pollIntervalMs - Auto-sync interval in ms (default: 0 = disabled)
   *   Set PLANE_CONFIG_SYNC_INTERVAL_MS env var or pass pollIntervalMs to enable auto-sync.
   *   When enabled, the service polls Plane every N minutes, discovers new projects,
   *   and ensures all projects have the required states, labels, and descriptions.
   *   Sync results are cached in Redis under 'plane-config-sync:last-run' (24h TTL).
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.PLANE_API_KEY;
    this.baseUrl = options.baseUrl || process.env.PLANE_BASE_URL || 'http://host.docker.internal:80';
    this.workspaceSlug = options.workspaceSlug || process.env.PLANE_WORKSPACE_SLUG || 'devopscloud-00';
    this.dryRun = options.dryRun || false;
    this.pollIntervalMs = options.pollIntervalMs ||
      parseInt(process.env.PLANE_CONFIG_SYNC_INTERVAL_MS || '0');
    this._intervalId = null;
    this._redis = options.redis || null; // optional Redis client for caching last-run results

    if (!this.apiKey) {
      throw new Error('PlaneProjectConfigSync: PLANE_API_KEY is required');
    }

    this.client = axios.create({
      baseURL: `${this.baseUrl}/api/v1`,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    logger.info(`[PlaneConfigSync] Initialized for workspace: ${this.workspaceSlug} (dryRun=${this.dryRun}, pollInterval=${this.pollIntervalMs ? this.pollIntervalMs / 60000 + 'min' : 'disabled'})`);
  }

  // ════════════════════════════════════════════════════════════
  // AUTO-SYNC SCHEDULER
  // ════════════════════════════════════════════════════════════

  /**
   * Start the auto-sync scheduler.
   * Runs syncAll() immediately, then every pollIntervalMs milliseconds.
   * Discovers new Plane projects automatically and ensures they have correct config.
   *
   * Stores last-run results in Redis under 'plane-config-sync:last-run' (24h TTL)
   * so the /api/plane-config/status endpoint can show when sync last ran.
   *
   * @param {Object} [redisClient] - Optional ioredis client for caching results
   * @returns {PlaneProjectConfigSync} this (for chaining)
   */
  startAutoSync(redisClient = null) {
    if (!this.pollIntervalMs || this.pollIntervalMs < 60000) {
      logger.warn(`[PlaneConfigSync] Auto-sync not started: pollIntervalMs=${this.pollIntervalMs} (minimum 60000ms / 1 minute)`);
      return this;
    }

    if (this._intervalId) {
      logger.warn('[PlaneConfigSync] Auto-sync already running');
      return this;
    }

    if (redisClient) this._redis = redisClient;

    const runSync = async () => {
      logger.info(`[PlaneConfigSync] 🔄 Auto-sync triggered for workspace: ${this.workspaceSlug}`);
      try {
        const result = await this.syncAll();

        // Cache result in Redis for status endpoint
        if (this._redis) {
          try {
            await this._redis.set(
              'plane-config-sync:last-run',
              JSON.stringify({
                timestamp: new Date().toISOString(),
                workspace: this.workspaceSlug,
                projectsChecked: result.projects.length,
                statesCreated: result.totals.statesCreated,
                labelsCreated: result.totals.labelsCreated,
                errors: result.totals.errors,
                elapsed: result.elapsed,
              }),
              'EX', 86400 // 24h TTL
            );
          } catch (redisErr) {
            logger.debug(`[PlaneConfigSync] Redis cache write failed (non-fatal): ${redisErr.message}`);
          }
        }

        logger.info(`[PlaneConfigSync] ✅ Auto-sync complete: ${result.totals.statesCreated} states, ${result.totals.labelsCreated} labels created across ${result.projects.length} projects`);
      } catch (err) {
        logger.error(`[PlaneConfigSync] Auto-sync error: ${err.message}`);
      }
    };

    // Run immediately on start
    runSync();

    // Then run on interval
    this._intervalId = setInterval(runSync, this.pollIntervalMs);
    logger.info(`[PlaneConfigSync] ✅ Auto-sync started — will check for new projects every ${this.pollIntervalMs / 60000} minutes`);

    return this;
  }

  /**
   * Stop the auto-sync scheduler.
   */
  stopAutoSync() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      logger.info('[PlaneConfigSync] Auto-sync stopped');
    }
  }

  /**
   * Check if auto-sync is running.
   */
  isAutoSyncRunning() {
    return !!this._intervalId;
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Sync all projects in the workspace.
   * @returns {Promise<Object>} Summary of what was created/skipped
   */
  async syncAll() {
    const startTime = Date.now();
    logger.info(`[PlaneConfigSync] Starting full sync for workspace: ${this.workspaceSlug}`);

    const summary = {
      workspace: this.workspaceSlug,
      dryRun: this.dryRun,
      projects: [],
      totals: { statesCreated: 0, labelsCreated: 0, descriptionsSet: 0, errors: 0 },
      elapsed: null,
    };

    try {
      // 1. Get all projects in workspace
      const projects = await this.listProjects();
      logger.info(`[PlaneConfigSync] Found ${projects.length} projects to sync`);

      // 2. Sync each project
      for (const project of projects) {
        const projectResult = await this.syncProject(project);
        summary.projects.push(projectResult);
        summary.totals.statesCreated += projectResult.statesCreated;
        summary.totals.labelsCreated += projectResult.labelsCreated;
        summary.totals.descriptionsSet += projectResult.descriptionSet ? 1 : 0;
        summary.totals.errors += projectResult.errors.length;
      }

      summary.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      logger.info(`[PlaneConfigSync] ✅ Sync complete in ${summary.elapsed}: ${summary.totals.statesCreated} states created, ${summary.totals.labelsCreated} labels created, ${summary.totals.descriptionsSet} descriptions set, ${summary.totals.errors} errors`);

      return summary;
    } catch (err) {
      logger.error(`[PlaneConfigSync] Fatal error during sync: ${err.message}`);
      summary.error = err.message;
      summary.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      return summary;
    }
  }

  /**
   * Sync a single project by ID or slug.
   * @param {string|Object} projectIdOrObj - Project ID string or project object from listProjects()
   * @returns {Promise<Object>} Result for this project
   */
  async syncProject(projectIdOrObj) {
    const project = typeof projectIdOrObj === 'string'
      ? await this.getProject(projectIdOrObj)
      : projectIdOrObj;

    const result = {
      projectId: project.id,
      projectName: project.name,
      projectIdentifier: project.identifier,
      statesCreated: 0,
      labelsCreated: 0,
      descriptionSet: false,
      errors: [],
    };

    logger.info(`[PlaneConfigSync] Syncing project: ${project.name} (${project.identifier})`);

    // Sync states
    try {
      const statesResult = await this.syncStates(project.id);
      result.statesCreated = statesResult.created;
      result.statesSkipped = statesResult.skipped;
    } catch (err) {
      logger.error(`[PlaneConfigSync] States sync failed for ${project.name}: ${err.message}`);
      result.errors.push(`states: ${err.message}`);
    }

    // Sync labels
    try {
      const labelsResult = await this.syncLabels(project.id);
      result.labelsCreated = labelsResult.created;
      result.labelsSkipped = labelsResult.skipped;
    } catch (err) {
      logger.error(`[PlaneConfigSync] Labels sync failed for ${project.name}: ${err.message}`);
      result.errors.push(`labels: ${err.message}`);
    }

    // Sync description
    try {
      const descResult = await this.syncDescription(project);
      result.descriptionSet = descResult.set;
    } catch (err) {
      logger.error(`[PlaneConfigSync] Description sync failed for ${project.name}: ${err.message}`);
      result.errors.push(`description: ${err.message}`);
    }

    const status = result.errors.length > 0 ? '⚠️' : '✅';
    logger.info(`[PlaneConfigSync] ${status} ${project.name}: +${result.statesCreated} states, +${result.labelsCreated} labels${result.descriptionSet ? ', description set' : ''}`);

    return result;
  }

  // ════════════════════════════════════════════════════════════
  // STATES SYNC
  // ════════════════════════════════════════════════════════════

  /**
   * Ensure all required states exist in a project.
   * Creates missing states; skips existing ones (matched by name, case-insensitive).
   */
  async syncStates(projectId) {
    const result = { created: 0, skipped: 0, details: [] };

    // Get existing states
    const existing = await this.listStates(projectId);
    const existingNames = new Set(existing.map(s => s.name.toLowerCase().trim()));

    for (const requiredState of REQUIRED_STATES) {
      const nameLower = requiredState.name.toLowerCase().trim();

      if (existingNames.has(nameLower)) {
        result.skipped++;
        result.details.push({ name: requiredState.name, action: 'skipped' });
        logger.debug(`[PlaneConfigSync] State "${requiredState.name}" already exists in project ${projectId}`);
        continue;
      }

      // Create the missing state
      if (this.dryRun) {
        logger.info(`[PlaneConfigSync] [DRY RUN] Would create state "${requiredState.name}" in project ${projectId}`);
        result.created++;
        result.details.push({ name: requiredState.name, action: 'would-create' });
        continue;
      }

      try {
        await this.createState(projectId, requiredState);
        result.created++;
        result.details.push({ name: requiredState.name, action: 'created' });
        logger.info(`[PlaneConfigSync] ✅ Created state "${requiredState.name}" in project ${projectId}`);
      } catch (err) {
        logger.warn(`[PlaneConfigSync] Failed to create state "${requiredState.name}": ${err.message}`);
        result.details.push({ name: requiredState.name, action: 'error', error: err.message });
      }
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════
  // LABELS SYNC
  // ════════════════════════════════════════════════════════════

  /**
   * Ensure all required labels exist in a project.
   * Creates missing labels; skips existing ones (matched by name, case-insensitive).
   */
  async syncLabels(projectId) {
    const result = { created: 0, skipped: 0, details: [] };

    // Get existing labels
    const existing = await this.listLabels(projectId);
    const existingNames = new Set(existing.map(l => l.name.toLowerCase().trim()));

    for (const requiredLabel of REQUIRED_LABELS) {
      const nameLower = requiredLabel.name.toLowerCase().trim();

      if (existingNames.has(nameLower)) {
        result.skipped++;
        result.details.push({ name: requiredLabel.name, action: 'skipped' });
        logger.debug(`[PlaneConfigSync] Label "${requiredLabel.name}" already exists in project ${projectId}`);
        continue;
      }

      // Create the missing label
      if (this.dryRun) {
        logger.info(`[PlaneConfigSync] [DRY RUN] Would create label "${requiredLabel.name}" in project ${projectId}`);
        result.created++;
        result.details.push({ name: requiredLabel.name, action: 'would-create' });
        continue;
      }

      try {
        await this.createLabel(projectId, requiredLabel);
        result.created++;
        result.details.push({ name: requiredLabel.name, action: 'created' });
        logger.info(`[PlaneConfigSync] ✅ Created label "${requiredLabel.name}" in project ${projectId}`);
      } catch (err) {
        logger.warn(`[PlaneConfigSync] Failed to create label "${requiredLabel.name}": ${err.message}`);
        result.details.push({ name: requiredLabel.name, action: 'error', error: err.message });
      }
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════
  // DESCRIPTION SYNC
  // ════════════════════════════════════════════════════════════

  /**
   * Set project description if it's missing or empty.
   */
  async syncDescription(project) {
    const result = { set: false };

    // Only set if description is missing/empty
    if (project.description && project.description.trim().length > 20) {
      logger.debug(`[PlaneConfigSync] Project "${project.name}" already has a description, skipping`);
      return result;
    }

    const description = DEFAULT_PROJECT_DESCRIPTION(project.name);

    if (this.dryRun) {
      logger.info(`[PlaneConfigSync] [DRY RUN] Would set description for project "${project.name}"`);
      result.set = true;
      return result;
    }

    try {
      await this.updateProject(project.id, { description });
      result.set = true;
      logger.info(`[PlaneConfigSync] ✅ Set description for project "${project.name}"`);
    } catch (err) {
      logger.warn(`[PlaneConfigSync] Failed to set description for "${project.name}": ${err.message}`);
      throw err;
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════
  // PLANE API METHODS
  // ════════════════════════════════════════════════════════════

  /**
   * List all projects in the workspace
   */
  async listProjects() {
    try {
      const response = await this.client.get(
        `/workspaces/${this.workspaceSlug}/projects/`
      );
      // Plane API returns { results: [...] } or just an array
      const data = response.data;
      return Array.isArray(data) ? data : (data.results || []);
    } catch (err) {
      throw new Error(`Failed to list projects: ${this._extractError(err)}`);
    }
  }

  /**
   * Get a single project by ID
   */
  async getProject(projectId) {
    try {
      const response = await this.client.get(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/`
      );
      return response.data;
    } catch (err) {
      throw new Error(`Failed to get project ${projectId}: ${this._extractError(err)}`);
    }
  }

  /**
   * Update a project (PATCH)
   */
  async updateProject(projectId, updates) {
    try {
      const response = await this.client.patch(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/`,
        updates
      );
      return response.data;
    } catch (err) {
      throw new Error(`Failed to update project ${projectId}: ${this._extractError(err)}`);
    }
  }

  /**
   * List all states in a project
   */
  async listStates(projectId) {
    try {
      const response = await this.client.get(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`
      );
      const data = response.data;
      return Array.isArray(data) ? data : (data.results || []);
    } catch (err) {
      throw new Error(`Failed to list states for project ${projectId}: ${this._extractError(err)}`);
    }
  }

  /**
   * Create a state in a project
   */
  async createState(projectId, state) {
    try {
      const payload = {
        name: state.name,
        group: state.group,
        color: state.color,
      };
      // description field may not be supported by all Plane versions — add if available
      if (state.description) payload.description = state.description;
      if (state.default) payload.default = true;

      const response = await this.client.post(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`,
        payload
      );
      return response.data;
    } catch (err) {
      throw new Error(`Failed to create state "${state.name}": ${this._extractError(err)}`);
    }
  }

  /**
   * List all labels in a project
   */
  async listLabels(projectId) {
    try {
      const response = await this.client.get(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`
      );
      const data = response.data;
      return Array.isArray(data) ? data : (data.results || []);
    } catch (err) {
      throw new Error(`Failed to list labels for project ${projectId}: ${this._extractError(err)}`);
    }
  }

  /**
   * Create a label in a project
   */
  async createLabel(projectId, label) {
    try {
      const payload = {
        name: label.name,
        color: label.color,
      };
      if (label.description) payload.description = label.description;

      const response = await this.client.post(
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
        payload
      );
      return response.data;
    } catch (err) {
      throw new Error(`Failed to create label "${label.name}": ${this._extractError(err)}`);
    }
  }

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════

  /**
   * Extract a readable error message from an axios error
   */
  _extractError(err) {
    if (err.response) {
      const status = err.response.status;
      const data = err.response.data;
      const detail = typeof data === 'object'
        ? (data.detail || data.error || JSON.stringify(data))
        : String(data);
      return `HTTP ${status}: ${detail}`;
    }
    return err.message;
  }

  /**
   * Get the list of required states (for inspection/documentation)
   */
  getRequiredStates() {
    return REQUIRED_STATES;
  }

  /**
   * Get the list of required labels (for inspection/documentation)
   */
  getRequiredLabels() {
    return REQUIRED_LABELS;
  }
}

module.exports = PlaneProjectConfigSync;
