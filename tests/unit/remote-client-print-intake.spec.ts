/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the node-plane print intake (ADR-135 amendment H). Two boundaries are proven, not mocked: (1) the REAL decideNodeTokenScope decides both the old global intake path and the new node-plane path, so the defect that made this necessary — a node token refused 'off-plane' at /api/print-ingest/documents — stays visible and its fix stays proven; (2) the REAL handler performs the device -> owner identity translation, so a node can never file into a foreign sub, and an unowned device is refused rather than guessed at.
 */

import { describe, expect, it } from 'vitest';
import { decideNodeTokenScope } from '@/features/remote-client';
import { __testing } from '@/app/routes/remote-client-print-routes';

const { handlePrintDocument, readDocument } = __testing;

/** Minimal Express response double that records what the handler wrote. */
function makeRes() {
  const state: { code: number; body: unknown; type: string } = { code: 0, body: null, type: '' };
  const res = {
    status(code: number) { state.code = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    type(t: string) { state.type = t; return res; },
    send(body: unknown) { state.body = body; return res; },
  };
  return { res, state };
}

function makeReq(clientId: string, body: unknown) {
  return { params: { clientId }, body } as never;
}

describe('node-bound token scope — why the intake lives on the node plane', () => {
  it('the GLOBAL print intake refuses a node token (the defect this design works around)', () => {
    const decision = decideNodeTokenScope({
      boundClientId: 'oshal-chat-abc',
      path: '/api/print-ingest/documents',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('off-plane');
  });

  it("the NODE-PLANE intake admits that same token on its OWN device", () => {
    const decision = decideNodeTokenScope({
      boundClientId: 'oshal-chat-abc',
      path: '/api/remote-clients/oshal-chat-abc/print-documents',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('own-device-plane');
  });

  it('a node cannot file on ANOTHER device\'s print plane', () => {
    const decision = decideNodeTokenScope({
      boundClientId: 'oshal-chat-abc',
      path: '/api/remote-clients/oshal-chat-victim/print-documents',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('foreign-device');
  });
});

describe('identity translation — the node proves the device, the swarm supplies the owner', () => {
  it('files under the DEVICE OWNER, never a sub the node supplied', async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ headers: init.headers, body: init.body });
      return { status: 201, text: async () => JSON.stringify({ intake: { id: 1 } }) };
    }) as unknown as typeof fetch;

    process.env.SWARM_SERVICE_SECRET = 'test-secret';
    const registry = { getClient: () => ({ clientId: 'node-1', ownerSub: 'owner-sub-real' }) };
    const { res, state } = makeRes();

    // The node ATTEMPTS to name a different owner — it must be ignored entirely.
    await handlePrintDocument(
      makeReq('node-1', { text: 'printed content', sidecar: { title: 'doc' }, ownerSub: 'attacker-sub' }),
      res as never,
      { registry, fetchImpl },
    );

    expect(state.code).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-oshal-user-sub']).toBe('owner-sub-real');
    // The forwarded body carries only text + sidecar; no caller-supplied identity survives.
    expect(JSON.parse(seen[0].body)).toEqual({ text: 'printed content', sidecar: { title: 'doc' } });
  });

  it('an UNOWNED device is refused — there is nobody to file for', async () => {
    process.env.SWARM_SERVICE_SECRET = 'test-secret';
    const registry = { getClient: () => ({ clientId: 'node-1', ownerSub: null }) };
    const { res, state } = makeRes();
    let called = false;
    const fetchImpl = (async () => { called = true; return { status: 201, text: async () => '{}' }; }) as unknown as typeof fetch;

    await handlePrintDocument(makeReq('node-1', { text: 'hi' }), res as never, { registry, fetchImpl });

    expect(state.code).toBe(409);
    expect((state.body as { error: string }).error).toBe('device_unowned');
    expect(called).toBe(false);
  });

  it('an unknown device is 404, not an accidental file', async () => {
    const registry = { getClient: () => null };
    const { res, state } = makeRes();
    await handlePrintDocument(makeReq('ghost', { text: 'hi' }), res as never, { registry });
    expect(state.code).toBe(404);
  });

  it('a missing service secret fails CLOSED rather than filing unauthenticated', async () => {
    delete process.env.SWARM_SERVICE_SECRET;
    const registry = { getClient: () => ({ clientId: 'node-1', ownerSub: 'owner' }) };
    const { res, state } = makeRes();
    let called = false;
    const fetchImpl = (async () => { called = true; return { status: 201, text: async () => '{}' }; }) as unknown as typeof fetch;

    await handlePrintDocument(makeReq('node-1', { text: 'hi' }), res as never, { registry, fetchImpl });

    expect(state.code).toBe(503);
    expect(called).toBe(false);
  });

  it('print-ingest absent reports "not installed", not a bare 404 the node would retry on', async () => {
    process.env.SWARM_SERVICE_SECRET = 'test-secret';
    const registry = { getClient: () => ({ clientId: 'node-1', ownerSub: 'owner' }) };
    const { res, state } = makeRes();
    const fetchImpl = (async () => ({ status: 404, text: async () => 'Not Found' })) as unknown as typeof fetch;

    await handlePrintDocument(makeReq('node-1', { text: 'hi' }), res as never, { registry, fetchImpl });

    expect(state.code).toBe(503);
    expect((state.body as { error: string }).error).toBe('print_ingest_not_installed');
  });
});

describe('only recovered text crosses the boundary', () => {
  it('an empty document is refused', () => {
    const result = readDocument({ text: '   ' });
    expect(result.ok).toBe(false);
  });

  it('an oversized document is refused before it reaches the app', () => {
    const result = readDocument({ text: 'x'.repeat(500_001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('too_large');
  });

  it('a non-string body carries no text', () => {
    expect(readDocument({ text: { evil: true } }).ok).toBe(false);
    expect(readDocument(null).ok).toBe(false);
  });
});
