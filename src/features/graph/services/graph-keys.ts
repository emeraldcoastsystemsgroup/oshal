/**
 * Graph key derivation — database names (isolation) + node keys (ADR-045).
 *
 * These functions are the isolation boundary: a person's graph database name is derived ONLY from
 * their `sub`, a tenant's ONLY from the tenant id, so a caller can never be handed another graph.
 * Treat changes here like the token broker — security-sensitive.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — per-person / per-tenant ArangoDB database-name derivation + ArangoDB-safe node _key derivation.
 *
 * @module graph-keys
 */
import * as crypto from 'crypto';

/** Short, stable hex digest (ArangoDB names/keys must avoid most punctuation). */
function sha(input: string, len = 24): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len);
}

/**
 * @description The ArangoDB database name for one person's graph. Derived solely from the OIDC
 * `sub` so it is unguessable and 1:1 with the user. Prefixed `g_p_`. ArangoDB DB names must start
 * with a letter and be <= 64 chars; this is well within that.
 * @param sub - the caller's OIDC sub
 * @returns the isolated database name
 */
export function personDbName(sub: string): string {
  return `g_p_${sha(String(sub))}`;
}

/**
 * @description The ArangoDB database name for one tenant's shared graph. Derived solely from the
 * tenant id. Prefixed `g_t_`.
 * @param tenant - the tenant id
 * @returns the isolated database name
 */
export function tenantDbName(tenant: string): string {
  return `g_t_${sha(String(tenant))}`;
}

/**
 * @description Map a caller node id to an ArangoDB-safe `_key`. Deterministic, so the same id
 * always resolves to the same key (required for neighbors/shortestPath lookups). Safe ids pass
 * through; anything else is hashed to avoid illegal keys and cross-id collisions.
 * @param id - the caller's node id
 * @returns an ArangoDB-legal _key
 */
export function nodeKey(id: string): string {
  const s = String(id);
  return /^[A-Za-z0-9_\-.:@]{1,200}$/.test(s) ? s : `k_${sha(s, 40)}`;
}
