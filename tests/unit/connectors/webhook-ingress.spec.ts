/**
 * Webhook ingress conformance (ADR-065 Phase 2).
 *
 * Asserts the inbound-webhook contract every connector inherits: signature/secret verification over
 * the raw body, replay/dedup protection, and a clean dispatch — unknown event 404, bad signature 401,
 * good event 200-and-dispatched-once, duplicate delivery deduped. Pure functions, no HTTP server.
 *
 * @module tests/unit/connectors/webhook-ingress
 */
import crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';
import { verifySignature, dispatchWebhook, inMemorySeenStore, resolveSecret, type WebhookEventSpec } from '@/app/connectors/webhooks/webhook-ingress';

const SECRET = 'whsec_test';
const hmac = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

describe('verifySignature', () => {
  it('accepts a valid hmac (with sha256= prefix) and rejects a tampered body', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifySignature({ type: 'hmac', header: 'X-Sig', secret: SECRET }, body, { 'x-sig': hmac(body) }).ok).toBe(true);
    expect(verifySignature({ type: 'hmac', header: 'X-Sig', secret: SECRET }, body + 'tamper', { 'x-sig': hmac(body) }).ok).toBe(false);
  });

  it('shared-secret compares constant-time and rejects a mismatch / missing header', () => {
    expect(verifySignature({ type: 'shared-secret', header: 'X-Token', secret: 'abc' }, '', { 'x-token': 'abc' }).ok).toBe(true);
    expect(verifySignature({ type: 'shared-secret', header: 'X-Token', secret: 'abc' }, '', { 'x-token': 'nope' }).ok).toBe(false);
    expect(verifySignature({ type: 'shared-secret', header: 'X-Token', secret: 'abc' }, '', {}).reason).toMatch(/missing/);
  });

  it('fails closed when no secret is configured', () => {
    expect(verifySignature({ type: 'hmac', header: 'X-Sig', secret: '' }, 'x', { 'x-sig': 'whatever' }).ok).toBe(false);
  });
});

describe('dispatchWebhook', () => {
  const events: WebhookEventSpec[] = [{ provider: 'spotify', event: 'playback.changed', verify: { type: 'hmac', header: 'X-Sig', secret: SECRET } }];

  it('404s an unknown provider/event', async () => {
    const onEvent = vi.fn();
    const r = await dispatchWebhook({ events, onEvent }, { provider: 'spotify', event: 'nope' }, '{}', {});
    expect(r.status).toBe(404);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('401s a bad signature and does not dispatch', async () => {
    const onEvent = vi.fn();
    const r = await dispatchWebhook({ events, onEvent }, { provider: 'spotify', event: 'playback.changed' }, '{"x":1}', { 'x-sig': 'sha256=bad' });
    expect(r.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('dispatches a verified event once and dedups a replayed delivery id', async () => {
    const onEvent = vi.fn();
    const seen = inMemorySeenStore();
    const body = JSON.stringify({ track: 'abc' });
    const headers = { 'x-sig': hmac(body), 'x-delivery-id': 'evt_1' };

    const first = await dispatchWebhook({ events, onEvent, seen }, { provider: 'spotify', event: 'playback.changed' }, body, headers);
    expect(first.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({ provider: 'spotify', event: 'playback.changed', deliveryId: 'evt_1', payload: { track: 'abc' } });

    const replay = await dispatchWebhook({ events, onEvent, seen }, { provider: 'spotify', event: 'playback.changed' }, body, headers);
    expect(replay.body.deduped).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1); // not dispatched again
  });

  it('content-hashes a delivery id when the provider sends none (replayed body dedups)', async () => {
    const onEvent = vi.fn();
    const seen = inMemorySeenStore();
    const body = JSON.stringify({ n: 7 });
    const headers = { 'x-sig': hmac(body) };
    await dispatchWebhook({ events, onEvent, seen }, { provider: 'spotify', event: 'playback.changed' }, body, headers);
    await dispatchWebhook({ events, onEvent, seen }, { provider: 'spotify', event: 'playback.changed' }, body, headers);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSecret', () => {
  it('resolves env: references and passes literals through', () => {
    process.env.__WH_TEST = 'fromenv';
    expect(resolveSecret('env:__WH_TEST')).toBe('fromenv');
    expect(resolveSecret('literal')).toBe('literal');
    expect(resolveSecret(undefined)).toBe('');
  });
});
