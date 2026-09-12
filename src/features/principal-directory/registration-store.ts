/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist exact roster registrations through reviewed, actor-bound, revision-checked imports without creating login or grants.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const identifier = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const issuer = identifier.refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; }
  catch { return false; }
}, 'An exact HTTPS issuer is required; local accounts must be invited through local account administration.');
export const PrincipalRegistrationSchema = z.object({ issuer, sub: identifier,
  displayName: identifier, email: z.string().email().max(320).nullable().default(null),
}).strict();
export const RosterImportSchema = z.object({
  entries: z.array(PrincipalRegistrationSchema).min(1).max(250), source: z.enum(['manual', 'directory-snapshot']),
  reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().nonnegative().safe(),
}).strict().refine(value => new Set(value.entries.map(entry => JSON.stringify([entry.issuer, entry.sub]))).size === value.entries.length,
  'Duplicate issuer and subject in import');
export const RosterApplySchema = z.object({ previewId: z.string().uuid() }).strict();
export type PrincipalRegistration = z.infer<typeof PrincipalRegistrationSchema> & { source: 'manual' | 'directory-snapshot' };
type Import = z.infer<typeof RosterImportSchema>;
type PreviewRow = { actor_issuer: string; actor_sub: string; revision: string; payload: Import; expires_at: Date; receipt: unknown };
export class RosterError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** @description Require actual current swarm administration. @param actor Authenticated server actor. @returns Nothing on success. */
export function requireRosterAdmin(actor: AuthorizationActor, permission: 'read' | 'assign' = 'read'): void {
  if (!actor.isActive || !actor.issuer || !actor.sub) throw new RosterError(401, 'roster_identity_required');
  if (!actor.isSwarmAdmin) throw new RosterError(403, 'roster_administrator_required');
  if (actor.allowedPermissions && !actor.allowedPermissions.includes(`platform:authorization.${permission}`)) throw new RosterError(403, 'roster_scope_denied');
  if (permission === 'assign' && actor.allowedPermissions && !actor.allowedPermissions.includes('platform:authorization.directory')) throw new RosterError(403, 'roster_scope_denied');
}

/** Registration labels are never consulted to activate accounts, link identities or grant permissions. */
export class PrincipalRegistrationStore {
  constructor(private readonly pool: Pool, private readonly now = () => Date.now()) {}
  /** @description Read reviewed metadata when the additive schema exists. @returns All exact registered labels. */
  async list(): Promise<PrincipalRegistration[]> {
    return runWithSystemIdentity(async () => {
      const exists = await this.pool.query("SELECT to_regclass('oshal_principal_registrations') IS NOT NULL AS present");
      if (!exists.rows[0]?.present) return [];
      return (await this.pool.query<PrincipalRegistration>(`SELECT issuer,user_sub AS sub,display_name AS "displayName",email,source
        FROM oshal_principal_registrations ORDER BY display_name,issuer,user_sub`)).rows;
    });
  }
  /** @description Read the roster version for review. @returns Current metadata revision. */
  async revision(): Promise<number> {
    return runWithSystemIdentity(async () => Number((await this.pool.query('SELECT revision FROM oshal_roster_state WHERE singleton')).rows[0].revision));
  }
  /** @description Store a review without changing any identity or access. @param actor Verified administrator. @param input Closed import request. @returns Review details. */
  async preview(actor: AuthorizationActor, input: unknown) {
    requireRosterAdmin(actor, 'assign'); const value = RosterImportSchema.parse(input);
    return this.transaction(async client => {
      const revision = await this.lockRevision(client);
      if (revision !== value.expectedRevision) throw new RosterError(409, 'roster_revision_changed');
      const id = randomUUID(); const expiresAt = new Date(this.now() + 600_000).toISOString();
      await client.query(`INSERT INTO oshal_roster_previews(id,actor_issuer,actor_sub,revision,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, actor.issuer, actor.sub, revision, JSON.stringify(value), expiresAt]);
      return { previewId: id, revision, expiresAt, entries: value.entries, source: value.source,
        reason: value.reason, consequence: 'Registers directory labels only. Does not enable sign-in, verify identity, link records or grant access.' };
    });
  }
  /** @description Apply the exact reviewed metadata once. @param actor Fresh verified administrator. @param input Stored preview reference. @returns Durable receipt. */
  async apply(actor: AuthorizationActor, input: unknown) {
    requireRosterAdmin(actor, 'assign'); const { previewId } = RosterApplySchema.parse(input);
    return this.transaction(async client => {
      const revision = await this.lockRevision(client);
      const row = (await client.query<PreviewRow>('SELECT * FROM oshal_roster_previews WHERE id=$1 FOR UPDATE', [previewId])).rows[0];
      if (!row) throw new RosterError(404, 'roster_preview_not_found');
      if (row.actor_issuer !== actor.issuer || row.actor_sub !== actor.sub) throw new RosterError(403, 'roster_preview_actor_mismatch');
      if (row.receipt) return row.receipt;
      if (new Date(row.expires_at).getTime() <= this.now()) throw new RosterError(410, 'roster_preview_expired');
      if (Number(row.revision) !== revision) throw new RosterError(409, 'roster_revision_changed');
      const value = RosterImportSchema.parse(row.payload);
      for (const entry of value.entries) await this.save(client, entry, value.source);
      const receipt = { applied: true, revision: revision + 1, count: value.entries.length, previewId };
      await client.query('UPDATE oshal_roster_state SET revision=$1 WHERE singleton', [revision + 1]);
      await client.query(`INSERT INTO oshal_roster_audit(id,revision,actor_issuer,actor_sub,reason,entries)
        VALUES($1,$2,$3,$4,$5,$6)`, [previewId, revision + 1, actor.issuer, actor.sub, value.reason, JSON.stringify(value.entries)]);
      await client.query('UPDATE oshal_roster_previews SET receipt=$2 WHERE id=$1', [previewId, JSON.stringify(receipt)]);
      return receipt;
    });
  }
  private async save(client: PoolClient, entry: z.infer<typeof PrincipalRegistrationSchema>, source: string) {
    if (entry.issuer === LOCAL_AUTH_PRINCIPAL_ISSUER) throw new RosterError(400, 'use_local_account_invitation');
    await client.query(`INSERT INTO oshal_principal_registrations(issuer,user_sub,display_name,email,source) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(issuer,user_sub) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email,
      source=EXCLUDED.source,updated_at=NOW()`, [entry.issuer, entry.sub, entry.displayName, entry.email, source]);
  }
  private async lockRevision(client: PoolClient): Promise<number> {
    return Number((await client.query('SELECT revision FROM oshal_roster_state WHERE singleton FOR UPDATE')).rows[0].revision);
  }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithSystemIdentity(async () => {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
}
