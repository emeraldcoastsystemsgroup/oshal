/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist exact external memberships with shared revision locking and atomic authorization history.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP, type AuthorizationActor } from '@/shared/application-authorization';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { ExternalTenantMembershipError, type ExternalTenantMembership, type ExternalTenantMembershipApply,
  type ExternalTenantMembershipCatalog, type ExternalTenantMembershipReceipt, type ExternalTenantMembershipStore, type StoredMembershipPreview } from './types';
import { requireMembershipFreshness, requireMembershipPreview } from './validation';

/** @description PostgreSQL adapter with no account/provider callbacks while retaining the shared policy writer lock. */
export class PostgresExternalTenantMembershipStore implements ExternalTenantMembershipStore {
  /** @description Use the normal control-plane pool after schema readiness. @param pool Wrapped runtime pool. @param ready Existing migration/bootstrap readiness. */
  constructor(private readonly pool: Pool, private readonly ready: Promise<unknown> = Promise.resolve()) {}
  /** @description Read inventory without acquiring the writer lock. @returns Consistent global revision, tenants and explicit memberships. */
  async catalog(): Promise<ExternalTenantMembershipCatalog> {
    return this.transaction(false, async (client, revision) => {
      const tenants = await client.query<{ tenantId: string; name: string | null }>('SELECT tenant_id::text AS "tenantId",name FROM oshal_tenants ORDER BY tenant_id');
      const memberships = await client.query<ExternalTenantMembership>(`SELECT issuer AS "targetIssuer",user_sub AS "targetSub",tenant_id::text AS "tenantId"
        FROM oshal_external_tenant_memberships ORDER BY issuer,user_sub,tenant_id`);
      return { revision, tenants: tenants.rows, memberships: memberships.rows };
    });
  }
  /** @description Read exact current memberships without email or provider-tenant inference.
   * @param sub Verified subject. @param issuer Verified namespace. @returns Current business tenant IDs.
   */
  async tenantIds(sub: string, issuer: string): Promise<string[]> {
    await this.ready;
    return runWithSystemIdentity(async () => (await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id::text FROM oshal_external_tenant_memberships WHERE issuer=$1 AND user_sub=$2 ORDER BY tenant_id', [issuer,sub],
    )).rows.map(row => row.tenant_id));
  }
  /** @description Load provenance before identity refresh without a writer lock. @param id Opaque preview ID. @returns Stored preview or null. */
  async readPreview(id: string): Promise<StoredMembershipPreview | null> {
    await this.ready; return runWithSystemIdentity(() => readPreview(this.pool, id));
  }
  /** @description Save only at the reviewed global revision while the selected tenant exists.
   * @param preview Server-produced owned preview. @param now Current service clock, evaluated after lock acquisition. @returns Completion.
   */
  async savePreview(preview: StoredMembershipPreview, now: () => number): Promise<void> {
    await this.transaction(true, async (client, revision) => {
      requireMembershipFreshness(preview, revision, now());
      await requireTenant(client, preview.change.tenantId);
      await client.query('INSERT INTO oshal_external_tenant_previews(id,payload) VALUES($1,$2::jsonb)', [preview.previewId,JSON.stringify(preview)]);
    });
  }
  /** @description Recheck review, replay and tenant state atomically with the shared revision and audit.
   * @param actor Refreshed administrator identity. @param input Closed apply reference. @param now Current service clock. @returns Applied receipt.
   */
  async apply(actor: Pick<AuthorizationActor, 'sub' | 'issuer'>, input: ExternalTenantMembershipApply,
    now: () => number): Promise<ExternalTenantMembershipReceipt> {
    return this.transaction(true, async (client, revision) => {
      const preview = requireMembershipPreview(await readPreview(client, input.previewId), actor);
      await requireUnusedKey(client, actor, input);
      if (preview.receipt) {
        if (preview.idempotencyKey !== input.idempotencyKey) throw new ExternalTenantMembershipError(409, 'tenant_membership_preview_consumed');
        return preview.receipt;
      }
      requireMembershipFreshness(preview, revision, now()); await requireTenant(client, preview.change.tenantId);
      return commitChange(client, preview, input.idempotencyKey, revision + 1, now());
    });
  }
  private async transaction<T>(write: boolean, operation: (client: PoolClient, revision: number) => Promise<T>): Promise<T> {
    await this.ready;
    return runWithSystemIdentity(async () => {
      const client = await this.pool.connect();
      try {
        await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const row = await client.query(`SELECT revision FROM oshal_authorization_state WHERE singleton=TRUE${write ? ' FOR UPDATE' : ''}`);
        const revision = Number(row.rows[0]?.revision);
        if (row.rows.length !== 1 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Authorization revision unavailable');
        const result = await operation(client, revision); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
}
async function readPreview(client: Pick<Pool, 'query'>, id: string): Promise<StoredMembershipPreview | null> {
  const result = await client.query<{ payload: StoredMembershipPreview }>('SELECT payload FROM oshal_external_tenant_previews WHERE id=$1', [id]);
  return result.rows[0]?.payload ?? null;
}
async function requireTenant(client: PoolClient, id: string): Promise<void> {
  const result = await client.query('SELECT tenant_id FROM oshal_tenants WHERE tenant_id=$1 FOR KEY SHARE', [id]);
  if (result.rows.length !== 1) throw new ExternalTenantMembershipError(400, 'tenant_membership_tenant_unknown');
}
async function requireUnusedKey(client: PoolClient, actor: Pick<AuthorizationActor, 'sub' | 'issuer'>, input: ExternalTenantMembershipApply): Promise<void> {
  const reused = await client.query(`SELECT id FROM oshal_external_tenant_previews WHERE payload #>> '{actor,issuer}'=$1
    AND payload #>> '{actor,sub}'=$2 AND payload ->> 'idempotencyKey'=$3 AND id<>$4`, [actor.issuer,actor.sub,input.idempotencyKey,input.previewId]);
  if (reused.rows.length) throw new ExternalTenantMembershipError(409, 'tenant_membership_idempotency_conflict');
}
async function commitChange(client: PoolClient, preview: StoredMembershipPreview, key: string, revision: number,
  now: number): Promise<ExternalTenantMembershipReceipt> {
  const change = preview.change; const values = [change.targetIssuer,change.targetSub,change.tenantId];
  if (change.action === 'grant') {
    await client.query('INSERT INTO oshal_external_tenant_memberships(issuer,user_sub,tenant_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', values);
  } else await client.query('DELETE FROM oshal_external_tenant_memberships WHERE issuer=$1 AND user_sub=$2 AND tenant_id=$3', values);
  const receipt: ExternalTenantMembershipReceipt = { applied: true, revision, auditId: randomUUID() };
  const event = { id: receipt.auditId, revision, actor: preview.actor, at: new Date(now).toISOString(), previewId: preview.previewId,
    change: { ...change, app: EXTERNAL_TENANT_MEMBERSHIP_AUDIT_APP, role: 'member' } };
  await client.query('UPDATE oshal_authorization_state SET revision=$1 WHERE singleton=TRUE', [revision]);
  await client.query('INSERT INTO oshal_authorization_audit(id,revision,payload) VALUES($1,$2,$3::jsonb)', [event.id,revision,JSON.stringify(event)]);
  await client.query('UPDATE oshal_external_tenant_previews SET payload=$2::jsonb WHERE id=$1', [preview.previewId,
    JSON.stringify({ ...preview, receipt, idempotencyKey: key })]);
  return receipt;
}
