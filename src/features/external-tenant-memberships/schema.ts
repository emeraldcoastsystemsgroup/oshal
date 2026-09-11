/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add external membership facts and actor-bound previews protected by forced control-plane RLS.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** @description Additive schema; established tenants and the existing authorization state/audit are prerequisites. */
export const EXTERNAL_TENANT_MEMBERSHIP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oshal_external_tenant_memberships (
    issuer TEXT NOT NULL CHECK(issuer NOT LIKE 'urn:oshal:%'), user_sub TEXT NOT NULL,
    tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(issuer,user_sub,tenant_id))`,
  `CREATE TABLE IF NOT EXISTS oshal_external_tenant_previews (id UUID PRIMARY KEY, payload JSONB NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS external_tenant_preview_idempotency ON oshal_external_tenant_previews
    ((payload #>> '{actor,issuer}'),(payload #>> '{actor,sub}'),(payload ->> 'idempotencyKey')) WHERE payload ? 'idempotencyKey'`,
  ...['memberships', 'previews'].flatMap(suffix => [
    `ALTER TABLE oshal_external_tenant_${suffix} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE oshal_external_tenant_${suffix} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS external_tenant_control_plane ON oshal_external_tenant_${suffix}`,
    `CREATE POLICY external_tenant_control_plane ON oshal_external_tenant_${suffix}
      USING(current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
  ]),
];
/** @description Verify additive tables after existing tenant and authorization schema. @param pool Bootstrap connection. @returns Schema readiness. */
export async function ensureExternalTenantMembershipSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'external business tenant memberships', lockKey: 7149135,
    statements: EXTERNAL_TENANT_MEMBERSHIP_SCHEMA,
    requirements: ['oshal_tenants','oshal_authorization_state','oshal_authorization_audit',
      'oshal_external_tenant_memberships','oshal_external_tenant_previews'].map(table => ({ table })) });
}
