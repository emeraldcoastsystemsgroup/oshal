/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): the in-process privileged-identity cache that lets the SYNCHRONOUS operator gate consult database-backed roles. isOperatorIdentity has 159 call sites, many inside Express middleware, so it cannot become async; and Feature-Sliced Design forbids shared/ importing features/. Both constraints are answered by inverting the dependency — this module owns a tiny replaceable snapshot, the swarm-roles feature pushes into it at boot and after every role write, and authz.ts reads it. Fail-closed by construction: an unpopulated cache grants nothing, so a swarm whose roles have not loaded falls back to the env break-glass allowlist rather than to "everyone".
 */

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
}

const EMPTY: PrivilegedSnapshot = { subs: new Set(), emails: new Set(), rootSub: null, loadedAt: null };

let snapshot: PrivilegedSnapshot = EMPTY;

/**
 * @description Replaces the privileged-identity snapshot with a freshly loaded role set.
 * Called by the swarm-roles feature at boot and immediately after any role mutation, so a
 * grant or revoke takes effect on the very next request without a restart. Replacement is
 * atomic (a whole new snapshot object) so a concurrent read can never observe a half-built
 * set — the reason this rebuilds rather than mutating the live Sets in place.
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
    if (typeof identity.email === 'string' && identity.email.length > 0) {
      emails.add(identity.email.toLowerCase());
    }
  }
  snapshot = { subs, emails, rootSub, loadedAt: Date.now() };
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
 * @description Whether the role snapshot has ever loaded, and how many identities it holds.
 * Surfaces use this to explain an empty admin page honestly — "roles have not loaded" is a
 * different statement from "you are not an admin", and conflating them is what makes a
 * fail-closed gate read as a bug.
 * @returns loaded flag, identity count, and the load timestamp
 */
export function privilegedIdentityStatus(): { loaded: boolean; count: number; loadedAt: number | null } {
  return { loaded: snapshot.loadedAt !== null, count: snapshot.subs.size, loadedAt: snapshot.loadedAt };
}

/**
 * @description Drops the snapshot back to empty. Test-only seam and the deliberate posture for
 * a role-store read failure: an unloadable role table must never leave a STALE privileged set
 * in memory, because a revoked admin would keep their access until the next successful load.
 * @returns nothing
 */
export function clearPrivilegedIdentities(): void {
  snapshot = EMPTY;
}
