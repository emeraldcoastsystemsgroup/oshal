/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentConfigService — Postgres-backed per-agent config store
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { ConfigField } from './capability-expansion-service';

const logger = createChildLogger({ module: 'agent-config-service' });
const REPO_ROOT = path.resolve(process.cwd());
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');

/**
 * @description Optional human-facing setup guide attached to an agent's config,
 * sourced from a Markdown doc under the repo's docs/ directory and surfaced in
 * admin config screens.
 */
export interface AgentConfigGuide {
  title: string;
  summary?: string;
  docPath: string;
  content?: string;
}

/**
 * @description Per-agent configuration record from the agent_config table.
 */
export interface AgentConfig {
  configId: string | null;
  agentId: string;
  schema: ConfigField[];
  values: Record<string, unknown>;
  updatedAt: string;
  configGuide?: AgentConfigGuide;
}

/**
 * @description Postgres-backed per-agent configuration store.
 * Replaces the legacy implementation's Redis-backed AgentConfigManager.
 *
 * Each agent can have a config schema (field definitions) and config values
 * (actual credentials/settings). The schema drives UI rendering for admin
 * config screens; the values are injected into the agent's execution context.
 */
export class AgentConfigService {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Gets the full config (schema + values) for an agent.
   * @param agentId - Agent identifier
   * @returns Config record, or null if no config exists
   */
  async getConfig(agentId: string): Promise<AgentConfig | null> {
    const resolvedAgentId = await this.resolveAgentId(agentId);
    if (!resolvedAgentId) return null;

    const result = await this.pool.query(
      `SELECT
         ac.config_id,
         a.agent_id,
         ac.config_schema,
         ac.config_values,
         COALESCE(ac.updated_at, a.updated_at) AS updated_at,
         a.metadata
       FROM agents a
       LEFT JOIN agent_config ac ON ac.agent_id = a.agent_id
       WHERE a.agent_id = $1`,
      [resolvedAgentId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as Record<string, unknown>;
    const configGuide = readAgentConfigGuide(row.metadata);
    return {
      configId: (row.config_id as string | null) ?? null,
      agentId: row.agent_id as string,
      schema: (row.config_schema as ConfigField[]) || [],
      values: (row.config_values as Record<string, unknown>) || {},
      updatedAt: (row.updated_at as Date).toISOString(),
      ...(configGuide ? { configGuide } : {}),
    };
  }

  /**
   * @description Sets or replaces the config schema for an agent.
   * This defines what fields the agent needs configured (API keys, URLs, etc.).
   * Upserts — creates the record if it doesn't exist.
   * @param agentId - Agent identifier
   * @param schema - Array of config field definitions
   */
  async setConfigSchema(agentId: string, schema: ConfigField[]): Promise<void> {
    const resolvedAgentId = await this.requireAgentId(agentId);
    await this.pool.query(
      `INSERT INTO agent_config (agent_id, config_schema)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET
         config_schema = EXCLUDED.config_schema,
         updated_at = NOW()`,
      [resolvedAgentId, JSON.stringify(schema)],
    );

    logger.info({ agentId: resolvedAgentId, fieldCount: schema.length }, 'Config schema set');
  }

  /**
   * @description Sets config values for an agent. Merges with existing values.
   * @param agentId - Agent identifier
   * @param values - Key-value pairs to set
   */
  async setConfigValues(agentId: string, values: Record<string, unknown>): Promise<void> {
    const resolvedAgentId = await this.requireAgentId(agentId);
    // Merge with existing values (JSONB || operator)
    await this.pool.query(
      `INSERT INTO agent_config (agent_id, config_values)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET
         config_values = agent_config.config_values || EXCLUDED.config_values,
         updated_at = NOW()`,
      [resolvedAgentId, JSON.stringify(values)],
    );

    logger.info({ agentId: resolvedAgentId, keys: Object.keys(values) }, 'Config values set');
  }

  /**
   * @description Gets a single config value for an agent.
   * @param agentId - Agent identifier
   * @param key - Config key name
   * @returns Value or undefined
   */
  async getConfigValue(agentId: string, key: string): Promise<unknown> {
    const config = await this.getConfig(agentId);
    return config?.values[key];
  }

  /**
   * @description Deletes all config for an agent.
   * @param agentId - Agent identifier
   * @returns True if deleted
   */
  async deleteConfig(agentId: string): Promise<boolean> {
    const resolvedAgentId = await this.resolveAgentId(agentId);
    if (!resolvedAgentId) {
      return false;
    }

    const result = await this.pool.query(
      'DELETE FROM agent_config WHERE agent_id = $1',
      [resolvedAgentId],
    );
    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      logger.info({ agentId: resolvedAgentId }, 'Agent config deleted');
    }
    return deleted;
  }

  /**
   * @description Lists all agents that have config registered.
   * @returns Array of agent IDs with config
   */
  async listConfiguredAgents(): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT agent_id FROM agent_config ORDER BY agent_id',
    );
    return result.rows.map((r) => (r as Record<string, unknown>).agent_id as string);
  }

  /**
   * @description Resolves a route-supplied agent reference into the canonical UUID.
   * Accepts either UUID text or the stable agent name to make config flows easier.
   * @param agentRef - Agent UUID or bot name.
   * @returns Canonical UUID string when the agent exists.
   */
  private async resolveAgentId(agentRef: string): Promise<string | null> {
    const normalizedRef = agentRef.trim();
    if (!normalizedRef) {
      return null;
    }

    const result = await this.pool.query<{ agent_id: string }>(
      `SELECT agent_id::text AS agent_id
       FROM agents
       WHERE agent_id::text = $1 OR lower(name) = lower($1)
       LIMIT 1`,
      [normalizedRef],
    );

    return result.rows[0]?.agent_id ?? null;
  }

  /**
   * @description Resolves an agent reference or throws when no such agent exists.
   * @param agentRef - Agent UUID or bot name.
   * @returns Canonical UUID string.
   */
  private async requireAgentId(agentRef: string): Promise<string> {
    const resolved = await this.resolveAgentId(agentRef);
    if (!resolved) {
      throw new Error(`Agent "${agentRef}" was not found in the registry.`);
    }
    return resolved;
  }
}

function readAgentConfigGuide(value: unknown): AgentConfigGuide | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate = normalizeRecord(
    record.configGuide
    ?? record.config_guide
    ?? record.setupGuide
    ?? record.setup_guide,
  );

  if (!candidate) {
    return undefined;
  }

  const docPath = normalizeDocPath(
    readOptionalString(candidate.docPath)
    || readOptionalString(candidate.doc_path)
    || readOptionalString(candidate.path),
  );

  if (!docPath) {
    return undefined;
  }

  const content = readGuideContent(docPath);
  const title = readOptionalString(candidate.title)
    || path.basename(docPath, path.extname(docPath)).replace(/[-_]+/g, ' ');
  const summary = readOptionalString(candidate.summary);

  return {
    title,
    docPath,
    ...(summary ? { summary } : {}),
    ...(content ? { content } : {}),
  };
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function normalizeDocPath(value: string): string {
  if (!value) {
    return '';
  }

  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('docs/')) {
    return '';
  }

  const absolute = path.resolve(REPO_ROOT, normalized);
  const relativeToDocs = path.relative(DOCS_ROOT, absolute);
  if (
    relativeToDocs.startsWith('..')
    || path.isAbsolute(relativeToDocs)
    || !absolute.toLowerCase().startsWith(DOCS_ROOT.toLowerCase())
  ) {
    return '';
  }

  return normalized;
}

function readGuideContent(docPath: string): string {
  try {
    const absolute = path.resolve(REPO_ROOT, docPath);
    if (!fs.existsSync(absolute)) {
      return '';
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    logger.warn({ err: error, docPath }, 'Failed to read agent config guide from docs');
    return '';
  }
}
