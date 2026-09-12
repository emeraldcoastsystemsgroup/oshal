/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist immutable authenticated queue creators behind controller-only row security.
 */
import type { Pool } from 'pg';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { QueuedApplicationPrincipalStore } from '@/shared/queued-application-principal';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

/** @description Migration133 statements shared with disposable integration fixtures. */
export const QUEUED_APPLICATION_PRINCIPAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oshal_queued_application_principals (
    ticket_id TEXT PRIMARY KEY, actor JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  'ALTER TABLE oshal_queued_application_principals ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE oshal_queued_application_principals FORCE ROW LEVEL SECURITY',
  'DROP POLICY IF EXISTS queued_application_principal_control ON oshal_queued_application_principals',
  `CREATE POLICY queued_application_principal_control ON oshal_queued_application_principals
    USING(current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
];

/** @description Ensure immutable queue authority storage during installation/startup.
 * @param pool Controller pool. @returns Completion after schema verification.
 */
export async function ensureQueuedApplicationPrincipalSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Queued application principals', lockKey: 7149133,
    statements: QUEUED_APPLICATION_PRINCIPAL_SCHEMA,
    requirements: [{ table: 'oshal_queued_application_principals', columns: ['ticket_id', 'actor', 'created_at'] }] });
}

/** @description Insert-only authority store; ordinary ticket edits cannot alter captured identity or directory freshness. */
export class PostgresQueuedApplicationPrincipalStore implements QueuedApplicationPrincipalStore {
  /** @description Hold the controller pool and installation readiness barrier.
   * @param pool Controller database. @param ready Schema readiness. */
  constructor(private readonly pool: Pool, private readonly ready: Promise<unknown>) {}
  /** @description Persist once; reusing a ticket identifier never replaces authority.
   * @param ticketId Newly created ticket. @param actor Verified creator snapshot. @returns Completion after insert.
   */
  async capture(ticketId: string, actor: AuthorizationActor): Promise<void> {
    await this.ready;
    await runWithSystemIdentity(() => this.pool.query(
      'INSERT INTO oshal_queued_application_principals(ticket_id,actor) VALUES($1,$2::jsonb) ON CONFLICT(ticket_id) DO NOTHING',
      [ticketId, JSON.stringify(actor)]));
  }
  /** @description Read only previously captured queue authority.
   * @param ticketId Durable ticket identifier. @returns Original actor evidence, or null for legacy/unqualified work.
   */
  async read(ticketId: string): Promise<AuthorizationActor | null> {
    await this.ready;
    const result = await runWithSystemIdentity(() => this.pool.query<{ actor: AuthorizationActor }>(
      'SELECT actor FROM oshal_queued_application_principals WHERE ticket_id=$1', [ticketId]));
    return result.rows[0]?.actor ?? null;
  }
}
