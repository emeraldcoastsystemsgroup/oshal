/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added per-task Cline runtime directory generation for session-specific MCP settings
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed provider poisoning: applyResolvedSelection overwrites VSCode Cline settings in session config
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added copyClinerules to copy governance rules from project root to task workspace
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Session 99: Mirror MCP settings to data/settings/cline_mcp_settings.json
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: stop copying provider/seed secrets into task workspaces, overwrite session state with plan-only no-approval metadata, and leave model-selected MCP servers empty while unattended CLI execution is disabled.
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import {
  ClineRuntimeConfigSyncService,
  type ClineRuntimeSelection,
} from './cline-runtime-config-sync-service';
import { buildClineConfig, buildClineGlobalState } from './cline-config-builder';
import type { ToolCapabilityScope } from './tool-capability-scope';

const logger = createChildLogger({ module: 'cline-session-runtime-service' });

/**
 * @description Session-specific runtime config directory prepared for a single task execution.
 */
export interface ClineSessionRuntime {
  configDir: string;
  mcpSettingsPath: string;
  mcpSettings: Record<string, unknown>;
}

/**
 * @description Creates per-task Cline compatibility directories containing only non-secret,
 * plan-only metadata. Provider credentials never enter the task workspace.
 */
export class ClineSessionRuntimeService {
  private readonly runtimeSyncService: ClineRuntimeConfigSyncService;
  private readonly sourceConfigDir: string;

  /**
   * @description Creates a session runtime service rooted at an existing Cline config directory.
   * @param runtimeSyncService - Shared runtime sync service.
   * @param sourceConfigDir - Source Cline config directory.
   */
  constructor(runtimeSyncService: ClineRuntimeConfigSyncService, sourceConfigDir: string) {
    this.runtimeSyncService = runtimeSyncService;
    this.sourceConfigDir = sourceConfigDir;
  }

  /**
   * @description Prepares a task-scoped Cline config directory inside the workspace.
   * @param workspacePath - Active task workspace path.
   * @returns Session runtime details including the config directory and MCP settings path.
   */
  prepareSessionRuntime(
    workspacePath: string,
    selectionOverride?: ClineRuntimeSelection,
    agentId?: string,
    capabilityScope?: ToolCapabilityScope,
  ): ClineSessionRuntime {
    // Per-agent config isolation: each bot gets its own Cline settings dir so concurrent
    // executions on the same task don't stomp each other's provider/model/MCP config.
    const runtimeDir = agentId
      ? path.join(workspacePath, '.oshal', 'cline-runtime', agentId.replace(/[^a-zA-Z0-9-_]/g, '_'))
      : path.join(workspacePath, '.oshal', 'cline-runtime');
    const sessionConfigDir = runtimeDir;
    const sessionDataDir = path.join(sessionConfigDir, 'data');
    fs.mkdirSync(sessionDataDir, { recursive: true });

    this.copyRuntimeFile('config.json', sessionConfigDir);
    this.copyRuntimeFile(path.join('data', 'globalState.json'), sessionConfigDir);

    this.applyResolvedSelection(sessionConfigDir, selectionOverride);
    this.copyClinerules(workspacePath);

    // Preserve the parameter for API compatibility, but never turn an advertised capability
    // into a model-visible MCP server while autonomous CLI execution is disabled.
    void capabilityScope;
    const mcpSettings: Record<string, unknown> = { mcpServers: {} };
    const mcpSettingsPath = path.join(sessionConfigDir, 'mcp_settings.json');
    fs.writeFileSync(mcpSettingsPath, JSON.stringify(mcpSettings, null, 2), 'utf8');
    // Mirror to the path Cline CLI actually reads — fixes zero-tool bug (Session 99)
    const clineSettingsDir = path.join(sessionConfigDir, 'data', 'settings');
    fs.mkdirSync(clineSettingsDir, { recursive: true });
    const clineSettingsPath = path.join(clineSettingsDir, 'cline_mcp_settings.json');
    fs.writeFileSync(clineSettingsPath, JSON.stringify(mcpSettings, null, 2), 'utf8');
    logger.info({ sessionConfigDir, mcpSettingsPath, clineSettingsPath }, 'Prepared session-scoped Cline runtime directory');

    return {
      configDir: sessionConfigDir,
      mcpSettingsPath,
      mcpSettings,
    };
  }

  /**
   * @description Overwrites session config/globalState with the resolved selection from global-config.json.
   * This prevents VSCode Cline extension from poisoning the session with its own provider/model settings.
   * @param sessionConfigDir - Session config root directory
   */
  private applyResolvedSelection(sessionConfigDir: string, selectionOverride?: ClineRuntimeSelection): void {
    const defaultModel = process.env.CLINE_MODEL || process.env.LLM_MODEL || 'gpt-5.3-codex';
    const selection = selectionOverride || this.runtimeSyncService.readRuntimeSelection(defaultModel);

    const configPath = path.join(sessionConfigDir, 'config.json');
    const config = buildClineConfig(selection.provider, selection.model) || {
      provider: selection.provider,
      model: selection.model,
      autoApprove: false,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const gsPath = path.join(sessionConfigDir, 'data', 'globalState.json');
    const globalState = {
      ...buildClineGlobalState(selection.provider, selection.model),
      focusChainSettings: {
        enabled: false,
        remindClineInterval: 0,
      },
    };
    fs.mkdirSync(path.dirname(gsPath), { recursive: true });
    fs.writeFileSync(gsPath, JSON.stringify(globalState, null, 2), 'utf8');

    // Tombstone any credential-bearing file left by a reused task workspace.
    const sessionSecretsDir = path.join(sessionConfigDir, 'data');
    const sessionSecretsPath = path.join(sessionSecretsDir, 'secrets.json');
    fs.mkdirSync(sessionSecretsDir, { recursive: true });
    fs.writeFileSync(sessionSecretsPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(sessionSecretsPath, 0o600);

    logger.info(
      { sessionConfigDir, provider: selection.provider, model: selection.model, mode: 'plan' },
      'Applied non-secret plan-only provider metadata to session runtime',
    );
  }

  /**
   * @description Copies a runtime file from the persisted config directory into the session config directory.
   * Missing files are skipped because the runtime can tolerate absent compatibility artifacts.
   *
   * @param relativePath - Relative runtime path inside the config root.
   * @param sessionConfigDir - Session config root.
   */
  /**
   * @description Copies the project .clinerules directory into the workspace so the registered
   * compatibility interface retains governance context if an audited broker is later introduced.
   * @param workspacePath - Task workspace root
   */
  private copyClinerules(workspacePath: string): void {
    const projectRoot = process.cwd();
    const sourceDir = path.join(projectRoot, '.clinerules');
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return;
    }
    const targetDir = path.join(workspacePath, '.clinerules');
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir)) {
      const srcFile = path.join(sourceDir, entry);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, path.join(targetDir, entry));
      }
    }
    logger.info({ sourceDir, targetDir, fileCount: fs.readdirSync(targetDir).length }, 'Copied .clinerules to task workspace');
  }

  private copyRuntimeFile(relativePath: string, sessionConfigDir: string): void {
    const sourcePath = path.join(this.sourceConfigDir, relativePath);
    if (!fs.existsSync(sourcePath)) {
      return;
    }

    const targetPath = path.join(sessionConfigDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}
