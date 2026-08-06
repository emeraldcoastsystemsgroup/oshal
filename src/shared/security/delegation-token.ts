/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a dependency-free HMAC-SHA256 codec for short-lived, task- and agent-bound controller delegation with strict key rotation and verification rails.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced symmetric delegation with Ed25519 controller-only issuance and structurally separate public-key verification so a compromised bot cannot mint user authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Signed and exactly verified principal_iss independently from token iss to preserve the authenticated subject namespace across the HTTP delegation boundary.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Sign and exactly verify the canonical request-body SHA-256 so a captured token cannot authorize mutated execution inputs.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Validate delegation subjects by UTF-8 byte length without trimming so signed exact OIDC identities survive issuance, parsing, and expectation binding unchanged.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Add exact method/path claims, a receipt issuer for durable jti persistence, and a route verifier whose remaining signed identity bindings are checked by the PostgreSQL delegation authority.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
  verify as verifyEd25519,
  type JsonWebKey,
  type KeyObject,
} from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { isExactUserSubject } from './exact-user-subject';
import {
  DELEGATION_TOKEN_VERSION,
  type DelegationTokenClaims,
  type DelegationTokenExpectations,
  type DelegationTokenGrant,
  type DelegationTokenHeader,
  type DelegationRouteExpectations,
} from '@/shared/types';

const logger = createChildLogger({ module: 'delegation-token' });
const TOKEN_TYPE = 'OSHAL-DLG' as const;
const TOKEN_ALGORITHM = 'EdDSA' as const;
const DEFAULT_TTL_SECONDS = 4_200;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 5_400;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_TOKEN_BYTES = 8_192;
const MAX_HEADER_BYTES = 512;
const MAX_CLAIMS_BYTES = 6_144;
const MAX_SIGNING_KEY_BYTES = 16_384;
const MAX_PUBLIC_KEY_DOCUMENT_BYTES = 65_536;
const MAX_PUBLIC_KEY_BYTES = 16_384;
const MAX_ROTATION_KEYS = 16;
const MAX_SCOPES = 16;
const ED25519_COMPONENT_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JTI_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const METHOD_PATTERN = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/;

type DelegationEnvironment = Readonly<Record<string, string | undefined>>;

interface DelegationIssuerConfiguration {
  activeKid: string;
  privateKey: KeyObject;
  ttlSeconds: number;
}

interface DelegationVerifierConfiguration {
  publicKeys: ReadonlyMap<string, KeyObject>;
  clockSkewSeconds: number;
}

/** @description Stable error categories suitable for translating failures into fail-closed responses. */
export type DelegationTokenErrorCode =
  | 'configuration'
  | 'malformed'
  | 'invalid_signature'
  | 'invalid_binding'
  | 'invalid_time';

/** @description A sanitized delegation failure that never embeds a token or key value. */
export class DelegationTokenError extends Error {
  /** @description Machine-readable failure category. */
  readonly code: DelegationTokenErrorCode;

  /**
   * @description Creates a sanitized delegation token failure.
   * @param code - Stable category for fail-closed caller handling.
   * @param message - Non-secret diagnostic message.
   * @returns A delegation token error instance.
   */
  constructor(code: DelegationTokenErrorCode, message: string) {
    super(message);
    this.name = 'DelegationTokenError';
    this.code = code;
  }
}

/** @description Process boundaries used only by the controller-side delegation issuer. */
export interface DelegationTokenIssuerOptions {
  /** @description Environment containing one controller private signing key and timing settings. */
  env?: DelegationEnvironment;
  /** @description Supplies Unix epoch seconds; production defaults to the system clock. */
  nowEpochSeconds?: () => number;
  /** @description Supplies a fresh opaque token identifier; production defaults to randomUUID(). */
  generateJti?: () => string;
}

/** @description Process boundaries used by a bot-side public-key delegation verifier. */
export interface DelegationTokenVerifierOptions {
  /** @description Environment containing only the trusted public-key rotation ring and clock skew. */
  env?: DelegationEnvironment;
  /** @description Supplies Unix epoch seconds; production defaults to the system clock. */
  nowEpochSeconds?: () => number;
}

/** @description Controller-only capability that can issue, but cannot verify, delegated authority. */
export interface DelegationTokenIssuer {
  /**
   * @description Issues one short-lived token bound to the supplied task, agent, and capability set.
   * @param grant - Least-privilege authority approved by the controller for one dispatch.
   * @returns A compact Ed25519-signed delegation token.
   */
  issue(grant: DelegationTokenGrant): string;
}

/** @description Signed token plus the exact claims recorded in the durable one-time grant row. */
export interface RecordedDelegationToken {
  token: string;
  claims: DelegationTokenClaims;
}
/** @description Per-dispatch ceiling that prevents a token from outliving its parent authority. */
export interface DelegationTokenIssueConstraints {
  expiresAtEpochSeconds?: number;
}
/** @description Controller-only issuer that exposes its signed claims for atomic durable recording. */
export interface RecordedDelegationTokenIssuer {
  /**
   * @description Issues one token and returns the immutable claims that must be persisted.
   * @param grant - Least-privilege route authority approved by deterministic controller code.
   * @returns Compact token and a defensive copy of its exact signed claims.
   */
  issue(grant: DelegationTokenGrant, constraints?: DelegationTokenIssueConstraints): RecordedDelegationToken;
}
/** @description Bot-safe capability that can verify with public material and has no issue method. */
export interface DelegationTokenVerifier {
  /**
   * @description Verifies signature, shape, time, and every expected dispatch binding.
   * @param token - Compact delegation token received with the task dispatch.
   * @param expected - Local task, agent, audience, issuer, scope, and user-subject bindings.
   * @returns A defensive copy of the verified signed claims.
   */
  verify(token: string, expected: DelegationTokenExpectations): DelegationTokenClaims;
}

/** @description Public-key verifier for API routes backed by a durable delegation record. */
export interface DelegationRouteTokenVerifier {
  /**
   * @description Verifies signature, time, and exact route bindings before the durable store
   * validates and consumes the signed subject, workload, dispatch, and jti tuple.
   * @param token - Compact controller-issued delegation token.
   * @param expected - Exact issuer, audience, method, path, body digest, and scopes for this route.
   * @returns Verified signed claims for durable authorization and one-time consumption.
   */
  verify(token: string, expected: DelegationRouteExpectations): DelegationTokenClaims;
}

/**
 * @description Builds the controller-only issuer from OSHAL_DELEGATION_SIGNING_PRIVATE_KEY and
 * OSHAL_DELEGATION_SIGNING_KID. It never loads a public ring or SWARM_SERVICE_SECRET, which keeps
 * the authority-minting boundary explicit in controller composition.
 * @param options - Optional controller environment, clock, and nonce seams.
 * @returns A frozen object exposing issuance only.
 */
export function createDelegationTokenIssuer(
  options: DelegationTokenIssuerOptions = {},
): DelegationTokenIssuer {
  const configuration = loadIssuerConfiguration(options.env ?? process.env);
  const nowEpochSeconds = options.nowEpochSeconds ?? systemEpochSeconds;
  const generateJti = options.generateJti ?? randomUUID;
  return Object.freeze({
    issue: (grant: DelegationTokenGrant) => executeIssue(configuration, grant, nowEpochSeconds, generateJti).token,
  });
}
/**
 * @description Builds a controller-only issuer that returns the exact signed claims so a durable
 * delegation store can persist the jti and bindings before releasing the token to a workload.
 * This is intentionally a separate capability from {@link createDelegationTokenIssuer}; bot HTTP
 * dispatch keeps its minimal string-only issuer surface.
 * @param options - Optional controller environment, clock, and nonce seams.
 * @returns Frozen issuer returning one signed token receipt per call.
 */
export function createRecordedDelegationTokenIssuer(
  options: DelegationTokenIssuerOptions = {},
): RecordedDelegationTokenIssuer {
  const configuration = loadIssuerConfiguration(options.env ?? process.env);
  const nowEpochSeconds = options.nowEpochSeconds ?? systemEpochSeconds;
  const generateJti = options.generateJti ?? randomUUID;
  return Object.freeze({
    issue: (grant: DelegationTokenGrant, constraints?: DelegationTokenIssueConstraints) => executeIssue(
      configuration, grant, nowEpochSeconds, generateJti, constraints,
    ),
  });
}
/**
 * @description Builds a verifier from OSHAL_DELEGATION_PUBLIC_KEYS only. Bot containers need no
 * private material, and the returned object structurally cannot mint delegated user authority.
 * @param options - Optional bot environment and clock seam.
 * @returns A frozen object exposing verification only.
 */
export function createDelegationTokenVerifier(
  options: DelegationTokenVerifierOptions = {},
): DelegationTokenVerifier {
  const configuration = loadVerifierConfiguration(options.env ?? process.env);
  const nowEpochSeconds = options.nowEpochSeconds ?? systemEpochSeconds;
  return Object.freeze({
    verify: (token: string, expected: DelegationTokenExpectations) => executeVerify(
      configuration, token, expected, nowEpochSeconds,
    ),
  });
}
/**
 * @description Builds a public-only route verifier for API delegations. It verifies the exact
 * request route before returning signed identity fields to the PostgreSQL authority, which must
 * compare and atomically consume the complete durable tuple before execution.
 * @param options - Optional public-key environment and clock seam.
 * @returns Frozen public-key route verifier with no issuance capability.
 */
export function createDelegationRouteTokenVerifier(
  options: DelegationTokenVerifierOptions = {},
): DelegationRouteTokenVerifier {
  const configuration = loadVerifierConfiguration(options.env ?? process.env);
  const nowEpochSeconds = options.nowEpochSeconds ?? systemEpochSeconds;
  return Object.freeze({
    verify: (token: string, expected: DelegationRouteExpectations) => executeRouteVerify(
      configuration, token, expected, nowEpochSeconds,
    ),
  });
}

function executeIssue(
  configuration: DelegationIssuerConfiguration,
  grant: DelegationTokenGrant,
  nowEpochSeconds: () => number,
  generateJti: () => string,
  constraints?: DelegationTokenIssueConstraints,
): RecordedDelegationToken {
  const startedAt = Date.now();
  logger.debug({ operation: 'issue' }, 'Delegation token issuance entered');
  try {
    const token = issueToken(configuration, grant, nowEpochSeconds, generateJti, constraints);
    logger.debug({ operation: 'issue', durationMs: Date.now() - startedAt }, 'Delegation token issuance exited');
    return token;
  } catch (error) {
    const failure = asDelegationError(error, 'configuration', 'Delegation token issuance failed');
    logSanitizedFailure('issue', failure, startedAt);
    throw failure;
  }
}

function executeRouteVerify(
  configuration: DelegationVerifierConfiguration,
  token: string,
  expected: DelegationRouteExpectations,
  nowEpochSeconds: () => number,
): DelegationTokenClaims {
  const startedAt = Date.now();
  logger.debug({ operation: 'verify_route' }, 'Delegation route verification entered');
  try {
    const claims = verifyRouteToken(configuration, token, expected, nowEpochSeconds);
    logger.debug({ operation: 'verify_route', durationMs: Date.now() - startedAt }, 'Delegation route verification exited');
    return claims;
  } catch (error) {
    const failure = asDelegationError(error, 'malformed', 'Delegation route verification failed');
    logSanitizedFailure('verify_route', failure, startedAt);
    throw failure;
  }
}

function executeVerify(
  configuration: DelegationVerifierConfiguration,
  token: string,
  expected: DelegationTokenExpectations,
  nowEpochSeconds: () => number,
): DelegationTokenClaims {
  const startedAt = Date.now();
  logger.debug({ operation: 'verify' }, 'Delegation token verification entered');
  try {
    const claims = verifyToken(configuration, token, expected, nowEpochSeconds);
    logger.debug({ operation: 'verify', durationMs: Date.now() - startedAt }, 'Delegation token verification exited');
    return claims;
  } catch (error) {
    const failure = asDelegationError(error, 'malformed', 'Delegation token verification failed');
    logSanitizedFailure('verify', failure, startedAt);
    throw failure;
  }
}

function systemEpochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function loadIssuerConfiguration(env: DelegationEnvironment): DelegationIssuerConfiguration {
  const activeKid = validateConfiguredKid(requireConfigValue(
    env.OSHAL_DELEGATION_SIGNING_KID,
    'OSHAL_DELEGATION_SIGNING_KID',
    64,
  ));
  const privateMaterial = requireConfigValue(
    env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY,
    'OSHAL_DELEGATION_SIGNING_PRIVATE_KEY',
    MAX_SIGNING_KEY_BYTES,
  );
  return Object.freeze({
    activeKid,
    privateKey: importPrivateKey(privateMaterial),
    ttlSeconds: readTtlSeconds(env.OSHAL_DELEGATION_TTL_SECONDS),
  });
}

function loadVerifierConfiguration(env: DelegationEnvironment): DelegationVerifierConfiguration {
  if ((env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY ?? '').trim() !== '') {
    throw new DelegationTokenError('configuration', 'Delegation verifier environment contains private key material');
  }
  const rawDocument = requireConfigValue(
    env.OSHAL_DELEGATION_PUBLIC_KEYS,
    'OSHAL_DELEGATION_PUBLIC_KEYS',
    MAX_PUBLIC_KEY_DOCUMENT_BYTES,
  );
  const document = parseConfigurationJson(rawDocument, 'Delegation public-key document is invalid');
  if (!isPlainRecord(document)) {
    throw new DelegationTokenError('configuration', 'Delegation public keys must be a JSON object');
  }
  const entries = Object.entries(document);
  if (entries.length === 0 || entries.length > MAX_ROTATION_KEYS) {
    throw new DelegationTokenError('configuration', 'Delegation public-key count is invalid');
  }
  const publicKeys = new Map<string, KeyObject>();
  for (const [kid, material] of entries) {
    publicKeys.set(validateConfiguredKid(kid), importPublicKey(material));
  }
  return Object.freeze({
    publicKeys,
    clockSkewSeconds: readClockSkewSeconds(env.OSHAL_DELEGATION_CLOCK_SKEW_SECONDS),
  });
}

function requireConfigValue(value: string | undefined, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DelegationTokenError('configuration', `${name} is required`);
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new DelegationTokenError('configuration', `${name} is too large`);
  }
  return normalized;
}

function validateConfiguredKid(kid: string): string {
  if (!KID_PATTERN.test(kid)) {
    throw new DelegationTokenError('configuration', 'Delegation key identifier is invalid');
  }
  return kid;
}

function importPrivateKey(material: string): KeyObject {
  const key = material.startsWith('{')
    ? importPrivateJwk(parseConfigurationJson(material, 'Delegation private JWK is invalid'))
    : importPrivatePem(material);
  return assertEd25519Key(key, 'private');
}

function importPrivatePem(material: string): KeyObject {
  assertPemEnvelope(material, 'PRIVATE KEY');
  return runGuarded(
    'private_key_import',
    'configuration',
    'Delegation private key is invalid',
    () => createPrivateKey(material),
  );
}

function importPrivateJwk(value: unknown): KeyObject {
  const jwk = validateEd25519Jwk(value, 'private');
  return runGuarded(
    'private_jwk_import',
    'configuration',
    'Delegation private JWK is invalid',
    () => createPrivateKey({ key: jwk, format: 'jwk' }),
  );
}

function importPublicKey(material: unknown): KeyObject {
  const key = typeof material === 'string'
    ? importPublicPem(requireBoundedPublicPem(material))
    : importPublicJwk(material);
  return assertEd25519Key(key, 'public');
}

function requireBoundedPublicPem(material: string): string {
  const normalized = material.trim();
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > MAX_PUBLIC_KEY_BYTES) {
    throw new DelegationTokenError('configuration', 'Delegation public key size is invalid');
  }
  return normalized;
}

function importPublicPem(material: string): KeyObject {
  assertPemEnvelope(material, 'PUBLIC KEY');
  return runGuarded(
    'public_key_import',
    'configuration',
    'Delegation public key is invalid',
    () => createPublicKey(material),
  );
}

function importPublicJwk(value: unknown): KeyObject {
  const jwk = validateEd25519Jwk(value, 'public');
  return runGuarded(
    'public_jwk_import',
    'configuration',
    'Delegation public JWK is invalid',
    () => createPublicKey({ key: jwk, format: 'jwk' }),
  );
}

function assertPemEnvelope(material: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): void {
  const lines = material.split(/\r?\n/);
  if (
    lines.length < 3
    || lines[0] !== `-----BEGIN ${label}-----`
    || lines[lines.length - 1] !== `-----END ${label}-----`
  ) {
    throw new DelegationTokenError('configuration', `Delegation ${label.toLowerCase()} role is invalid`);
  }
}

function validateEd25519Jwk(value: unknown, role: 'private' | 'public'): JsonWebKey {
  if (!isPlainRecord(value) || value.kty !== 'OKP' || value.crv !== 'Ed25519') {
    throw new DelegationTokenError('configuration', 'Delegation JWK must use Ed25519');
  }
  validateJwkComponent(value.x, 'public');
  const hasPrivateComponent = Object.prototype.hasOwnProperty.call(value, 'd');
  if (role === 'private' && !hasPrivateComponent) {
    throw new DelegationTokenError('configuration', 'Delegation JWK must contain private key material');
  }
  if (role === 'public' && hasPrivateComponent) {
    throw new DelegationTokenError('configuration', 'Delegation verifier key must be public only');
  }
  if (role === 'private') validateJwkComponent(value.d, 'private');
  return value as JsonWebKey;
}

function validateJwkComponent(value: unknown, role: 'private' | 'public'): void {
  if (typeof value !== 'string') {
    throw new DelegationTokenError('configuration', `Delegation JWK ${role} component is invalid`);
  }
  decodeCanonicalBase64Url(
    value,
    ED25519_COMPONENT_BYTES,
    ED25519_COMPONENT_BYTES,
    'configuration',
    `Delegation JWK ${role} component is invalid`,
  );
}

function assertEd25519Key(key: KeyObject, role: 'private' | 'public'): KeyObject {
  if (key.type !== role || key.asymmetricKeyType !== 'ed25519') {
    throw new DelegationTokenError('configuration', `Delegation ${role} key must use Ed25519`);
  }
  return key;
}

function parseConfigurationJson(raw: string, message: string): unknown {
  return runGuarded('configuration_json_parse', 'configuration', message, () => JSON.parse(raw));
}

function readTtlSeconds(raw: string | undefined): number {
  const requested = readIntegerSetting(raw, 'OSHAL_DELEGATION_TTL_SECONDS', DEFAULT_TTL_SECONDS);
  // Both ends are bounded so configuration cannot mint ambient, long-lived authority.
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, requested));
}

function readClockSkewSeconds(raw: string | undefined): number {
  const requested = readIntegerSetting(
    raw,
    'OSHAL_DELEGATION_CLOCK_SKEW_SECONDS',
    DEFAULT_CLOCK_SKEW_SECONDS,
  );
  if (requested < 0 || requested > MAX_CLOCK_SKEW_SECONDS) {
    throw new DelegationTokenError('configuration', 'Delegation clock skew is out of range');
  }
  return requested;
}

function readIntegerSetting(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new DelegationTokenError('configuration', `${name} must be an integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) {
    throw new DelegationTokenError('configuration', `${name} must be a safe integer`);
  }
  return value;
}

function issueToken(
  configuration: DelegationIssuerConfiguration,
  grant: DelegationTokenGrant,
  nowEpochSeconds: () => number,
  generateJti: () => string,
  constraints?: DelegationTokenIssueConstraints,
): RecordedDelegationToken {
  const normalized = normalizeGrant(grant);
  const now = readClock(nowEpochSeconds);
  const exp = constrainedExpiry(now, configuration.ttlSeconds, constraints);
  const claims: DelegationTokenClaims = {
    ...normalized,
    iat: now,
    nbf: now,
    exp,
    jti: validateJti(readJti(generateJti), 'configuration'),
  };
  const header: DelegationTokenHeader = {
    alg: TOKEN_ALGORITHM,
    typ: TOKEN_TYPE,
    kid: configuration.activeKid,
    v: DELEGATION_TOKEN_VERSION,
  };
  return Object.freeze({
    token: signToken(header, claims, configuration.privateKey),
    claims: Object.freeze({ ...claims, scope: Object.freeze([...claims.scope]) }) as DelegationTokenClaims,
  });
}

function constrainedExpiry(
  now: number,
  ttlSeconds: number,
  constraints?: DelegationTokenIssueConstraints,
): number {
  const configuredExpiry = now + ttlSeconds;
  if (constraints?.expiresAtEpochSeconds === undefined) return configuredExpiry;
  const ceiling = constraints.expiresAtEpochSeconds;
  if (!Number.isSafeInteger(ceiling) || ceiling < now + MIN_TTL_SECONDS) {
    throw new DelegationTokenError('configuration', 'Delegation expiry ceiling is invalid');
  }
  return Math.min(configuredExpiry, ceiling);
}

function normalizeGrant(grant: DelegationTokenGrant): DelegationTokenGrant {
  if (!isPlainRecord(grant)) {
    throw new DelegationTokenError('malformed', 'Delegation grant must be an object');
  }
  return {
    iss: validateText(grant.iss, 'iss', 256),
    aud: validateText(grant.aud, 'aud', 256),
    sub: validateDelegationSubject(grant.sub, 'sub'),
    principal_iss: validateText(grant.principal_iss, 'principal_iss', 2_048),
    azp: validateText(grant.azp, 'azp', 256),
    task_id: validateText(grant.task_id, 'task_id', 256),
    method: validateMethod(grant.method, 'malformed'),
    path: validatePath(grant.path, 'malformed'),
    body_sha256: validateBodyDigest(grant.body_sha256, 'malformed'),
    scope: normalizeScopes(grant.scope),
  };
}

function readJti(generateJti: () => string): string {
  return runGuarded(
    'jti_generation',
    'configuration',
    'Delegation token identifier generation failed',
    generateJti,
  );
}

function signToken(
  header: DelegationTokenHeader,
  claims: DelegationTokenClaims,
  privateKey: KeyObject,
): string {
  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = runGuarded(
    'token_sign',
    'configuration',
    'Delegation token signing failed',
    () => signEd25519(null, Buffer.from(signingInput, 'ascii'), privateKey),
  );
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new DelegationTokenError('configuration', 'Delegation token signature size is invalid');
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function verifyToken(
  configuration: DelegationVerifierConfiguration,
  token: string,
  expected: DelegationTokenExpectations,
  nowEpochSeconds: () => number,
): DelegationTokenClaims {
  const claims = readSignedClaims(configuration, token);
  const normalizedExpected = normalizeExpectations(expected);
  assertBindings(claims, normalizedExpected);
  assertTimes(claims, readClock(nowEpochSeconds), configuration.clockSkewSeconds);
  return copyClaims(claims);
}

function verifyRouteToken(
  configuration: DelegationVerifierConfiguration,
  token: string,
  expected: DelegationRouteExpectations,
  nowEpochSeconds: () => number,
): DelegationTokenClaims {
  const claims = readSignedClaims(configuration, token);
  const normalizedExpected = normalizeRouteExpectations(expected);
  assertRouteBindings(claims, normalizedExpected);
  assertTimes(claims, readClock(nowEpochSeconds), configuration.clockSkewSeconds);
  return copyClaims(claims);
}

function readSignedClaims(
  configuration: DelegationVerifierConfiguration,
  token: string,
): DelegationTokenClaims {
  const [encodedHeader, encodedClaims, encodedSignature] = splitToken(token);
  const header = parseHeader(encodedHeader);
  const publicKey = configuration.publicKeys.get(header.kid);
  if (!publicKey) {
    throw new DelegationTokenError('invalid_signature', 'Delegation token signature is invalid');
  }
  verifySignature(`${encodedHeader}.${encodedClaims}`, encodedSignature, publicKey);
  return parseClaims(encodedClaims);
}

function copyClaims(claims: DelegationTokenClaims): DelegationTokenClaims {
  return { ...claims, scope: [...claims.scope] };
}

function splitToken(token: string): [string, string, string] {
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new DelegationTokenError('malformed', 'Delegation token size is invalid');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new DelegationTokenError('malformed', 'Delegation token must contain three segments');
  }
  return parts as [string, string, string];
}

function parseHeader(encoded: string): DelegationTokenHeader {
  const value = decodeJsonSegment(encoded, MAX_HEADER_BYTES);
  assertExactKeys(value, ['alg', 'typ', 'kid', 'v']);
  if (value.alg !== TOKEN_ALGORITHM || value.typ !== TOKEN_TYPE || value.v !== DELEGATION_TOKEN_VERSION) {
    throw new DelegationTokenError('malformed', 'Delegation token header is unsupported');
  }
  if (typeof value.kid !== 'string' || !KID_PATTERN.test(value.kid)) {
    throw new DelegationTokenError('malformed', 'Delegation token key identifier is invalid');
  }
  return value as unknown as DelegationTokenHeader;
}

function verifySignature(signingInput: string, encoded: string, publicKey: KeyObject): void {
  const supplied = decodeCanonicalBase64Url(
    encoded,
    ED25519_SIGNATURE_BYTES,
    ED25519_SIGNATURE_BYTES,
    'invalid_signature',
    'Delegation token signature is invalid',
  );
  const valid = runGuarded(
    'token_verify',
    'invalid_signature',
    'Delegation token signature is invalid',
    () => verifyEd25519(null, Buffer.from(signingInput, 'ascii'), publicKey, supplied),
  );
  if (!valid) {
    throw new DelegationTokenError('invalid_signature', 'Delegation token signature is invalid');
  }
}

function parseClaims(encoded: string): DelegationTokenClaims {
  const value = decodeJsonSegment(encoded, MAX_CLAIMS_BYTES);
  assertExactKeys(value, [
    'iss', 'aud', 'sub', 'principal_iss', 'azp', 'task_id', 'method', 'path',
    'body_sha256', 'scope', 'iat', 'nbf', 'exp', 'jti',
  ]);
  const claims: DelegationTokenClaims = {
    iss: validateText(value.iss, 'iss', 256),
    aud: validateText(value.aud, 'aud', 256),
    sub: validateDelegationSubject(value.sub, 'sub'),
    principal_iss: validateText(value.principal_iss, 'principal_iss', 2_048),
    azp: validateText(value.azp, 'azp', 256),
    task_id: validateText(value.task_id, 'task_id', 256),
    method: validateMethod(value.method, 'malformed'),
    path: validatePath(value.path, 'malformed'),
    body_sha256: validateBodyDigest(value.body_sha256, 'malformed'),
    scope: normalizeScopes(value.scope),
    iat: validateTimestamp(value.iat, 'iat'),
    nbf: validateTimestamp(value.nbf, 'nbf'),
    exp: validateTimestamp(value.exp, 'exp'),
    jti: validateJti(value.jti, 'malformed'),
  };
  assertTemporalShape(claims);
  return claims;
}

function decodeJsonSegment(encoded: string, maxBytes: number): Record<string, unknown> {
  const bytes = decodeCanonicalBase64Url(
    encoded,
    2,
    maxBytes,
    'malformed',
    'Delegation token JSON encoding is invalid',
  );
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new DelegationTokenError('malformed', 'Delegation token JSON is not valid UTF-8');
  }
  const value = runGuarded(
    'token_json_parse',
    'malformed',
    'Delegation token JSON is invalid',
    () => JSON.parse(text),
  );
  if (!isPlainRecord(value)) {
    throw new DelegationTokenError('malformed', 'Delegation token JSON must be an object');
  }
  return value;
}

function decodeCanonicalBase64Url(
  encoded: string,
  minBytes: number,
  maxBytes: number,
  code: DelegationTokenErrorCode,
  message: string,
): Buffer {
  if (!BASE64URL_PATTERN.test(encoded)) throw new DelegationTokenError(code, message);
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.toString('base64url') !== encoded
    || decoded.length < minBytes
    || decoded.length > maxBytes
  ) {
    throw new DelegationTokenError(code, message);
  }
  return decoded;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new DelegationTokenError('malformed', 'Delegation token object shape is invalid');
  }
}

function normalizeExpectations(expected: DelegationTokenExpectations): DelegationTokenExpectations {
  if (!isPlainRecord(expected)) {
    throw new DelegationTokenError('invalid_binding', 'Delegation expectations must be an object');
  }
  return {
    iss: validateText(expected.iss, 'expected iss', 256),
    aud: validateText(expected.aud, 'expected aud', 256),
    azp: validateText(expected.azp, 'expected azp', 256),
    task_id: validateText(expected.task_id, 'expected task_id', 256),
    method: validateMethod(expected.method, 'invalid_binding'),
    path: validatePath(expected.path, 'invalid_binding'),
    body_sha256: validateBodyDigest(expected.body_sha256, 'invalid_binding'),
    scope: normalizeScopes(expected.scope),
    sub: validateDelegationSubject(expected.sub, 'expected sub'),
    principal_iss: validateText(expected.principal_iss, 'expected principal_iss', 2_048),
  };
}

function normalizeRouteExpectations(
  expected: DelegationRouteExpectations,
): DelegationRouteExpectations {
  if (!isPlainRecord(expected)) {
    throw new DelegationTokenError('invalid_binding', 'Delegation route expectations must be an object');
  }
  return {
    iss: validateText(expected.iss, 'expected iss', 256),
    aud: validateText(expected.aud, 'expected aud', 256),
    method: validateMethod(expected.method, 'invalid_binding'),
    path: validatePath(expected.path, 'invalid_binding'),
    body_sha256: validateBodyDigest(expected.body_sha256, 'invalid_binding'),
    scope: normalizeScopes(expected.scope),
  };
}

function assertBindings(claims: DelegationTokenClaims, expected: DelegationTokenExpectations): void {
  if (
    claims.iss !== expected.iss
    || claims.aud !== expected.aud
    || claims.azp !== expected.azp
    || claims.task_id !== expected.task_id
    || claims.method !== expected.method
    || claims.path !== expected.path
    || claims.body_sha256 !== expected.body_sha256
    || claims.sub !== expected.sub
    || claims.principal_iss !== expected.principal_iss
    || !sameScopes(claims.scope, expected.scope)
  ) {
    throw new DelegationTokenError('invalid_binding', 'Delegation token dispatch binding is invalid');
  }
}

function assertRouteBindings(
  claims: DelegationTokenClaims,
  expected: DelegationRouteExpectations,
): void {
  if (
    claims.iss !== expected.iss
    || claims.aud !== expected.aud
    || claims.method !== expected.method
    || claims.path !== expected.path
    || claims.body_sha256 !== expected.body_sha256
    || !sameScopes(claims.scope, expected.scope)
  ) {
    throw new DelegationTokenError('invalid_binding', 'Delegation token route binding is invalid');
  }
}

function validateMethod(value: unknown, code: DelegationTokenErrorCode): string {
  if (typeof value !== 'string' || !METHOD_PATTERN.test(value)) {
    throw new DelegationTokenError(code, 'Delegation request method is invalid');
  }
  return value;
}

function validatePath(value: unknown, code: DelegationTokenErrorCode): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || value[0] !== '/'
    || /[\u0000-\u0020\u007F?#\\]/.test(value)
    || value.includes('//')
  ) {
    throw new DelegationTokenError(code, 'Delegation request path is invalid');
  }
  return value;
}

function validateBodyDigest(value: unknown, code: DelegationTokenErrorCode): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new DelegationTokenError(code, 'Delegation request-body digest is invalid');
  }
  return value;
}

function sameScopes(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((scope, index) => scope === expected[index]);
}

function assertTemporalShape(claims: DelegationTokenClaims): void {
  const lifetime = claims.exp - claims.iat;
  if (claims.nbf < claims.iat || claims.exp <= claims.nbf) {
    throw new DelegationTokenError('invalid_time', 'Delegation token time ordering is invalid');
  }
  if (lifetime < MIN_TTL_SECONDS || lifetime > MAX_TTL_SECONDS) {
    throw new DelegationTokenError('invalid_time', 'Delegation token lifetime is invalid');
  }
}

function assertTimes(claims: DelegationTokenClaims, now: number, skew: number): void {
  if (claims.iat > now + skew) {
    throw new DelegationTokenError('invalid_time', 'Delegation token was issued in the future');
  }
  if (claims.nbf > now + skew) {
    throw new DelegationTokenError('invalid_time', 'Delegation token is not active');
  }
  // exp is exclusive; at exactly exp + allowed skew the delegated authority is gone.
  if (now - skew >= claims.exp) {
    throw new DelegationTokenError('invalid_time', 'Delegation token is expired');
  }
}

function readClock(nowEpochSeconds: () => number): number {
  const now = runGuarded(
    'clock_read',
    'configuration',
    'Delegation clock failed',
    nowEpochSeconds,
  );
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new DelegationTokenError('configuration', 'Delegation clock must return Unix epoch seconds');
  }
  return now;
}

function validateTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DelegationTokenError('malformed', `Delegation token ${name} is invalid`);
  }
  return value as number;
}

function validateText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new DelegationTokenError('malformed', `Delegation token ${name} is invalid`);
  }
  return value;
}

function validateDelegationSubject(value: unknown, name: string): string {
  if (typeof value === 'string' && isExactUserSubject(value)) return value;
  throw new DelegationTokenError('malformed', `Delegation token ${name} is invalid`);
}

function validateJti(value: unknown, code: DelegationTokenErrorCode): string {
  if (typeof value !== 'string' || !JTI_PATTERN.test(value)) {
    throw new DelegationTokenError(code, 'Delegation token jti is invalid');
  }
  return value;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPES) {
    throw new DelegationTokenError('malformed', 'Delegation token scope is invalid');
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
      throw new DelegationTokenError('malformed', 'Delegation token scope entry is invalid');
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw new DelegationTokenError('malformed', 'Delegation token scope entries must be unique');
  }
  return scopes.sort();
}

function runGuarded<T>(
  operation: string,
  code: DelegationTokenErrorCode,
  message: string,
  action: () => T,
): T {
  try {
    return action();
  } catch {
    const failure = new Error(`${operation} failed`);
    failure.name = 'DelegationGuardError';
    logger.error({ err: failure, operation }, message);
    throw new DelegationTokenError(code, message);
  }
}

function asDelegationError(
  error: unknown,
  fallbackCode: DelegationTokenErrorCode,
  fallbackMessage: string,
): DelegationTokenError {
  return error instanceof DelegationTokenError
    ? error
    : new DelegationTokenError(fallbackCode, fallbackMessage);
}

function logSanitizedFailure(
  operation: 'issue' | 'verify' | 'verify_route',
  failure: DelegationTokenError,
  startedAt: number,
): void {
  const loggedError = new Error(`Delegation ${operation} rejected`);
  loggedError.name = failure.name;
  logger.error({
    err: loggedError,
    operation,
    code: failure.code,
    durationMs: Date.now() - startedAt,
  }, `Delegation token ${operation} rejected`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
