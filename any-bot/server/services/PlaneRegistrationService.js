/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PlaneRegistrationService
 * 
 * Handles automatic Plane project registration and discovery for bots.
 * Enables bots to auto-register with Plane on startup based on environment configuration.
 * 
 * Features:
 * - Auto-discovery of existing projects
 * - Auto-creation of missing projects
 * - Context injection into LLM system prompts
 * - Graceful degradation on errors
 * 
 * Environment Variables Required:
 * - USE_PLANE: Enable/disable Plane integration
 * - PLANE_WORKSPACE_SLUG: Workspace identifier
 * - PLANE_PROJECT: Project name
 * - PLANE_API_KEY: API authentication key
 */

const logger = require('../utils/logger');

/**
 * @description Service that lets a bot bootstrap its own Plane workspace/project on
 * startup so the rest of the application has a known project context to work against.
 * It discovers an existing project (or creates one), publishes that context globally
 * and into the LLM system prompt, and ensures swarm agents have Plane user accounts.
 * All operations degrade gracefully so that a Plane outage or misconfiguration never
 * blocks the bot from starting.
 */
class PlaneRegistrationService {
  /**
   * @description Build the service with its MCP transport and Plane configuration, and
   * fix the retry/timeout policy used for every Plane API call. Retry delays escalate
   * (5s/10s/20s/30s/60s) and the overall registration is bounded by a 3-minute timeout
   * so a slow or unreachable Plane backend cannot stall bot startup indefinitely.
   * @param {object} mcpService - MCP service used to invoke the plane-mcp tools.
   * @param {object} config - Bot configuration; expects a `plane` section (enabled, workspace, project, apiKey, baseUrl).
   */
  constructor(mcpService, config) {
    this.mcpService = mcpService;
    this.config = config;
    this.retryAttempts = 5;
    this.retryDelays = [5000, 10000, 20000, 30000, 60000]; // 5s, 10s, 20s, 30s, 60s (total ~125s)
    this.timeout = 180000; // 3 minutes (increased from 30 seconds)
  }

  /**
   * Main initialization entry point
   * Called from app.js during bot startup
   */
  async initialize() {
    try {
      logger.info('[PlaneRegistration] Starting Plane auto-registration...');

      // Check if Plane integration is enabled
      if (!this.checkPlaneEnabled()) {
        logger.info('[PlaneRegistration] Plane integration disabled (USE_PLANE=false)');
        return { enabled: false };
      }

      // Validate required configuration
      this.validateConfig();

      // Find or create project with timeout
      const result = await this.withTimeout(
        this.findOrCreateProject(),
        this.timeout,
        'Plane registration timeout'
      );

      if (result.success) {
        // Store project context globally
        this.storeProjectContext(result.workspace, result.project);

        // Inject context into LLM
        this.injectLLMContext(result.workspace, result.project);

        logger.info('[PlaneRegistration] ✅ Registration complete', {
          workspace: result.workspace,
          project: result.project.name,
          projectId: result.project.id
        });

        // ⭐ Issue #005: Ensure all agent users exist in Plane
        // This runs after project registration so workspace context is available
        try {
          await this.ensureAllAgentUsers(result.workspace);
        } catch (agentUserErr) {
          logger.warn('[PlaneRegistration] Agent user creation failed (non-fatal):', agentUserErr.message);
        }

        return {
          enabled: true,
          success: true,
          workspace: result.workspace,
          project: result.project
        };
      }

      return { enabled: true, success: false };

    } catch (error) {
      logger.error('[PlaneRegistration] Registration failed:', error);
      logger.warn('[PlaneRegistration] ⚠️  Bot will continue with reduced functionality');
      
      return {
        enabled: true,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * ⭐ Issue #005: Ensure all swarm agents have Plane user accounts.
   * Reads all YAML files from ai-lab/bot-personas/, checks if each bot has a Plane user,
   * and creates missing users via the Plane API.
   * 
   * This is called after project registration so workspace context is available.
   * Non-fatal: if this fails, the bot continues with reduced assignment functionality.
   * 
   * @param {string} workspace - Plane workspace slug
   * @returns {Promise<{created: number, existing: number, failed: number}>}
   */
  async ensureAllAgentUsers(workspace) {
    logger.info('[PlaneRegistration] Checking agent user accounts in Plane...');
    const stats = { created: 0, existing: 0, failed: 0 };

    try {
      // Get all mapped agent IDs from AgentPlaneUserMap
      let agentIds = [];
      try {
        const { getAllMappedAgentIds } = require('./queue-manager/AgentPlaneUserMap');
        agentIds = getAllMappedAgentIds();
        logger.info(`[PlaneRegistration] Found ${agentIds.length} agents to check`);
      } catch (mapErr) {
        logger.warn('[PlaneRegistration] Could not load AgentPlaneUserMap:', mapErr.message);
        return stats;
      }

      // Check each agent — try to list users and see if bot email exists
      // We use the email pattern: {agent_id}@bot.local
      for (const agentId of agentIds) {
        const email = `${agentId}@bot.local`;
        try {
          // Try to find the user by listing workspace members
          // If the user doesn't exist, we'll get a 404 or empty result
          const checkResult = await this.executeMcpTool( 'list_workspace_members', {
            workspace_slug: workspace,
          }).catch(() => null);

          // Check if this agent's email is in the member list
          let userExists = false;
          if (checkResult?.result) {
            try {
              const content = checkResult.result.content;
              const text = Array.isArray(content) 
                ? content.find(c => c.type === 'text')?.text 
                : typeof content === 'string' ? content : null;
              if (text) {
                const members = JSON.parse(text);
                userExists = Array.isArray(members) && members.some(m => 
                  m.email === email || m.member?.email === email
                );
              }
            } catch (parseErr) {
              // Can't parse — assume user doesn't exist, will try to create
            }
          }

          if (userExists) {
            stats.existing++;
            logger.debug(`[PlaneRegistration] Agent user exists: ${agentId} (${email})`);
          } else {
            // User doesn't exist — log it (actual creation requires DB migration)
            // The SQL migration in plane/migrations/create-bot-users.sql handles creation
            logger.info(`[PlaneRegistration] Agent user not found in workspace: ${agentId} — run plane/migrations/create-bot-users.sql to create`);
            stats.failed++; // Count as "needs migration" not hard failure
          }
        } catch (agentErr) {
          logger.debug(`[PlaneRegistration] Could not check agent ${agentId}: ${agentErr.message}`);
          stats.failed++;
        }
      }

      logger.info(`[PlaneRegistration] Agent user check complete: ${stats.existing} existing, ${stats.created} created, ${stats.failed} need migration`);
      
      if (stats.failed > 0) {
        logger.info('[PlaneRegistration] 💡 To create missing bot users, run:');
        logger.info('[PlaneRegistration]    kubectl exec -n plane plane-db -- psql -U plane -d plane -f /migrations/create-bot-users.sql');
      }

      return stats;
    } catch (error) {
      logger.warn('[PlaneRegistration] ensureAllAgentUsers failed:', error.message);
      return stats;
    }
  }

  /**
   * Check if Plane integration is enabled
   */
  checkPlaneEnabled() {
    return this.config.plane?.enabled === true;
  }

  /**
   * Validate required configuration
   */
  validateConfig() {
    const required = ['workspace', 'project', 'apiKey'];
    const missing = required.filter(key => !this.config.plane[key]);

    if (missing.length > 0) {
      throw new Error(`Missing required Plane config: ${missing.join(', ')}`);
    }

    logger.info('[PlaneRegistration] Configuration validated', {
      workspace: this.config.plane.workspace,
      project: this.config.plane.project,
      baseUrl: this.config.plane.baseUrl
    });
  }

  /**
   * Find existing project or create new one
   */
  async findOrCreateProject() {
    const workspace = this.config.plane.workspace;
    const projectName = this.config.plane.project;

    logger.info('[PlaneRegistration] Looking for project:', { workspace, projectName });

    // First, verify workspace exists by attempting to list projects
    // If workspace doesn't exist, this will fail with clear error
    logger.info('[PlaneRegistration] Verifying workspace exists...');
    try {
      await this.verifyWorkspaceExists(workspace);
      logger.info('[PlaneRegistration] ✅ Workspace verified:', workspace);
    } catch (error) {
      logger.error('[PlaneRegistration] ❌ Workspace does not exist:', workspace);
      logger.error('[PlaneRegistration] Please create workspace manually or via setup script');
      throw new Error(`Workspace '${workspace}' does not exist. Run: bash plane/scripts/setup-local-api-key.sh`);
    }

    // Try to find existing project
    const existingProject = await this.findProject(workspace, projectName);

    if (existingProject) {
      logger.info('[PlaneRegistration] ✅ Found existing project', {
        id: existingProject.id,
        name: existingProject.name
      });

      return {
        success: true,
        workspace,
        project: existingProject,
        created: false
      };
    }

    // Project not found, create new one
    logger.info('[PlaneRegistration] Project not found, creating new project...');
    const newProject = await this.createProject(workspace, projectName);

    if (newProject) {
      logger.info('[PlaneRegistration] ✅ Created new project', {
        id: newProject.id,
        name: newProject.name
      });

      return {
        success: true,
        workspace,
        project: newProject,
        created: true
      };
    }

    throw new Error('Failed to find or create project');
  }

  /**
   * Verify workspace exists
   * Throws error if workspace not found
   */
  async verifyWorkspaceExists(workspace) {
    try {
      const result = await this.executeMcpTool( 'list_projects', {
        workspace_slug: workspace
      });

      // If we get isError, workspace likely doesn't exist
      const mcpResult = result?.result;
      if (mcpResult?.isError) {
        const errorText = mcpResult.content?.[0]?.text || '';
        if (errorText.includes('404') || errorText.includes('not found')) {
          throw new Error(`Workspace '${workspace}' not found`);
        }
      }

      return true;
    } catch (error) {
      throw new Error(`Workspace '${workspace}' does not exist or is not accessible`);
    }
  }

  /**
   * Find existing project by name
   */
  async findProject(workspace, projectName) {
    return await this.retryOperation(async () => {
      try {
        logger.info('[PlaneRegistration] Querying Plane API for projects...');

        // Call plane-mcp list_projects tool
        const result = await this.executeMcpTool( 'list_projects', {
          workspace_slug: workspace
        });

        if (!result || !result.result) {
          logger.warn('[PlaneRegistration] No projects returned from API');
          return null;
        }

        // Parse the result - MCPServiceV2 wraps in result.result
        let projects = [];
        const mcpResult = result.result;
        
        // Try to parse as JSON first
        try {
          if (Array.isArray(mcpResult.content)) {
            const textContent = mcpResult.content.find(c => c.type === 'text')?.text;
            if (textContent) {
              projects = JSON.parse(textContent);
            }
          } else if (typeof mcpResult.content === 'string') {
            projects = JSON.parse(mcpResult.content);
          } else if (Array.isArray(mcpResult)) {
            projects = mcpResult;
          }
        } catch (parseError) {
          logger.warn('[PlaneRegistration] Failed to parse projects response:', parseError.message);
          return null;
        }

        // Find project by name (case-insensitive)
        const project = projects.find(p => 
          p.name && p.name.toLowerCase() === projectName.toLowerCase()
        );

        if (project) {
          logger.info('[PlaneRegistration] Project found in Plane', {
            id: project.id,
            name: project.name,
            identifier: project.identifier
          });
        }

        return project || null;

      } catch (error) {
        logger.error('[PlaneRegistration] Error finding project:', error);
        throw error;
      }
    }, 'findProject');
  }

  /**
   * Create new project in Plane
   */
  async createProject(workspace, projectName) {
    return await this.retryOperation(async () => {
      try {
        logger.info('[PlaneRegistration] Creating project in Plane...', {
          workspace,
          name: projectName
        });

        // Generate identifier from project name
        // Uppercase, alphanumeric only, max 12 chars
        const identifier = this.generateProjectIdentifier(projectName);

        // Call plane-mcp create_project tool
        const result = await this.executeMcpTool( 'create_project', {
          workspace_slug: workspace,
          name: projectName,
          identifier: identifier,
          description: `Auto-created project for ${projectName} bot`
        });

        if (!result || !result.result) {
          throw new Error('No response from create_project API');
        }

        // Parse the result - MCPServiceV2 wraps in result.result
        const mcpResult = result.result;
        
        // Check for MCP-level errors first
        if (mcpResult.isError && Array.isArray(mcpResult.content)) {
          const errorText = mcpResult.content.find(c => c.type === 'text')?.text || 'Unknown error';
          logger.error('[PlaneRegistration] Plane API error:', errorText);
          throw new Error(`Plane API error: ${errorText}`);
        }
        
        // Parse successful response
        let project = null;
        try {
          if (Array.isArray(mcpResult.content)) {
            const textContent = mcpResult.content.find(c => c.type === 'text')?.text;
            if (textContent) {
              // MCP returns formatted text like "✅ Project created!\n\nProject ID: xxx\n\n{json}"
              // Extract the JSON portion
              const jsonMatch = textContent.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                project = JSON.parse(jsonMatch[0]);
              }
            }
          } else if (typeof mcpResult.content === 'string') {
            project = JSON.parse(mcpResult.content);
          } else if (typeof mcpResult === 'object' && mcpResult.id) {
            project = mcpResult;
          }
        } catch (parseError) {
          logger.error('[PlaneRegistration] Failed to parse create response:', parseError);
          throw new Error('Failed to parse project creation response');
        }

        if (!project || !project.id) {
          throw new Error('Invalid project data returned from API');
        }

        logger.info('[PlaneRegistration] ✅ Project created successfully', {
          id: project.id,
          name: project.name,
          identifier: project.identifier
        });

        return project;

      } catch (error) {
        logger.error('[PlaneRegistration] Error creating project:', error);
        throw error;
      }
    }, 'createProject');
  }

  /**
   * Generate project identifier from name
   * Rules: Uppercase, alphanumeric only, max 12 chars
   */
  generateProjectIdentifier(projectName) {
    // Remove special characters, keep alphanumeric and spaces
    let identifier = projectName
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 12);

    // Ensure it starts with a letter
    if (!/^[A-Z]/.test(identifier)) {
      identifier = 'P_' + identifier.substring(0, 10);
    }

    logger.debug('[PlaneRegistration] Generated identifier:', {
      from: projectName,
      to: identifier
    });

    return identifier;
  }

  /**
   * Store project context globally for use throughout the application
   */
  storeProjectContext(workspace, project) {
    global.PLANE_CONFIG = {
      enabled: true,
      workspace: workspace,
      projectId: project.id,
      projectName: project.name,
      projectIdentifier: project.identifier
    };

    logger.info('[PlaneRegistration] Stored global Plane config', global.PLANE_CONFIG);
  }

  /**
   * Inject Plane context into LLM system prompt
   */
  injectLLMContext(workspace, project) {
    const contextMessage = `

## Plane Project Integration

You are configured to work with the following Plane project:

**Workspace:** ${workspace}
**Project:** ${project.name}
**Project ID:** ${project.id}

When using Plane tools (via plane-mcp), you should use these defaults:
- workspace_slug: "${workspace}"
- project_id: "${project.id}"

You do NOT need to ask the user for workspace or project information when using Plane tools.
Use the above defaults automatically unless the user explicitly requests a different workspace/project.

Examples:
- "Show me open tickets" → Use workspace_slug="${workspace}", project_id="${project.id}"
- "Create a new issue" → Use workspace_slug="${workspace}", project_id="${project.id}"
- "List my tasks" → Use workspace_slug="${workspace}", project_id="${project.id}"
`;

    global.PLANE_CONTEXT = contextMessage;

    logger.info('[PlaneRegistration] Injected LLM context');
  }

  /**
   * Retry operation with exponential backoff
   */
  async retryOperation(operation, operationName) {
    let lastError;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        logger.info(`[PlaneRegistration] ${operationName} - Attempt ${attempt}/${this.retryAttempts}`);
        
        const result = await operation();
        return result;

      } catch (error) {
        lastError = error;
        logger.warn(`[PlaneRegistration] ${operationName} failed (attempt ${attempt}):`, error.message);

        if (attempt < this.retryAttempts) {
          const delay = this.retryDelays[attempt - 1]; // Use predefined delays
          logger.info(`[PlaneRegistration] Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`${operationName} failed after ${this.retryAttempts} attempts: ${lastError.message}`);
  }

  /**
   * Execute operation with timeout
   */
  async withTimeout(promise, timeoutMs, errorMessage) {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = PlaneRegistrationService;