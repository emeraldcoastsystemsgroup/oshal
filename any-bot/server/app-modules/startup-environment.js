/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): pre-database startup blocks (PHASE_54 provider log, workspace symlink, PHASE_15 Cline CLI setup, SlashCommandGenerator init)
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
 * @description PHASE_15: per-bot persistent ~/.cline config symlink, Cline CLI GovCloud patch + wrapper install, auth config write, and (when already initialized) layered custom-instruction generation.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {Promise<void>}
 */
async function setupClineCli(application) {
    // ═══════════════════════════════════════════════════════════
    // PHASE_15: Cline CLI — Symlink + GovCloud Patch + Auth Config
    // Ensures ALL bots have working Cline CLI with GovCloud prefix fix
    // ═══════════════════════════════════════════════════════════
    try {
      const fs = require('fs');
      const { execSync } = require('child_process');
      const homeDir = process.env.HOME || '/home/node';
      // ⭐ Per-bot persistent .cline config: If /app/bot-cline-configs is mounted (docker-compose),
      // create a per-bot subdirectory and symlink ~/.cline → /app/bot-cline-configs/{AGENT_ID}/.cline
      // This gives each bot its own persistent, individually-configurable .cline directory.
      const botConfigsBase = '/app/bot-cline-configs';
      const agentIdForConfig = process.env.AGENT_ID || 'default';
      if (fs.existsSync(botConfigsBase)) {
        const perBotClineDir = `${botConfigsBase}/${agentIdForConfig}/.cline`;
        const perBotDataDir = `${perBotClineDir}/data`;
        fs.mkdirSync(perBotDataDir, { recursive: true });
        
        const homeClineLink = `${homeDir}/.cline`;
        // Check if ~/.cline is already a symlink pointing to the right place
        try {
          const stats = fs.lstatSync(homeClineLink);
          if (stats.isSymbolicLink()) {
            const target = fs.readlinkSync(homeClineLink);
            if (target !== perBotClineDir) {
              fs.unlinkSync(homeClineLink);
              fs.symlinkSync(perBotClineDir, homeClineLink);
              logger.info(`✓ Per-bot .cline symlink fixed: ~/.cline → ${perBotClineDir} (was: ${target})`);
            } else {
              logger.info(`✓ Per-bot .cline symlink already correct: ~/.cline → ${perBotClineDir}`);
            }
          } else {
            // It's a real directory — move contents and replace with symlink
            const contents = fs.readdirSync(homeClineLink);
            for (const item of contents) {
              const src = path.join(homeClineLink, item);
              const dest = path.join(perBotClineDir, item);
              if (!fs.existsSync(dest)) {
                try { fs.renameSync(src, dest); } catch(e) { /* cross-device, skip */ }
              }
            }
            fs.rmSync(homeClineLink, { recursive: true, force: true });
            fs.symlinkSync(perBotClineDir, homeClineLink);
            logger.info(`✓ Per-bot .cline: converted dir to symlink: ~/.cline → ${perBotClineDir} (moved ${contents.length} items)`);
          }
        } catch (e) {
          if (e.code === 'ENOENT') {
            // ~/.cline doesn't exist — create symlink
            fs.symlinkSync(perBotClineDir, homeClineLink);
            logger.info(`✓ Per-bot .cline symlink created: ~/.cline → ${perBotClineDir}`);
          } else {
            logger.warn(`⚠️ Per-bot .cline symlink setup failed: ${e.message}`);
          }
        }
      }

      const clineDir = `${homeDir}/.cline`;
      const dataDir = `${clineDir}/data`;
      const localBin = `${homeDir}/.local/bin`;
      const clineWrapperPath = `${localBin}/cline`;
      const patchedPath = `${clineDir}/cli-patched.mjs`;
      const origPath = '/usr/local/lib/node_modules/cline/dist/cli.mjs';

      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      // 1. GovCloud patch: copy cli.mjs → patch → wrapper
      if (fs.existsSync(origPath)) {
        // Only patch if not already done (check patched file exists and is newer)
        let needsPatch = !fs.existsSync(patchedPath);
        if (!needsPatch) {
          const origStat = fs.statSync(origPath);
          const patchStat = fs.statSync(patchedPath);
          needsPatch = origStat.mtimeMs > patchStat.mtimeMs;
        }

        if (needsPatch) {
          let code = fs.readFileSync(origPath, 'utf8');
          let patched = 0;

          // PATCH 1: getModel() — recognize prefixed model IDs (us-gov., us., eu., etc.)
          const p1old = 'if(e&&e in fD){let c=e;return{id:c,info:fD[c]}}let a=application.options.awsBedrockCustomSelected';
          const p1new = 'if(e&&e in fD){let c=e;return{id:c,info:fD[c]}}if(e){let _px=["us-gov.","us.","eu.","ap.","apac.","jp.","global."];for(let _p of _px){if(e.startsWith(_p)){let _b=e.slice(_p.length);if(_b in fD)return{id:e,info:fD[_b]}}}}let a=application.options.awsBedrockCustomSelected';
          if (code.includes(p1old)) { code = code.replace(p1old, p1new); patched++; }
          else if (code.includes(p1new)) { patched++; } // already patched

          // PATCH 2: getModelId() — handle GovCloud regions
          const p2marker = '_pxs.some(_p=>_m.id.startsWith(_p))';
          if (!code.includes(p2marker)) {
            const p2old = 'async getModelId(){if(!application.options.awsBedrockCustomSelected&&application.options.awsUseCrossRegionInference){if(application.getModel().info.supportsGlobalEndpoint&&application.options.awsUseGlobalInference)return`global.${application.getModel().id}`;switch(application.getRegion().slice(0,3)){case"us-":return`us.${application.getModel().id}`';
            const p2new = 'async getModelId(){let _m=application.getModel();let _pxs=["us-gov.","us.","eu.","ap.","apac.","jp.","global."];if(_pxs.some(_p=>_m.id.startsWith(_p)))return _m.id;if(!application.options.awsBedrockCustomSelected&&application.options.awsUseCrossRegionInference){if(_m.info.supportsGlobalEndpoint&&application.options.awsUseGlobalInference)return`global.${_m.id}`;let _rg=application.getRegion();if(_rg.startsWith("us-gov-"))return`us-gov.${_m.id}`;switch(_rg.slice(0,3)){case"us-":return`us.${_m.id}`';
            if (code.includes(p2old)) { code = code.replace(p2old, p2new); patched++; }
          } else { patched++; }

          fs.writeFileSync(patchedPath, code);
          // Symlink node_modules for ESM resolution
          const nmSource = '/usr/local/lib/node_modules/cline/node_modules';
          const nmDest = `${clineDir}/node_modules`;
          try { fs.unlinkSync(nmDest); } catch(e) {}
          try { fs.symlinkSync(nmSource, nmDest); } catch(e) {}
          logger.info(`✓ Cline CLI GovCloud patch applied (${patched}/2 patches)`);
        }

        // Create wrapper script pointing to patched binary
        try { fs.unlinkSync(clineWrapperPath); } catch(e) {}
        fs.writeFileSync(clineWrapperPath, `#!/bin/sh\nexec node "${patchedPath}" "$@"\n`, { mode: 0o755 });
        logger.info('✓ Cline CLI wrapper installed');
      } else if (fs.existsSync('/usr/local/bin/cline')) {
        // No cli.mjs found — just symlink the binary
        try { fs.unlinkSync(clineWrapperPath); } catch(e) {}
        fs.symlinkSync('/usr/local/bin/cline', clineWrapperPath);
        logger.info('✓ Cline CLI symlink created (no patch needed)');
      }

      // 2. Write auth config
      const configPath = `${clineDir}/config.json`;
      // ⭐ PHASE_54 SESSION_10+: ALWAYS write when ANTHROPIC_API_KEY is set — it's the authoritative signal.
      // Never "preserve existing" when the env var is present — a stale Bedrock config would silently break things.
      if (process.env.ANTHROPIC_API_KEY || !fs.existsSync(configPath)) {
        // ⭐ PHASE_54 SESSION_10 FIX: Write claude-code config, NOT bedrock
        // The agent provider is always cline-cli (per oshal-agent-provider-rules.md)
        // Cline CLI uses claude-code provider which authenticates via ANTHROPIC_API_KEY
        const clineModel = 'claude-sonnet-4-5-20250929';
        const clineConfig = {
          provider: 'claude-code',
          model: clineModel,
          autoApprove: true,
        };
        fs.writeFileSync(`${clineDir}/config.json`, JSON.stringify(clineConfig, null, 2));

        const globalState = {
          welcomeViewCompleted: true,
          mode: 'act',
          yoloModeToggled: true,
          actModeApiProvider: 'claude-code',
          planModeApiProvider: 'claude-code',
          actModeApiModelId: clineModel,
          planModeApiModelId: clineModel,
          autoApprovalSettings: { version: 3, enabled: true, favorites: [], maxRequests: 100, enableNotifications: false, actions: { readFiles: true, readFilesExternally: true, editFiles: true, editFilesExternally: true, executeSafeCommands: true, executeAllCommands: true, useBrowser: true, useMcp: true } },
        };
        fs.writeFileSync(`${dataDir}/globalState.json`, JSON.stringify(globalState, null, 2));
        logger.info(`✓ Cline CLI auth configured (claude-code provider) — written ${process.env.ANTHROPIC_API_KEY ? 'unconditionally (ANTHROPIC_API_KEY set)' : '(first run)'}`);
      } else {
        logger.info('✓ Cline CLI config already exists and no API key override — preserving');
      }
      
      // ⭐ PHASE_54: SlashCommandGenerator now initialized earlier (before database init)
      // Generate static files for backward compatibility with PHASE_53
      if (application.slashCommandGenerator) {
        try {
          await application.slashCommandGenerator.generateAll();
          await application.slashCommandGenerator.assembleMaster();
          logger.info(`✓ Cline CLI layered custom instructions generated - PHASE_53/54`);
        } catch (customErr) {
          logger.warn(`Failed to generate layered custom instructions: ${customErr.message}`);
        }
      }
    } catch (clineErr) {
      logger.info(`Cline CLI setup: ${clineErr.message?.substring(0, 100) || 'skipped'}`);
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
