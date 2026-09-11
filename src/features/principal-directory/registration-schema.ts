/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep reviewed roster metadata separate from verified sign-in and authorization evidence.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

export const REGISTRATION_TABLES = ['oshal_principal_registrations', 'oshal_roster_state', 'oshal_roster_previews', 'oshal_roster_audit'] as const;
export const REGISTRATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oshal_principal_registrations (
    issuer TEXT NOT NULL, user_sub TEXT NOT NULL, display_name TEXT NOT NULL, email TEXT,
    source TEXT NOT NULL CHECK(source IN ('manual','directory-snapshot')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(issuer,user_sub))`,
  `CREATE TABLE IF NOT EXISTS oshal_roster_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision BIGINT NOT NULL DEFAULT 0)`,
  `INSERT INTO oshal_roster_state(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oshal_roster_previews (id UUID PRIMARY KEY, actor_issuer TEXT NOT NULL, actor_sub TEXT NOT NULL,
    revision BIGINT NOT NULL, payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, receipt JSONB)`,
  `CREATE TABLE IF NOT EXISTS oshal_roster_audit (id UUID PRIMARY KEY, revision BIGINT UNIQUE NOT NULL,
    actor_issuer TEXT NOT NULL, actor_sub TEXT NOT NULL, reason TEXT NOT NULL, entries JSONB NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  ...REGISTRATION_TABLES.flatMap(table => [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS roster_control_plane ON ${table}`,
    `CREATE POLICY roster_control_plane ON ${table} USING (current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
  ]),
];
/** @description Initialize additive roster metadata only. @param pool Bootstrap connection. @returns Readiness. */
export async function ensurePrincipalRegistrationSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'principal registration', lockKey: 7149134,
    statements: REGISTRATION_SCHEMA, requirements: REGISTRATION_TABLES.map(table => ({ table })) });
}
