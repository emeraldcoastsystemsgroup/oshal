/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Centralized the controller-to-bot HTTP delegation header, exact scope, identity defaults, and key-material rollout detection so issuer and verifier cannot drift.
 */

/** Header carrying the private Ed25519 delegation media type; never an OIDC bearer token. */
export const DELEGATION_HTTP_HEADER = 'x-oshal-delegation-token';
/** Default controller token issuer for one trusted oshal control plane. */
export const DEFAULT_DELEGATION_ISSUER = 'urn:oshal:controller';
/** Default bot-node HTTP audience. */
export const DEFAULT_DELEGATION_AUDIENCE = 'urn:oshal:bot-node';
/** Only capability granted by this first HTTP integration. */
export const SWARM_EXECUTE_DELEGATION_SCOPE = Object.freeze(['swarm:execute'] as const);
/** Explicit subject stamped only for work running under the positive SYSTEM sentinel. */
export const CONTROLLER_SYSTEM_SUBJECT = 'system:oshal-controller';
/** Trusted namespace paired with the explicit controller system subject. */
export const PLATFORM_SYSTEM_PRINCIPAL_ISSUER = 'urn:oshal:system';

type DelegationEnvironment = Readonly<Record<string, string | undefined>>;

/** @description Stable configuration error with no key or token material. */
export class DelegationHttpPolicyError extends Error {
  /** @description Creates a sanitized rollout-policy failure. */
  constructor(message: string) {
    super(message);
    this.name = 'DelegationHttpPolicyError';
  }
}

/**
 * @description Resolves the controller token issuer with a stable production-safe default.
 * @param env - Controller or bot environment.
 * @returns A bounded exact issuer string.
 */
export function delegationIssuerFromEnvironment(env: DelegationEnvironment = process.env): string {
  return readIdentifier(env.OSHAL_DELEGATION_ISSUER, DEFAULT_DELEGATION_ISSUER, 'issuer');
}

/**
 * @description Resolves the bot-node audience with a stable production-safe default.
 * @param env - Controller or bot environment.
 * @returns A bounded exact audience string.
 */
export function delegationAudienceFromEnvironment(env: DelegationEnvironment = process.env): string {
  return readIdentifier(env.OSHAL_DELEGATION_AUDIENCE, DEFAULT_DELEGATION_AUDIENCE, 'audience');
}

/**
 * @description Detects any controller signing configuration. Partial configuration counts as
 * configured so startup fails through the issuer loader instead of silently disabling rollout.
 * @param env - Controller environment.
 * @returns True when a signing key or key id was supplied.
 */
export function hasDelegationSigningConfiguration(
  env: DelegationEnvironment = process.env,
): boolean {
  return hasValue(env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY)
    || hasValue(env.OSHAL_DELEGATION_SIGNING_KID);
}

/**
 * @description Detects bot verification or leaked private material. A private key on a bot counts
 * as configured so verifier construction rejects the unsafe role rather than running unenforced.
 * @param env - Bot-node environment.
 * @returns True when public verification material or a private signing key was supplied.
 */
export function hasDelegationVerificationConfiguration(
  env: DelegationEnvironment = process.env,
): boolean {
  return hasValue(env.OSHAL_DELEGATION_PUBLIC_KEYS)
    || hasValue(env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY);
}

/**
 * @description Recognizes an explicit namespaced system subject. No blank/ownerless subject can
 * acquire the trusted platform issuer default.
 * @param subject - Candidate delegation subject.
 * @returns True only for a bounded `system:<name>` identity.
 */
export function isExplicitSystemSubject(subject: string): boolean {
  return /^system:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(subject);
}

function readIdentifier(
  configured: string | undefined,
  fallback: string,
  label: 'issuer' | 'audience',
): string {
  const value = configured === undefined || configured.trim() === '' ? fallback : configured.trim();
  if (value.length > 256 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new DelegationHttpPolicyError(`Delegation ${label} configuration is invalid`);
  }
  return value;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
