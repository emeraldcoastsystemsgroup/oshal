/**
 * Verify the hosted/runtime schema posture:
 * - the app connects through the normal runtime pool wrappers
 * - OSHAL_SCHEMA_BOOTSTRAP=validate-only is active
 * - core shared schemas are already present and visible to the app role
 * - runtime DDL is blocked by the pool guard
 *
 * Usage:
 *   OSHAL_SCHEMA_BOOTSTRAP=validate-only DATABASE_URL=postgres://app:... npm run verify:runtime-schema
 */

import {
  createOptionalPostgresPool,
  ensureConversationStoreSchema,
  ensurePersonaLayerSchema,
  ensureSubtaskLifecycleSchema,
  ensureSwarmEscalationStoreSchema,
  ensureSwarmRunStoreSchema,
  ensureTicketSchema,
  ensureWorkItemSchema,
  ensureWorkspaceSchema,
  runtimeSchemaBootstrapEnabled,
} from '@/shared/services/database';
import { ensureContentSchema } from '@/app/routes/content-routes';
import { ensureConnectionsSchema } from '@/app/routes/connectors-routes';
import { ensureEducationSchema } from '@/app/routes/education-routes';
// (ensureEmailSchema import removed 2026-07-19: oshal_email_digests is app-owned lazy DDL —
//  carved to the app store with the email-summarizer package, ADR-085 Wave 3; the packaged
//  route carries the ensure (with owner-RLS). The kernel email-routes module keeps only the
//  shared send/metadata machinery, which owns no schema.)
import { ensureFeedsSchema } from '@/app/routes/feeds-indexing';
import { ensureFreeTierSchema } from '@/app/routes/free-tier-rotation';
import { ensureInboxSchema } from '@/app/routes/inbox-ingest';
import { ensureJarvisSchema } from '@/app/routes/jarvis-routes';
import { ensureSecuritySchema } from '@/app/routes/security-routes';
import { ensureStoragePrefsSchema } from '@/app/routes/storage-target';
import { ensureGoldenSchema } from '@/app/routes/test-lab-golden';
// (ensureTradingSchema import repointed 2026-07-19: trading engine extraction, ADR-085
//  pre-carve — the schema bootstrap is ENGINE and lives kernel-side in app/trading-schema.ts;
//  the trading SURFACE (routes) is what the upcoming carve moves to the app store.)
import { ensureTradingSchema } from '@/app/trading-schema';
// (ensureTravelSchema import repointed 2026-07-19: the Travel SURFACE carved to the app
//  store, ADR-085 Wave 3 — the swarm-shared price engine that owns the travel_* schema
//  fallback stays kernel-resident in travel-farewatch with the fare-watch cron.)
import { ensureTravelSchema } from '@/app/routes/travel-farewatch';

const checkedSchemas = [
  'conversation',
  'workspace',
  'work-item',
  'swarm-run',
  'swarm-escalation',
  'subtask-lifecycle',
  'persona-layer',
  'ticket',
  'connectors',
  'connector-token-crypto',
  'connector-tenancy',
  'content',
  'education',
  // ('email' removed: oshal_email_digests carved to the app store with the
  //  email-summarizer package, ADR-085 Wave 3 — the packaged route carries the ensure.)
  'feeds',
  'free-tier',
  'inbox',
  'jarvis',
  // ('presentations' removed: oshal_presentations is app-owned lazy DDL — carved to the app
  //  store with the AI Office package, ADR-085 Wave 2; the packaged route carries the ensure.)
  'security',
  'storage',
  'test-lab-golden',
  'trading',
  'travel',
];

async function main(): Promise<void> {
  process.env.OSHAL_SCHEMA_BOOTSTRAP = process.env.OSHAL_SCHEMA_BOOTSTRAP || 'validate-only';

  if (runtimeSchemaBootstrapEnabled()) {
    throw new Error('OSHAL_SCHEMA_BOOTSTRAP must be validate-only/off/false for this verifier.');
  }

  const pool = createOptionalPostgresPool('runtime-schema-validate-only');
  if (!pool) {
    throw new Error('Postgres is not configured. Set DATABASE_URL or PG*/POSTGRES_* env vars.');
  }

  try {
    await ensureConversationStoreSchema(pool);
    await ensureWorkspaceSchema(pool);
    await ensureWorkItemSchema(pool);
    await ensureSwarmRunStoreSchema(pool);
    await ensureSwarmEscalationStoreSchema(pool);
    await ensureSubtaskLifecycleSchema(pool);
    await ensurePersonaLayerSchema(pool);
    await ensureTicketSchema(pool);
    await ensureConnectionsSchema(pool);
    await ensureContentSchema(pool);
    await ensureEducationSchema(pool);
    await ensureFeedsSchema(pool);
    await ensureFreeTierSchema(pool);
    await ensureInboxSchema(pool);
    await ensureJarvisSchema(pool);
    await ensureSecuritySchema(pool);
    await ensureStoragePrefsSchema(pool);
    await ensureGoldenSchema(pool);
    await ensureTradingSchema(pool);
    await ensureTravelSchema(pool);

    const ddlGuard = await proveDdlGuard(pool);
    console.log(JSON.stringify({
      ok: true,
      mode: process.env.OSHAL_SCHEMA_BOOTSTRAP,
      checkedSchemas,
      ddlGuard,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

async function proveDdlGuard(pool: { query: (sql: string) => Promise<unknown> }): Promise<'passed'> {
  try {
    await pool.query('CREATE TABLE oshal_runtime_schema_guard_should_not_exist (id text)');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Runtime schema DDL is disabled')) {
      return 'passed';
    }
    throw error;
  }

  throw new Error('Runtime DDL guard did not block CREATE TABLE.');
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
