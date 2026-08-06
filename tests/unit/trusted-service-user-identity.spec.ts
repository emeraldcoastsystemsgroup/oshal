/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added behavior coverage for the shared user-bound service middleware: valid asserted owners become non-operator request identities, missing bindings fail closed, and ordinary session identities pass through unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Name the deterministic service credential as a test placeholder so repository secret scanning remains fail-closed without mistaking fixture data for deployable material.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard canonical encoded service-user subjects, including exact whitespace/case round-trip and fail-closed malformed payload handling.
 */

import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireTrustedServiceUserIdentity } from '@/shared/middleware/trusted-service-user-identity';
import { trustedServiceUserHeaders } from '@/shared/middleware/authz';
import {
  getRequestIdentity,
  runWithRequestIdentity,
  type RequestIdentity,
} from '@/shared/services/database/request-identity';

interface ResponseObservation {
  status?: number;
  body?: unknown;
}

const SERVICE_CREDENTIAL_PLACEHOLDER = 'service-user-test-placeholder';

/** Build only the response surface the middleware is allowed to use. */
function responseDouble(seen: ResponseObservation): Response {
  return {
    status(code: number) {
      seen.status = code;
      return this;
    },
    json(body: unknown) {
      seen.body = body;
      return this;
    },
  } as Response;
}

/** Build a request with normalized Express-style lowercase headers. */
function request(headers: Record<string, string>): Request {
  return {
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
  } as unknown as Request;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireTrustedServiceUserIdentity', () => {
  it('re-enters a valid service call as the asserted owner without operator reach', () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_CREDENTIAL_PLACEHOLDER);
    let inside: RequestIdentity | undefined;
    const next: NextFunction = () => { inside = getRequestIdentity(); };

    requireTrustedServiceUserIdentity(request({
      'x-service-secret': SERVICE_CREDENTIAL_PLACEHOLDER,
      'x-oshal-user-sub': 'auth0|bound-owner',
    }), responseDouble({}), next);

    expect(inside).toEqual({ sub: 'auth0|bound-owner', isOperator: false });
  });

  it('re-enters an encoded service call with its exact case and whitespace intact', () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_CREDENTIAL_PLACEHOLDER);
    const exactSub = ' Auth0|Bound-Owner ';
    let inside: RequestIdentity | undefined;

    requireTrustedServiceUserIdentity(
      request(trustedServiceUserHeaders(exactSub)),
      responseDouble({}),
      () => { inside = getRequestIdentity(); },
    );

    expect(inside).toEqual({ sub: exactSub, isOperator: false });
  });

  it('rejects malformed encoded identity instead of falling back to a legacy claim', () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_CREDENTIAL_PLACEHOLDER);
    const seen: ResponseObservation = {};
    const next = vi.fn();

    requireTrustedServiceUserIdentity(request({
      'x-service-secret': SERVICE_CREDENTIAL_PLACEHOLDER,
      'x-oshal-user-sub-b64': 'not+base64url',
      'x-oshal-user-sub': 'auth0|fallback-owner',
    }), responseDouble(seen), next);

    expect(next).not.toHaveBeenCalled();
    expect(seen).toEqual({ status: 403, body: { error: 'trusted_service_user_sub_required' } });
  });

  it('refuses a valid machine credential that omits its accountable user binding', () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_CREDENTIAL_PLACEHOLDER);
    const seen: ResponseObservation = {};
    const next = vi.fn();

    requireTrustedServiceUserIdentity(
      request({ 'x-service-secret': SERVICE_CREDENTIAL_PLACEHOLDER }),
      responseDouble(seen),
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(seen).toEqual({ status: 403, body: { error: 'trusted_service_user_sub_required' } });
  });

  it('leaves an ordinary OIDC/PAT request identity exactly as the outer middleware established it', () => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_CREDENTIAL_PLACEHOLDER);
    const sessionIdentity = { sub: 'auth0|session-owner', isOperator: false };
    let inside: RequestIdentity | undefined;

    runWithRequestIdentity(sessionIdentity, () => {
      requireTrustedServiceUserIdentity(
        request({}),
        responseDouble({}),
        () => { inside = getRequestIdentity(); },
      );
    });

    expect(inside).toEqual(sessionIdentity);
  });
});
