/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): the in-process privileged-identity cache that lets the SYNCHRONOUS operator gate consult database-backed roles. isOperatorIdentity has 159 call sites, many inside Express middleware, so it cannot become async; and Feature-Sliced Design forbids shared/ importing features/. Both constraints are answered by inverting the dependency — this module owns a tiny replaceable snapshot, the swarm-roles feature pushes into it at boot and after every role write, and authz.ts reads it. Fail-closed by construction: an unpopulated cache grants nothing, so a swarm whose roles have not loaded falls back to the env break-glass allowlist rather than to "everyone".
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Operator identity is exact (ADR-174 Amendment A: admin is a role on a person's account). (1) A role row's email enters the snapshot only when it is an email address (isEmailAddress: it contains '@') and the row's subject is not local-auth-shaped (isLocalAuthSubject): a local account's address was never verified, and a stored one would be a key for any identity-provider principal reporting it, whoever wrote the row. A local login or an identity-provider preferred_username without '@' reaches getCaller as the caller's email, so a row carrying one would make every identity reporting that username a privileged identity; rows written by any path (the store, the installer, plain SQL) are filtered here, at the one place the gate reads. (2) privilegedIdentityStatus reports rolesConfigured: whether a root or admin is loaded, or was loaded before a failed refresh. dropPrivilegedIdentitiesAfterFailure (the role store's failure path) still drops every identity, so nobody keeps a revoked privilege, but it keeps that fact, so the admin console, which now counts role rows as configured, does not reopen to every signed-in user while the role table is unreadable.
 */

import { isLocalAuthSubject } from './principal-issuer';

/** One privileged identity as the cache holds it — exact sub, lowercased email. */
export interface PrivilegedIdentity {
  sub: string | null;
  email: string | null;
  role: 'root' | 'admin';
}

/** The immutable snapshot the synchronous gate reads. Replaced wholesale, never mutated. */
interface PrivilegedSnapshot {
  subs: Set<string>;
  emails: Set<string>;
  rootSub: string | null;
  loadedAt: number | null;
  /** A root or admin is loaded, or was loaded before a failed refresh dropped the identities. */
  rolesConfigured: boolean;
}

const EMPTY: PrivilegedSnapshot = { subs: new Set(), emails: new Set(), rootSub: null, loadedAt: null, rolesConfigured: false };

let snapshot: PrivilegedSnapshot = EMPTY;

/**
 * @description True when a value is an email address rather than a login: it contains '@'. A
 * local login and an identity-provider preferred_username without '@' both reach getCaller as
 * the caller's "email", so only an address may ever match by email.
 * @param value - candidate email
 * @returns true for a string containing '@'
 */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.includes('@');
}

/**
 * @description Replaces the privileged-identity snapshot with a freshly loaded role set.
 * Called by the swarm-roles feature at boot and immediately after any role mutation, so a
 * grant or revoke takes effect on the very next request without a restart. Replacement is
 * atomic (a whole new snapshot object) so a concurrent read can never observe a half-built
 * set — the reason this rebuilds rather than mutating the live Sets in place. An email that
 * is not an address (see {@link isEmailAddress}) is ignored, so a login never matches as an email.
 * @param identities - every identity currently holding root or admin
 * @returns nothing; swaps the module snapshot
 */
export function setPrivilegedIdentities(identities: readonly PrivilegedIdentity[]): void {
  const subs = new Set<string>();
  const emails = new Set<string>();
  let rootSub: string | null = null;
  for (const identity of identities) {
    if (typeof identity.sub === 'string' && identity.sub.length > 0) {
      subs.add(identity.sub);
      if (identity.role === 'root') rootSub = identity.sub;
    }
    // A local account's email was never verified, so a row for a local-shaped subject never matches by
    // email, however the row was written (the store, the installer, plain SQL, an older version).
    if (isEmailAddress(identity.email) && !isLocalAuthSubject(identity.sub)) {
      emails.add(identity.email.toLowerCase());
    }
  }
  snapshot = { subs, emails, rootSub, loadedAt: Date.now(), rolesConfigured: subs.size > 0 };
}

/**
 * @description True when the identity holds root or admin in the loaded role snapshot.
 * Subject match is EXACT and case-sensitive (an OIDC sub is an opaque identifier — the
 * case-preservation rule authz.ts already follows); email match is case-insensitive.
 * @param sub - the caller's OIDC sub, when known
 * @param email - the caller's email, when known
 * @returns true when the identity is privileged by role
 */
export function isPrivilegedIdentity(sub?: string | null, email?: string | null): boolean {
  if (typeof sub === 'string' && sub.length > 0 && snapshot.subs.has(sub)) return true;
  if (typeof email === 'string' && email.length > 0 && snapshot.emails.has(email.toLowerCase())) return true;
  return false;
}

/**
 * @description The sub currently holding swarm root, or null when root is unclaimed or the
 * cache has not loaded. Used by surfaces that must distinguish "root is you" from "you are an
 * admin", and by the first-run flow to decide whether root is still claimable.
 * @returns the root sub, or null
 */
export function getRootSub(): string | null {
  return snapshot.rootSub;
}

/**
 * @description Whether the role snapshot has ever loaded, how many identities it holds, and
 * whether privileged roles are configured at all. Surfaces use this to explain an empty admin
 * page honestly — "roles have not loaded" is a different statement from "you are not an admin",
 * and conflating them is what makes a fail-closed gate read as a bug. `rolesConfigured` stays
 * true after a failed refresh dropped the identities (see {@link dropPrivilegedIdentitiesAfterFailure}).
 * @returns loaded flag, identity count, the load timestamp and whether roles are configured
 */
export function privilegedIdentityStatus(): { loaded: boolean; count: number; loadedAt: number | null; rolesConfigured: boolean } {
  return {
    loaded: snapshot.loadedAt !== null,
    count: snapshot.subs.size,
    loadedAt: snapshot.loadedAt,
    rolesConfigured: snapshot.rolesConfigured,
  };
}

/**
 * @description The role store's posture for a failed refresh. Every identity is dropped, exactly
 * as {@link clearPrivilegedIdentities} does, because a STALE privileged set would let a revoked
 * admin keep their access until the next successful load. What is kept is the fact that roles
 * were configured: a swarm that had a root still has one in its table, so surfaces that are
 * restricted once roles exist (the admin console) stay restricted instead of reading the
 * failure as a fresh install. The env break-glass allowlist is then the only way in.
 * @returns nothing
 */
export function dropPrivilegedIdentitiesAfterFailure(): void {
  snapshot = { ...EMPTY, rolesConfigured: snapshot.rolesConfigured };
}

/**
 * @description Drops the snapshot back to empty, including the record that roles were ever
 * configured. Test-only seam; the role store's failure path uses
 * {@link dropPrivilegedIdentitiesAfterFailure} instead.
 * @returns nothing
 */
export function clearPrivilegedIdentities(): void {
  snapshot = EMPTY;
}
