/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — seeds persona YAML authorizations into agent_tools on startup
 */

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
// NOTE: Direct import required because swarm-orchestration barrel has a pre-existing type error
// in llm-execution-handler.ts that breaks barrel resolution. Revert to barrel import when fixed.
import { loadPersonaFromFile, type BotPersona } from '@/features/swarm-orchestration';

const logger = createChildLogger({ module: 'persona-authorization-seeder' });

/** @description Valid tool authorization modes matching the agent_tools.auth_mode CHECK constraint. */
const VALID_AUTH_MODES = new Set(['auto', 'ask', 'off']);
const AUTH_MODE_ALIASES = new Map<string, string>([
  ['approval', 'ask'],
  ['approve', 'ask'],
  ['manual', 'ask'],
  ['prompt', 'ask'],
  ['confirm', 'ask'],
  ['confirmation', 'ask'],
  ['enabled', 'auto'],
  ['true', 'auto'],
  ['disabled', 'off'],
  ['blocked', 'off'],
  ['false', 'off'],
]);

/**
 * @description Seeds persona YAML `authorizations` into the `agent_tools` table on startup.
 * Uses INSERT ... ON CONFLICT DO NOTHING so that manually-configured auth modes
 * (set via the config UI) are never overwritten by persona defaults.
 *
 * Flow:
 * 1. Reads `BOT_PERSONA_FILE` env var → loads persona YAML via PersonaFileLoader
 * 2. For each tool in `persona.authorizations`, resolves tool name → tool_id from the `tools` table
 * 3. Upserts into `agent_tools` with ON CONFLICT DO NOTHING (first-write wins)
 *
 * @param pool - Shared PostgreSQL pool.
 * @param agentId - The agent UUID for this bot instance.
 * @returns Count of newly seeded tool authorizations.
 */
export async function seedPersonaAuthorizations(pool: Pool, agentId: string, personaFilePath?: string): Promise<number> {
  // An explicit per-bot persona path (e.g. from a swarm-app manifest) wins over the
  // process-level BOT_PERSONA_FILE — without it, seeding multiple bots in one process
  // (the api) would seed every bot from the api's own persona (project-manager).
  const personaFile = personaFilePath ?? process.env.BOT_PERSONA_FILE;
  if (!personaFile) {
    logger.info('No BOT_PERSONA_FILE set — skipping persona authorization seeding');
    return 0;
  }

  let persona: BotPersona | null;
  try {
    // Prefer the explicit file path (BOT_PERSONA_FILE) — loadPersonaFromFile handles absolute paths
    // directly. Fall back to agentId lookup for containers that don't set BOT_PERSONA_FILE.
    persona = loadPersonaFromFile(personaFile ?? agentId);
  } catch (err) {
    logger.warn({ err, personaFile }, 'Failed to load persona file — skipping authorization seeding');
    return 0;
  }

  if (!persona) {
    logger.warn({ personaFile }, 'Persona file returned null — skipping authorization seeding');
    return 0;
  }

  const authorizations = persona.authorizations;
  if (!authorizations || Object.keys(authorizations).length === 0) {
    logger.info({ agentId, personaFile }, 'Persona has no authorizations — nothing to seed');
    return 0;
  }

  const toolNames = Object.keys(authorizations);
  // Persona YAMLs use snake_case (aws_cli), registry uses kebab-case (aws-cli).
  // Build both variants for lookup.
  const allVariants = new Set<string>();
  for (const name of toolNames) {
    allVariants.add(name);
    allVariants.add(name.replace(/_/g, '-'));
  }

  logger.info(
    { agentId, personaFile, toolCount: toolNames.length },
    'Seeding persona authorizations into agent_tools',
  );

  const toolLookup = await resolveToolIds(pool, [...allVariants]);
  let seeded = 0;

  for (const [toolName, authMode] of Object.entries(authorizations)) {
    const normalizedMode = normalizeAuthMode(authMode);
    if (!VALID_AUTH_MODES.has(normalizedMode)) {
      logger.warn(
        { agentId, toolName, authMode },
        'Invalid auth mode in persona — skipping tool',
      );
      continue;
    }

    // Try exact name first, then kebab-case variant
    const toolId = toolLookup.get(toolName) ?? toolLookup.get(toolName.replace(/_/g, '-'));
    if (!toolId) {
      logger.debug(
        { agentId, toolName },
        'Tool not found in registry — skipping (may not be seeded yet)',
      );
      continue;
    }

    const inserted = await upsertAuthMode(pool, agentId, toolId, normalizedMode);
    if (inserted) {
      seeded++;
    }
  }

  logger.info(
    { agentId, seeded, total: toolNames.length, resolved: toolLookup.size },
    'Persona authorization seeding complete',
  );

  return seeded;
}

/**
 * @description Resolves tool names to tool_ids from the tools table.
 * @param pool - Database pool.
 * @param toolNames - Array of tool names from persona authorizations.
 * @returns Map of tool_name → tool_id.
 */
async function resolveToolIds(pool: Pool, toolNames: string[]): Promise<Map<string, string>> {
  if (toolNames.length === 0) return new Map();

  const result = await pool.query<{ name: string; tool_id: string }>(
    `SELECT name, tool_id FROM tools WHERE name = ANY($1::text[])`,
    [toolNames],
  );

  const lookup = new Map<string, string>();
  for (const row of result.rows) {
    lookup.set(row.name, row.tool_id);
  }

  const missing = toolNames.filter((n) => !lookup.has(n));
  if (missing.length > 0) {
    logger.debug({ missing }, 'Some persona tools not found in registry');
  }

  return lookup;
}

/**
 * @description Inserts an agent_tools record with ON CONFLICT DO NOTHING.
 * This ensures persona defaults are only written when no record exists,
 * preserving any manual overrides set via the config UI.
 * @param pool - Database pool.
 * @param agentId - Agent UUID.
 * @param toolId - Tool UUID.
 * @param authMode - Authorization mode (auto | ask | off).
 * @returns True if a new row was inserted, false if it already existed.
 */
async function upsertAuthMode(
  pool: Pool,
  agentId: string,
  toolId: string,
  authMode: string,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO agent_tools (agent_id, tool_id, auth_mode, installed, install_verified)
     VALUES ($1, $2, $3, false, false)
     ON CONFLICT (agent_id, tool_id) DO NOTHING`,
    [agentId, toolId, authMode],
  );

  return (result.rowCount ?? 0) > 0;
}

function normalizeAuthMode(value: unknown): string {
  const normalized = String(value).toLowerCase().trim();
  return AUTH_MODE_ALIASES.get(normalized) ?? normalized;
}
