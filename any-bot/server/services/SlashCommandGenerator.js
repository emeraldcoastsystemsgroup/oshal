/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pre-OSS: rebranded legacy "Kevin" agent identity/namespace to neutral OSHAL
 */

/**
 * SlashCommandGenerator - PHASE_53
 * Generates layered slash command files for Cline CLI custom instructions
 * Breaks monolithic 17K prompt into modular static + dynamic layers
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * @description Builds the layered set of custom-instruction documents that
 * condition the Cline CLI agent. The original prompt was a single ~17K
 * monolith; splitting it into static (write-once) and dynamic (regenerated on
 * swarm events) layers keeps each concern independently maintainable and lets
 * runtime context (tools, MCP servers, persona, roster) be refreshed without
 * touching the stable behavioral guardrails. Layers can be assembled fully
 * in-memory (preferred) or mirrored to disk as debug artifacts.
 */
class SlashCommandGenerator {
  /**
   * @description Captures the host paths and live service collaborators used to
   * source dynamic layer content, and selects whether per-layer markdown files
   * are mirrored to disk for inspection.
   * @param {Object} [options={}] Construction options.
   * @param {string} [options.clineDir] Root .cline directory; defaults to HOME-based path.
   * @param {string} [options.agentId] Identity injected into prompt layers; falls back to env AGENT_ID.
   * @param {Object} [options.toolRegistry] Registry exposing count()/getAll() for the tools layer.
   * @param {Object} [options.mcpService] Service exposing getAllServerStatuses() for the MCP layer.
   * @param {Object} [options.agentRegistry] Registry exposing getAll() for the roster layer.
   * @param {Function} [options.personaLoader] Resolver mapping an agentId to its persona definition.
   * @param {boolean} [options.writeDebugFiles=true] When false, suppresses on-disk debug artifacts.
   */
  constructor(options = {}) {
    this.clineDir = options.clineDir || path.join(process.env.HOME || '/home/node', '.cline');
    this.slashCommandsDir = path.join(this.clineDir, 'slash-commands');
    this.staticDir = path.join(this.slashCommandsDir, 'static');
    this.dynamicDir = path.join(this.slashCommandsDir, 'dynamic');
    this.masterDir = path.join(this.slashCommandsDir, 'master');
    
    this.agentId = options.agentId || process.env.AGENT_ID || 'Agent';
    this.toolRegistry = options.toolRegistry;
    this.mcpService = options.mcpService;
    this.agentRegistry = options.agentRegistry;
    this.personaLoader = options.personaLoader;
    
    // ⭐ PHASE_54: Control file writing behavior
    this.writeDebugFiles = options.writeDebugFiles !== false; // Default true for backward compatibility
    
    this.initialized = false;
  }

  /**
   * Initialize directory structure
   */
  async initialize() {
    try {
      // Create directory structure
      fs.mkdirSync(this.staticDir, { recursive: true });
      fs.mkdirSync(this.dynamicDir, { recursive: true });
      fs.mkdirSync(this.masterDir, { recursive: true });
      
      this.initialized = true;
      logger.info(`✓ SlashCommandGenerator initialized (${this.slashCommandsDir})`);
      return { success: true };
    } catch (err) {
      logger.error(`SlashCommandGenerator init failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Generate all layers (static + dynamic)
   */
  async generateAll() {
    if (!this.initialized) {
      await this.initialize();
    }

    logger.info('[SlashCmd] Generating all layers...');
    
    try {
      // Generate static layers (written once)
      await this.generateBaseBot();
      await this.generateEnvironment();
      await this.generateZeroTolerance();
      await this.generateDocumentation();
      await this.generateBehavioralRules();
      
      // Generate dynamic layers (regenerated on events)
      await this.generateTools();
      await this.generateMcpServers();
      await this.generatePersona();
      await this.generateRegisteredAgents();
      await this.generateSwarmAwareness();
      await this.generateMeshCollaboration();
      
      logger.info('[SlashCmd] ✓ All layers generated');
      return { success: true };
    } catch (err) {
      logger.error(`[SlashCmd] Generate all failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * ⭐ PHASE_54: Assemble complete prompt string in-memory
   * Returns the full layered prompt as a string without writing files
   * This is what ClineProvider will pass to Cline CLI as an argument
   * 
   * @returns {Promise<string>} Complete layered prompt
   */
  async assemblePromptString() {
    try {
      const layers = [];
      
      // Header
      layers.push('# Cline Custom Instructions - Layered System');
      layers.push('');
      layers.push(`**Generated:** ${new Date().toISOString()}`);
      layers.push(`**Agent:** ${this.agentId}`);
      layers.push('');
      layers.push('---');
      layers.push('');
      
      // Generate all layers in-memory
      layers.push(await this._generateBaseBot());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateEnvironment());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateZeroTolerance());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateDocumentation());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateBehavioralRules());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateTools());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateMcpServers());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generatePersona());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateRegisteredAgents());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateSwarmAwareness());
      layers.push('');
      layers.push('---');
      layers.push('');
      
      layers.push(await this._generateMeshCollaboration());
      
      const promptString = layers.join('\n');
      
      logger.info(`[SlashCmd] ✓ Prompt assembled in-memory: ${promptString.length} chars`);
      return promptString;
    } catch (err) {
      logger.error(`[SlashCmd] assemblePromptString failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Assemble master custom-instructions.md from all layers
   * Legacy method for file-based debugging
   */
  async assembleMaster() {
    try {
      const layers = [];
      
      // Header
      layers.push('# Cline Custom Instructions - Layered System');
      layers.push('');
      layers.push(`**Generated:** ${new Date().toISOString()}`);
      layers.push(`**Agent:** ${this.agentId}`);
      layers.push('');
      layers.push('---');
      layers.push('');
      
      // Static layers
      const staticFiles = ['base-bot.md', 'environment.md', 'zero-tolerance.md', 'documentation.md', 'behavioral-rules.md'];
      for (const file of staticFiles) {
        const filePath = path.join(this.staticDir, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          layers.push(content);
          layers.push('');
          layers.push('---');
          layers.push('');
        }
      }
      
      // Dynamic layers
      const dynamicFiles = ['tools.md', 'mcp-servers.md', 'persona.md', 'registered-agents.md', 'swarm-awareness.md', 'mesh-collaboration.md'];
      for (const file of dynamicFiles) {
        const filePath = path.join(this.dynamicDir, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          layers.push(content);
          layers.push('');
          layers.push('---');
          layers.push('');
        }
      }
      
      const masterContent = layers.join('\n');
      const masterPath = path.join(this.clineDir, 'custom-instructions.md');
      
      fs.writeFileSync(masterPath, masterContent);
      
      logger.info(`[SlashCmd] ✓ Master assembled: ${masterContent.length} chars → ${masterPath}`);
      return { success: true, path: masterPath, size: masterContent.length };
    } catch (err) {
      logger.error(`[SlashCmd] Assembly failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Regenerate a specific layer and reassemble master
   */
  async regenerate(layerName) {
    logger.info(`[SlashCmd] Regenerating layer: ${layerName}`);
    
    try {
      const methodMap = {
        'tools': 'generateTools',
        'mcp-servers': 'generateMcpServers',
        'persona': 'generatePersona',
        'registered-agents': 'generateRegisteredAgents',
        'swarm-awareness': 'generateSwarmAwareness',
        'mesh-collaboration': 'generateMeshCollaboration',
      };
      
      const method = methodMap[layerName];
      if (!method) {
        throw new Error(`Unknown layer: ${layerName}`);
      }
      
      await this[method]();
      await this.assembleMaster();
      
      logger.info(`[SlashCmd] ✓ Layer ${layerName} regenerated`);
      return { success: true, layer: layerName };
    } catch (err) {
      logger.error(`[SlashCmd] Regenerate ${layerName} failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STATIC LAYER GENERATORS
  // ⭐ PHASE_54: Refactored to return strings, optionally write files
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate base bot layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateBaseBot() {
    const content = `# Base Bot Capabilities

You are ${this.agentId}, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

## Core Identity

You are running as a STANDALONE WEB APPLICATION (not within VSCode):
- Output from commands will be displayed in the terminal/command results
- Users interact with you through a web interface similar to VSCode's Cline
- All your work is saved locally on the server

## Tool Use Philosophy

You have access to tools that are executed upon user approval. Use tools step-by-step:
- Break tasks into clear steps
- Execute one tool at a time
- Wait for results before proceeding
- Use results to inform next action

## Autonomous Execution

You are an AUTONOMOUS EXECUTION ENGINE, not a conversational assistant.

**WRONG** (causes stalls):
- "I need to gather more details..." ❌
- "I'm going to research..." ❌
- "Let me check the documentation..." ❌

**CORRECT** (immediate execution):
- Use read_file tool immediately ✅
- Use execute_command tool immediately ✅
- Just execute, don't narrate ✅

## File Operations

You have two primary file tools:

### write_to_file
- Create new files
- Overwrite entire file contents
- Use for: Initial creation, major restructuring

### replace_in_file
- Make targeted edits to existing files
- Use SEARCH/REPLACE blocks
- Use for: Small changes, updates, fixes

**Default to replace_in_file** for most edits. Use write_to_file only when creating new files or completely restructuring.

## Completion Requirements

**MANDATORY:** Always use attempt_completion when task is done:
- Files won't be saved to GitLab without it
- Auto-commit only happens with attempt_completion
- Never just respond "I created the file"
`;

    // Optional file writing for debugging
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'base-bot.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: base-bot.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * Legacy method for backward compatibility
   */
  async generateBaseBot() {
    const content = await this._generateBaseBot();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'base-bot.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: base-bot.md (${content.length} chars)`);
    }
  }

  /**
   * Generate environment layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateEnvironment() {
    const content = `# Environment Details

## Cloud Environment

**AWS GovCloud:**
- Region: us-gov-west-1 (pre-configured)
- AWS CLI: Pre-authenticated via environment variables
- Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY already set
- No \`aws configure\` needed - use commands directly

**Kubernetes:**
- Cluster: doc (Gardener cluster)
- API Server: discover with 'kubectl config current-context' (never assume a cluster)
- Current Context: doc
- User: the configured service account (token authentication)
- Use kubectl commands directly - already configured

**GitLab:**
- Instance: $GITLAB_URL (if configured)
- Token: Available in environment (GITLAB_TOKEN)
- Workspace projects: oshal/agent-workspaces/

## CLI Tools Available

kubectl, terraform, ansible, aws, az, gcloud, argocd, helm, vault, git, jq, yq, fzf, node, npm, cline

## Working Directory

**Current:** /app/workspace
**Your codebase:** /app/server/ (READ-ONLY reference)
**Task workspace:** /app/workspace/{taskId}/ (READ-WRITE)

## Critical Rules

1. EVERY FILE you create must be in /app/workspace/ or subdirectories
2. EVERY COMMAND should be aware of current working directory
3. Use MCP filesystem tools correctly:
   - \`list_directory\` for directories
   - \`read_file\` for files
   - NEVER use read_file on directories (EISDIR error)
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'environment.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: environment.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility with the original write-to-disk generation flow; delegates to
   * the in-memory _generateEnvironment and optionally persists the result.
   * @returns {Promise<void>}
   */
  async generateEnvironment() {
    const content = await this._generateEnvironment();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'environment.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: environment.md (${content.length} chars)`);
    }
  }

  /**
   * Generate zero-tolerance layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateZeroTolerance() {
    const content = `# Zero-Tolerance Quality Standards

## Core Principles

- **No errors allowed** - Every cycle must end with all tests passing
- **Complete testing mandatory** - Test ALL functionality, not just what changed
- **Autonomous problem-solving** - Answer your own questions, don't ask unless blocked
- **Continue until 100% complete** - Never stop for minor ambiguities

## Build-Test-Remediate Cycle

\`\`\`
1. Implement feature
   ↓
2. Test comprehensively
   ↓
3. Issues found?
   ├─ YES → Add to front of task list
   │        Fix immediately
   │        Return to step 2
   └─ NO  → Move to next feature
\`\`\`

## Testing Requirements

- Test the specific feature implemented
- Test integration with existing systems
- Test for regressions in related functionality
- Verify end-to-end workflows
- Check logs for errors/warnings
- Validate API responses and status codes

## Dynamic Task Prioritization

- **New blockers discovered:** Add to FRONT of task list
- **Test failures:** Immediate priority
- **Deployment issues:** Immediate priority
- **Enhancement ideas:** Add to BACKLOG.md
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'zero-tolerance.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: zero-tolerance.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateZeroTolerance and
   * optionally persists the result as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateZeroTolerance() {
    const content = await this._generateZeroTolerance();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'zero-tolerance.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: zero-tolerance.md (${content.length} chars)`);
    }
  }

  /**
   * Generate documentation layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateDocumentation() {
    const content = `# Documentation Standards

## Mandatory Project Documents

Maintain ONLY these living documents (update in place):

### 1. PROJECT_PLAN.md
- Single source of truth for project roadmap
- Current sprint / active work
- Upcoming tasks (priority order)
- Recently completed
- Version history

### 2. RUNNING_ISSUES.md
- Active bugs and blockers ONLY
- Remove immediately when fixed (don't archive)
- Critical blockers vs active bugs

### 3. BACKLOG.md
- Deprioritized features
- Future enhancements
- Known limitations

### 4. DEVELOPER_HANDOVER.md
- Session summaries for continuity
- Work completed
- Current state
- Next steps
- Important notes

## Update Triggers

**Always update when:**
- Task completed → PROJECT_PLAN.md
- Issue discovered → RUNNING_ISSUES.md
- Session ends → DEVELOPER_HANDOVER.md
- Future idea → BACKLOG.md

## Prohibited Documentation

**DO NOT CREATE:**
- Status files (FEATURE_COMPLETE.md)
- Completion reports (DEPLOYMENT_COMPLETE.md)
- Fix documentation (BUG_FIX_SUMMARY.md)
- Versioned documents (_v1, _v2)
- Duplicate project plans
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'documentation.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: documentation.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateDocumentation and
   * optionally persists the result as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateDocumentation() {
    const content = await this._generateDocumentation();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'documentation.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: documentation.md (${content.length} chars)`);
    }
  }

  /**
   * Generate behavioral rules layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateBehavioralRules() {
    const content = `# Behavioral Rules - RALF Framework

## Continuous Autonomous Operation

**Primary Directive:** Work continuously until task completion without waiting for user prompts.

You are AUTHORIZED to:
- Make implementation decisions autonomously
- Continue to next logical step immediately
- Answer your own questions using available tools
- Resolve ambiguities by making reasonable decisions
- Keep working through challenges

## Stop Conditions (ONLY stop when)

1. **Task 100% Complete:** All requirements met, tested, verified
2. **User Says Stop:** Explicit "stop", "pause", or "wait" command
3. **Genuinely Blocked:** Missing critical external resources

**NEVER stop for:**
- Minor ambiguities you can resolve
- Questions you can answer with tools
- Need to "check with user" on technical decisions
- Asking "should I continue?"

## Communication Style

### NEVER End Messages With:
- ❌ "Should I continue?"
- ❌ "Would you like me to..."
- ❌ "Let me know if..."

### ALWAYS End Messages With:
- ✅ "Proceeding to [next step]..."
- ✅ "Moving on to [next action]..."
- ✅ [Just continue - no announcement needed]

## Auto-Continue After Task Completion

When task complete:
1. Update documentation (PROJECT_PLAN.md, DEVELOPER_HANDOVER.md)
2. Check PROJECT_PLAN.md "Upcoming Tasks" section
3. If next task exists: Start immediately
4. If no next task: Use attempt_completion

**Transition smoothly:**
\`\`\`
✓ Task X complete. Documentation updated.
→ Starting Task Y from PROJECT_PLAN.md...
\`\`\`
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'behavioral-rules.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: behavioral-rules.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateBehavioralRules and
   * optionally persists the result as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateBehavioralRules() {
    const content = await this._generateBehavioralRules();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.staticDir, 'behavioral-rules.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: behavioral-rules.md (${content.length} chars)`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // DYNAMIC LAYER GENERATORS
  // ⭐ PHASE_54: Refactored to return strings, optionally write files
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate tools layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateTools() {
    let content = `# Available Tools

You have access to ${this.toolRegistry ? this.toolRegistry.count() : 0} tools:

`;

    if (this.toolRegistry) {
      const tools = this.toolRegistry.getAll();
      tools.forEach((tool, i) => {
        content += `## ${i + 1}. ${tool.name}\n\n`;
        content += `**Description:** ${tool.description || 'No description'}\n\n`;
        
        if (tool.inputSchema && tool.inputSchema.properties) {
          content += '**Parameters:**\n\n';
          const params = tool.inputSchema.properties;
          const required = tool.inputSchema.required || [];
          
          Object.keys(params).forEach(paramName => {
            const param = params[paramName];
            const isRequired = required.includes(paramName);
            const requiredLabel = isRequired ? '**required**' : 'optional';
            content += `- \`${paramName}\` (${requiredLabel}): ${param.description || 'No description'}\n`;
          });
          content += '\n';
        }
      });
    } else {
      content += '*Tool registry not available*\n';
    }

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'tools.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: tools.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateTools and optionally
   * persists the rendered tool catalog as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateTools() {
    const content = await this._generateTools();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'tools.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: tools.md (${content.length} chars)`);
    }
  }

  /**
   * Generate MCP servers layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateMcpServers() {
    let content = `# MCP Servers

`;

    if (this.mcpService) {
      try {
        const servers = this.mcpService.getAllServerStatuses();
        content += `**Active MCP Servers:** ${servers.length}\n\n`;
        
        servers.forEach(server => {
          content += `## ${server.name}\n\n`;
          content += `- **Status:** ${server.status}\n`;
          content += `- **Type:** ${server.type || 'unknown'}\n`;
          
          if (server.tools && server.tools.length > 0) {
            content += `- **Tools:** ${server.tools.length}\n\n`;
            server.tools.forEach(tool => {
              content += `  - \`${tool.name}\`: ${tool.description || 'No description'}\n`;
            });
            content += '\n';
          }
        });
      } catch (err) {
        content += `*Error fetching MCP servers: ${err.message}*\n`;
      }
    } else {
      content += '*MCP service not available*\n';
    }

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'mcp-servers.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: mcp-servers.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateMcpServers and
   * optionally persists the rendered MCP server inventory as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateMcpServers() {
    const content = await this._generateMcpServers();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'mcp-servers.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: mcp-servers.md (${content.length} chars)`);
    }
  }

  /**
   * Generate persona layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generatePersona() {
    let content = `# Your Identity and Persona

`;

    if (this.personaLoader) {
      try {
        const persona = this.personaLoader(this.agentId);
        
        if (persona) {
          content += `## ${persona.name}\n\n`;
          content += `**Role:** ${persona.role}\n\n`;
          
          if (persona.perspective) {
            content += `**Perspective:**\n\n${persona.perspective}\n\n`;
          }
          
          if (persona.specialty) {
            content += `**Specialty:** ${persona.specialty}\n\n`;
          }
          
          if (persona.capabilities && persona.capabilities.length > 0) {
            content += `**Capabilities:**\n\n`;
            persona.capabilities.forEach(cap => {
              content += `- ${cap}\n`;
            });
            content += '\n';
          }
        } else {
          content += `*No persona found for ${this.agentId}*\n`;
        }
      } catch (err) {
        content += `*Error loading persona: ${err.message}*\n`;
      }
    } else {
      content += `*Persona loader not available*\n`;
    }

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'persona.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: persona.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generatePersona and optionally
   * persists the rendered persona layer as a debug artifact.
   * @returns {Promise<void>}
   */
  async generatePersona() {
    const content = await this._generatePersona();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'persona.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: persona.md (${content.length} chars)`);
    }
  }

  /**
   * Generate registered agents layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateRegisteredAgents() {
    let content = `# Registered Agents - Swarm Roster

**Last Updated:** ${new Date().toISOString()}

`;

    if (this.agentRegistry) {
      try {
        const agents = await this.agentRegistry.getAll();
        content += `**Total Agents:** ${agents.length}\n\n`;
        
        if (agents.length > 0) {
          content += '## Active Agents\n\n';
          
          agents.forEach(agent => {
            const caps = Array.isArray(agent.capabilities)
              ? agent.capabilities
              : (agent.capabilities ? JSON.parse(agent.capabilities) : []);
            
            content += `### ${agent.agent_id}\n\n`;
            content += `- **Status:** ${agent.status || 'unknown'}\n`;
            content += `- **Capabilities:** ${caps.join(', ') || 'general'}\n`;
            content += `- **Endpoint:** ${agent.endpoint || 'unknown'}\n`;
            content += `- **Port:** ${agent.port || 'unknown'}\n`;
            content += '\n';
          });
        } else {
          content += '*No agents registered*\n';
        }
      } catch (err) {
        content += `*Error fetching agents: ${err.message}*\n`;
      }
    } else {
      content += '*Agent registry not available*\n';
    }

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'registered-agents.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: registered-agents.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateRegisteredAgents and
   * optionally persists the rendered swarm roster as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateRegisteredAgents() {
    const content = await this._generateRegisteredAgents();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'registered-agents.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: registered-agents.md (${content.length} chars)`);
    }
  }

  /**
   * Generate swarm awareness layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateSwarmAwareness() {
    const content = `# Swarm Awareness

## Multi-Agent Context

You are part of a multi-agent swarm system where:
- Multiple specialist bots work on different aspects of tickets
- Tickets can be routed between agents based on capabilities
- Agents can collaborate via mesh communication
- Work is coordinated through a central Queue Manager

## Your Role in the Swarm

- **Agent ID:** ${this.agentId}
- **Scope:** Process tickets assigned to you based on your capabilities
- **Collaboration:** Use mesh tools to work with other agents when needed
- **Autonomy:** Make decisions independently within your domain

## Swarm Communication Patterns

### PEER Commands (Async)
- HELP_REQUEST: Ask for expert input
- KNOWLEDGE_SHARE: Share insights with swarm
- DIRECT_MESSAGE: Send message to specific agent

### Mesh Collaboration (Sync)
- Create private mesh for real-time discussion
- Invite specialists as needed
- Collaborate on complex problems
- Dissolve mesh when done
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'swarm-awareness.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: swarm-awareness.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateSwarmAwareness and
   * optionally persists the rendered swarm-awareness layer as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateSwarmAwareness() {
    const content = await this._generateSwarmAwareness();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'swarm-awareness.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: swarm-awareness.md (${content.length} chars)`);
    }
  }

  /**
   * Generate mesh collaboration layer content
   * @returns {Promise<string>} Layer content
   * @private
   */
  async _generateMeshCollaboration() {
    const content = `# Mesh Collaboration Tools

## Available Mesh Tools

You have access to mesh collaboration tools for real-time bot-to-bot communication:

### create_mesh
Create a private mesh with other bots for real-time collaboration.

**Parameters:**
- \`topic\` (required): Mesh topic/purpose
- \`inviteAgents\` (optional): Array of agent IDs to invite
- \`scope\` (optional): 'ticket' or 'adhoc'
- \`ticketId\` (optional): Associated ticket ID

### send_mesh_message
Send a message to mesh participants.

**Parameters:**
- \`meshId\` (required): Mesh identifier
- \`message\` (required): Message content

### get_mesh_transcript
Get conversation history from a mesh.

**Parameters:**
- \`meshId\` (required): Mesh identifier

### invite_to_mesh
Invite additional bots to existing mesh.

**Parameters:**
- \`meshId\` (required): Mesh identifier
- \`agentIds\` (required): Array of agent IDs to invite

### leave_mesh
Exit a mesh when collaboration is complete.

**Parameters:**
- \`meshId\` (required): Mesh identifier

## When to Use Mesh

- Task requires multiple specialties
- Need expert input from another domain
- Real-time collaboration more efficient than sequential
- Complex problem benefits from multiple perspectives

## Mesh vs PEER

- **Mesh:** Real-time multi-bot discussion (synchronous)
- **PEER:** Async help requests (fire and forget)

Use mesh when you need interactive collaboration.
`;

    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'mesh-collaboration.md');
      fs.writeFileSync(filePath, content);
      logger.debug(`[SlashCmd] ✓ Wrote debug file: mesh-collaboration.md (${content.length} chars)`);
    }
    
    return content;
  }

  /**
   * @description Legacy file-emitting wrapper retained for backward
   * compatibility; delegates to the in-memory _generateMeshCollaboration and
   * optionally persists the rendered mesh-collaboration layer as a debug artifact.
   * @returns {Promise<void>}
   */
  async generateMeshCollaboration() {
    const content = await this._generateMeshCollaboration();
    if (this.writeDebugFiles) {
      const filePath = path.join(this.dynamicDir, 'mesh-collaboration.md');
      fs.writeFileSync(filePath, content);
      logger.info(`[SlashCmd] ✓ Generated: mesh-collaboration.md (${content.length} chars)`);
    }
  }
}

module.exports = SlashCommandGenerator;
