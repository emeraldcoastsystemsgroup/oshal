/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted seedAgentProfile from index.ts (1000-line governance cap — same treatment as swarm-runtime-registry). Carries the ADR-083 fix: the boot seed reads selector_descriptor / routing_keywords from the persona YAML instead of dumping `perspective` as the selector and capabilities as keywords — the declaration defect that made owners bid mud on their own domains on fresh deployments.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the boot self-seed body in runWithSystemIdentity — the identity-less upsert to the global `agents` table must stamp operator under OSHAL_DB_GUC_STRICT=deny (guc warn-audit site).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { AgentProfileRepository } from '@/entities/agent';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { SwarmRuntimeIdentity } from './swarm-bot-registry';

const logger = createChildLogger({ module: 'agent-profile-boot-seeder' });

/**
 * @description Auto-seeds this bot into the Postgres agents table on startup.
 * The router uses the agents table to find routing candidates. Without this,
 * dynamically added bots (new YAML + compose service) are invisible to the router.
 * Uses ON CONFLICT to upsert — safe to call on every boot.
 * @param pool - Postgres pool (skips silently when absent — DB-less dev).
 * @param runtimeIdentity - This container's resolved bot identity.
 */
export async function seedAgentProfile(
  pool: Pool | null | undefined,
  runtimeIdentity: SwarmRuntimeIdentity,
): Promise<void> {
  if (!pool) return;
  // Boot self-seed with no request in scope — trusted SYSTEM so the global `agents` upsert stamps
  // operator under OSHAL_DB_GUC_STRICT=deny (else RLS scopes the identity-less write to nothing).
  return runWithSystemIdentity(async () => {
  const repo = new AgentProfileRepository(pool);

  const { agentId, agentName, capabilities } = runtimeIdentity;

  // The agents table uses UUID for agent_id. If this bot's ID isn't a valid UUID
  // (e.g. "architect-bot"), we can't query by it. Check by name instead.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId);

  try {
    if (isUuid) {
      const existing = await repo.getAgentProfile(agentId);
      if (existing) {
        logger.debug({ agentId, agentName }, 'Agent profile already exists in Postgres — skipping seed');
        return;
      }
    } else {
      // Check by name for non-UUID agents
      const allAgents = await repo.listAgents();
      const existingByName = allAgents.find((a) => a.name === agentName);
      if (existingByName) {
        logger.debug({ agentId, agentName }, 'Agent profile already exists by name — skipping seed');
        return;
      }
    }
  } catch (err) {
    logger.debug({ agentId, err: (err as Error).message }, 'Agent profile lookup failed — will attempt creation');
  }

  // Load routing declarations from the persona YAML if available. ADR-083: prefer the
  // crisp selector_descriptor + routing_keywords fields — dumping `perspective` as the
  // selector (and capabilities as keywords, below) was the declaration defect that made
  // owners bid mud on their own domains.
  let selectorDescriptor = `${agentName} agent`;
  let routingKeywords: string[] = capabilities;
  try {
    const personaPath = process.env.BOT_PERSONA_FILE;
    if (personaPath && require('fs').existsSync(personaPath)) {
      const yaml = require('js-yaml');
      const parsed = yaml.load(require('fs').readFileSync(personaPath, 'utf-8'));
      const declaredSelector = parsed?.selector_descriptor ?? parsed?.selectorDescriptor;
      if (declaredSelector) {
        selectorDescriptor = String(declaredSelector).trim().slice(0, 500);
      } else if (parsed?.perspective) {
        selectorDescriptor = String(parsed.perspective).slice(0, 500);
      }
      const declaredKeywords = parsed?.routing_keywords ?? parsed?.routingKeywords;
      if (Array.isArray(declaredKeywords) && declaredKeywords.length > 0) {
        routingKeywords = declaredKeywords
          .filter((k: unknown): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k: string) => k.trim());
      }
    }
  } catch { /* best effort */ }

  // Use direct SQL with the runtime agent_id so the cockpit can look up the profile
  // by the same UUID the bot announces on the mesh. repo.createAgent() lets Postgres
  // auto-generate the UUID which causes a mismatch.
  if (isUuid) {
    await pool.query(`
      INSERT INTO agents (agent_id, name, status, api_provider_id, persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata)
      VALUES ($1::uuid, $2, 'active', 'auto', $3::jsonb, $4::text[], $5, $6::text[], $7::jsonb)
      ON CONFLICT (agent_id) DO UPDATE SET
        name = EXCLUDED.name, status = EXCLUDED.status,
        base_capabilities = EXCLUDED.base_capabilities,
        base_selector_descriptor = EXCLUDED.base_selector_descriptor,
        base_routing_keywords = EXCLUDED.base_routing_keywords,
        metadata = EXCLUDED.metadata
    `, [
      agentId,
      agentName,
      JSON.stringify({ name: agentName, agentId, role: process.env.BOT_ROLE || 'localhost/worker' }),
      capabilities,
      selectorDescriptor,
      routingKeywords,
      JSON.stringify({ autoSeeded: true, bootTime: new Date().toISOString() }),
    ]);
  } else {
    await repo.createAgent({
      name: agentName,
      status: 'active',
      apiProviderId: 'auto',
      modelId: undefined,
      persona: { name: agentName, agentId, role: process.env.BOT_ROLE || 'localhost/worker' },
      baseCapabilities: capabilities,
      baseSelectorDescriptor: selectorDescriptor,
      baseRoutingKeywords: routingKeywords,
      metadata: { autoSeeded: true, bootTime: new Date().toISOString() },
    });
  }

  logger.info({ agentId, agentName, capabilities }, 'Auto-seeded agent profile into Postgres agents table');
  });
}
