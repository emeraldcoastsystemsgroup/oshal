/**
 * Webhook HMAC hardening tests (additive, opt-in per webhook).
 *
 * Proves:
 *  - valid GitHub-style signature verifies; invalid/missing fail;
 *  - timingSafeEqual length-mismatch safety (no throw, returns false);
 *  - Slack-style basestring verification;
 *  - middleware is a PASS-THROUGH no-op when its secret env is unset;
 *  - middleware FAIL-CLOSES (401) when enabled and the signature is bad.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for opt-in webhook HMAC guard.
 */
import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { verifyHmacSignature, hmacWebhookGuard } from '@/features/security/hardening/webhook-hmac';

const SECRET = 'shhh-shared-webhook-secret';
const BODY = JSON.stringify({ alert: 'container down', n: 1 });

function githubSig(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

test('verifyHmacSignature — valid GitHub-style signature passes', () => {
  const ok = verifyHmacSignature({
    payload: BODY,
    signatureHeader: githubSig(BODY),
    secret: SECRET,
    prefix: 'sha256=',
  });
  expect(ok).toBe(true);
});

test('verifyHmacSignature — wrong secret fails', () => {
  const ok = verifyHmacSignature({
    payload: BODY,
    signatureHeader: githubSig(BODY, 'other-secret'),
    secret: SECRET,
    prefix: 'sha256=',
  });
  expect(ok).toBe(false);
});

test('verifyHmacSignature — tampered body fails', () => {
  const ok = verifyHmacSignature({
    payload: BODY + 'x',
    signatureHeader: githubSig(BODY),
    secret: SECRET,
    prefix: 'sha256=',
  });
  expect(ok).toBe(false);
});

test('verifyHmacSignature — missing header fails (no throw)', () => {
  expect(verifyHmacSignature({ payload: BODY, signatureHeader: undefined, secret: SECRET, prefix: 'sha256=' })).toBe(false);
});

test('verifyHmacSignature — length-mismatch input is safe (returns false, no throw)', () => {
  // A short bogus hex value vs the full-length expected digest must not throw.
  const ok = verifyHmacSignature({ payload: BODY, signatureHeader: 'sha256=deadbeef', secret: SECRET, prefix: 'sha256=' });
  expect(ok).toBe(false);
});

test('verifyHmacSignature — wrong/absent prefix fails', () => {
  const bare = createHmac('sha256', SECRET).update(BODY).digest('hex');
  expect(verifyHmacSignature({ payload: BODY, signatureHeader: bare, secret: SECRET, prefix: 'sha256=' })).toBe(false);
});

test('verifyHmacSignature — Slack-style basestring verifies', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const base = `v0:${ts}:${BODY}`;
  const sig = 'v0=' + createHmac('sha256', SECRET).update(base, 'utf8').digest('hex');
  const ok = verifyHmacSignature({
    payload: BODY,
    signatureHeader: sig,
    secret: SECRET,
    prefix: 'v0=',
    slack: { timestamp: ts },
  });
  expect(ok).toBe(true);
});

// ── middleware behavior ────────────────────────────────────────────────────

function fakeReqRes(headers: Record<string, string>, rawBody: string) {
  const req = { headers, rawBody } as unknown as Request;
  let statusCode = 0;
  let body: unknown;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  } as unknown as Response & { statusCode: number; body: unknown };
  return { req, res };
}

test('middleware — pass-through no-op when secret env is unset (opt-in)', () => {
  delete process.env.TEST_HMAC_SECRET;
  const guard = hmacWebhookGuard({ secretEnv: 'TEST_HMAC_SECRET', prefix: 'sha256=' });
  const { req, res } = fakeReqRes({}, BODY);
  let called = false;
  guard(req, res as unknown as Response, () => { called = true; });
  expect(called).toBe(true);
  expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
});

test('middleware — fail-closed 401 when enabled and signature invalid', () => {
  process.env.TEST_HMAC_SECRET = SECRET;
  const guard = hmacWebhookGuard({ secretEnv: 'TEST_HMAC_SECRET', header: 'x-hub-signature-256', prefix: 'sha256=' });
  const { req, res } = fakeReqRes({ 'x-hub-signature-256': 'sha256=bad' }, BODY);
  let called = false;
  guard(req, res as unknown as Response, () => { called = true; });
  expect(called).toBe(false);
  expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
  delete process.env.TEST_HMAC_SECRET;
});

test('middleware — passes through to next() when enabled and signature valid', () => {
  process.env.TEST_HMAC_SECRET = SECRET;
  const guard = hmacWebhookGuard({ secretEnv: 'TEST_HMAC_SECRET', header: 'x-hub-signature-256', prefix: 'sha256=' });
  const { req, res } = fakeReqRes({ 'x-hub-signature-256': githubSig(BODY) }, BODY);
  let called = false;
  guard(req, res as unknown as Response, () => { called = true; });
  expect(called).toBe(true);
  expect((res as unknown as { statusCode: number }).statusCode).toBe(0);
  delete process.env.TEST_HMAC_SECRET;
});
