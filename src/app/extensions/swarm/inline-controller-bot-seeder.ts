/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped seedInlineControllerBotProfiles in runWithSystemIdentity — the identity-less boot upserts to the global `agents` table must stamp operator under OSHAL_DB_GUC_STRICT=deny (guc warn-audit site). (File had no change-log block; added.)
 */

import type { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { isControllerInlineContainer } from '@/features/agent-management';
import { getActiveRegistry, type SwarmBotDefinition } from './swarm-bot-registry';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'inline-controller-bot-seeder' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PersonaSeed {
  name?: unknown;
  role?: unknown;
  perspective?: unknown;
  capabilities?: unknown;
  selector_descriptor?: unknown;
  selectorDescriptor?: unknown;
  routing_keywords?: unknown;
  routingKeywords?: unknown;
}

export interface InlineControllerBotProfileSeed {
  agentId: string;
  name: string;
  role: string;
  apiProviderId: string;
  capabilities: string[];
  selectorDescriptor: string;
  routingKeywords: string[];
  persona: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Inline concierge bots run inside the controller, so they do not get the normal
 * per-container "seed myself" boot path. Seed their selector rows from registry
 * plus persona YAML so selector composition works after any API bounce.
 */
export async function seedInlineControllerBotProfiles(pool?: Pool | null): Promise<number> {
  if (!pool) return 0;
  // Boot seed with no request in scope — trusted SYSTEM so the global `agents` upserts stamp
  // operator under OSHAL_DB_GUC_STRICT=deny (else RLS scopes the identity-less writes to nothing).
  return runWithSystemIdentity(async () => {
  const bots = getActiveRegistry().filter((bot) => isControllerInlineContainer(bot.container));
  let seeded = 0;

  for (const bot of bots) {
    const seed = buildInlineControllerBotProfileSeed(bot, loadPersonaSeed(bot.name));
    if (!seed) continue;
    try {
      await upsertInlineControllerBot(pool, seed);
      seeded += 1;
    } catch (err) {
      logger.warn({ err, agentId: seed.agentId, name: seed.name }, 'Failed to seed inline controller bot profile');
    }
  }

  logger.info({ seeded, candidateCount: bots.length }, 'Seeded inline controller bot profiles');
  return seeded;
  });
}

export function buildInlineControllerBotProfileSeed(
  bot: SwarmBotDefinition,
  personaSeed: PersonaSeed | null,
): InlineControllerBotProfileSeed | null {
  const agentId = typeof bot.agentId === 'string' ? bot.agentId.trim() : '';
  if (!UUID_RE.test(agentId) || !isControllerInlineContainer(bot.container)) return null;

  const personaCapabilities = readStringArray(personaSeed?.capabilities);
  const capabilities = mergeStrings(personaCapabilities, bot.capabilities);
  const selectorDescriptor = firstNonEmptyString(
    personaSeed?.selector_descriptor,
    personaSeed?.selectorDescriptor,
    personaSeed?.perspective,
    `Select this bot for ${bot.name} tasks.`,
  );
  const routingKeywords = mergeStrings(
    readStringArray(personaSeed?.routing_keywords ?? personaSeed?.routingKeywords),
    capabilities,
  );
  const role = firstNonEmptyString(personaSeed?.role, bot.role, 'controller-inline');
  const systemPrompt = firstNonEmptyString(personaSeed?.perspective, selectorDescriptor);

  return {
    agentId,
    name: bot.name,
    role,
    apiProviderId: bot.apiType ?? process.env.FORCE_LLM_PROVIDER ?? 'auto',
    capabilities,
    selectorDescriptor,
    routingKeywords,
    persona: {
      name: bot.name,
      agentId,
      role,
      systemPrompt,
      capabilities,
      selectorDescriptor,
      routingKeywords,
    },
    metadata: {
      autoSeeded: true,
      inlineControllerBot: true,
      registryContainer: bot.container,
      registryRole: bot.role,
      harnessType: bot.harnessType ?? '',
      bootTime: new Date().toISOString(),
    },
  };
}

async function upsertInlineControllerBot(pool: Pool, seed: InlineControllerBotProfileSeed): Promise<void> {
  await pool.query(
    `
      INSERT INTO agents (
        agent_id, name, status, api_provider_id, persona,
        base_capabilities, base_selector_descriptor, base_routing_keywords,
        computed_capabilities, computed_selector_descriptor, computed_routing_keywords,
        metadata
      )
      VALUES (
        $1::uuid, $2, 'active', $3, $4::jsonb,
        $5::text[], $6, $7::text[],
        $5::text[], $6, $7::text[],
        $8::jsonb
      )
      ON CONFLICT (agent_id) DO UPDATE SET
        name = EXCLUDED.name,
        status = 'active',
        api_provider_id = EXCLUDED.api_provider_id,
        base_capabilities = EXCLUDED.base_capabilities,
        base_selector_descriptor = EXCLUDED.base_selector_descriptor,
        base_routing_keywords = EXCLUDED.base_routing_keywords,
        computed_capabilities = CASE
          WHEN COALESCE(array_length(agents.computed_capabilities, 1), 0) = 0
            THEN EXCLUDED.computed_capabilities
          ELSE agents.computed_capabilities
        END,
        computed_selector_descriptor = CASE
          WHEN COALESCE(NULLIF(agents.computed_selector_descriptor, ''), '') = ''
            THEN EXCLUDED.computed_selector_descriptor
          ELSE agents.computed_selector_descriptor
        END,
        computed_routing_keywords = CASE
          WHEN COALESCE(array_length(agents.computed_routing_keywords, 1), 0) = 0
            THEN EXCLUDED.computed_routing_keywords
          ELSE agents.computed_routing_keywords
        END,
        persona = CASE
          WHEN agents.persona = '{}'::jsonb OR agents.metadata->>'inlineControllerBot' = 'true'
            THEN EXCLUDED.persona
          ELSE agents.persona
        END,
        metadata = agents.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      seed.agentId,
      seed.name,
      seed.apiProviderId,
      JSON.stringify(seed.persona),
      seed.capabilities,
      seed.selectorDescriptor,
      seed.routingKeywords,
      JSON.stringify(seed.metadata),
    ],
  );
}

function loadPersonaSeed(botName: string): PersonaSeed | null {
  const personaPath = path.resolve(process.cwd(), 'ai-lab', 'bot-personas', `${botName}.yaml`);
  if (!existsSync(personaPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    return yaml.load(readFileSync(personaPath, 'utf8')) as PersonaSeed;
  } catch (err) {
    logger.warn({ err, botName, personaPath }, 'Failed to read inline bot persona seed');
    return null;
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return mergeStrings(value.filter((item): item is string => typeof item === 'string'));
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function mergeStrings(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}
