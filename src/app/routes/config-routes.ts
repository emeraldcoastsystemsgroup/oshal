/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserved mock-user and user-prefixed secret envelopes so local/mock OIDC saves do not wipe per-user OAuth credentials
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of LLM configuration API routes
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added root-level GET/POST/DELETE /api/config with split-mode persistence
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Integrated EncryptedConfigManager for secrets at rest
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added POST /api/config/migrate for plaintext-to-encrypted migration
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserved per-user OAuth secret envelopes during global config saves and filtered user partitions from merged config reads
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added save-time Cline runtime sync so provider/model and OpenAI Codex credentials are persisted only on config save
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added MCP runtime config read/write routes for the standalone chat tools modal
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated RAG/Presentron service configuration routes for popup-managed runtime settings
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Switched Presentron and Google Search MCP defaults to deployable service endpoints
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit config ownership contract route so cockpit and docs can distinguish global OSHAL config from per-agent profile/tool configuration
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | POST /api/config now MERGES partial saves: non-secret settings merge into existing global-config.json and global secrets are preserved across saves (was wholesale-overwrite, which wiped previously-saved provider keys + service configs when saving one provider at a time)
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';
import { buildConfigOwnershipContract } from './config-ownership-contract';

const logger = createChildLogger({ module: 'config-routes' });

/**
 * @description Pattern list for detecting secret keys in config payloads.
 * Keys matching any of these patterns (case-insensitive) are routed to
 * the encrypted secrets store instead of the plain settings file.
 */
const SECRET_KEY_PATTERNS = [
  'apikey', 'api_key', 'apiKey',
  'secret', 'Secret',
  'token', 'Token',
  'password', 'Password',
  'clientsecret', 'clientSecret',
  'accesskey', 'accessKey',
  'secretkey', 'secretKey',
  'sessiontoken', 'sessionToken',
];

/**
 * @description Determines whether a config key should be treated as a secret.
 * Matches against known secret key patterns (case-insensitive substring).
 *
 * @param key - The configuration key to test
 * @returns True if the key represents a secret value
 */
function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/**
 * @description Reads a JSON file from disk, returning an empty object if
 * the file does not exist or cannot be parsed.
 *
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed object or empty object
 */
function readJsonSafe(filePath: string): Record<string, any> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err: any) {
    logger.error({ err, path: filePath }, 'Failed to read JSON file');
  }
  return {};
}

/**
 * @description Writes a JavaScript object to disk as formatted JSON.
 * Creates parent directories if they do not exist.
 *
 * @param filePath - Absolute path to write
 * @param data - The data to serialize
 */
function writeJsonSafe(filePath: string, data: Record<string, any>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * @description Detects per-user secret envelope entries keyed by UUID-like user IDs.
 *
 * @param key - Top-level secrets key
 * @param value - Top-level secrets value
 * @returns True when the entry appears to be a user-partitioned secret envelope
 */
function isUserSecretEnvelopeEntry(key: string, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)
    || /^mock-user-[\w-]+$/i.test(key)
    || /^user-[\w-]+$/i.test(key);
}

/**
 * @description Separates global secret keys from per-user envelope entries.
 *
 * @param allSecrets - Full secrets payload as stored by EncryptedConfigManager
 * @returns Global secrets and preserved user envelope entries
 */
function partitionSecretsEnvelope(allSecrets: Record<string, any>): {
  globalSecrets: Record<string, any>;
  userEnvelopes: Record<string, any>;
} {
  const globalSecrets: Record<string, any> = {};
  const userEnvelopes: Record<string, any> = {};

  for (const [key, value] of Object.entries(allSecrets)) {
    if (isUserSecretEnvelopeEntry(key, value)) {
      userEnvelopes[key] = value;
    } else {
      globalSecrets[key] = value;
    }
  }

  return { globalSecrets, userEnvelopes };
}

/**
 * @description Creates configuration routes for LLM provider management.
 * Provides root-level CRUD with split-mode persistence (settings in
 * global-config.json, secrets via EncryptedConfigManager) plus legacy
 * /llm endpoints for backward compatibility.
 *
 * @returns Express router with configuration routes
 */
export function createConfigRoutes(): Router {
  const router = Router();
  const context = createConfigRoutesContext();
  registerRootConfigRoutes(router, context);
  registerMigrationRoutes(router, context);
  registerMcpRoutes(router, context);
  registerServiceConfigRoutes(router, context);
  registerLegacyLlmRoutes(router, context);
  return router;
}

interface SecretsManagerLike {
  isEncrypted(): boolean;
  loadSecrets(userId?: string | null): Record<string, any>;
  saveSecrets(secretsData: Record<string, any>, userId?: string | null): void;
  getSecretsPath(): string;
  deleteSecrets(): boolean;
  migrateFromPlaintext(removePlain?: boolean): Record<string, unknown>;
}

interface ConfigRoutesContext {
  configDir: string;
  settingsPath: string;
  legacyConfigPath: string;
  secretsManager: SecretsManagerLike;
  runtimeSyncService: ClineRuntimeConfigSyncService;
}

/**
 * @description Build shared context dependencies used by all config routes.
 *
 * @returns Context with paths and secrets manager instance
 */
function createConfigRoutesContext(): ConfigRoutesContext {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settingsPath = path.join(configDir, 'global-config.json');
  const legacyConfigPath = path.join(configDir, 'llm-config.json');
  const encryptionKey = process.env.ENCRYPTION_KEY || null;
  const runtimeSyncService = new ClineRuntimeConfigSyncService();

  // Lazy-load the CommonJS encrypted config manager
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EncryptedConfigManager } = require('../../../src/api/encrypted-config-manager');
  const secretsManager = new EncryptedConfigManager(configDir, encryptionKey);

  logger.info({ configDir, encrypted: secretsManager.isEncrypted() }, 'Config routes initialized');
  return {
    configDir,
    settingsPath,
    legacyConfigPath,
    secretsManager,
    runtimeSyncService,
  };
}

/**
 * @description Register root-level CRUD routes for merged/global configuration.
 *
 * @param router - Express router
 * @param context - Shared route context
 */
function registerRootConfigRoutes(router: Router, context: ConfigRoutesContext): void {
  router.get('/ownership', handleGetConfigOwnership(context));
  router.get('/', handleGetMergedConfig(context));
  router.post('/', handleSaveMergedConfig(context));
  router.delete('/', handleDeleteMergedConfig(context));
}

/**
 * @description Register migration route for plaintext-to-encrypted secrets conversion.
 *
 * @param router - Express router
 * @param context - Shared route context
 */
function registerMigrationRoutes(router: Router, context: ConfigRoutesContext): void {
  router.post('/migrate', handleMigrateSecrets(context));
}

/**
 * @description Register MCP runtime config routes.
 *
 * @param router - Express router
 * @param context - Shared route context
 */
function registerMcpRoutes(router: Router, context: ConfigRoutesContext): void {
  router.get('/mcp', handleGetMcpConfig(context));
  router.post('/mcp', handleSaveMcpConfig(context));
}

/**
 * @description Register service-level runtime config routes used by chat popup modals.
 *
 * @param router - Express router
 * @param context - Shared route context
 */
function registerServiceConfigRoutes(router: Router, context: ConfigRoutesContext): void {
  router.get('/rag', handleGetServiceConfig(context, 'ragServiceConfig', buildDefaultRagServiceConfig(), '/api/config/rag'));
  router.post('/rag', handleSaveServiceConfig(context, 'ragServiceConfig', '/api/config/rag'));
  router.get('/presentron', handleGetServiceConfig(context, 'presentronServiceConfig', buildDefaultPresentronConfig(), '/api/config/presentron'));
  router.post('/presentron', handleSaveServiceConfig(context, 'presentronServiceConfig', '/api/config/presentron'));
  router.get('/google-search-mcp', handleGetServiceConfig(context, 'googleSearchMcpConfig', buildDefaultGoogleSearchMcpConfig(), '/api/config/google-search-mcp'));
  router.post('/google-search-mcp', handleSaveServiceConfig(context, 'googleSearchMcpConfig', '/api/config/google-search-mcp'));
  router.get('/google-search-mcp/health', handleGoogleSearchMcpHealth(context));
}

/**
 * @description Register legacy `/llm` compatibility routes.
 *
 * @param router - Express router
 * @param context - Shared route context
 */
function registerLegacyLlmRoutes(router: Router, context: ConfigRoutesContext): void {
  router.get('/llm', handleGetLegacyLlmConfig(context));
  router.post('/llm', handleSaveLegacyLlmConfig(context));
}

/**
 * @description Build GET handler that returns merged settings and global secrets.
 *
 * @param context - Shared route context
 * @returns Express handler for GET /api/config
 */
function handleGetMergedConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      logger.info('GET /api/config — loading merged configuration');
      const settings = readJsonSafe(context.settingsPath);
      const allSecrets = context.secretsManager.loadSecrets();
      const { globalSecrets } = partitionSecretsEnvelope(allSecrets);
      const merged = { ...settings, ...globalSecrets };
      // Expose env-level LLM_PROVIDER / LLM_MODEL so the UI can resolve agent "auto" values
      if (process.env.LLM_PROVIDER) merged.llmProvider = process.env.LLM_PROVIDER;
      if (process.env.LLM_MODEL) merged.llmModel = process.env.LLM_MODEL;
      // Redact secret values before sending to client
      const redacted = Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [k, isSecretKey(k) ? '***' : v]),
      );
      logger.info(
        { settingsKeys: Object.keys(settings).length, secretsKeys: Object.keys(globalSecrets).length },
        'Configuration loaded',
      );
      res.json({ success: true, config: redacted });
    } catch (err: any) {
      logger.error({ err }, 'Failed to load configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build GET handler that returns the canonical OSHAL config ownership model.
 *
 * @param context - Shared route context
 * @returns Express handler for GET /api/config/ownership
 */
function handleGetConfigOwnership(context: ConfigRoutesContext) {
  return (_req: Request, res: Response): void => {
    try {
      logger.info('GET /api/config/ownership — describing config ownership model');
      const ownership = buildConfigOwnershipContract({
        settingsPath: context.settingsPath,
        secretsPath: context.secretsManager.getSecretsPath(),
      });
      logger.info(
        {
          globalRoutes: ownership.globalConfig.routes.length,
          perAgentProfileRoutes: ownership.perAgentProfile.routes.length,
          perAgentToolRoutes: ownership.perAgentTools.routes.length,
          perAgentRuntimeRoutes: ownership.perAgentRuntime.routes.length,
          legacyRoutes: ownership.legacyCompatibility.routes.length,
        },
        'Config ownership model loaded',
      );
      res.json({ success: true, ownership });
    } catch (err: any) {
      logger.error({ err }, 'Failed to describe config ownership model');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Split incoming config payload into non-secret and secret partitions.
 *
 * @param body - Incoming request payload
 * @returns Partitioned settings and secrets objects
 */
function splitSettingsAndSecrets(body: Record<string, any>): {
  settings: Record<string, any>;
  secrets: Record<string, any>;
} {
  const settings: Record<string, any> = {};
  const secrets: Record<string, any> = {};

  for (const [key, value] of Object.entries(body)) {
    if (isSecretKey(key)) {
      secrets[key] = value;
    } else {
      settings[key] = value;
    }
  }

  return { settings, secrets };
}

/**
 * @description Save global secrets while preserving existing per-user secret envelopes.
 *
 * @param context - Shared route context
 * @param secrets - Global secrets partition from request payload
 * @returns Count of preserved per-user secret envelope entries
 */
function saveGlobalSecretsPreservingUsers(
  context: ConfigRoutesContext,
  secrets: Record<string, any>,
): number {
  const existingEnvelope = context.secretsManager.loadSecrets();
  const { globalSecrets, userEnvelopes } = partitionSecretsEnvelope(existingEnvelope);
  // Preserve previously-saved global secrets so an incremental save (one provider
  // key at a time) does not wipe the others; new values in `secrets` override.
  const mergedSecrets = { ...globalSecrets, ...userEnvelopes, ...secrets };
  context.secretsManager.saveSecrets(mergedSecrets);
  return Object.keys(userEnvelopes).length;
}

/**
 * @description Build POST handler that persists split-mode config while preserving user OAuth entries.
 *
 * @param context - Shared route context
 * @returns Express handler for POST /api/config
 */
function handleSaveMergedConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      const body = req.body || {};
      logger.info({ keyCount: Object.keys(body).length }, 'POST /api/config — saving configuration');
      const { settings, secrets } = splitSettingsAndSecrets(body);
      if (!fs.existsSync(context.configDir)) {
        fs.mkdirSync(context.configDir, { recursive: true });
      }
      // Merge into existing settings so a partial save (e.g. one provider's
      // model + active selection) preserves unrelated keys (rag/presentron/etc.).
      const existingSettings = readJsonSafe(context.settingsPath);
      writeJsonSafe(context.settingsPath, { ...existingSettings, ...settings });
      const preservedCount = saveGlobalSecretsPreservingUsers(context, secrets);
      const userId = getOptionalOidcUserId(req);
      const selection = context.runtimeSyncService.syncFromPersistedConfig(
        process.env.CLINE_MODEL || process.env.LLM_MODEL || 'gpt-5.3-codex',
        userId,
      );
      logger.info(
        {
          settingsCount: Object.keys(settings).length,
          secretsCount: Object.keys(secrets).length,
          preservedUserSecretEnvelopes: preservedCount,
          runtimeProvider: selection.provider,
          runtimeModel: selection.model,
          runtimeMode: selection.mode,
          userId: userId || null,
        },
        'Configuration saved in split mode',
      );
      res.json({
        success: true,
        mode: 'split',
        files: { settings: context.settingsPath, secrets: context.secretsManager.getSecretsPath() },
        settingsCount: Object.keys(settings).length,
        secretsCount: Object.keys(secrets).length,
      });
    } catch (err: any) {
      logger.error({ err }, 'Failed to save configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Reads optional OIDC user id from request context.
 * @param req - Express request carrying optional OIDC data
 * @returns User id when present; otherwise null
 */
function getOptionalOidcUserId(req: Request): string | null {
  const candidate = (req as any).oidc?.user?.sub;
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return null;
  }
  return candidate;
}

/**
 * @description Build DELETE handler that clears settings, legacy config, and secrets stores.
 *
 * @param context - Shared route context
 * @returns Express handler for DELETE /api/config
 */
function handleDeleteMergedConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      logger.info('DELETE /api/config — clearing configuration');
      if (fs.existsSync(context.settingsPath)) {
        fs.unlinkSync(context.settingsPath);
        logger.info({ path: context.settingsPath }, 'Settings file deleted');
      }
      context.secretsManager.deleteSecrets();
      if (fs.existsSync(context.legacyConfigPath)) {
        fs.unlinkSync(context.legacyConfigPath);
        logger.info({ path: context.legacyConfigPath }, 'Legacy config file deleted');
      }
      res.json({ success: true, cleared: true });
    } catch (err: any) {
      logger.error({ err }, 'Failed to clear configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build POST migration handler for encrypted secrets conversion.
 *
 * @param context - Shared route context
 * @returns Express handler for POST /api/config/migrate
 */
function handleMigrateSecrets(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      const { removePlain } = req.body || {};
      logger.info({ removePlain }, 'POST /api/config/migrate');
      const result = context.secretsManager.migrateFromPlaintext(!!removePlain);
      res.json({ success: true, ...result });
    } catch (err: any) {
      logger.error({ err }, 'Migration failed');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build GET handler for runtime MCP settings.
 *
 * @param context - Shared route context
 * @returns Express handler for GET /api/config/mcp
 */
function handleGetMcpConfig(context: ConfigRoutesContext) {
  return (_req: Request, res: Response): void => {
    try {
      const config = context.runtimeSyncService.readMcpSettings();
      res.json({
        success: true,
        config,
        path: context.runtimeSyncService.getMcpSettingsPath(),
      });
    } catch (err: any) {
      logger.error({ err }, 'Failed to load MCP configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build POST handler for runtime MCP settings.
 *
 * @param context - Shared route context
 * @returns Express handler for POST /api/config/mcp
 */
function handleSaveMcpConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ success: false, error: 'MCP config must be a JSON object' });
        return;
      }

      const normalized = body.mcpServers && typeof body.mcpServers === 'object' && !Array.isArray(body.mcpServers)
        ? body
        : { mcpServers: {} };

      context.runtimeSyncService.writeMcpSettings(normalized as Record<string, unknown>);
      res.json({
        success: true,
        config: normalized,
        path: context.runtimeSyncService.getMcpSettingsPath(),
      });
    } catch (err: any) {
      logger.error({ err }, 'Failed to save MCP configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build GET handler for a nested service config object in global settings.
 *
 * @param context - Shared route context
 * @param key - Settings key name
 * @param defaults - Default payload when no settings exist
 * @param routeLabel - Route label for structured logs
 * @returns Express handler
 */
function handleGetServiceConfig(
  context: ConfigRoutesContext,
  key: 'ragServiceConfig' | 'presentronServiceConfig' | 'googleSearchMcpConfig',
  defaults: Record<string, unknown>,
  routeLabel: string,
) {
  return (_req: Request, res: Response): void => {
    try {
      const settings = readJsonSafe(context.settingsPath);
      const value = settings[key];
      const config = value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : defaults;
      logger.info({ routeLabel, hasCustomConfig: value !== undefined }, 'Service configuration loaded');
      res.json({ success: true, config });
    } catch (err: any) {
      logger.error({ err, routeLabel }, 'Failed to load service configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build POST handler that writes a nested service config object into global settings.
 *
 * @param context - Shared route context
 * @param key - Settings key name
 * @param routeLabel - Route label for structured logs
 * @returns Express handler
 */
function handleSaveServiceConfig(
  context: ConfigRoutesContext,
  key: 'ragServiceConfig' | 'presentronServiceConfig' | 'googleSearchMcpConfig',
  routeLabel: string,
) {
  return (req: Request, res: Response): void => {
    try {
      const body = req.body?.config ?? req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        res.status(400).json({ success: false, error: 'Service config must be a JSON object' });
        return;
      }

      const settings = readJsonSafe(context.settingsPath);
      const nextSettings = { ...settings, [key]: body };
      writeJsonSafe(context.settingsPath, nextSettings);
      logger.info({ routeLabel, keyCount: Object.keys(body).length }, 'Service configuration saved');
      res.json({ success: true, config: body });
    } catch (err: any) {
      logger.error({ err, routeLabel }, 'Failed to save service configuration');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Default RAG service configuration used when no persisted settings exist.
 *
 * @returns Default RAG service config object
 */
function buildDefaultRagServiceConfig(): Record<string, unknown> {
  return {
    embeddingProviderId: 'openai',
    embeddingModelId: 'text-embedding-3-small',
    endpoint: '',
    defaultCollection: 'default',
    chunking: {
      strategy: 'tiered',
      chunkSize: 700,
      chunkOverlap: 100,
      tierSizes: [1200, 700, 350],
      tierOverlaps: [180, 100, 60],
    },
  };
}

/**
 * @description Default Presentron service configuration used when no persisted settings exist.
 *
 * @returns Default Presentron config object
 */
function buildDefaultPresentronConfig(): Record<string, unknown> {
  return {
    endpoint: process.env.PRESENTRON_ENDPOINT || process.env.PRESENTRON_URL || 'http://presentron:8080',
    healthcheckPath: '/health',
    mcpUrl: process.env.PRESENTRON_MCP_URL || 'http://presentron-mcp:8081',
  };
}

/**
 * @description Default Google Search MCP configuration used when no persisted settings exist.
 *
 * @returns Default Google Search MCP config object
 */
function buildDefaultGoogleSearchMcpConfig(): Record<string, unknown> {
  return {
    url: process.env.GOOGLE_SEARCH_MCP_URL || 'http://google-search-mcp:8080/mcp',
    healthcheckPath: '/health',
  };
}

/**
 * @description Build GET handler that probes the configured Google Search MCP service.
 *
 * @param context - Shared route context
 * @returns Express handler for GET /api/config/google-search-mcp/health
 */
function handleGoogleSearchMcpHealth(context: ConfigRoutesContext) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const settings = readJsonSafe(context.settingsPath);
      const raw = settings.googleSearchMcpConfig;
      const config = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : buildDefaultGoogleSearchMcpConfig();
      const baseUrl = typeof config.url === 'string' && config.url.trim().length > 0
        ? config.url.trim()
        : String(buildDefaultGoogleSearchMcpConfig().url);
      const healthPath = typeof config.healthcheckPath === 'string' && config.healthcheckPath.trim().length > 0
        ? config.healthcheckPath.trim()
        : '/health';
      const target = new URL(healthPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(target, { signal: controller.signal });
        res.json({
          success: true,
          target,
          googleSearchMcp: response.ok ? 'connected' : 'unreachable',
          status: response.status,
        });
      } catch (probeErr: any) {
        // A failed reach (service down / not in this profile set, DNS ENOTFOUND,
        // timeout) is "unreachable" — NOT a 500. The Settings panel renders this
        // as a normal status badge; a 500 here makes the whole panel look broken.
        logger.warn({ target, reason: probeErr?.message }, 'Google Search MCP unreachable');
        res.json({ success: true, target, googleSearchMcp: 'unreachable', reason: probeErr?.message });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err: any) {
      logger.error({ err }, 'Failed to probe Google Search MCP health');
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * @description Build GET handler for legacy `/api/config/llm` read compatibility.
 *
 * @param context - Shared route context
 * @returns Express handler for GET /api/config/llm
 */
function handleGetLegacyLlmConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      if (!fs.existsSync(context.configDir)) {
        fs.mkdirSync(context.configDir, { recursive: true });
      }
      if (fs.existsSync(context.legacyConfigPath)) {
        const config = JSON.parse(fs.readFileSync(context.legacyConfigPath, 'utf-8'));
        logger.info('LLM configuration loaded (legacy)');
        res.json(config);
        return;
      }
      logger.info('No LLM configuration found, returning defaults');
      res.json({ provider: '', model: '', apiKey: '' });
    } catch (err: any) {
      logger.error({ err }, 'Failed to load LLM config');
      res.status(500).json({ error: 'Failed to load configuration' });
    }
  };
}

/**
 * @description Build POST handler for legacy `/api/config/llm` write compatibility.
 *
 * @param context - Shared route context
 * @returns Express handler for POST /api/config/llm
 */
function handleSaveLegacyLlmConfig(context: ConfigRoutesContext) {
  return (req: Request, res: Response): void => {
    try {
      const { provider, model, apiKey } = req.body;
      if (!provider || !model) {
        res.status(400).json({ error: 'Provider and model are required' });
        return;
      }
      if (!fs.existsSync(context.configDir)) {
        fs.mkdirSync(context.configDir, { recursive: true });
      }
      const config = { provider, model, apiKey: apiKey || '' };
      fs.writeFileSync(context.legacyConfigPath, JSON.stringify(config, null, 2));
      if (provider === 'anthropic' && apiKey) {
        updateLegacyClineAnthropicConfig(model, apiKey);
      }
      logger.info({ provider, model }, 'LLM configuration saved (legacy)');
      res.json({ success: true, message: 'Configuration saved successfully', config });
    } catch (err: any) {
      logger.error({ err }, 'Failed to save LLM config');
      res.status(500).json({ error: 'Failed to save configuration' });
    }
  };
}

/**
 * @description Update legacy Cline config for Anthropic when legacy endpoint is used.
 *
 * @param model - Anthropic model identifier
 * @param apiKey - Anthropic API key
 */
function updateLegacyClineAnthropicConfig(model: string, apiKey: string): void {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  const clineDir = path.join(homeDir, '.cline');
  const clineConfigPath = path.join(clineDir, 'config.json');
  if (!fs.existsSync(clineDir)) {
    fs.mkdirSync(clineDir, { recursive: true });
  }
  const clineConfig = { apiProvider: 'anthropic', apiModelId: model, anthropicApiKey: apiKey };
  fs.writeFileSync(clineConfigPath, JSON.stringify(clineConfig, null, 2));
  logger.info('Cline CLI config updated for Anthropic provider');
}
