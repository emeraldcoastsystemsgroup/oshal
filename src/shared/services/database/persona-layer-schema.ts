/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persona layer schema bootstrap for swarm prompt composition
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';

const logger = createChildLogger({ module: 'persona-layer-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the persona_layers table exists before persona queries execute.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the persona layer schema is ready
 */
export function ensurePersonaLayerSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyPersonaLayerSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

async function applyPersonaLayerSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring persona layer persistence schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'persona-layer',
    statements,
    requirements: [
      { table: 'persona_layers', columns: ['layer_id', 'layer_type', 'scope', 'prompt_fragment', 'enabled'] },
    ],
  });
  logger.info({ statementCount: statements.length }, 'Persona layer persistence schema ready');
}

function buildSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS persona_layers (
      layer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      layer_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      agent_id UUID,
      priority INTEGER NOT NULL DEFAULT 50,
      prompt_fragment TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_persona_layers_type ON persona_layers(layer_type)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_layers_agent ON persona_layers(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_persona_layers_scope ON persona_layers(scope)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_layers_unique
      ON persona_layers(layer_type, scope, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
  ];
}
