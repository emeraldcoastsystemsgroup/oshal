/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deterministic golden, tamper, configuration, binding, time-boundary, and rotation guards for task-bound delegation tokens.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reworked the guards for Ed25519, separate issuer/verifier capabilities, public-only bot configuration, key-role validation, and sanitized parser failures.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard the separately signed principal issuer against identity-provider namespace substitution.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard the exact canonical request-body digest claim and reject body-integrity substitution.
 */

import {
  generateKeyPairSync,
  sign as signEd25519,
  type JsonWebKey,
  type KeyObject,
} from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  createDelegationTokenIssuer,
  createDelegationTokenVerifier,
  DelegationTokenError,
  type DelegationTokenErrorCode,
  type DelegationTokenIssuer,
  type DelegationTokenVerifier,
} from '@/shared/security/delegation-token';
import type {
  DelegationTokenClaims,
  DelegationTokenExpectations,
  DelegationTokenGrant,
} from '@/shared/types';

const NOW = 1_800_000_000;
const BODY_SHA256 = 'a'.repeat(64);
const ACTIVE_PAIR = generateKeyPairSync('ed25519');
const PREVIOUS_PAIR = generateKeyPairSync('ed25519');
const RSA_PAIR = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const ACTIVE_PRIVATE_PEM = privatePem(ACTIVE_PAIR.privateKey);
const ACTIVE_PUBLIC_PEM = publicPem(ACTIVE_PAIR.publicKey);
const PREVIOUS_PRIVATE_JWK = privateJwk(PREVIOUS_PAIR.privateKey);
const PREVIOUS_PUBLIC_JWK = publicJwk(PREVIOUS_PAIR.publicKey);
const RSA_PRIVATE_PEM = privatePem(RSA_PAIR.privateKey);
const RSA_PUBLIC_PEM = publicPem(RSA_PAIR.publicKey);

type PublicKeyMaterial = string | JsonWebKey;

function privatePem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function publicPem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function privateJwk(key: KeyObject): JsonWebKey {
  return key.export({ format: 'jwk' });
}

function publicJwk(key: KeyObject): JsonWebKey {
  return key.export({ format: 'jwk' });
}

function issuerEnvironment(
  privateKey = ACTIVE_PRIVATE_PEM,
  kid = 'current',
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: privateKey,
    OSHAL_DELEGATION_SIGNING_KID: kid,
    ...overrides,
  };
}

function verifierEnvironment(
  publicKeys: Record<string, PublicKeyMaterial> = { current: ACTIVE_PUBLIC_PEM },
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify(publicKeys),
    ...overrides,
  };
}

function issuer(
  env = issuerEnvironment(),
  clock: { now: number } = { now: NOW },
  jti = 'jti-golden-0001',
): DelegationTokenIssuer {
  return createDelegationTokenIssuer({
    env,
    nowEpochSeconds: () => clock.now,
    generateJti: () => jti,
  });
}

function verifier(
  env = verifierEnvironment(),
  clock: { now: number } = { now: NOW },
): DelegationTokenVerifier {
  return createDelegationTokenVerifier({ env, nowEpochSeconds: () => clock.now });
}

function grant(overrides: Partial<DelegationTokenGrant> = {}): DelegationTokenGrant {
  return {
    iss: 'oshal-controller',
    aud: 'oshal-bot-node',
    sub: 'oidc|alice',
    principal_iss: 'https://identity.example.test/realms/main',
    azp: 'agent-17',
    task_id: 'task-42',
    body_sha256: BODY_SHA256,
    scope: ['store:read', 'task:execute'],
    ...overrides,
  };
}

function expectations(
  overrides: Partial<DelegationTokenExpectations> = {},
): DelegationTokenExpectations {
  return {
    iss: 'oshal-controller',
    aud: 'oshal-bot-node',
    sub: 'oidc|alice',
    principal_iss: 'https://identity.example.test/realms/main',
    azp: 'agent-17',
    task_id: 'task-42',
    body_sha256: BODY_SHA256,
    scope: ['store:read', 'task:execute'],
    ...overrides,
  };
}

function decodeSegment<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
}

function tokenParts(token: string): [string, string, string] {
  return token.split('.') as [string, string, string];
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signEncoded(
  encodedHeader: string,
  encodedClaims: string,
  key: KeyObject = ACTIVE_PAIR.privateKey,
): string {
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = signEd25519(null, Buffer.from(input, 'ascii'), key).toString('base64url');
  return `${input}.${signature}`;
}

function signRaw(header: unknown, claims: unknown, key?: KeyObject): string {
  return signEncoded(encodeJson(header), encodeJson(claims), key);
}

function issuedParts(): { header: Record<string, unknown>; claims: DelegationTokenClaims } {
  const [header, claims] = tokenParts(issuer().issue(grant()));
  return {
    header: decodeSegment<Record<string, unknown>>(header),
    claims: decodeSegment<DelegationTokenClaims>(claims),
  };
}

function signedClaims(overrides: Partial<DelegationTokenClaims> = {}): string {
  const { header, claims } = issuedParts();
  return signRaw(header, { ...claims, ...overrides });
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected delegation operation to fail');
}

function expectCode(action: () => unknown, code: DelegationTokenErrorCode): DelegationTokenError {
  const error = captureError(action);
  expect(error).toBeInstanceOf(DelegationTokenError);
  expect(error).not.toBeInstanceOf(SyntaxError);
  expect((error as DelegationTokenError).code).toBe(code);
  return error as DelegationTokenError;
}

describe('delegation capability separation and wire contract', () => {
  it('issues deterministic EdDSA tokens and verifies every signed claim', () => {
    const controller = issuer();
    const token = controller.issue(grant());
    const [encodedHeader] = tokenParts(token);

    expect(controller.issue(grant())).toBe(token);
    expect(decodeSegment(encodedHeader)).toEqual({
      alg: 'EdDSA', typ: 'OSHAL-DLG', kid: 'current', v: 1,
    });
    expect(verifier().verify(token, expectations({ scope: ['task:execute', 'store:read'] }))).toEqual({
      ...grant({ scope: ['store:read', 'task:execute'] }),
      iat: NOW, nbf: NOW, exp: NOW + 4_200, jti: 'jti-golden-0001',
    });
  });

  it('returns distinct frozen capabilities with no cross-boundary method', () => {
    const controller = issuer();
    const bot = verifier();

    expect(Object.keys(controller)).toEqual(['issue']);
    expect(Object.keys(bot)).toEqual(['verify']);
    expect('verify' in controller).toBe(false);
    expect('issue' in bot).toBe(false);
    expect(Object.isFrozen(controller)).toBe(true);
    expect(Object.isFrozen(bot)).toBe(true);
  });

  it('constructs and verifies on a bot with public material only', () => {
    const publicOnlyEnv = verifierEnvironment();
    expect(publicOnlyEnv.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(verifier(publicOnlyEnv).verify(issuer().issue(grant()), expectations()).sub).toBe('oidc|alice');
  });

  it('fails startup if private signing material leaks into a verifier environment', () => {
    const leakedEnv = verifierEnvironment();
    leakedEnv.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY = ACTIVE_PRIVATE_PEM;
    expectCode(() => verifier(leakedEnv), 'configuration');
  });
});

describe('delegation asymmetric key configuration', () => {
  it('never falls back to the ambient swarm secret or legacy symmetric variables', () => {
    const ambient = { SWARM_SERVICE_SECRET: 'example' };
    const legacy = { OSHAL_DELEGATION_KEYS: JSON.stringify({ current: 'legacy' }) };

    expectCode(() => createDelegationTokenIssuer({ env: ambient }), 'configuration');
    expectCode(() => createDelegationTokenVerifier({ env: ambient }), 'configuration');
    expectCode(() => createDelegationTokenIssuer({ env: legacy }), 'configuration');
    expectCode(() => createDelegationTokenVerifier({ env: legacy }), 'configuration');
  });

  it('rejects public material for issuance and private material for verification', () => {
    expectCode(() => issuer(issuerEnvironment(ACTIVE_PUBLIC_PEM)), 'configuration');
    expectCode(
      () => verifier(verifierEnvironment({ current: ACTIVE_PRIVATE_PEM })),
      'configuration',
    );
    expectCode(
      () => issuer(issuerEnvironment(JSON.stringify(publicJwk(ACTIVE_PAIR.publicKey)))),
      'configuration',
    );
    expectCode(
      () => verifier(verifierEnvironment({ current: privateJwk(ACTIVE_PAIR.privateKey) })),
      'configuration',
    );
  });

  it('rejects non-Ed25519 keys even when their PEM roles are correct', () => {
    expectCode(() => issuer(issuerEnvironment(RSA_PRIVATE_PEM)), 'configuration');
    expectCode(() => verifier(verifierEnvironment({ current: RSA_PUBLIC_PEM })), 'configuration');
  });

  it('sanitizes malformed JSON, key documents, and JWK base64 failures', () => {
    const badJwk = { kty: 'OKP', crv: 'Ed25519', x: 'not+base64url' };
    const badPem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
    const privateError = expectCode(() => issuer(issuerEnvironment('{')), 'configuration');
    const ringError = expectCode(
      () => createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: '{' } }),
      'configuration',
    );
    const pemError = expectCode(() => issuer(issuerEnvironment(badPem)), 'configuration');
    expectCode(() => verifier(verifierEnvironment({ current: badJwk })), 'configuration');
    expect(privateError.message).toBe('Delegation private JWK is invalid');
    expect(ringError.message).toBe('Delegation public-key document is invalid');
    expect(pemError.message).toBe('Delegation private key is invalid');
  });
});

describe('delegation token tamper and parser rails', () => {
  it('rejects payload and signature tampering before granting authority', () => {
    const token = issuer().issue(grant());
    const [header, claims, signature] = tokenParts(token);
    const changedClaims = `${claims[0] === 'A' ? 'B' : 'A'}${claims.slice(1)}`;
    const changedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

    expectCode(() => verifier().verify(`${header}.${changedClaims}.${signature}`, expectations()), 'invalid_signature');
    expectCode(() => verifier().verify(`${header}.${claims}.${changedSignature}`, expectations()), 'invalid_signature');
    expectCode(() => verifier().verify(`${header}.${claims}.not+base64`, expectations()), 'invalid_signature');
  });

  it('converts malformed header and claim JSON into sanitized domain errors', () => {
    const { header } = issuedParts();
    const badHeader = `${Buffer.from('{').toString('base64url')}.e30.signature`;
    const badClaims = signEncoded(encodeJson(header), Buffer.from('{').toString('base64url'));

    expectCode(() => verifier().verify(badHeader, expectations()), 'malformed');
    expectCode(() => verifier().verify(badClaims, expectations()), 'malformed');
  });

  it.each([
    ['two segments', 'one.segment'],
    ['four segments', 'one.two.three.four'],
    ['oversized token', 'a'.repeat(8_193)],
  ])('rejects a malformed token with %s', (_label, token) => {
    expectCode(() => verifier().verify(token, expectations()), 'malformed');
  });
});

describe('delegation strict signed shape', () => {
  it.each([
    ['algorithm', { alg: 'none' }],
    ['type', { typ: 'JWT' }],
    ['version', { v: 2 }],
    ['key id', { kid: 'retired' }],
  ])('rejects a signed token with the wrong %s header', (_label, override) => {
    const { header, claims } = issuedParts();
    const token = signRaw({ ...header, ...override }, claims);
    expectCode(
      () => verifier().verify(token, expectations()),
      override.kid === 'retired' ? 'invalid_signature' : 'malformed',
    );
  });

  it('rejects missing, extra, and ambiguous claims even when signed', () => {
    const { header, claims } = issuedParts();
    const { jti: _removed, ...missingJti } = claims;
    const extra = signRaw(header, { ...claims, delegated_admin: true });
    const missing = signRaw(header, missingJti);
    const duplicateScope = signRaw(header, { ...claims, scope: ['store:read', 'store:read'] });
    const invalidDigest = signRaw(header, { ...claims, body_sha256: 'A'.repeat(64) });

    expectCode(() => verifier().verify(extra, expectations()), 'malformed');
    expectCode(() => verifier().verify(missing, expectations()), 'malformed');
    expectCode(() => verifier().verify(duplicateScope, expectations()), 'malformed');
    expectCode(() => verifier().verify(invalidDigest, expectations()), 'malformed');
  });
});

describe('delegation exact dispatch binding', () => {
  it.each([
    ['issuer', { iss: 'other-controller' }],
    ['audience', { aud: 'other-service' }],
    ['agent', { azp: 'agent-18' }],
    ['task', { task_id: 'task-43' }],
    ['request body', { body_sha256: 'b'.repeat(64) }],
    ['scope', { scope: ['task:execute'] }],
    ['subject', { sub: 'oidc|mallory' }],
    ['principal issuer', { principal_iss: 'https://identity.example.test/realms/other' }],
  ])('rejects the wrong expected %s', (_label, override) => {
    const expected = expectations({ sub: 'oidc|alice', ...override });
    expectCode(() => verifier().verify(issuer().issue(grant()), expected), 'invalid_binding');
  });

  it('requires the exact scope set while treating order as non-authoritative', () => {
    const token = issuer().issue(grant());
    expect(verifier().verify(token, expectations({
      scope: ['task:execute', 'store:read'],
    })).scope).toEqual(['store:read', 'task:execute']);
    expectCode(() => verifier().verify(token, expectations({
      scope: ['store:read', 'task:execute', 'store:write'],
    })), 'invalid_binding');
  });

  it('fails closed when a caller omits the expected user subject at runtime', () => {
    const expected = { ...expectations(), sub: undefined } as unknown as DelegationTokenExpectations;
    expectCode(() => verifier().verify(issuer().issue(grant()), expected), 'malformed');
  });
});

describe('delegation token time boundaries', () => {
  it('accepts iat and nbf at the skew boundary but rejects one second beyond', () => {
    const atBoundary = signedClaims({ iat: NOW + 30, nbf: NOW + 30, exp: NOW + 330 });
    const beyond = signedClaims({ iat: NOW + 31, nbf: NOW + 31, exp: NOW + 331 });

    expect(verifier().verify(atBoundary, expectations()).iat).toBe(NOW + 30);
    expectCode(() => verifier().verify(beyond, expectations()), 'invalid_time');
  });

  it('treats exp as exclusive after skew and enforces the signed maximum TTL', () => {
    const justValidExp = NOW - 29;
    const expiredExp = NOW - 30;
    const valid = signedClaims({ iat: justValidExp - 300, nbf: justValidExp - 300, exp: justValidExp });
    const expired = signedClaims({ iat: expiredExp - 300, nbf: expiredExp - 300, exp: expiredExp });
    const tooShort = signedClaims({ iat: NOW, nbf: NOW, exp: NOW + 299 });
    const tooLong = signedClaims({ iat: NOW, nbf: NOW, exp: NOW + 5_401 });

    expect(verifier().verify(valid, expectations()).exp).toBe(justValidExp);
    expectCode(() => verifier().verify(expired, expectations()), 'invalid_time');
    expectCode(() => verifier().verify(tooShort, expectations()), 'invalid_time');
    expectCode(() => verifier().verify(tooLong, expectations()), 'invalid_time');
  });

  it('bounds configured TTL and skew and sanitizes a failing clock', () => {
    const lifetimes = ['1', '999999'].map((ttl) => {
      const token = issuer(issuerEnvironment(ACTIVE_PRIVATE_PEM, 'current', {
        OSHAL_DELEGATION_TTL_SECONDS: ttl,
      })).issue(grant());
      const claims = decodeSegment<DelegationTokenClaims>(tokenParts(token)[1]);
      return claims.exp - claims.iat;
    });
    expect(lifetimes).toEqual([300, 5_400]);
    expectCode(() => verifier(verifierEnvironment({ current: ACTIVE_PUBLIC_PEM }, {
      OSHAL_DELEGATION_CLOCK_SKEW_SECONDS: '301',
    })), 'configuration');
    const badClock = createDelegationTokenIssuer({
      env: issuerEnvironment(),
      nowEpochSeconds: () => { throw new Error('clock detail'); },
    });
    expectCode(() => badClock.issue(grant()), 'configuration');
  });
});

describe('delegation public-key rotation', () => {
  it('accepts an explicitly retained JWK kid and rejects it once retired', () => {
    const oldController = issuer(
      issuerEnvironment(JSON.stringify(PREVIOUS_PRIVATE_JWK), 'previous'),
      { now: NOW },
      'jti-previous',
    );
    const oldToken = oldController.issue(grant());
    const rotated = verifier(verifierEnvironment({
      current: ACTIVE_PUBLIC_PEM,
      previous: PREVIOUS_PUBLIC_JWK,
    }));
    const retired = verifier(verifierEnvironment({ current: ACTIVE_PUBLIC_PEM }));

    expect(rotated.verify(oldToken, expectations()).jti).toBe('jti-previous');
    expect(decodeSegment(tokenParts(issuer().issue(grant()))[0])).toMatchObject({ kid: 'current' });
    expectCode(() => retired.verify(oldToken, expectations()), 'invalid_signature');
  });
});
