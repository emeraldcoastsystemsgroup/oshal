/**
 * RingCentral connector conformance.
 *
 * Added when the connector was, for an inbound-call screen-pop: a CRM resolves the caller's number
 * to a customer record before the rep says hello. The catalog audit covers the shipped set in
 * aggregate; this pins the two things that make THIS spec useful and are easy to break silently —
 * that `~` (RingCentral's literal "current account/extension" token, not a placeholder) survives
 * into the request path, and that the live-call + history reads are present and GET-only.
 *
 * No network, no credentials.
 *
 * @module tests/unit/connectors/ringcentral-spec
 */
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { auditSpec, buildClientFromSpec, loadConnectorSpec } from '@/app/connectors/runtime';

const SPEC = path.join(process.cwd(), 'swarm-apps/connectors', 'ringcentral.yaml');

function mockFetch(body: unknown) {
  const calls: Array<{ url: string }> = [];
  const fn = vi.fn(async (url: string) => {
    calls.push({ url });
    return { status: 200, ok: true, text: async () => JSON.stringify(body), headers: { get: () => null } } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('ringcentral connector spec', () => {
  it('loads and declares OAuth 2.0 against the production host', () => {
    const spec = loadConnectorSpec(SPEC);
    expect(spec.provider).toBe('ringcentral');
    expect(spec.auth?.type).toBe('oauth2');
    // The sandbox (platform.devtest.ringcentral.com) has separate credentials and numbers —
    // shipping it as the default would silently point a customer at a test switch.
    expect(spec.baseUrl).toBe('https://platform.ringcentral.com');
  });

  it('passes the catalog audit', () => {
    expect(auditSpec(loadConnectorSpec(SPEC)).errors ?? []).toEqual([]);
  });

  it('is read-only — a connector must not place calls or send SMS by accident', () => {
    for (const r of loadConnectorSpec(SPEC).resources) expect(r.method).toBe('GET');
  });

  it('carries the reads a screen-pop and a call-history backfill need', () => {
    const tools = loadConnectorSpec(SPEC).resources.map((r) => r.tool);
    for (const required of [
      'ringcentral-active-calls',          // "who is ringing right now"
      'ringcentral-company-active-calls',
      'ringcentral-call-log',              // backfill activities
      'ringcentral-company-call-log',
      'ringcentral-list-extensions',       // map RingCentral users -> CRM reps
      'ringcentral-message-store',         // SMS + voicemail share the store
    ]) expect(tools).toContain(required);
  });

  it('keeps ~ in the path — it is the literal current-account token, not a placeholder', async () => {
    const spec = loadConnectorSpec(SPEC);
    const { fn, calls } = mockFetch({ records: [] });
    const client = buildClientFromSpec(spec, { token: async () => 'test-bearer', fetchImpl: fn });
    await client.call('active-calls', {});
    expect(calls).toHaveLength(1);
    // If a templating change ever ate the tilde, the URL silently becomes a 404 against a real
    // account and the screen-pop just stops firing.
    expect(calls[0].url).toContain('/restapi/v1.0/account/~/extension/~/active-calls');
    expect(calls[0].url.startsWith('https://platform.ringcentral.com/')).toBe(true);
  });

  it('does not declare a pagination strategy it cannot honour', () => {
    // RingCentral pages are 1-BASED (`paging.page`); the runtime's offset walker starts at 0 and
    // steps by pageSize, so declaring it would mis-walk every result set. Params are exposed
    // instead and the caller pages explicitly.
    const spec = loadConnectorSpec(SPEC);
    expect(spec.pagination).toBeUndefined();
    const callLog = spec.resources.find((r) => r.tool === 'ringcentral-call-log');
    expect(Object.keys(callLog?.query ?? {})).toEqual(expect.arrayContaining(['page', 'perPage', 'phoneNumber']));
  });
});
