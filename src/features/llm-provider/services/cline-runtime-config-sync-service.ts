/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added shared swarm-seed fallback for OpenAI Codex OAuth credentials so worker containers can refresh from the PM callback seed without per-container reauth
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stopped removing OpenAI Codex runtime credentials when non-Codex providers are globally selected so shared OAuth stays available for task-scoped Codex runs
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of centralized Cline runtime sync service for save-time provider/model and OpenAI Codex credential persistence
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added MCP settings read/write helpers for chat-side tools configuration UI
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Seeded a configurable default Chroma MCP entry so knowledge-base runtime config is present before manual JSON edits
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Aligned mode fallback with provider resolver so plan selection wins when mode is missing
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added managed session MCP policy generation for presentron/google-search/plane and stdio runtime defaults
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Updated managed Google Search MCP default to the streamable HTTP endpoint path
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Stopped injecting an implicit chroma-mcp server unless explicitly configured
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Resolved encrypted-config-manager module lookup across repo-root tests, source execution, and container runtime layouts so OAuth callback sync can complete outside /control-plane working directories
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Session 99: Mirror MCP settings to data/settings/cline_mcp_settings.json — the path Cline CLI actually reads at runtime (fixes zero-tool bug)
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added structured info-level logging to credential lookup chain — each resolution path now logs what it reads, what keys it finds, and which path succeeds
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Propagate ALL persisted provider API keys (not just Anthropic) from the encrypted secrets store into Cline data/secrets.json so keys entered in the UI actually authenticate the Cline CLI
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Credential bag now resolves the codex OAuth token through getSwarmApiKey('openai') (live ~/.codex/auth.json first, seed fallback with warn) instead of reading the dead config-seed blob directly; removed the duplicated private extractOpenAiCodexAccessToken
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Stopped injecting google-search-mcp unless explicitly configured — the container was retired from every active compose stack, so the hardcoded http://google-search-mcp:8080/mcp fallback handed every managed session an unresolvable MCP endpoint. Mirrors the 2026-03-12 chroma-mcp fix
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Closed the last dead-seed codex consumer: the OAuth-blob resolution chain (syncOpenAiCodexCredentials → findOpenAiCodexCredentialBlob) now reads the LIVE ~/.codex/auth.json (via resolveCodexAuthSourcePath) before falling back to the never-rotated config-seed copy, so Cline data/secrets.json can no longer be poisoned with an expired seed token while codex auth is healthy; seed fallback downgraded to a warn mirroring swarm-credentials
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: runtime sync writes non-secret metadata only, overwrites legacy credential-bearing Cline files, and retires API-key/OAuth materialization into data/secrets.json.
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { buildClineConfig, buildClineGlobalState } from './cline-config-builder';
import {
  filterMcpSettingsByCapabilities,
  type ToolCapabilityScope,
} from './tool-capability-scope';

const logger = createChildLogger({ module: 'cline-runtime-config-sync-service' });

const DEFAULT_CONFIG_OUTPUT_DIR = 'output';
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'claude-code';
const DEFAULT_CHROMA_MCP_URL = process.env.CHROMA_MCP_URL;
const DEFAULT_PRESENTRON_MCP_URL = process.env.PRESENTRON_MCP_URL || 'http://presentron-mcp:8081';
const DEFAULT_GOOGLE_SEARCH_MCP_URL = process.env.GOOGLE_SEARCH_MCP_URL;
const DEFAULT_PLANE_MCP_URL = process.env.PLANE_MCP_URL || 'http://plane-mcp:3000';

/**
 * @description Active provider/model/mode selection derived from persisted settings.
 */
export interface ClineRuntimeSelection {
  provider: string;
  model: string;
  mode: 'act' | 'plan';
}

/**
 * @description Centralizes writes to Cline runtime files (`~/.cline`) so config is persisted
 * only on save/auth events instead of each chat request.
 */
export class ClineRuntimeConfigSyncService {
  private configDir: string;
  private outputDir: string;

  /**
   * @description Creates a runtime sync service with optional directory overrides.
   * @param configDir - Optional absolute/relative Cline runtime directory
   * @param outputDir - Optional absolute/relative app config output directory
   * @returns New runtime sync service
   */
  constructor(configDir?: string, outputDir?: string) {
    this.configDir = this.resolveConfigDir(configDir);
    this.outputDir = this.resolveOutputDir(outputDir);
    logger.info({ configDir: this.configDir, outputDir: this.outputDir }, 'Cline runtime sync service initialized');
  }

  /**
   * @description Reads current provider/model/mode from persisted app settings.
   * @param defaultModel - Model fallback when settings do not define one
   * @returns Resolved runtime selection
   */
  readRuntimeSelection(defaultModel: string): ClineRuntimeSelection {
    const settingsPath = path.join(this.outputDir, 'global-config.json');
    const settings = this.readJsonObject(settingsPath);
    const selection = this.resolveRuntimeSelection(settings, defaultModel);
    // Respect FORCE_LLM_PROVIDER env override — bypasses stale global-config.json provider.
    const forceProvider = process.env.FORCE_LLM_PROVIDER?.trim();
    if (forceProvider) {
      selection.provider = forceProvider;
    }
    // Respect FORCE_LLM_MODEL env override — bypasses stale global-config.json model.
    const forceModel = process.env.FORCE_LLM_MODEL?.trim();
    if (forceModel) {
      selection.model = forceModel;
    }
    return selection;
  }

  /**
   * @description Syncs non-secret runtime provider/model metadata and tombstones legacy Cline
   * credential files. Intended to run from save/callback/signout flows, not per chat request.
   *
   * @param defaultModel - Model fallback when settings do not define one
   * @param userId - Optional authenticated user id for per-user secrets lookup
   * @returns Selection that was written to Cline runtime files
   */
  syncFromPersistedConfig(defaultModel: string, userId?: string | null): ClineRuntimeSelection {
    const selection = this.readRuntimeSelection(defaultModel);
    this.writeClineConfig(selection);
    this.writeClineGlobalState(selection);
    this.purgeLegacyClineSecrets();

    logger.debug({ selection, userId: userId || null }, 'Synchronized Cline runtime configuration from persisted settings');
    return selection;
  }

  /**
   * @description Reads the Cline MCP runtime settings file.
   * @returns Parsed MCP settings object
   */
  readMcpSettings(): Record<string, unknown> {
    const filePath = path.join(this.configDir, 'mcp_settings.json');
    const existing = this.readJsonObject(filePath);
    return this.mergeDefaultMcpSettings(existing);
  }

  /**
   * @description Builds the session-scoped MCP settings payload used for live task startup.
   * This merges persisted UI edits with managed runtime servers that should appear whenever
   * their backing services or policies are enabled.
   *
   * @returns Session-ready MCP settings payload
   */
  buildSessionMcpSettings(scope?: ToolCapabilityScope): Record<string, unknown> {
    const baseSettings = this.readMcpSettings();
    const sessionServers = this.buildManagedSessionMcpServers();
    const existingServers = this.readMcpServers(baseSettings);
    const sessionSettings = {
      ...baseSettings,
      mcpServers: {
        ...sessionServers,
        ...existingServers,
      },
    };
    return filterMcpSettingsByCapabilities(sessionSettings, scope);
  }

  /**
   * @description Writes the Cline MCP runtime settings file.
   * Also mirrors to `data/settings/cline_mcp_settings.json` — the path Cline CLI reads at runtime.
   * Without the mirror, bots see `{ "mcpServers": {} }` and have zero tools (Session 99 fix).
   * @param settings - MCP settings payload to persist
   */
  writeMcpSettings(settings: Record<string, unknown>): void {
    const mergedSettings = this.mergeDefaultMcpSettings(settings);
    const filePath = path.join(this.configDir, 'mcp_settings.json');
    this.writeJsonObject(filePath, mergedSettings);
    // Mirror to the path Cline CLI actually reads — fixes zero-tool bug (Session 99)
    const clineSettingsPath = path.join(this.configDir, 'data', 'settings', 'cline_mcp_settings.json');
    this.writeJsonObject(clineSettingsPath, mergedSettings);
    logger.debug({ clineSettingsPath }, 'Mirrored MCP settings to Cline CLI data/settings path');
  }

  /**
   * @description Returns the resolved runtime MCP settings path.
   * @returns Absolute MCP settings file path
   */
  getMcpSettingsPath(): string {
    return path.join(this.configDir, 'mcp_settings.json');
  }

  /**
   * @description Clears the legacy Cline secrets file. Unattended CLI auth is isolated in
   * vendor-owned storage and is never copied into model-runtime configuration.
   */
  private purgeLegacyClineSecrets(): void {
    const filePath = path.join(this.configDir, 'data', 'secrets.json');
    const existing = this.readJsonObject(filePath);
    if (Object.keys(existing).length > 0) {
      this.writeJsonObject(filePath, {});
      logger.info({ filePath }, 'Removed legacy Cline runtime credential material');
    }
  }

  /**
   * @description Compatibility no-op for the retired Codex-to-Cline credential copy. It clears
   * legacy Cline secret material and always reports that nothing was propagated.
   * @param userId - Optional authenticated user id for per-user secrets lookup
   * @returns Always false; raw credential materialization is disabled
   */
  syncOpenAiCodexCredentials(userId?: string | null): boolean {
    this.purgeLegacyClineSecrets();
    logger.info(
      { userId: userId || null },
      'OpenAI Codex credential materialization is disabled; local vendor auth remains isolated',
    );
    return false;
  }

  /**
   * @description Clears any legacy Cline runtime secrets left by older releases.
   * @returns True when the legacy file contained material and was emptied
   */
  removeOpenAiCodexCredentials(): boolean {
    const filePath = path.join(this.configDir, 'data', 'secrets.json');
    const existing = this.readJsonObject(filePath);
    const removed = Object.keys(existing).length > 0;
    if (removed) this.writeJsonObject(filePath, {});
    logger.info({ filePath, removed }, 'Ensured Cline runtime credential file is empty');
    return removed;
  }

  /**
   * @description Resolves runtime provider/model/mode from persisted settings with safe fallbacks.
   * @param settings - Parsed settings object from global-config.json
   * @param defaultModel - Model fallback when settings do not define one
   * @returns Resolved runtime selection
   */
  private resolveRuntimeSelection(
    settings: Record<string, unknown>,
    defaultModel: string,
  ): ClineRuntimeSelection {
    const explicitMode = settings.mode === 'plan' || settings.mode === 'act'
      ? settings.mode
      : undefined;
    const planProvider = this.readNonEmptyString(settings.planModeApiProvider);
    const actProvider = this.readNonEmptyString(settings.actModeApiProvider);
    const legacyProvider = this.readNonEmptyString(settings.provider);
    const planModel = this.readNonEmptyString(settings.planModeApiModelId);
    const actModel = this.readNonEmptyString(settings.actModeApiModelId);
    const legacyModel = this.readNonEmptyString(settings.model);
    const mode = explicitMode
      ?? (planProvider || planModel ? 'plan' : 'act');

    const provider = mode === 'plan'
      ? (planProvider || actProvider || legacyProvider || DEFAULT_PROVIDER)
      : (actProvider || planProvider || legacyProvider || DEFAULT_PROVIDER);

    const model = mode === 'plan'
      ? (planModel || actModel || legacyModel || defaultModel)
      : (actModel || planModel || legacyModel || defaultModel);

    return { provider, model, mode };
  }

  /**
   * @description Overwrites Cline config.json with non-secret provider/model metadata and
   * auto-approval disabled. Existing fields are not merged so legacy secrets are tombstoned.
   * @param selection - Selection to persist
   * @returns Void after persistence
   */
  private writeClineConfig(selection: ClineRuntimeSelection): void {
    const filePath = path.join(this.configDir, 'config.json');
    const providerConfig = buildClineConfig(selection.provider, selection.model);

    if (providerConfig === null) {
      // Overwrite instead of preserving a legacy credential-bearing wrapper config.
      this.writeJsonObject(filePath, {
        autoApprove: false,
        provider: selection.provider,
        model: selection.model,
      });
      return;
    }

    this.writeJsonObject(filePath, providerConfig);
  }

  /**
   * @description Overwrites Cline globalState.json with non-secret provider/model metadata,
   * plan mode, and every autonomous approval disabled.
   * @param selection - Selection to persist
   * @returns Void after persistence
   */
  private writeClineGlobalState(selection: ClineRuntimeSelection): void {
    const filePath = path.join(this.configDir, 'data', 'globalState.json');
    const providerState = buildClineGlobalState(selection.provider, selection.model);
    this.writeJsonObject(filePath, providerState);
  }

  /**
   * @description Reads and parses JSON files with object-only fallback semantics.
   * @param filePath - JSON file path to read
   * @returns Parsed object, or empty object when file is missing/invalid
   */
  private readJsonObject(filePath: string): Record<string, unknown> {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    try {
      logger.info({ operation: 'read', filePath }, 'Reading runtime JSON file');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch (error) {
      logger.error({ err: error, filePath }, 'Failed to parse runtime JSON file');
      return {};
    }
  }

  /**
   * @description Writes JSON object files and creates parent directories when needed.
   * @param filePath - JSON file path to write
   * @param data - Object payload to serialize
   * @returns Void after persistence
   */
  private writeJsonObject(filePath: string, data: Record<string, unknown>): void {
    try {
      logger.info({ operation: 'write', filePath }, 'Writing runtime JSON file');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error({ err: error, filePath }, 'Failed to write runtime JSON file');
      throw error;
    }
  }

  /**
   * @description Merges persisted MCP settings with the default Chroma MCP registration.
   * This keeps the knowledge-base MCP visible/configurable even before a human edits the JSON.
   *
   * @param settings - Raw MCP settings loaded from disk or request payload
   * @returns MCP settings payload with guaranteed baseline server entries
   */
  private mergeDefaultMcpSettings(settings: Record<string, unknown>): Record<string, unknown> {
    const existingServers = this.readMcpServers(settings);
    const defaultServers = this.buildDefaultMcpServers();
    return {
      ...settings,
      mcpServers: {
        ...defaultServers,
        ...existingServers,
      },
    };
  }

  /**
   * @description Returns the baseline MCP server registry exposed in local chat/runtime config.
   * @returns Default MCP servers keyed by runtime server name
   */
  private buildDefaultMcpServers(): Record<string, unknown> {
    if (!DEFAULT_CHROMA_MCP_URL || DEFAULT_CHROMA_MCP_URL.trim().length === 0) {
      return {};
    }

    return {
      'chroma-mcp': {
        url: DEFAULT_CHROMA_MCP_URL,
        transport: 'streamable-http',
        description: 'Preconfigured Chroma knowledge-base MCP server. Edit the URL if your deployment exposes a different endpoint.',
      },
    };
  }

  /**
   * @description Builds the managed MCP server policy applied to live sessions.
   * These are the baseline runtime servers inherited from local-dev/core-stack conventions.
   *
   * @returns Managed MCP servers keyed by runtime name
   */
  private buildManagedSessionMcpServers(): Record<string, unknown> {
    const settings = this.readJsonObject(path.join(this.outputDir, 'global-config.json'));
    const presentronConfig = this.readNamedObject(settings.presentronServiceConfig);
    const googleSearchConfig = this.readNamedObject(settings.googleSearchMcpConfig);
    const servers: Record<string, unknown> = {
      ...this.buildStdioSessionMcpServers(),
      ...this.buildDefaultMcpServers(),
    };

    const googleSearchUrl = this.resolveGoogleSearchMcpUrl(googleSearchConfig);
    if (googleSearchUrl) {
      servers['google-search-mcp'] = this.buildRemoteServer(
        googleSearchUrl,
        'Managed Google Search MCP endpoint for live runtime search capabilities.',
      );
    }

    const presentronUrl = this.resolvePresentronMcpUrl(presentronConfig);
    if (presentronUrl) {
      servers['presentron-mcp'] = this.buildRemoteServer(
        presentronUrl,
        'Managed Presentron MCP endpoint for presentation generation capabilities.',
      );
    }

    if (process.env.ENABLE_PLANE_MCP === 'true') {
      servers['plane-mcp'] = this.buildRemoteServer(
        DEFAULT_PLANE_MCP_URL,
        'Managed Plane MCP endpoint for ticket and planning workflows.',
      );
    }

    return servers;
  }

  /**
   * @description Builds stdio MCP servers that are expected in local/runtime sessions.
   * @returns Stdio MCP server registry keyed by runtime server name.
   */
  private buildStdioSessionMcpServers(): Record<string, unknown> {
    const workspaceRoot = process.env.CLINE_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || '/app/workspace';
    const servers: Record<string, unknown> = {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot],
      },
      fetch: {
        command: 'npx',
        args: ['-y', 'mcp-fetch-server'],
      },
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    };

    if (process.env.CONTEXT7_API_KEY && process.env.CONTEXT7_API_KEY.trim().length > 0) {
      servers.context7 = {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp', '--api-key', process.env.CONTEXT7_API_KEY.trim()],
      };
    }

    // Splunk MCP — enabled when SPLUNK_URL is configured
    if (process.env.SPLUNK_URL) {
      servers['splunk-mcp'] = {
        command: 'node',
        args: [path.resolve(process.cwd(), 'dist/mcp-servers/splunk-mcp-server.js')],
        env: {
          SPLUNK_URL: process.env.SPLUNK_URL,
          ...(process.env.SPLUNK_TOKEN ? { SPLUNK_TOKEN: process.env.SPLUNK_TOKEN } : {}),
          ...(process.env.SPLUNK_USER ? { SPLUNK_USER: process.env.SPLUNK_USER } : {}),
          ...(process.env.SPLUNK_PASS ? { SPLUNK_PASS: process.env.SPLUNK_PASS } : {}),
        },
      };
    }

    // ServiceNow MCP — enabled when SERVICENOW_URL is configured
    if (process.env.SERVICENOW_URL) {
      servers['servicenow-mcp'] = {
        command: 'node',
        args: [path.resolve(process.cwd(), 'dist/mcp-servers/servicenow-mcp-server.js')],
        env: {
          SERVICENOW_URL: process.env.SERVICENOW_URL,
          ...(process.env.SERVICENOW_TOKEN ? { SERVICENOW_TOKEN: process.env.SERVICENOW_TOKEN } : {}),
          ...(process.env.SERVICENOW_USER ? { SERVICENOW_USER: process.env.SERVICENOW_USER } : {}),
          ...(process.env.SERVICENOW_PASS ? { SERVICENOW_PASS: process.env.SERVICENOW_PASS } : {}),
        },
      };
    }

    return servers;
  }

  /**
   * @description Builds a normalized remote MCP server definition.
   * @param url - Remote MCP endpoint URL.
   * @param description - Human-readable description.
   * @returns Remote MCP server config.
   */
  private buildRemoteServer(url: string, description: string): Record<string, unknown> {
    return {
      url,
      transport: 'streamable-http',
      description,
    };
  }

  /**
   * @description Resolves the effective Presentron MCP URL from persisted service config or env defaults.
   * @param presentronConfig - Persisted Presentron service config.
   * @returns Presentron MCP URL.
   */
  private resolvePresentronMcpUrl(presentronConfig: Record<string, unknown>): string {
    const explicitMcpUrl = this.readNonEmptyString(presentronConfig.mcpUrl);
    if (explicitMcpUrl) {
      return explicitMcpUrl;
    }

    const endpoint = this.readNonEmptyString(presentronConfig.endpoint);
    if (!endpoint) {
      return DEFAULT_PRESENTRON_MCP_URL;
    }

    return endpoint.endsWith('/mcp') ? endpoint : endpoint.replace(/\/$/, '');
  }

  /**
   * @description Resolves the effective Google Search MCP URL from persisted service config or env.
   * There is deliberately NO built-in default: the `google-search-mcp` container was retired from
   * every active compose stack, so a hardcoded fallback injected an unresolvable endpoint into every
   * managed session. Returns empty when unconfigured so the caller skips injection entirely — the
   * same treatment `chroma-mcp` received on 2026-03-12.
   * @param googleSearchConfig - Persisted Google Search MCP config.
   * @returns Google Search MCP URL, or an empty string when no operator has configured one.
   */
  private resolveGoogleSearchMcpUrl(googleSearchConfig: Record<string, unknown>): string {
    return this.readNonEmptyString(googleSearchConfig.url) || DEFAULT_GOOGLE_SEARCH_MCP_URL || '';
  }

  /**
   * @description Reads a plain object from unknown input.
   * @param value - Raw value.
   * @returns Object value or empty object.
   */
  private readNamedObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  /**
   * @description Normalizes the `mcpServers` object from persisted runtime settings.
   * @param settings - Raw MCP settings object
   * @returns Safe MCP server registry object
   */
  private readMcpServers(settings: Record<string, unknown>): Record<string, unknown> {
    if (settings.mcpServers && typeof settings.mcpServers === 'object' && !Array.isArray(settings.mcpServers)) {
      return settings.mcpServers as Record<string, unknown>;
    }

    return {};
  }

 /**
   * @description Resolves Cline runtime directory from explicit value, env, or home fallback.
   * @param configuredDir - Optional runtime directory override
   * @returns Absolute runtime directory path
   */
  private resolveConfigDir(configuredDir?: string): string {
    if (configuredDir && configuredDir.trim().length > 0) {
      return path.resolve(configuredDir);
    }

    const envDir = process.env.CLINE_CONFIG_DIR;
    if (envDir && envDir.trim().length > 0) {
      return path.resolve(envDir);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      return path.resolve(homeDir, '.cline');
    }

    return path.resolve(process.cwd(), '.cline');
  }

  /**
   * @description Resolves app config output directory from explicit value or env fallback.
   * @param configuredDir - Optional output directory override
   * @returns Absolute output directory path
   */
  private resolveOutputDir(configuredDir?: string): string {
    if (configuredDir && configuredDir.trim().length > 0) {
      return path.resolve(configuredDir);
    }

    const envDir = process.env.CONFIG_OUTPUT_DIR || DEFAULT_CONFIG_OUTPUT_DIR;
    return path.resolve(envDir);
  }

  /**
   * @description Normalizes unknown values into non-empty strings.
   * @param value - Candidate value
   * @returns Trimmed string or null when invalid
   */
  private readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

}
