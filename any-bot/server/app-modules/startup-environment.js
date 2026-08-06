/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): pre-database startup blocks (PHASE_54 provider log, workspace symlink, PHASE_15 Cline CLI setup, SlashCommandGenerator init)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: replace automatic Cline binary/auth/approval setup with non-secret plan-only compatibility state, empty legacy secret/MCP carriers, and a fail-closed wrapper.
 */

const path = require('path');
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * @description PHASE_54: log the LLM provider/model config at startup for test validation.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function logProviderStartupConfig(application) {
    // PHASE_54: Log LLM provider/model config at startup for test validation
    try {
      const fs = require('fs');
      const homeDir = process.env.HOME || '/home/node';
      const clineConfigPath = `${homeDir}/.cline/config.json`;
      if (fs.existsSync(clineConfigPath)) {
        const clineConfig = JSON.parse(fs.readFileSync(clineConfigPath, 'utf8'));
        logger.info(`[PHASE_54] LLM provider startup config: provider=${clineConfig.provider}, model=${clineConfig.model}`);
      } else {
        logger.warn('[PHASE_54] LLM provider startup config: ~/.cline/config.json not found');
      }
    } catch (e) {
      logger.warn(`[PHASE_54] Failed to log LLM provider startup config: ${e.message}`);
    }
}

/**
 * @description PHASE_54 SESSION_10: ensure /app/workspace is a symlink to /home/node/workspace (fixes 60+ hardcoded /app/workspace references; non-fatal on failure).
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function ensureWorkspaceSymlink(application) {
    // ═══════════════════════════════════════════════════════════
    // PHASE_54 SESSION_10: Workspace Path Symlink Fix
    // Creates symlink from /app/workspace → /home/node/workspace
    // This fixes 60+ hardcoded /app/workspace references in codebase
    // Root cause: Dockerfile creates /app/workspace as empty dir, but
    // docker-compose mounts the actual workspace to /home/node/workspace
    // ═══════════════════════════════════════════════════════════
    try {
      const fs = require('fs');
      const appWorkspace = '/app/workspace';
      const realWorkspace = '/home/node/workspace';
      
      // Ensure the real workspace exists
      if (!fs.existsSync(realWorkspace)) {
        fs.mkdirSync(realWorkspace, { recursive: true });
        logger.info(`✓ Created workspace directory: ${realWorkspace}`);
      }
      
      // Check if /app/workspace needs to be converted to symlink
      if (fs.existsSync(appWorkspace)) {
        const stats = fs.lstatSync(appWorkspace);
        if (!stats.isSymbolicLink()) {
          // It's a real directory (created by Dockerfile), convert to symlink
          // First check if it's empty or has content
          const contents = fs.readdirSync(appWorkspace);
          if (contents.length === 0) {
            // Empty directory - safe to remove and symlink
            fs.rmdirSync(appWorkspace);
            fs.symlinkSync(realWorkspace, appWorkspace);
            logger.info(`✓ PHASE_54: Converted /app/workspace to symlink → ${realWorkspace}`);
          } else {
            // Has content - move it to real workspace first
            logger.warn(`⚠️ /app/workspace has ${contents.length} items - moving to ${realWorkspace}`);
            for (const item of contents) {
              const srcPath = path.join(appWorkspace, item);
              const destPath = path.join(realWorkspace, item);
              if (!fs.existsSync(destPath)) {
                fs.renameSync(srcPath, destPath);
              }
            }
            // Now remove and symlink
            fs.rmdirSync(appWorkspace);
            fs.symlinkSync(realWorkspace, appWorkspace);
            logger.info(`✓ PHASE_54: Moved content and created symlink /app/workspace → ${realWorkspace}`);
          }
        } else {
          // Already a symlink - verify it points to the right place
          const target = fs.readlinkSync(appWorkspace);
          if (target === realWorkspace) {
            logger.info(`✓ PHASE_54: Workspace symlink already correct: /app/workspace → ${realWorkspace}`);
          } else {
            // Wrong target - fix it
            fs.unlinkSync(appWorkspace);
            fs.symlinkSync(realWorkspace, appWorkspace);
            logger.info(`✓ PHASE_54: Fixed symlink /app/workspace → ${realWorkspace} (was: ${target})`);
          }
        }
      } else {
        // Doesn't exist - create symlink
        fs.symlinkSync(realWorkspace, appWorkspace);
        logger.info(`✓ PHASE_54: Created symlink /app/workspace → ${realWorkspace}`);
      }
    } catch (wsSymlinkErr) {
      logger.warn(`⚠️ PHASE_54: Workspace symlink setup failed: ${wsSymlinkErr.message}`);
      // Non-fatal - continue startup
    }
}

/**
 * @description Writes fail-closed, non-secret Cline compatibility state. Unattended CLI execution
 * remains disabled by the shared execution guard; this startup hook also empties legacy Cline
 * credential/MCP carriers and disables any wrapper created by older releases.
 * @param {object} application - The Application instance; retained for startup-call compatibility.
 * @returns {Promise<void>}
 */
async function setupClineCli(application) {
    void application;
    try {
      const fs = require('fs');
      const homeDir = process.env.HOME || '/home/node';
      const clineDir = `${homeDir}/.cline`;
      const dataDir = `${clineDir}/data`;
      const settingsDir = `${dataDir}/settings`;
      const localBin = `${homeDir}/.local/bin`;
      const normalizeMetadata = (value, fallback) => {
        const candidate = String(value || '').trim();
        return /^[A-Za-z0-9._:/-]+$/.test(candidate) ? candidate : fallback;
      };
      const provider = normalizeMetadata(process.env.LLM_PROVIDER, 'noop');
      const model = normalizeMetadata(process.env.LLM_MODEL, 'disabled');

      fs.mkdirSync(settingsDir, { recursive: true });
      fs.mkdirSync(localBin, { recursive: true });
      fs.writeFileSync(`${clineDir}/config.json`, JSON.stringify({
        provider,
        model,
        autoApprove: false,
      }, null, 2));

      const disabledActions = {
        readFiles: false,
        readFilesExternally: false,
        editFiles: false,
        editFilesExternally: false,
        executeSafeCommands: false,
        executeAllCommands: false,
        useBrowser: false,
        useMcp: false,
      };
      fs.writeFileSync(`${dataDir}/globalState.json`, JSON.stringify({
        welcomeViewCompleted: true,
        mode: 'plan',
        yoloModeToggled: false,
        actModeApiProvider: provider,
        planModeApiProvider: provider,
        actModeApiModelId: model,
        planModeApiModelId: model,
        autoApprovalSettings: {
          version: 3,
          enabled: false,
          favorites: [],
          maxRequests: 0,
          enableNotifications: false,
          actions: disabledActions,
        },
      }, null, 2));

      // Persistent volumes may contain credential-bearing files from older releases.
      fs.writeFileSync(`${dataDir}/secrets.json`, '{}\n', { mode: 0o600 });
      const disabledMcpSettings = JSON.stringify({ mcpServers: {} }, null, 2);
      fs.writeFileSync(`${clineDir}/mcp_settings.json`, disabledMcpSettings, { mode: 0o600 });
      fs.writeFileSync(`${settingsDir}/cline_mcp_settings.json`, disabledMcpSettings, { mode: 0o600 });

      // A stale PATH-preferred wrapper must not make the disabled interface executable.
      fs.writeFileSync(
        `${localBin}/cline`,
        '#!/bin/sh\necho "Unattended Cline execution is disabled pending an audited OSHAL broker." >&2\nexit 73\n',
        { mode: 0o700 },
      );
      logger.info('Cline compatibility state is non-secret and plan-only; unattended execution is disabled');
    } catch (clineErr) {
      logger.warn(`Failed to establish fail-closed Cline compatibility state: ${clineErr.message?.substring(0, 100) || 'unknown error'}`);
      throw clineErr;
    }
}

/**
 * @description PHASE_54: initialize the SlashCommandGenerator FIRST (before database init) so ClineProvider can assemble layered prompts in memory.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {Promise<void>}
 */
async function initSlashCommandGenerator(application) {
    // ═══════════════════════════════════════════════════════════════════
    // ⭐ PHASE_54: Initialize SlashCommandGenerator FIRST
    // Must happen before ClineProvider initialization to ensure it's available
    // ═══════════════════════════════════════════════════════════════════
    try {
      const SlashCommandGenerator = require('../services/SlashCommandGenerator');
      const { loadPersona } = require('../utils/personaLoader');
      const agentId = process.env.AGENT_ID || 'Agent';
      
      application.slashCommandGenerator = new SlashCommandGenerator({
        clineDir: path.join(process.env.HOME || '/home/node', '.cline'),
        agentId: agentId,
        toolRegistry: application.toolRegistry,
        mcpService: null, // Will be set later after MCP init
        agentRegistry: null, // Will be set later after QueueManager init
        personaLoader: loadPersona,
        writeDebugFiles: true, // Keep file writing for debugging
      });
      
      await application.slashCommandGenerator.initialize();
      logger.info(`✓ SlashCommandGenerator initialized (PHASE_54)`);
      logger.info(`[DEBUG] SlashCommandGenerator stored on this: ${!!application.slashCommandGenerator}`);
    } catch (genErr) {
      logger.warn(`SlashCommandGenerator init failed: ${genErr.message}`);
      application.slashCommandGenerator = null;
    }
}

module.exports = { logProviderStartupConfig, ensureWorkspaceSymlink, setupClineCli, initSlashCommandGenerator };
