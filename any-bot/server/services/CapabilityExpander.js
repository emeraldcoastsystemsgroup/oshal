/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CapabilityExpander — Orchestrator for Self-Evolving Agent Factory (Layer 2)
 * 
 * This is the main pipeline that agent-factory-bot calls when creating
 * a bot with genuinely NEW capabilities (not just a persona clone).
 * 
 * Pipeline:
 * 1. ToolScaffolder → generates tool code, config schema, provision manifest
 * 2. AgentConfigManager → registers config schema in Redis
 * 3. ComposeGenerator → generates docker-compose service block
 * 4. ProvisioningManager → builds custom Docker image (if npm deps needed)
 * 5. ComposeGenerator → deploys the container
 * 6. DynamicToolManager → registers new tool for LLM function calling
 * 7. AgentRegistry → bot self-registers on startup with new capabilities
 * 
 * Called via: POST /api/agents/expand-capability
 * 
 * Layer 2: Self-Evolving Agent Factory
 */

const logger = require('../utils/logger');
const ToolScaffolder = require('./ToolScaffolder');

/**
 * @description Layer-2 orchestrator that turns a capability specification into a
 * live, self-evolving agent. It coordinates the end-to-end pipeline (scaffold →
 * register config schema → optionally build a custom Docker image → deploy →
 * register the new tool for LLM function calling) so callers can grant an agent
 * genuinely new capabilities through a single entry point, while tracking the
 * history and status of every expansion. Collaborators (config/compose/
 * provisioning/dynamic-tool managers) are injected so the pipeline degrades
 * gracefully and stays testable when a stage is unavailable.
 */
class CapabilityExpander {
  /**
   * @param {Object} options
   * @param {Object} options.configManager - AgentConfigManager instance
   * @param {Object} options.composeGenerator - ComposeGenerator instance (optional, lazy-loaded)
   * @param {Object} options.provisioningManager - ProvisioningManager instance (optional)
   * @param {Object} options.dynamicToolManager - DynamicToolManager instance (optional)
   * @param {string} options.outputDir - Base directory for generated artifacts
   * @param {string} options.baseImage - Docker base image
   */
  constructor(options = {}) {
    this.configManager = options.configManager || null;
    this.composeGenerator = options.composeGenerator || null;
    this.provisioningManager = options.provisioningManager || null;
    this.dynamicToolManager = options.dynamicToolManager || null;

    this.scaffolder = new ToolScaffolder({
      outputDir: options.outputDir,
      baseImage: options.baseImage,
    });

    // Track expansion history
    this.expansions = new Map(); // agentId → { spec, status, artifacts, timestamps }
  }

  /**
   * Execute the full capability expansion pipeline.
   * This is the main entry point — called by POST /api/agents/expand-capability.
   * 
   * @param {Object} spec - Capability specification (same as ToolScaffolder.scaffold)
   * @returns {Object} Pipeline result with status at each step
   */
  async expand(spec) {
    const startTime = Date.now();
    const agentId = spec.agentId;

    logger.info(`[CapabilityExpander] ═══════════════════════════════════════`);
    logger.info(`[CapabilityExpander] Starting expansion for: ${agentId}`);
    logger.info(`[CapabilityExpander] Tool: ${spec.toolName}`);
    logger.info(`[CapabilityExpander] Capabilities: ${(spec.capabilities || []).join(', ')}`);
    logger.info(`[CapabilityExpander] ═══════════════════════════════════════`);

    const pipeline = {
      agentId,
      toolName: spec.toolName,
      steps: {},
      status: 'in-progress',
      startedAt: new Date().toISOString(),
    };

    try {
      // ── Step 1: Scaffold artifacts ──────────────────────────
      pipeline.steps.scaffold = await this._stepScaffold(spec);
      if (!pipeline.steps.scaffold.success) {
        pipeline.status = 'failed';
        pipeline.error = 'Scaffold failed';
        return this._finalizeResult(pipeline, startTime);
      }

      // ── Step 2: Register config schema ──────────────────────
      pipeline.steps.configSchema = await this._stepRegisterConfig(
        agentId,
        pipeline.steps.scaffold.artifacts.configSchemaData
      );

      // ── Step 3: Build custom image (if needed) ─────────────
      const manifest = pipeline.steps.scaffold.artifacts.manifestData;
      if (manifest.image_type === 'custom') {
        pipeline.steps.customBuild = await this._stepBuildCustomImage(manifest);
      } else {
        pipeline.steps.customBuild = { skipped: true, reason: 'base image sufficient' };
      }

      // ── Step 4: Deploy via ComposeGenerator ────────────────
      pipeline.steps.deploy = await this._stepDeploy(agentId, spec, manifest);

      // ── Step 5: Register tool ──────────────────────────────
      pipeline.steps.toolRegistration = await this._stepRegisterTool(
        pipeline.steps.scaffold.artifacts.toolRegistration
      );

      // Determine overall status
      const deploySuccess = pipeline.steps.deploy.success || pipeline.steps.deploy.skipped;
      const criticalFailure = !pipeline.steps.scaffold.success;

      pipeline.status = criticalFailure ? 'failed' : (deploySuccess ? 'completed' : 'partial');

      // Track expansion
      this.expansions.set(agentId, {
        spec,
        status: pipeline.status,
        artifacts: pipeline.steps.scaffold.artifacts,
        completedAt: new Date().toISOString(),
      });

      return this._finalizeResult(pipeline, startTime);

    } catch (error) {
      logger.error(`[CapabilityExpander] Pipeline failed for ${agentId}: ${error.message}`);
      pipeline.status = 'failed';
      pipeline.error = error.message;
      return this._finalizeResult(pipeline, startTime);
    }
  }

  /**
   * Get expansion status for an agent.
   * @param {string} agentId
   * @returns {Object|null}
   */
  getExpansionStatus(agentId) {
    return this.expansions.get(agentId) || null;
  }

  /**
   * List all expansions.
   * @returns {Array}
   */
  listExpansions() {
    const result = [];
    for (const [agentId, data] of this.expansions) {
      result.push({
        agentId,
        status: data.status,
        toolName: data.spec?.toolName,
        capabilities: data.spec?.capabilities,
        completedAt: data.completedAt,
      });
    }
    return result;
  }

  /**
   * Validate a capability spec before expanding.
   * Useful for dry-run / preview.
   * @param {Object} spec
   * @returns {Object} { valid, errors, preview }
   */
  async validate(spec) {
    const validation = this.scaffolder.validateSpec(spec);
    
    if (!validation.valid) {
      return { valid: false, errors: validation.errors };
    }

    // Generate preview without writing files
    const preview = {
      agentId: spec.agentId,
      toolName: spec.toolName,
      capabilities: spec.capabilities || ['general'],
      needsCustomImage: (spec.npmDependencies && spec.npmDependencies.length > 0),
      npmDependencies: spec.npmDependencies || [],
      configFields: (spec.configFields || []).map(f => ({
        key: f.key,
        type: f.type || 'string',
        required: f.required !== false,
      })),
      estimatedSteps: this._estimateSteps(spec),
    };

    return { valid: true, errors: [], preview };
  }

  // ──────────────────────────────────────────────────────────────
  // Pipeline Steps
  // ──────────────────────────────────────────────────────────────

  /**
   * Step 1: Generate all artifacts via ToolScaffolder.
   */
  async _stepScaffold(spec) {
    logger.info(`[CapabilityExpander] Step 1: Scaffolding artifacts...`);
    try {
      const result = await this.scaffolder.scaffold(spec);
      if (result.success) {
        logger.info(`[CapabilityExpander] ✅ Step 1: Scaffold complete → ${result.agentDir}`);
      } else {
        logger.error(`[CapabilityExpander] ❌ Step 1: Scaffold failed: ${(result.errors || []).join(', ')}`);
      }
      return result;
    } catch (error) {
      logger.error(`[CapabilityExpander] ❌ Step 1: Scaffold error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Step 2: Register config schema in AgentConfigManager.
   */
  async _stepRegisterConfig(agentId, configSchemaData) {
    logger.info(`[CapabilityExpander] Step 2: Registering config schema...`);
    
    if (!this.configManager) {
      logger.warn(`[CapabilityExpander] ⚠️ Step 2: No ConfigManager — skipping`);
      return { skipped: true, reason: 'no-config-manager' };
    }

    if (!configSchemaData || !configSchemaData.fields || configSchemaData.fields.length === 0) {
      logger.info(`[CapabilityExpander] ℹ️ Step 2: No config fields — skipping`);
      return { skipped: true, reason: 'no-config-fields' };
    }

    try {
      const result = await this.configManager.registerSchema(agentId, configSchemaData);
      logger.info(`[CapabilityExpander] ✅ Step 2: Config schema registered (${result.fieldCount} fields)`);
      return { success: true, fieldCount: result.fieldCount };
    } catch (error) {
      logger.error(`[CapabilityExpander] ❌ Step 2: Config registration failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Step 3: Build custom Docker image via ProvisioningManager.
   */
  async _stepBuildCustomImage(manifest) {
    logger.info(`[CapabilityExpander] Step 3: Building custom Docker image...`);

    if (!this.provisioningManager) {
      logger.warn(`[CapabilityExpander] ⚠️ Step 3: No ProvisioningManager — skipping custom build`);
      return { skipped: true, reason: 'no-provisioning-manager' };
    }

    try {
      const result = await this.provisioningManager.provisionAgent(manifest);
      if (result.success) {
        logger.info(`[CapabilityExpander] ✅ Step 3: Custom image built and deployed`);
      } else {
        logger.warn(`[CapabilityExpander] ⚠️ Step 3: Custom build issue: ${result.error}`);
      }
      return result;
    } catch (error) {
      logger.error(`[CapabilityExpander] ❌ Step 3: Custom build failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Step 4: Deploy via ComposeGenerator (or ProvisioningManager for custom builds).
   */
  async _stepDeploy(agentId, spec, manifest) {
    logger.info(`[CapabilityExpander] Step 4: Deploying agent...`);

    // If custom build already deployed via ProvisioningManager, skip compose
    if (manifest.image_type === 'custom' && this.provisioningManager) {
      logger.info(`[CapabilityExpander] ℹ️ Step 4: Already deployed via ProvisioningManager`);
      return { skipped: true, reason: 'deployed-via-provisioning-manager' };
    }

    if (!this.composeGenerator) {
      // Try lazy-loading
      try {
        const ComposeGenerator = require('./ComposeGenerator');
        this.composeGenerator = new ComposeGenerator();
      } catch (e) {
        logger.warn(`[CapabilityExpander] ⚠️ Step 4: No ComposeGenerator — skipping deploy`);
        return { skipped: true, reason: 'no-compose-generator' };
      }
    }

    try {
      const result = await this.composeGenerator.deployAgent(agentId);
      if (result.success) {
        logger.info(`[CapabilityExpander] ✅ Step 4: Agent deployed via ComposeGenerator`);
      } else {
        logger.warn(`[CapabilityExpander] ⚠️ Step 4: Deploy issue: ${result.error || result.message}`);
      }
      return { success: result.success, details: result };
    } catch (error) {
      logger.error(`[CapabilityExpander] ❌ Step 4: Deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Step 5: Register tool via DynamicToolManager.
   */
  async _stepRegisterTool(toolRegistration) {
    logger.info(`[CapabilityExpander] Step 5: Registering tool...`);

    if (!this.dynamicToolManager) {
      logger.warn(`[CapabilityExpander] ⚠️ Step 5: No DynamicToolManager — skipping`);
      return { skipped: true, reason: 'no-dynamic-tool-manager' };
    }

    try {
      const result = await this.dynamicToolManager.registerTool(toolRegistration);
      if (result.success) {
        logger.info(`[CapabilityExpander] ✅ Step 5: Tool "${toolRegistration.toolName}" registered`);
      } else {
        logger.warn(`[CapabilityExpander] ⚠️ Step 5: Tool registration issue: ${result.error}`);
      }
      return result;
    } catch (error) {
      logger.error(`[CapabilityExpander] ❌ Step 5: Tool registration failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Estimate pipeline steps for preview.
   */
  _estimateSteps(spec) {
    const steps = ['scaffold', 'register-config'];
    if (spec.npmDependencies && spec.npmDependencies.length > 0) {
      steps.push('build-custom-image');
    }
    steps.push('deploy', 'register-tool');
    return steps;
  }

  /**
   * Finalize pipeline result with timing.
   */
  _finalizeResult(pipeline, startTime) {
    pipeline.duration = Date.now() - startTime;
    pipeline.completedAt = new Date().toISOString();

    const statusEmoji = pipeline.status === 'completed' ? '✅' :
                        pipeline.status === 'partial' ? '⚠️' : '❌';

    logger.info(`[CapabilityExpander] ${statusEmoji} Pipeline ${pipeline.status} for ${pipeline.agentId} (${pipeline.duration}ms)`);

    return pipeline;
  }
}

module.exports = CapabilityExpander;
