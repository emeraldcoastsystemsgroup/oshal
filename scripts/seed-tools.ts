/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of tool registry seeding script
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned with Dockerfile baseline - removed gh/podman, added 21 tools from any-bot/Dockerfile
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition: moved the inline tool catalog data into per-domain modules under scripts/seed-tools/ (aggregated by tool-catalog.ts); seeding logic and npm invocation (seed:tools) unchanged
 */

import { Pool } from 'pg';
import pino from 'pino';
import type { CreateToolInput } from '../src/entities/tool/schemas/tool-schemas';
import { toolCatalog } from './seed-tools/tool-catalog';

/**
 * @description Logger instance for seed script
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

/**
 * @description PostgreSQL connection pool configuration
 */
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'oshal',
  user: process.env.POSTGRES_USER || 'oshal_user',
  password: process.env.POSTGRES_PASSWORD || 'oshal_password',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * @description Seed a single tool into the database
 * @param tool - Tool definition to seed
 * @returns Promise resolving to success status and tool ID
 */
async function seedTool(tool: CreateToolInput): Promise<{ success: boolean; toolId?: string; error?: string }> {
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO tools (
        name, display_name, type, category, version,
        install_spec, skills, selector_fragment, routing_tags,
        auth_group, default_auth_mode, description,
        input_schema, output_schema, usage_instructions, examples,
        requires_approval, timeout_ms, tags, enabled, registered_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20, $21
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING tool_id
    `;

    const values = [
      tool.name,
      tool.displayName,
      tool.type,
      tool.category,
      tool.version,
      JSON.stringify(tool.installSpec),
      tool.skills,
      tool.selectorFragment,
      tool.routingTags,
      tool.authGroup,
      tool.defaultAuthMode,
      tool.description,
      JSON.stringify(tool.inputSchema),
      tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
      tool.usageInstructions || null,
      JSON.stringify(tool.examples),
      tool.requiresApproval,
      tool.timeoutMs,
      tool.tags,
      tool.enabled,
      tool.registeredBy,
    ];

    const result = await client.query(query, values);

    if (result.rows.length > 0) {
      const toolId = result.rows[0].tool_id;
      logger.info({ toolName: tool.name, toolId }, 'Tool registered successfully');
      return { success: true, toolId };
    } else {
      logger.info({ toolName: tool.name }, 'Tool already exists, skipped');
      return { success: true };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, toolName: tool.name }, 'Failed to seed tool');
    return { success: false, error: errorMessage };
  } finally {
    client.release();
  }
}

/**
 * @description Main seeding function
 */
async function seedAllTools(): Promise<void> {
  logger.info('Starting tool registry seeding...');
  logger.info({ count: toolCatalog.length }, 'Total tools to seed');

  let registered = 0;
  let skipped = 0;
  let failed = 0;

  for (const tool of toolCatalog) {
    const result = await seedTool(tool);
    if (result.success) {
      if (result.toolId) {
        registered++;
      } else {
        skipped++;
      }
    } else {
      failed++;
    }
  }

  logger.info(
    { registered, skipped, failed, total: toolCatalog.length },
    'Tool registry seeding completed'
  );

  if (failed > 0) {
    logger.warn({ failed }, 'Some tools failed to seed');
    process.exit(1);
  }
}

/**
 * @description Verify database connection
 */
async function verifyConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('Database connection verified');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database');
    throw error;
  }
}

/**
 * @description Main execution
 */
async function main(): Promise<void> {
  try {
    await verifyConnection();
    await seedAllTools();
    await pool.end();
    logger.info('Seed script completed successfully');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Seed script failed');
    await pool.end();
    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main();
}

export { seedAllTools, seedTool, toolCatalog };
