/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 3 rebuild: re-projects an owner's (or every owner's) person-model rollups, mention relations and ambient-recall vector chunks from STORED enrichment rows and canon transcript text. Pure SQL/IO — it never runs an LLM (re-enrichment for a new taxonomy is the accountable bot's job). Idempotent: chunk ids are deterministic (`pm:<segment_id>`), rollups are rebuilt from scratch, ask statuses survive via dedupe_key. Runs from the host against the compose Postgres (DATABASE_URL host rewritten) under SYSTEM identity so FORCE-RLS tables are visible.
 *
 * Usage (outside src/, not part of the build):
 *   npx ts-node -r tsconfig-paths/register scripts/person-model-rebuild.ts --owner <sub>
 *   npx ts-node -r tsconfig-paths/register scripts/person-model-rebuild.ts --all
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { hostDatabaseUrl } from './kalshi-db-url';

interface RebuildArgs {
  owner: string | null;
  all: boolean;
}

/**
 * @description Parses `--owner <sub>` / `--all` from argv; refuses to run with neither so a bare
 * invocation can never sweep every owner by accident.
 * @param argv - Process arguments after the script path.
 * @returns The parsed arguments.
 */
export function parseRebuildArgs(argv: string[]): RebuildArgs {
  const all = argv.includes('--all');
  const idx = argv.indexOf('--owner');
  const owner = idx >= 0 && argv[idx + 1] ? String(argv[idx + 1]) : null;
  if (!all && !owner) throw new Error('Pass --owner <sub> or --all');
  if (all && owner) throw new Error('--owner and --all are mutually exclusive');
  return { owner, all };
}

async function main(): Promise<void> {
  const args = parseRebuildArgs(process.argv.slice(2));
  // The pgvector engine mints its own pool from DATABASE_URL at import time, so the host rewrite
  // must land BEFORE the slice is loaded — hence the dynamic imports below.
  process.env.DATABASE_URL = hostDatabaseUrl();
  process.env.RAG_ENGINE = process.env.RAG_ENGINE || 'pgvector';
  const { wrapPoolWithGuc } = await import('@/shared/services/database');
  const { runWithSystemIdentity } = await import('@/shared/services/database/request-identity');
  const pm = await import('@/features/person-model');

  const pool = wrapPoolWithGuc(new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }));
  try {
    await runWithSystemIdentity(async () => {
      await pm.ensurePersonModelSchema(pool);
      const owners = args.all ? await listOwners(pool) : [args.owner as string];
      if (owners.length === 0) { console.log('No owners with ambient transcripts.'); return; }
      const semantic = await pm.semanticLegAvailable(pool);
      console.log(`Semantic leg: ${semantic ? 'available (pgvector)' : 'unavailable — rollups only'}; owners: ${owners.length}`);
      for (const owner of owners) {
        const ledger = await pm.rebuildOwnerProjection(pool, owner);
        console.log(`${owner}: canon=${ledger.canonRows} projected=${ledger.projectedRows} status=${ledger.status} rebuiltAt=${ledger.lastRebuildAt}`);
      }
    });
  } finally {
    await pool.end();
  }
}

/** Every owner with at least one transcript segment (SYSTEM identity sees across owners). */
async function listOwners(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query('SELECT DISTINCT user_sub FROM ambient_transcript_segments ORDER BY user_sub');
  return rows.map((r) => String(r.user_sub));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error('FAIL:', error);
    process.exit(1);
  });
}
