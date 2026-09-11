/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Store exact verified principal provenance and preserve disabled state across subsequent observations.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** Metadata supplied only by the verified authentication boundary; never credentials or role claims. */
export interface PrincipalObservation {
  issuer: string; sub: string; provider: string; email: string | null; emailVerified: boolean;
  displayName: string | null; canonicalLocalSub: string | null;
}
/** An observed principal remains separate from every other issuer, even when emails and subjects coincide. */
export interface VerifiedPrincipal extends PrincipalObservation {
  status: 'active' | 'disabled'; firstSeenAt: string; lastSeenAt: string;
}
const CREATE = `CREATE TABLE IF NOT EXISTS oshal_verified_principals (
  issuer TEXT NOT NULL, user_sub TEXT NOT NULL, provider TEXT NOT NULL,
  email TEXT, email_verified BOOLEAN NOT NULL DEFAULT FALSE, display_name TEXT,
  canonical_local_sub TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(issuer,user_sub)
)`;
/** @description Initialize the additive control-plane inventory. @param pool Schema connection. @returns Readiness. */
export async function ensurePrincipalDirectorySchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'verified principal directory', lockKey: 7149129,
    statements: [CREATE, 'ALTER TABLE oshal_verified_principals ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE oshal_verified_principals FORCE ROW LEVEL SECURITY',
      'DROP POLICY IF EXISTS verified_principal_control_plane ON oshal_verified_principals',
      `CREATE POLICY verified_principal_control_plane ON oshal_verified_principals
        USING (current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on')`],
    requirements: [{ table: 'oshal_verified_principals', columns: ['issuer','user_sub','provider','email_verified','canonical_local_sub','status','last_seen_at'] }],
  });
}
type Row = { issuer: string; user_sub: string; provider: string; email: string | null; email_verified: boolean;
  display_name: string | null; canonical_local_sub: string | null; status: 'active' | 'disabled'; first_seen_at: Date; last_seen_at: Date };
function principal(row: Row): VerifiedPrincipal {
  return { issuer: row.issuer, sub: row.user_sub, provider: row.provider, email: row.email,
    emailVerified: row.email_verified, displayName: row.display_name, canonicalLocalSub: row.canonical_local_sub,
    status: row.status, firstSeenAt: new Date(row.first_seen_at).toISOString(), lastSeenAt: new Date(row.last_seen_at).toISOString() };
}
function valid(value: string, max = 512): boolean { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value); }
/** Read/write access is control-plane only; observations never modify a local account, link or role. */
export class PrincipalDirectoryStore {
  constructor(private readonly pool: Pool) {}
  /** @description Record verified labels without reactivating disabled identities or changing a canonical link.
   * @param value Trusted protocol-derived observation. @returns Persisted metadata.
   */
  async observe(value: PrincipalObservation): Promise<VerifiedPrincipal> {
    if (!valid(value.issuer, 2048) || !valid(value.sub) || !valid(value.provider, 64)
      || (value.email !== null && !valid(value.email)) || (value.displayName !== null && !valid(value.displayName))
      || (value.canonicalLocalSub !== null && !valid(value.canonicalLocalSub))) throw new Error('Invalid verified principal metadata');
    return runWithSystemIdentity(async () => {
      const result = await this.pool.query<Row>(`INSERT INTO oshal_verified_principals
        (issuer,user_sub,provider,email,email_verified,display_name,canonical_local_sub) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(issuer,user_sub) DO UPDATE SET provider=EXCLUDED.provider,email=EXCLUDED.email,
          email_verified=EXCLUDED.email_verified,display_name=EXCLUDED.display_name,last_seen_at=NOW(),
          canonical_local_sub=COALESCE(oshal_verified_principals.canonical_local_sub,EXCLUDED.canonical_local_sub)
        WHERE oshal_verified_principals.canonical_local_sub IS NULL
          OR oshal_verified_principals.canonical_local_sub IS NOT DISTINCT FROM EXCLUDED.canonical_local_sub
        RETURNING *`, [value.issuer,value.sub,value.provider,value.email,value.emailVerified,value.displayName,value.canonicalLocalSub]);
      if (!result.rows[0]) throw new Error('Verified principal canonical identity conflict');
      return principal(result.rows[0]);
    });
  }
  /** @description Look up exactly one known identity. @param issuer Verified namespace. @param sub Exact subject. @returns Known metadata or null. */
  async get(issuer: string, sub: string): Promise<VerifiedPrincipal | null> {
    return runWithSystemIdentity(async () => {
      const result = await this.pool.query<Row>('SELECT * FROM oshal_verified_principals WHERE issuer=$1 AND user_sub=$2', [issuer,sub]);
      return result.rows[0] ? principal(result.rows[0]) : null;
    });
  }
  /** @description List observed identities for an authorized management inventory. @returns Exact provider-qualified metadata. */
  async list(): Promise<VerifiedPrincipal[]> {
    return runWithSystemIdentity(async () => (await this.pool.query<Row>('SELECT * FROM oshal_verified_principals ORDER BY provider,issuer,user_sub')).rows.map(principal));
  }
}
