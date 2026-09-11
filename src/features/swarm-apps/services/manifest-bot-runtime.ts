/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Seed authoritative manifest runtime records without replacing operator selections.
 */
import type { Pool } from 'pg';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';
import { ApiProviderSchema } from '@/shared/types/api-provider';
import type { SwarmAppBotDeclaration, SwarmAppManifest } from '../types';
import { readBotSelectorSeed } from './swarm-app-manifest-mapping';

const logger = createChildLogger({ module: 'manifest-bot-runtime' });
export interface ManifestBotRuntimeDefaults { providerId: string; modelId?: string }
export type ManifestBotRuntimeDefaultsResolver = (providerId?: string) => ManifestBotRuntimeDefaults | undefined;

/** Package paths stay package-owned; only repository kernel manifests use repository-relative personas. */
function personaPath(bot: SwarmAppBotDeclaration, manifestPath: string): string | undefined {
  if (!bot.persona?.trim()) return undefined;
  const directory = dirname(resolve(manifestPath));
  const candidate = resolve(directory, bot.persona);
  const kernelRoot = resolve(process.cwd(), 'swarm-apps');
  const base = directory === kernelRoot ? process.cwd() : directory;
  const selected = existsSync(candidate) ? candidate : directory === kernelRoot ? resolve(base, bot.persona) : candidate;
  const boundary = relative(realpathSync(base), existsSync(selected) ? realpathSync(selected) : selected);
  if (boundary.startsWith('..') || resolve(base, boundary) !== resolve(selected)) {
    throw new Error(`Bot ${bot.name} persona must stay inside its owning package`);
  }
  return selected;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Existing persona files name harnesses while authoritative records name API providers. */
function providerName(value: unknown): unknown {
  if (value === 'codex' || value === 'codex-cli') return 'openai-codex';
  if (value === 'gemini-cli' || value === 'google-gemini') return 'gemini';
  return value;
}
function knownProvider(value: unknown): boolean {
  return ApiProviderSchema.safeParse(value).success || value === 'a2a' || value === 'noop';
}

/** Read only provider/model declarations: persona execution policy and credentials are never copied. */
function runtimeSeed(bot: SwarmAppBotDeclaration, path: string | undefined,
  defaults: ManifestBotRuntimeDefaultsResolver): ManifestBotRuntimeDefaults | undefined {
  const document = path && existsSync(path) ? yaml.load(readFileSync(path, 'utf8')) as { runtime?: unknown } | null : null;
  const runtime = document?.runtime;
  if (runtime !== undefined && (!runtime || typeof runtime !== 'object' || Array.isArray(runtime))) {
    throw new Error(`Bot ${bot.name} has an invalid persona runtime`);
  }
  const fields = (runtime ?? {}) as Record<string, unknown>;
  const provider = providerName(fields.providerId ?? fields.provider ?? fields.harness ?? bot.apiType);
  const model = fields.modelId ?? fields.model;
  if (provider !== undefined && !knownProvider(provider)) {
    throw new Error(`Bot ${bot.name} has an invalid runtime provider`);
  }
  if (model !== undefined && !nonEmpty(model)) throw new Error(`Bot ${bot.name} has an invalid runtime model`);
  const fallback = defaults(provider as string | undefined);
  const providerId = nonEmpty(provider) ?? nonEmpty(fallback?.providerId);
  if (!providerId) return undefined;
  if (!knownProvider(providerId)) throw new Error(`Bot ${bot.name} has an invalid default provider`);
  const modelId = nonEmpty(model) ?? (fallback?.providerId === providerId ? nonEmpty(fallback.modelId) : undefined);
  return { providerId, ...(modelId ? { modelId } : {}) };
}

/** Fill absent keys under PostgreSQL's conflict row lock; present blank/null/disabled values remain authoritative. */
export async function seedManifestBotRuntime(pool: Pool, agentId: string, seed: ManifestBotRuntimeDefaults): Promise<boolean> {
  const mergedValues = `CASE WHEN jsonb_typeof(agent_config.config_values) = 'object' THEN
    (CASE WHEN agent_config.config_values ? 'providerId'
               AND agent_config.config_values->'providerId' IS DISTINCT FROM EXCLUDED.config_values->'providerId'
          THEN EXCLUDED.config_values - 'modelId' ELSE EXCLUDED.config_values END) || agent_config.config_values
    ELSE agent_config.config_values END`;
  const result = await pool.query<{ config_values: Record<string, unknown> }>(
    `INSERT INTO agent_config (agent_id, config_values) VALUES ($1, $2::jsonb)
     ON CONFLICT (agent_id) DO UPDATE SET
       config_values = ${mergedValues},
       updated_at = CASE WHEN agent_config.config_values IS DISTINCT FROM (${mergedValues})
         THEN NOW() ELSE agent_config.updated_at END
     RETURNING config_values`,
    [agentId, JSON.stringify({ ...seed, configVersion: 1 })],
  );
  return Boolean(nonEmpty(result.rows[0]?.config_values?.providerId));
}

/** Agent registration and runtime persistence run before activation exposes the package for dispatch. */
export async function upsertManifestBots(pool: Pool, manifest: SwarmAppManifest, manifestPath: string,
  defaults?: ManifestBotRuntimeDefaultsResolver): Promise<void> {
  for (const bot of manifest.bots ?? []) {
    try {
      const path = personaPath(bot, manifestPath);
      const seed = defaults ? runtimeSeed(bot, path, defaults) : undefined;
      // Compatibility constructors retain their previous provider fallback; production injects deployment defaults.
      let providerId = seed?.providerId ?? (defaults ? undefined : process.env.FORCE_LLM_PROVIDER || 'openai-native');
      if (!providerId && defaults) {
        const existing = await pool.query<{ api_provider_id: string }>('SELECT api_provider_id FROM agents WHERE agent_id=$1', [bot.agentId]);
        providerId = nonEmpty(existing.rows[0]?.api_provider_id);
      }
      if (!providerId) throw new Error(`Authoritative runtime unavailable for bot ${bot.name}: no provider default`);
      const selectorSeed = readBotSelectorSeed({ ...bot, persona: path });
      const keywords = selectorSeed.routingKeywords.length ? selectorSeed.routingKeywords : bot.capabilities ?? [];
      const result = await pool.query<{ api_provider_id: string; model_id: string | null }>(
        `INSERT INTO agents (agent_id, name, api_provider_id, base_capabilities,
           base_selector_descriptor, base_routing_keywords, metadata, status, persona, model_id)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, 'active', $8::jsonb, $10)
         ON CONFLICT (agent_id) DO UPDATE SET
           name = EXCLUDED.name, base_capabilities = EXCLUDED.base_capabilities,
           base_selector_descriptor = CASE WHEN EXCLUDED.base_selector_descriptor <> ''
             THEN EXCLUDED.base_selector_descriptor ELSE agents.base_selector_descriptor END,
           base_routing_keywords = CASE WHEN COALESCE(array_length(EXCLUDED.base_routing_keywords, 1), 0) > 0
             THEN EXCLUDED.base_routing_keywords ELSE agents.base_routing_keywords END,
           metadata = agents.metadata || EXCLUDED.metadata,
           persona = CASE WHEN agents.persona = '{}'::jsonb OR agents.metadata->>'manifestApp' = $9
             THEN EXCLUDED.persona ELSE agents.persona END,
           status = 'active', updated_at = NOW()
         RETURNING api_provider_id, model_id`,
        [bot.agentId, bot.name, providerId, bot.capabilities ?? [], selectorSeed.selectorDescriptor, keywords,
          JSON.stringify({ role: bot.role ?? '', manifestApp: manifest.name, persona: bot.persona ?? '',
            ...(bot.jarvisMode ? { jarvisMode: bot.jarvisMode } : {}) }),
          JSON.stringify({ role: bot.role ?? '', systemPrompt: bot.persona ?? '', capabilities: bot.capabilities ?? [],
            selectorDescriptor: selectorSeed.selectorDescriptor, routingKeywords: keywords }), manifest.name, seed?.modelId ?? null],
      );
      if (defaults) {
        const saved = result.rows[0];
        if (!saved?.api_provider_id) throw new Error(`Authoritative runtime unavailable for bot ${bot.name}`);
        const modelId = saved.model_id ?? (saved.api_provider_id === seed?.providerId ? seed.modelId : undefined);
        const available = await seedManifestBotRuntime(pool, bot.agentId, {
          providerId: saved.api_provider_id, ...(modelId !== undefined ? { modelId } : {}),
        });
        if (!available) logger.warn({ agentId: bot.agentId }, 'Authoritative bot runtime remains unavailable; explicit stored selection preserved');
      }
    } catch (err) {
      logger.error({ err, agentId: bot.agentId, name: bot.name }, 'Bot registration failed');
      if (defaults) throw err;
    }
  }
}
