/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared real-boundary setup for the chat-channel specs: lay the channel schema down as the migrator would (service DDL, then migration 112's forced owner RLS on channel_links/channel_link_codes and migration 166's forced RLS on the occurrence claims), grant the runtime role its DML, prove the role is NOSUPERUSER NOBYPASSRLS and the four tables are FORCE-RLS, and hand back the GUC-stamped runtime pool the product code runs on. The refusal ledger (migration 155) is expected to be in the fixture's own migration list.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Also apply migration 170 (channel_links/channel_link_codes.user_issuer), so the schema the specs run on includes the migrator's issuer columns, not only the runtime DDL mirror.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { ChannelLinkService } from '@/features/chat-channels';
import { wrapPoolWithGuc } from '@/shared/services/database';
import type { DisposablePostgres } from './disposable-postgres';

/** The tables whose row-level security the channel specs depend on. */
export const CHANNEL_RLS_TABLES = ['channel_inbound_events', 'channel_link_codes', 'channel_links', 'oshal_refusals'] as const;

/**
 * @description Build the channel + refusal schema on a started fixture and return the runtime pool.
 * The caller must stub OSHAL_SCHEMA_BOOTSTRAP=validate-only before the runtime role's services
 * call ensureSchema, because that role (like production's) does not own the tables.
 * @param fixture - A started DisposablePostgres that declared `role` and migration 155.
 * @param role - The non-superuser runtime role.
 * @returns The GUC-stamped pool connected as `role`, plus the rows proving the enforcement posture.
 */
export async function prepareChannelSchema(fixture: DisposablePostgres, role: string): Promise<{
  runtime: Pool;
  forcedTables: string[];
  roleFlags: { rolsuper: boolean; rolbypassrls: boolean };
}> {
  const admin = fixture.pool;
  await new ChannelLinkService(admin as never).ensureSchema();
  for (const migration of ['112-owner-column-rls.sql', '166-chat-channel-inbound-events.sql', '170-channel-link-principal-issuer.sql']) {
    await admin.query(readFileSync(resolve(process.cwd(), 'scripts/migrations', migration), 'utf8'));
  }
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON channel_links, channel_link_codes TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT ON oshal_refusals TO ${role}`);
  const forced = await admin.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
    [[...CHANNEL_RLS_TABLES]],
  );
  const flags = await fixture.rolePool(role).query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  return { runtime: wrapPoolWithGuc(fixture.rolePool(role)), forcedTables: forced.rows.map((r) => r.relname), roleFlags: flags.rows[0] };
}
