/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the SEC-01 legacy read refusal, sanitized route/workload telemetry, exact error contract, and independently authenticated OIDC/PAT precedence under mixed legacy headers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const logSpies = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
  logger: logSpies,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[redacted]' },
}));

import { rejectLegacyServiceIdentityForUserRead } from '@/features/security';

const SERVICE_SECRET = 'unit-sec01-fleet-credential';
const ROUTE = '/api/jarvis/tasks';

interface GuardResult {
  nextCalled: boolean;
  status?: number;
  body?: unknown;
}

/** Drive the middleware without HTTP normalization so hostile telemetry bytes stay testable. */
function driveGuard(headers: Request['headers'], oidc?: unknown): GuardResult {
  const result: GuardResult = { nextCalled: false };
  const req = { method: 'GET', headers, oidc } as unknown as Request;
  const res = {
    status: (status: number) => { result.status = status; return res; },
    json: (body: unknown) => { result.body = body; return res; },
  } as unknown as Response;
  const next: NextFunction = () => { result.nextCalled = true; };
  rejectLegacyServiceIdentityForUserRead(ROUTE)(req, res, next);
  return result;
}

describe('SEC-01 legacy service identity read guard', () => {
  beforeEach(() => {
    vi.stubEnv('SWARM_SERVICE_SECRET', SERVICE_SECRET);
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('returns the exact 403 for a matching legacy credential and victim substitution', () => {
    const result = driveGuard({
      'x-service-secret': SERVICE_SECRET,
      'x-oshal-user-sub': 'victim-subject-never-log',
      'x-oshal-workload-id': 'bot-one\nBearer private',
    });

    expect(result).toEqual({
      nextCalled: false,
      status: 403,
      body: { error: 'legacy_service_identity_not_allowed' },
    });
    const [context] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
    expect(context).toMatchObject({
      route: ROUTE,
      method: 'GET',
      workload: 'bot-one_Bearer_private',
      workloadSource: 'x-oshal-workload-id',
      workloadAttribution: 'unverified',
      assertedSubjectHeader: 'plain',
    });
    expect(JSON.stringify(logSpies.warn.mock.calls)).not.toContain(SERVICE_SECRET);
    expect(JSON.stringify(logSpies.warn.mock.calls)).not.toContain('victim-subject-never-log');
  });

  it('uses the same refusal when the encoded subject is absent or attacker-selected', () => {
    const encoded = driveGuard({
      'x-service-secret': SERVICE_SECRET,
      'x-oshal-user-sub-b64': Buffer.from('second-victim').toString('base64url'),
    });
    expect(encoded.status).toBe(403);
    expect(logSpies.warn.mock.calls[0]?.[0]).toMatchObject({ assertedSubjectHeader: 'encoded' });

    vi.clearAllMocks();
    const missing = driveGuard({ 'x-service-secret': SERVICE_SECRET });
    expect(missing.status).toBe(403);
    expect(logSpies.warn.mock.calls[0]?.[0]).toMatchObject({ assertedSubjectHeader: 'missing' });
  });

  it.each(['browser OIDC', 'PAT'])('keeps an authenticated %s principal authoritative', () => {
    const result = driveGuard(
      { 'x-service-secret': SERVICE_SECRET, 'x-oshal-user-sub': 'victim-substitution' },
      { isAuthenticated: () => true, user: { sub: 'authenticated-owner' } },
    );
    expect(result).toEqual({ nextCalled: true });
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('does not trust a caller-populated user object without authenticated-session proof', () => {
    const result = driveGuard(
      { 'x-service-secret': SERVICE_SECRET, 'x-oshal-user-sub': 'victim-substitution' },
      { user: { sub: 'spoofed-owner' } },
    );
    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });

  it('leaves missing or invalid legacy credentials to the ordinary authentication wall', () => {
    expect(driveGuard({}).nextCalled).toBe(true);
    expect(driveGuard({ 'x-service-secret': `${SERVICE_SECRET}x` }).nextCalled).toBe(true);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });
});
