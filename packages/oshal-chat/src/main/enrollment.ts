/**
 * Node enrollment — turn a one-time enrollment token into a SERVER-VERIFIED owner identity.
 *
 * Onboarding used to mean an operator minting a join code that embedded the swarm-wide
 * `REMOTE_CLIENT_SHARED_SECRET` in plaintext, sending it to a person, and that person pasting it
 * into a CLI. The node that came up was bound to NOBODY: `ownerSub` was self-asserted from local
 * config, which was usually empty until someone clicked "Sign in to the swarm" inside the app. That
 * is the wrong shape now that dispatch is owner-scoped on the control plane — an unowned node is
 * invisible to the very person whose computer it is.
 *
 * The enrollment token (`oshal_pat_…`, minted by POST /api/join/enroll for the signed-in user, short
 * lived and revocable) fixes both halves at once. It is a real credential, so the node simply ASKS
 * the control plane who it belongs to; the answer is authoritative because the token was minted for
 * that user. The node never asserts an identity it cannot prove, and no swarm-wide secret has to
 * travel to a human to get a computer attached.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: exchange an enrollment
 *   token for the owning user's verified sub/email via GET /api/cli-tokens/whoami and persist it, so
 *   the node registers with a real ownerSub instead of coming up unowned.
 *
 * @module main/enrollment
 */

import type { OshalChatConfig } from './config';

/** How long to wait on the control plane before giving up on the exchange. */
const EXCHANGE_TIMEOUT_MS = 15000;

/** The subset of the config store this module needs — keeps it testable without Electron. */
export interface EnrollmentStore {
  save(update: Partial<OshalChatConfig>): OshalChatConfig;
}

/** Outcome of an enrollment exchange. `skipped` means there was nothing to do. */
export interface EnrollmentResult {
  status: 'skipped' | 'enrolled' | 'failed';
  sub?: string;
  email?: string;
  error?: string;
}

/**
 * @description Exchanges this node's one-time enrollment token for the owning user's VERIFIED
 * identity and persists it, so registration can bind the device to a real person. No-ops when the
 * node has no token or already knows its user — re-running is safe and re-launches stay silent.
 * Never throws: an unreachable or expired token leaves the node unowned (fail-closed on the control
 * plane) rather than blocking startup, and the reason is returned for the caller to log/surface.
 * @param config - The node's current configuration.
 * @param store - Config store used to persist the resolved identity.
 * @returns What happened, including the resolved sub on success.
 */
export async function resolveEnrollmentIdentity(
  config: OshalChatConfig,
  store: EnrollmentStore,
): Promise<EnrollmentResult> {
  const token = (config.enrollmentToken || '').trim();
  if (!token) return { status: 'skipped' };
  // An identity already established (enrolled earlier, or an in-app sign-in) wins — never
  // overwrite a verified sub with another lookup.
  if ((config.userSub || '').trim()) return { status: 'skipped' };

  // The token authenticates on the swarm's public origin when OIDC runs behind a tunnel; the
  // worker plane may be a LAN address. Prefer the same base the sign-in flow uses.
  const base = (config.cockpitBaseUrl || config.controlPlaneUrl || '').replace(/\/+$/, '');
  if (!base) return { status: 'failed', error: 'No control-plane URL configured.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/cli-tokens/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 401 here means expired/revoked — the common real-world case, and worth saying plainly.
      const reason = res.status === 401
        ? 'The enrollment code has expired or been revoked. Enroll this computer again from the cockpit.'
        : `The swarm rejected the enrollment code (HTTP ${res.status}).`;
      return { status: 'failed', error: reason };
    }
    const body = (await res.json()) as { sub?: string; email?: string };
    const sub = String(body.sub || '').trim();
    if (!sub) return { status: 'failed', error: 'The swarm did not return an identity for this enrollment code.' };

    const email = String(body.email || '').trim();
    // The token has done its job. Clear it so a stale credential does not linger on disk — the
    // identity it proved is what persists.
    store.save({ userSub: sub, userEmail: email, enrollmentToken: '' });
    return { status: 'enrolled', sub, email };
  } catch (err) {
    const error = err instanceof Error && err.name === 'AbortError'
      ? 'Timed out reaching the swarm to verify the enrollment code.'
      : err instanceof Error ? err.message : 'Enrollment exchange failed.';
    return { status: 'failed', error };
  } finally {
    clearTimeout(timer);
  }
}
