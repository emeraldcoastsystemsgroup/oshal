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
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { getSwarmApiKey, resolveCodexAuthSourcePath } from './swarm-credentials';
import { buildClineConfig, buildClineGlobalState, type CredentialBag } from './cline-config-builder';
import {
  filterMcpSettingsByCapabilities,
  type ToolCapabilityScope,
} from './tool-capability-scope';

const logger = createChildLogger({ module: 'cline-runtime-config-sync-service' });

const DEFAULT_CONFIG_OUTPUT_DIR = 'output';
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'claude-code';
const OPENAI_CODEX_PROVIDER = 'openai-codex';
const DEFAULT_CHROMA_MCP_URL = process.env.CHROMA_MCP_URL;
const DEFAULT_PRESENTRON_MCP_URL = process.env.PRESENTRON_MCP_URL || 'http://presentron-mcp:8081';
const DEFAULT_GOOGLE_SEARCH_MCP_URL = process.env.GOOGLE_SEARCH_MCP_URL;
const DEFAULT_PLANE_MCP_URL = process.env.PLANE_MCP_URL || 'http://plane-mcp:3000';
const APP_OPENAI_CODEX_CREDENTIALS_KEY = 'openAiCodexOauthCredentials';
const CLINE_OPENAI_CODEX_CREDENTIALS_KEY = 'openai-codex-oauth-credentials';

interface SecretsManagerLike {
  loadSecrets(userId?: string | null): Record<string, unknown>;
}

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
   * @description Syncs runtime provider/model/mode and provider-specific secrets to Cline files.
   * Intended to run from save/callback/signout flows, not per chat request.
   *
   * @param defaultModel - Model fallback when settings do not define one
   * @param userId - Optional authenticated user id for per-user secrets lookup
   * @returns Selection that was written to Cline runtime files
   */
  syncFromPersistedConfig(defaultModel: string, userId?: string | null): ClineRuntimeSelection {
    const selection = this.readRuntimeSelection(defaultModel);
    this.writeClineConfig(selection);
    this.writeClineGlobalState(selection);
    this.syncProviderApiKeys(selection);
    this.syncOpenAiCodexCredentials(userId);

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
   * @description Syncs provider API keys from env into Cline secrets so the CLI subprocess
   * can authenticate with the selected provider.
   * @param selection - Active runtime selection containing the resolved provider
   */
  private syncProviderApiKeys(selection: ClineRuntimeSelection): void {
    const filePath = path.join(this.configDir, 'data', 'secrets.json');
    const existing = this.readJsonObject(filePath);
    const updates: Record<string, string> = {};

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey.trim().length > 0) {
      updates.anthropicApiKey = anthropicKey;
    }

    // Propagate every provider API key the operator saved through the cockpit
    // (POST /api/config routes secret-pattern keys into the encrypted store).
    // Cline reads these from data/secrets.json keyed by its own field names —
    // which are exactly the `configKeys` declared in provider-definitions
    // (anthropicApiKey, openAiApiKey, geminiApiKey, openRouterApiKey, …).
    // Without this, a key entered in the UI lands in the store but never
    // authenticates the CLI, so only Anthropic ever worked.
    const persistedKeys = this.collectPersistedProviderApiKeys();
    for (const [key, value] of Object.entries(persistedKeys)) {
      // env-sourced keys above take precedence when set
      if (!updates[key]) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    this.writeJsonObject(filePath, { ...existing, ...updates });
    logger.debug(
      { filePath, provider: selection.provider, keysSynced: Object.keys(updates) },
      'Synchronized provider API keys to Cline runtime secrets',
    );
  }

  /**
   * @description Loads global provider API keys persisted via the cockpit config save.
   * Returns the top-level string secrets from the encrypted store (the values
   * `POST /api/config` writes), excluding per-user OAuth envelopes and the Codex
   * OAuth credential blobs which `syncOpenAiCodexCredentials` handles separately.
   *
   * @returns Map of Cline secret field name → API key value
   */
  private collectPersistedProviderApiKeys(): Record<string, string> {
    const result: Record<string, string> = {};
    let allSecrets: Record<string, unknown>;
    try {
      allSecrets = this.createSecretsManager().loadSecrets();
    } catch (error) {
      logger.warn({ err: error }, 'Could not load persisted secrets for provider key sync');
      return result;
    }

    const codexKeys = new Set([APP_OPENAI_CODEX_CREDENTIALS_KEY, CLINE_OPENAI_CODEX_CREDENTIALS_KEY]);
    for (const [key, value] of Object.entries(allSecrets)) {
      // Skip per-user OAuth envelopes (nested objects) and the Codex blobs.
      if (typeof value !== 'string' || codexKeys.has(key)) {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        result[key] = trimmed;
      }
    }
    return result;
  }

  /**
   * @description Syncs OpenAI Codex OAuth credentials from app secrets into Cline secrets.
   * @param userId - Optional authenticated user id for per-user secrets lookup
   * @returns True when credentials were written to Cline secrets
   */
  syncOpenAiCodexCredentials(userId?: string | null): boolean {
    const credentials = this.loadClineCompatibleOpenAiCodexCredentials(userId);
    if (!credentials) {
      // Not-an-error: when the codex CLI authenticates from its own ~/.codex/auth.json
      // (bind-mounted into bot containers on boot) there is nothing to propagate here.
      // This used to log at WARN on every provider resolution, flooding the journal.
      logger.debug({ userId: userId || null }, 'No cockpit-stored OpenAI Codex credentials to sync (codex CLI uses its own auth)');
      return false;
    }

    const filePath = path.join(this.configDir, 'data', 'secrets.json');
    const existing = this.readJsonObject(filePath);
    const next = {
      ...existing,
      [CLINE_OPENAI_CODEX_CREDENTIALS_KEY]: JSON.stringify(credentials),
    };
    this.writeJsonObject(filePath, next);
    logger.debug({ filePath, userId: userId || null }, 'Synchronized OpenAI Codex credentials to Cline runtime secrets');
    return true;
  }

  /**
   * @description Removes OpenAI Codex credentials from Cline runtime secrets.
   * @returns True when a credential key existed and was removed
   */
  removeOpenAiCodexCredentials(): boolean {
    const filePath = path.join(this.configDir, 'data', 'secrets.json');
    const existing = this.readJsonObject(filePath);
    if (!(CLINE_OPENAI_CODEX_CREDENTIALS_KEY in existing)) {
      return false;
    }

    const next = { ...existing };
    delete next[CLINE_OPENAI_CODEX_CREDENTIALS_KEY];
    this.writeJsonObject(filePath, next);
    logger.info({ filePath }, 'Removed OpenAI Codex credentials from Cline runtime secrets');
    return true;
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
   * @description Writes runtime provider/model to Cline config.json using per-provider credential mapping.
   * Phase 0: Now uses buildClineConfig() from cline-config-builder.ts which maps provider-specific
   * credential field names (awsAccessKey, geminiApiKey, openAiNativeApiKey, etc.) — ported from
   * any-bot LLMProviderRegistry.js PHASE_62.
   * @param selection - Selection to persist
   * @returns Void after persistence
   */
  private writeClineConfig(selection: ClineRuntimeSelection): void {
    const filePath = path.join(this.configDir, 'config.json');
    const existing = this.readJsonObject(filePath);
    const credentials = this.loadCredentialBag();
    const providerConfig = buildClineConfig(selection.provider, selection.model, credentials);

    if (providerConfig === null) {
      // Provider doesn't use config.json (e.g. cline-cli, claude-code)
      logger.info({ provider: selection.provider }, 'Provider does not use Cline config.json — skipping write');
      return;
    }

    const next = { ...existing, ...providerConfig };
    this.writeJsonObject(filePath, next);
  }

  /**
   * @description Writes runtime mode/provider/model to Cline globalState.json using per-provider state keys.
   * Phase 0: Now uses buildClineGlobalState() from cline-config-builder.ts which maps provider-specific
   * state key names (awsAuthentication, openAiNativeApiKey, geminiApiKey, etc.) — ported from
   * any-bot LLMProviderRegistry.js PHASE_62.
   * @param selection - Selection to persist
   * @returns Void after persistence
   */
  private writeClineGlobalState(selection: ClineRuntimeSelection): void {
    const filePath = path.join(this.configDir, 'data', 'globalState.json');
    const existing = this.readJsonObject(filePath);
    const credentials = this.loadCredentialBag();
    const providerState = buildClineGlobalState(selection.provider, selection.model, credentials);

    const next = {
      ...existing,
      ...providerState,
      mode: selection.mode,
    };
    this.writeJsonObject(filePath, next);
  }

  /**
   * @description Loads provider credentials from environment variables and persisted secrets.
   * Used by writeClineConfig/writeClineGlobalState to populate provider-specific credential fields.
   * @returns Credential bag with all available provider credentials
   */
  private loadCredentialBag(): CredentialBag {
    const bag: CredentialBag = {};

    // Environment variables
    const envKeys = [
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
      'GEMINI_API_KEY', 'VERTEX_PROJECT_ID', 'VERTEX_REGION',
      'AZURE_API_KEY', 'AZURE_ENDPOINT', 'AZURE_DEPLOYMENT_ID', 'AZURE_API_VERSION',
      'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY',
      'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY',
      'SAMBANOVA_API_KEY', 'NEBIUS_API_KEY', 'ASKSAGE_API_KEY',
      'REQUESTY_API_KEY', 'LITELLM_BASE_URL',
      'OLLAMA_HOST', 'LMSTUDIO_HOST',
    ];

    for (const key of envKeys) {
      const value = process.env[key];
      if (value && value.trim().length > 0) {
        bag[key] = value.trim();
      }
    }

    // Also load from persisted secrets (global-config.json, secrets.json)
    const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
    const globalConfig = this.readJsonObject(path.join(configDir, 'global-config.json'));
    const seedSecrets = this.readJsonObject(this.resolveSharedSeedPath());

    // OpenAI Codex OAuth token — resolve through the shared swarm-credentials resolver so the
    // LIVE ~/.codex/auth.json (rotated by the codex harness + written back since the
    // token-stranding fix) wins over the never-rotated config-seed copy. getSwarmApiKey
    // handles the full order: named keys → live auth.json → seed blob (with its "SEEDED
    // codex credential" warn) → env override. Reading the seed blob directly here was the
    // dead-seed consumer flagged in the 2026-07-18 codex seed audit.
    if (!bag['OPENAI_API_KEY']) {
      const oauthToken = getSwarmApiKey('openai');
      if (oauthToken) {
        bag['OPENAI_API_KEY'] = oauthToken;
        logger.info('Credential bag: resolved OPENAI_API_KEY via swarm-credentials (live-first codex resolution)');
      }
    }

    return bag;
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
   * @description Loads and normalizes OpenAI Codex credentials from app secrets.
   * @param userId - Optional authenticated user id for per-user secrets lookup
   * @returns Cline-compatible credential object or null when unavailable/invalid
   */
  private loadClineCompatibleOpenAiCodexCredentials(userId?: string | null): Record<string, unknown> | null {
    const secretsManager = this.createSecretsManager();
    const allSecrets = secretsManager.loadSecrets();
    const userSecrets = userId ? secretsManager.loadSecrets(userId) : null;
    const seedSecrets = this.readSharedSeedSecrets();
    const rawBlob = this.findOpenAiCodexCredentialBlob(allSecrets, userSecrets, seedSecrets);

    if (!rawBlob) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawBlob) as Record<string, unknown>;
      return this.normalizeOpenAiCodexCredentials(parsed);
    } catch (error) {
      logger.error({ err: error, userId: userId || null }, 'Failed to parse OpenAI Codex credential payload');
      return null;
    }
  }

  /**
   * @description Creates the encrypted/plain secrets manager used by app config persistence.
   * @returns Secrets manager instance
   */
  private createSecretsManager(): SecretsManagerLike {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptedConfigManager } = require(this.resolveEncryptedConfigManagerModulePath());
    return new EncryptedConfigManager(this.outputDir, process.env.ENCRYPTION_KEY || null);
  }

  /**
   * @description Resolves the encrypted-config-manager module path across repo-root test execution,
   * direct source runs, and compiled/container runtime layouts.
   *
   * @returns Absolute module path suitable for CommonJS require.
   */
  private resolveEncryptedConfigManagerModulePath(): string {
    const candidates = [
      path.resolve(process.cwd(), 'src/api/encrypted-config-manager'),
      path.resolve(process.cwd(), 'control-plane/OSHAL/src/api/encrypted-config-manager'),
      path.resolve(__dirname, '../../../api/encrypted-config-manager'),
      path.resolve(__dirname, '../../../../src/api/encrypted-config-manager'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(`${candidate}.js`) || fs.existsSync(`${candidate}.ts`)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  /**
   * @description Finds OpenAI Codex credential JSON blob from user/global envelopes.
   * @param allSecrets - Full secrets envelope payload
   * @param userSecrets - Optional user-scoped secret envelope
   * @returns Serialized credential blob when found
   */
  private findOpenAiCodexCredentialBlob(
    allSecrets: Record<string, unknown>,
    userSecrets: Record<string, unknown> | null,
    seedSecrets: Record<string, unknown> | null,
  ): string | null {
    logger.info(
      { hasUserSecrets: !!userSecrets, globalKeyCount: Object.keys(allSecrets).length, hasSeedSecrets: !!seedSecrets },
      'Credential lookup: starting resolution chain',
    );

    const userBlob = userSecrets ? this.readCredentialBlobFromEnvelope(userSecrets) : null;
    if (userBlob) {
      logger.info('Credential lookup: resolved from user-scoped secrets');
      return userBlob;
    }

    const globalBlob = this.readCredentialBlobFromEnvelope(allSecrets);
    if (globalBlob) {
      logger.info('Credential lookup: resolved from global secrets envelope');
      return globalBlob;
    }

    // LIVE codex auth.json comes BEFORE the config-seed fallback. The seed copy is written once
    // at install/login and never rotated, while the codex harness rotates the live source and
    // (since the token-stranding fix) writes the rotated token back. Resolving the seed first
    // synced a dead token into Cline data/secrets.json forever — the 2026-07-18 codex seed
    // audit's last remaining dead-seed consumer.
    const liveBlob = this.readLiveCodexAuthBlob();
    if (liveBlob) {
      logger.info('Credential lookup: resolved from live ~/.codex/auth.json (live-first codex resolution)');
      return liveBlob;
    }

    const seedBlob = seedSecrets ? this.readCredentialBlobFromEnvelope(seedSecrets) : null;
    if (seedBlob) {
      logger.warn('Credential lookup: resolved from SEEDED codex credential (config-seed) — live ~/.codex/auth.json was unreadable; the seed is never rotated and may be expired');
      return seedBlob;
    }

    for (const value of Object.values(allSecrets)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const nestedBlob = this.readCredentialBlobFromEnvelope(value as Record<string, unknown>);
      if (nestedBlob) {
        logger.info('Credential lookup: resolved from nested envelope iteration');
        return nestedBlob;
      }
    }

    logger.warn('Credential lookup: all resolution paths exhausted — no credentials found');
    return null;
  }

  /**
   * @description Reads the LIVE codex auth source (`~/.codex/auth.json`, the file the codex
   * harness rotates and writes back to) and serializes it into the same credential-blob shape
   * the envelope lookups return, so `normalizeOpenAiCodexCredentials` accepts it unchanged.
   *
   * Accepts both the native CLI shape (`{ tokens: { access_token, refresh_token, id_token,
   * account_id } }`) and a flat token object. Expiry is taken from an explicit numeric field
   * when present, else derived from the access/id token JWT `exp` claim, else a short 1-hour
   * window (mirroring openai-codex-oauth-service) so a near-term refresh repopulates it —
   * a missing `expires` would otherwise trip normalize and silently fall back to the dead seed.
   *
   * @returns Serialized live credential blob, or null when the live source is missing/incomplete
   */
  private readLiveCodexAuthBlob(): string | null {
    const filePath = resolveCodexAuthSourcePath();
    if (!filePath) {
      return null;
    }
    const live = this.readJsonObject(filePath);
    const tokens = this.readNamedObject(live.tokens);
    const bag = Object.keys(tokens).length > 0 ? tokens : live;

    const accessToken = this.readNonEmptyString(bag.access_token) || this.readNonEmptyString(bag.accessToken);
    const refreshToken = this.readNonEmptyString(bag.refresh_token) || this.readNonEmptyString(bag.refreshToken);
    if (!accessToken || !refreshToken) {
      return null;
    }

    const idToken = this.readNonEmptyString(bag.id_token) || this.readNonEmptyString(bag.idToken);
    const expires = this.readNumberValue(bag.expires)
      ?? this.readNumberValue(bag.expiresAt)
      ?? this.readNumberValue(live.expires)
      ?? this.readNumberValue(live.expiresAt)
      ?? this.parseJwtExpiryMs(idToken || accessToken)
      ?? Date.now() + 60 * 60 * 1000;

    const blob: Record<string, unknown> = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires,
    };
    if (idToken) {
      blob.id_token = idToken;
    }
    const accountId = this.readNonEmptyString(bag.account_id) || this.readNonEmptyString(bag.accountId);
    if (accountId) {
      blob.accountId = accountId;
    }
    const email = this.readNonEmptyString(bag.email) || this.readNonEmptyString(live.email);
    if (email) {
      blob.email = email;
    }
    return JSON.stringify(blob);
  }

  /**
   * @description Extracts an absolute expiry (milliseconds) from a JWT `exp` claim.
   * @param jwt - Candidate JWT string, or null when no token is available
   * @returns Expiry in epoch milliseconds, or undefined when the claim cannot be read
   */
  private parseJwtExpiryMs(jwt: string | null): number | undefined {
    if (!jwt) {
      return undefined;
    }
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
      const exp = this.readNumberValue(payload.exp);
      return exp !== undefined ? exp * 1000 : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * @description Reads known OpenAI Codex credential keys from one envelope object.
   * @param envelope - Candidate secrets envelope
   * @returns Serialized credential blob when available
   */
  private readCredentialBlobFromEnvelope(envelope: Record<string, unknown>): string | null {
    const appBlob = envelope[APP_OPENAI_CODEX_CREDENTIALS_KEY];
    if (typeof appBlob === 'string' && appBlob.trim().length > 0) {
      return appBlob;
    }

    const clineBlob = envelope[CLINE_OPENAI_CODEX_CREDENTIALS_KEY];
    if (typeof clineBlob === 'string' && clineBlob.trim().length > 0) {
      return clineBlob;
    }

    return null;
  }

  /**
   * @description Reads the shared swarm config-seed secrets payload when available.
   * @returns Shared seed secrets object or null when missing/invalid.
   */
  private readSharedSeedSecrets(): Record<string, unknown> | null {
    const filePath = this.resolveSharedSeedPath();
    if (!fs.existsSync(filePath)) {
      logger.info({ filePath }, 'Shared seed secrets file does not exist');
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const isValid = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      logger.info({ filePath, keyCount: isValid ? Object.keys(parsed as object).length : 0, valid: isValid }, 'Read shared seed secrets');
      return isValid ? parsed as Record<string, unknown> : null;
    } catch (error) {
      logger.warn({ err: error, filePath }, 'Failed to read shared swarm seed secrets');
      return null;
    }
  }

  /**
   * @description Resolves the shared swarm seed secrets path from env with a container-safe default.
   * @returns Shared seed secrets path.
   */
  private resolveSharedSeedPath(): string {
    return process.env.OPENAI_CODEX_SHARED_SEED_PATH || '/app/config-seed/secrets.json';
  }

  /**
   * @description Normalizes credential payload to Cline OAuth schema.
   * @param payload - Parsed credential object
   * @returns Cline-compatible credentials or null when required fields are missing
   */
  private normalizeOpenAiCodexCredentials(payload: Record<string, unknown>): Record<string, unknown> | null {
    const accessToken = this.readNonEmptyString(payload.access_token) || this.readNonEmptyString(payload.accessToken);
    const refreshToken = this.readNonEmptyString(payload.refresh_token) || this.readNonEmptyString(payload.refreshToken);
    const expires = this.readNumberValue(payload.expires) ?? this.readNumberValue(payload.expiresAt);
    if (!accessToken || !refreshToken || typeof expires !== 'number') {
      logger.warn('OpenAI Codex credentials missing required token fields');
      return null;
    }

    const normalized: Record<string, unknown> = {
      type: OPENAI_CODEX_PROVIDER,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires,
      expiresAt: expires,
    };

    const idToken = this.readNonEmptyString(payload.id_token) || this.readNonEmptyString(payload.idToken);
    if (idToken) {
      normalized.id_token = idToken;
      normalized.idToken = idToken;
    }

    const email = this.readNonEmptyString(payload.email);
    if (email) {
      normalized.email = email;
    }

    const accountId = this.readNonEmptyString(payload.accountId);
    if (accountId) {
      normalized.accountId = accountId;
    }

    return normalized;
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

  /**
   * @description Reads finite numeric values from unknown inputs.
   * @param value - Candidate numeric value
   * @returns Parsed finite number or undefined
   */
  private readNumberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
