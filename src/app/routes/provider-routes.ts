/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — GET /api/providers returns all available LLM providers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | GET /api/providers/access — the embedded LLM providers (any-bot connectors, run under the Cline wrapper / provider registry — no harness wrappers) + per-provider auth kind + whether a key is configured. Powers the Utilities "Bot LLM access" roster.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | GET /api/providers/access now returns models, configKeys, the persisted-secret configured status, the active provider, and each provider's saved model — so the Utilities panel can actually enter keys + pick models, not just display status.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: pooled Codex availability derives from the live vendor auth source or an explicit platform API key, never a stale static config-seed OAuth copy.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  ProviderRegistry,
  getAllProviders,
  getProvider,
  getDefaultModel,
  getProvidersForAgent,
  hasLiveCodexAuth,
} from '@/features/llm-provider';
import { createChildLogger } from '@/shared/logger';

const registry = new ProviderRegistry();
const logger = createChildLogger({ module: 'provider-routes' });

/** How each embedded provider authenticates + the env var(s) that mean "configured". */
const PROVIDER_ACCESS: Record<string, { kind: 'api-key' | 'oauth' | 'local'; env?: string[]; note: string }> = {
  anthropic: { kind: 'api-key', env: ['ANTHROPIC_API_KEY'], note: 'API key' },
  'claude-code': { kind: 'oauth', note: 'Claude Code login (below) — OAuth, works remotely' },
  openai: { kind: 'api-key', env: ['OPENAI_API_KEY'], note: 'API key' },
  'openai-native': { kind: 'api-key', env: ['OPENAI_API_KEY'], note: 'API key' },
  'openai-codex': { kind: 'oauth', env: ['OPENAI_API_KEY'], note: 'ChatGPT login (~/.codex, local-only) or OPENAI_API_KEY' },
  gemini: { kind: 'api-key', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], note: 'API key' },
  openrouter: { kind: 'api-key', env: ['OPENROUTER_API_KEY'], note: 'API key' },
  deepseek: { kind: 'api-key', env: ['DEEPSEEK_API_KEY'], note: 'API key' },
  qwen: { kind: 'api-key', env: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], note: 'API key' },
  'qwen-code': { kind: 'oauth', env: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], note: 'Qwen login or key' },
  bedrock: { kind: 'api-key', env: ['AWS_ACCESS_KEY_ID'], note: 'AWS creds' },
  vertex: { kind: 'api-key', env: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY'], note: 'GCP creds' },
  ollama: { kind: 'local', note: 'Local — Ollama, no key' },
  lmstudio: { kind: 'local', note: 'Local — LM Studio, no key' },
  litellm: { kind: 'local', note: 'Local proxy, no key' },
};

/** Minimal provider shape consumed from the registry. */
interface RegistryProvider {
  id: string;
  displayName?: string;
  name?: string;
  defaultModelId?: string;
  requiresApiKey?: boolean;
  configKeys?: string[];
  models?: Array<{ id: string; name?: string }>;
}

/**
 * @description Reads + parses a JSON file, returning an empty object on any failure.
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed object or empty object
 */
function readJsonSafe(filePath: string): Record<string, unknown> {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch (err) {
    logger.warn({ err, filePath }, 'Could not read JSON for provider access');
  }
  return {};
}

/**
 * @description Loads persisted global secrets so the panel can report which providers
 * already have a key on file (not just which have an env var set).
 * @returns Map of secret key → value (string entries only)
 */
function loadPersistedSecrets(): Record<string, unknown> {
  try {
    const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptedConfigManager } = require('../../../src/api/encrypted-config-manager');
    const mgr = new EncryptedConfigManager(configDir, process.env.ENCRYPTION_KEY || null);
    return mgr.loadSecrets() as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, 'Could not load persisted secrets for provider access');
    return {};
  }
}

/** Resolves the active provider + persisted model from saved global config. */
interface ActiveSelection {
  provider: string | null;
  models: Record<string, string>;
}

/**
 * @description Reads the active provider and per-provider saved models from global-config.json.
 * @returns Active provider id (or null when none set) + a provider→model map
 */
function readActiveSelection(): ActiveSelection {
  const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
  const settings = readJsonSafe(path.join(configDir, 'global-config.json'));
  const provider = [settings.actModeApiProvider, settings.planModeApiProvider, settings.provider]
    .find((v) => typeof v === 'string' && (v as string).trim().length > 0) as string | undefined;
  const prefs = settings.providerModelPreferences;
  const models = prefs && typeof prefs === 'object' && !Array.isArray(prefs)
    ? prefs as Record<string, string>
    : {};
  return { provider: provider || null, models };
}

/**
 * @description Whether a provider has a usable key/credential — env var OR persisted secret.
 * @param providerId - Provider id
 * @param access - Static access descriptor for the provider
 * @param configKeys - Provider secret field names from the registry
 * @param secrets - Persisted global secrets
 * @returns True when the provider is configured
 */
function isConfigured(
  providerId: string,
  access: { kind: string; env?: string[] },
  configKeys: string[],
  secrets: Record<string, unknown>,
): boolean {
  if (access.kind === 'local') return true;
  const envSet = !!(access.env && access.env.some((e) => !!process.env[e]));
  if (envSet) return true;
  return configKeys.some((k) => typeof secrets[k] === 'string' && (secrets[k] as string).trim().length > 0);
}

/** @description One provider in the framework's authoritative roster (mirrors GET /api/providers/access). */
export interface ConfiguredProvider {
  id: string;
  label: string;
  kind: 'api-key' | 'oauth' | 'local';
  note: string;
  configured: boolean;
  requiresApiKey: boolean;
  secretKey: string | null;
  models: Array<{ id: string; name: string }>;
  defaultModelId: string;
  selectedModel: string;
  active: boolean;
}

/**
 * @description The framework's authoritative LLM-provider roster — the SAME data the Utilities
 * "Bot LLM access" panel renders (GET /api/providers/access): every registry provider with its auth
 * kind, whether it's actually configured (env/persisted key, or local), its models, and which one is
 * the active/default login. This is the single source of truth any in-framework surface (e.g. the
 * Token Chase optimizer) should read instead of inventing its own credential detection.
 * @returns The provider roster + the active provider id.
 */
export function listConfiguredProviders(): { providers: ConfiguredProvider[]; activeProvider: string | null } {
  const all = registry.getAll() as RegistryProvider[];
  const secrets = loadPersistedSecrets();
  const { provider: activeProvider, models: savedModels } = readActiveSelection();

  const providers: ConfiguredProvider[] = all.map((p) => {
    const a = PROVIDER_ACCESS[p.id] || { kind: 'api-key' as const, note: 'API key' };
    const configKeys = Array.isArray(p.configKeys) ? p.configKeys : [];
    const models = Array.isArray(p.models) ? p.models.map((m) => ({ id: m.id, name: m.name || m.id })) : [];
    const secretKey = configKeys.find((k) => /key|secret|token/i.test(k)) || configKeys[0] || null;
    return {
      id: p.id,
      label: p.displayName || p.name || p.id,
      kind: a.kind,
      note: a.note,
      configured: isConfigured(p.id, a, configKeys, secrets),
      requiresApiKey: !!p.requiresApiKey,
      secretKey,
      models,
      defaultModelId: p.defaultModelId || (models[0] && models[0].id) || '',
      selectedModel: savedModels[p.id] || '',
      active: activeProvider === p.id,
    };
  });

  return { providers, activeProvider };
}

/** @description The platform-shared "free" model offered to keyless users, or null when none is pooled. */
export interface FreeModel {
  available: boolean;
  provider: string;
  model: string;
  label: string;
}

/**
 * @description Resolves whether a pooled platform LLM is available to offer keyless users as a
 * "free" option. Backed by the live operator Codex auth source or a platform OPENAI_API_KEY.
 * Returns ONLY availability + provider/model — never any secret value,
 * so the wizard can show the option without exposing keys.
 * @returns Free-model descriptor; `available:false` when nothing is pooled.
 */
export function resolveFreeModel(): FreeModel {
  const provider = process.env.FREE_SHARED_PROVIDER || 'openai-codex';
  const model = process.env.FREE_SHARED_MODEL || 'gpt-5.3-codex';
  const label = process.env.FREE_SHARED_LABEL || 'OSHAL free model';

  // Explicit opt-out for operators who don't want to pool their credentials.
  if (process.env.FREE_SHARED_MODEL_ENABLED === 'false') {
    return { available: false, provider, model, label };
  }

  const hasPooledCodex = hasLiveCodexAuth();
  const hasPlatformKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);

  return { available: hasPooledCodex || hasPlatformKey, provider, model, label };
}

/**
 * @description Creates provider registry routes.
 * @returns Express router with provider endpoints
 */
export function createProviderRoutes(): Router {
  const router = Router();

  /**
   * @openapi
   * /api/providers:
   *   get:
   *     summary: Get all available LLM providers and their models
   *     tags:
   *       - Providers
   *     responses:
   *       200:
   *         description: List of provider metadata
   */
  router.get('/', (_req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info('GET /api/providers');
    const providers = registry.getAll();
    logger.info({ providerCount: providers.length, durationMs: Date.now() - startedAt }, 'GET /api/providers complete');
    res.json(providers);
  });

  /** GET /access — embedded providers + auth kind + models + configured status + active selection. */
  router.get('/access', (_req: Request, res: Response) => {
    const { providers, activeProvider } = listConfiguredProviders();
    res.json({
      providers,
      activeProvider,
      hasActive: !!activeProvider,
      // The platform-shared "free" model: available to brand-new users with no key of their own,
      // backed by the operator's pooled credentials. Keys are NEVER returned — only availability.
      freeModel: resolveFreeModel(),
      runtimeNote: 'Embedded in any-bot — run under the Cline CLI wrapper / provider registry. Enter your API key and pick a model; the first provider you set up becomes the default. Claude Code / Codex use the OAuth login above.',
    });
  });

  /**
   * @openapi
   * /api/providers/catalog:
   *   get:
   *     summary: Get the full provider catalog with model groups and credential requirements
   *     description: >
   *       Returns the 26-provider catalog ported from any-bot LLMProviderRegistry.js.
   *       Includes model groups, required credential keys, Cline provider mapping, and
   *       agent compatibility. Used by cockpit UI for provider/model dropdown population.
   *     tags:
   *       - Providers
   *     parameters:
   *       - in: query
   *         name: agent
   *         schema:
   *           type: string
   *         description: Filter to providers compatible with a specific agent (cline, claude-code, codex)
   */
  router.get('/catalog', (req: Request, res: Response) => {
    const startedAt = Date.now();
    const agentFilter = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    logger.info({ agentFilter: agentFilter || null }, 'GET /api/providers/catalog');

    let providers = getAllProviders();

    if (agentFilter) {
      const validIds = new Set(getProvidersForAgent(agentFilter));
      providers = providers.filter((p) => validIds.has(p.id));
    }

    logger.info({ providerCount: providers.length, durationMs: Date.now() - startedAt }, 'GET /api/providers/catalog complete');
    res.json({ success: true, providers });
  });

  /**
   * @openapi
   * /api/providers/catalog/{providerId}:
   *   get:
   *     summary: Get a specific provider with its model groups
   *     tags:
   *       - Providers
   */
  router.get('/catalog/:providerId', (req: Request, res: Response) => {
    const providerId = String(req.params.providerId);
    const provider = getProvider(providerId);
    if (!provider) {
      res.status(404).json({ success: false, error: `Provider '${providerId}' not found` });
      return;
    }
    const defaultModelId = getDefaultModel(providerId);
    res.json({ success: true, provider, defaultModel: defaultModelId });
  });

  logger.info('Provider routes registered (including catalog)');
  return router;
}
