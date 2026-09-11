/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bootstrap migration130 control tables before registered briefing delivery becomes available.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { ensureJarvisSchema } from '../routes/jarvis-task-store';
/**
 * @description Prepare durable source ownership before any producer may enqueue a briefing.
 * @param pool - Server-owned pool running under system identity.
 * @returns Completion after schema verification.
 */
export async function ensureJarvisBriefingSchema(pool: Pool): Promise<void> {
  await ensureJarvisSchema(pool);
  const tables = ['jarvis_briefing_sources', 'jarvis_briefing_preferences', 'jarvis_briefing_cursors'];
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Jarvis briefing preferences', lockKey: 7149130,
    statements: [
      `CREATE TABLE IF NOT EXISTS jarvis_briefing_sources(source_id TEXT PRIMARY KEY,app TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,
        definition JSONB NOT NULL,active BOOLEAN NOT NULL DEFAULT FALSE)`,
      `CREATE TABLE IF NOT EXISTS jarvis_briefing_preferences(principal_issuer TEXT NOT NULL,user_sub TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES jarvis_briefing_sources(source_id),preference JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(principal_issuer,user_sub,source_id))`,
      `CREATE TABLE IF NOT EXISTS jarvis_briefing_cursors(principal_issuer TEXT NOT NULL,user_sub TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES jarvis_briefing_sources(source_id),last_announced_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(principal_issuer,user_sub,source_id))`,
      ...tables.flatMap(table => [`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
        `DROP POLICY IF EXISTS briefing_control_plane ON ${table}`,
        `CREATE POLICY briefing_control_plane ON ${table} USING(current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on')`]),
      'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS briefing_source_id TEXT',
      'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS principal_issuer TEXT',
    ], requirements: [
      { table: tables[0], columns: ['source_id','app','session_id','definition','active'] },
      { table: tables[1], columns: ['principal_issuer','user_sub','source_id','preference','updated_at'] },
      { table: tables[2], columns: ['principal_issuer','user_sub','source_id','last_announced_at'] },
      { table: 'jarvis_tasks', columns: ['briefing_source_id','principal_issuer'] },
    ],
  });
}
