/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify actual Jarvis ticket projections and close routes plus an explicit provider-free carrier module witness across current issuer, guest and result rights, retaining admitted externally-completed cached reuse and idempotent close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { JARVIS_OWNER, JARVIS_OPERATOR, JARVIS_ISSUER, JARVIS_TWIN_ISSUER, JARVIS_SECRET,
  serveJarvisTicketPrincipal, seedJarvisTicket, jarvisPrincipalCall, fixtureJarvisDelegation,
  protectJarvisTicket, jarvisShelfRow, type JarvisTicketPrincipalFixture } from '../fixtures/jarvis-ticket-principal';

let f: JarvisTicketPrincipalFixture;
beforeEach(async () => {
  for (const key of ['DATABASE_URL', 'PGHOST', 'POSTGRES_HOST']) vi.stubEnv(key, '');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', JARVIS_OPERATOR); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('SWARM_SERVICE_SECRET', JARVIS_SECRET); vi.stubEnv('ENABLE_GUEST_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'jarvis-principal-fixture-signing-secret-0123456789');
  vi.stubEnv('OSHAL_ALLOW_LEGACY_UNOWNED', 'false'); vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'allow');
  f = await serveJarvisTicketPrincipal();
});
afterEach(async () => { if (f) await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** @description Read actual production overview JSON, preserving its personal-panel envelope. */
async function overview(caller = 'owner', headers: Record<string, string> = {}) {
  const response = await jarvisPrincipalCall(f, '/overview', caller, undefined, headers);
  expect(response.status).toBe(200);
  return await response.json() as { activity: { tickets: Array<{ id: string; title: string }>; openCount: number }; comms: unknown; calendar: unknown; bots?: unknown };
}

/** @description Explicit carrier module witness; it never executes production /ask or invokes a provider. */
async function open(sessionId: string, caller = 'owner'): Promise<string | null> {
  const response = await jarvisPrincipalCall(f, '/__fixture/open', caller, { sessionId });
  expect(response.status).toBe(200); return (await response.json() as { id: string | null }).id;
}

/** @description Seed the actual chat-ticket lifecycle with caller provenance and controlled durable ordering. */
async function carrier(sessionId: string, issuer = JARVIS_ISSUER, updatedAt = '2026-10-04T10:00:00Z'): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(updatedAt));
  try {
    const ticket = await seedJarvisTicket(f, { title: 'Existing carrier', ticketType: 'chat', status: 'in_process',
      metadata: { taskId: sessionId, kind: 'chat-thread', targetBot: 'jarvis' } }, issuer);
    return ticket.ticketId;
  } finally { vi.useRealTimers(); }
}

/** @description Read actual production shelf JSON without replacing its terminal return helpers. */
async function shelf(): Promise<Array<Record<string, unknown>>> {
  const response = await jarvisPrincipalCall(f, '/tasks'); expect(response.status).toBe(200);
  return (await response.json() as { tasks: Array<Record<string, unknown>> }).tasks;
}

describe('Jarvis direct ticket reads keep the current ticket verdict', () => {
  it('withholds same-sub other-issuer activity before title projection and openCount', async () => {
    const own = await seedJarvisTicket(f, { title: 'Own activity' });
    await seedJarvisTicket(f, { title: 'FOREIGN PRIVATE ACTIVITY' }, JARVIS_TWIN_ISSUER);
    const body = await overview(); expect(body.activity.openCount).toBe(1);
    expect(body.activity.tickets.map(t => t.id)).toEqual([own.ticketId]);
    expect(JSON.stringify(body)).not.toContain('FOREIGN PRIVATE ACTIVITY');
    expect(body).not.toHaveProperty('bots'); expect(body.comms).toMatchObject({ signals: [{ subject: 'Own comms' }] });
    expect(body.calendar).toEqual({ events: [] });
  });

  it('preserves the same-sub caller own work from the other verified issuer', async () => {
    await seedJarvisTicket(f); const twin = await seedJarvisTicket(f, { title: 'Twin own work' }, JARVIS_TWIN_ISSUER);
    expect((await overview('twin')).activity.tickets.map(t => t.id)).toEqual([twin.ticketId]);
  });

  it('withholds inactive or unavailable current-account activity', async () => {
    await seedJarvisTicket(f); f.state.active = false;
    expect((await overview()).activity).toEqual({ tickets: [], openCount: 0 });
    f.state.active = true; f.state.unavailableActor = true;
    expect((await overview()).activity).toEqual({ tickets: [], openCount: 0 });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('keeps active legacy unstamped same-sub rows while still refusing an inactive caller', async () => {
    const legacy = await seedJarvisTicket(f, { title: 'Legacy own work' }, null);
    expect((await overview('twin')).activity.tickets.map(t => t.id)).toEqual([legacy.ticketId]);
    f.state.active = false; expect((await overview()).activity.openCount).toBe(0);
  });

});

describe('Jarvis guest and protected activity retain canonical provenance', () => {
  it('preserves signed guest-own stamped activity and withholds unstamped, foreign and protected rows', async () => {
    const own = await seedJarvisTicket(f, { ownerSub: f.guest.sub, title: 'Guest own' }, GUEST_PRINCIPAL_ISSUER);
    await seedJarvisTicket(f, { ownerSub: f.guest.sub, title: 'GUEST UNSTAMPED' }, null);
    const protectedTicket = await seedJarvisTicket(f, { ownerSub: f.guest.sub }, GUEST_PRINCIPAL_ISSUER);
    await f.tasks.create({ taskId: protectedTicket.ticketId, ownerSub: f.guest.sub, title: 'Guest protected',
      processingMode: 'agentic', metadata: { oshalProtectedExecutions: ['guest-execution'] } });
    await seedJarvisTicket(f, { ownerSub: 'guest|foreign' }, GUEST_PRINCIPAL_ISSUER);
    expect((await overview('guest')).activity).toMatchObject({ openCount: 1, tickets: [{ id: own.ticketId }] });
  });

  it('refuses a marker without guest issuer, a guest issuer without marker and missing issuer provenance', async () => {
    await seedJarvisTicket(f, { ownerSub: f.guest.sub }, GUEST_PRINCIPAL_ISSUER);
    for (const caller of ['marker-without-issuer', 'issuer-without-marker', 'no-issuer']) {
      expect((await overview(caller)).activity).toEqual({ tickets: [], openCount: 0 });
      expect(await open(randomUUID(), caller)).toBeNull();
    }
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rechecks protected activity rights instead of counting revoked output', async () => {
    const own = await seedJarvisTicket(f); await protectJarvisTicket(f, own.ticketId, 'activity-execution');
    expect((await overview()).activity.openCount).toBe(1); f.state.denied.add('activity-execution');
    expect((await overview()).activity).toEqual({ tickets: [], openCount: 0 });
  });

});

describe('Jarvis request identity remains authoritative across supported transports', () => {
  it('refuses unsigned and legacy service-only reads before consulting tickets', async () => {
    expect((await jarvisPrincipalCall(f, '/overview', 'anonymous')).status).toBe(401);
    expect((await jarvisPrincipalCall(f, '/overview', 'anonymous', undefined,
      { 'X-Service-Secret': JARVIS_SECRET, 'X-Oshal-User-Sub': JARVIS_OPERATOR })).status).toBe(403);
    expect(f.list).not.toHaveBeenCalled();
  });

  it('keeps authenticated owner claims authoritative under hostile operator and service headers', async () => {
    const own = await seedJarvisTicket(f); await seedJarvisTicket(f, {}, JARVIS_TWIN_ISSUER);
    const body = await overview('owner', { 'X-Service-Secret': JARVIS_SECRET, 'X-Oshal-User-Sub': JARVIS_OPERATOR, 'X-Role': 'operator' });
    expect(body.activity.tickets.map(t => t.id)).toEqual([own.ticketId]); expect(body).not.toHaveProperty('bots');
  });

  it('admits verified delegated own activity without inventing OIDC or operator authority', async () => {
    const own = await seedJarvisTicket(f); await seedJarvisTicket(f, { title: 'Delegated twin secret' }, JARVIS_TWIN_ISSUER);
    const response = await jarvisPrincipalCall(f, '/overview', 'anonymous', undefined,
      { authorization: 'Bearer ' + fixtureJarvisDelegation('/overview'), 'X-Oshal-User-Sub': JARVIS_OPERATOR });
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.activity.tickets.map((t: { id: string }) => t.id)).toEqual([own.ticketId]); expect(body).not.toHaveProperty('bots');
  });

  it('binds a delegated caller to its actual issuer and withholds activity after account deactivation', async () => {
    await seedJarvisTicket(f); const twin = await seedJarvisTicket(f, {}, JARVIS_TWIN_ISSUER);
    const headers = { authorization: 'Bearer ' + fixtureJarvisDelegation('/overview', JARVIS_TWIN_ISSUER) };
    const admitted = await jarvisPrincipalCall(f, '/overview', 'anonymous', undefined, headers);
    expect((await admitted.json()).activity.tickets.map((t: { id: string }) => t.id)).toEqual([twin.ticketId]);
    f.state.active = false;
    const inactive = await jarvisPrincipalCall(f, '/overview', 'anonymous', undefined, headers);
    expect((await inactive.json()).activity).toEqual({ tickets: [], openCount: 0 });
  });
});

describe('Jarvis complex shelf filtering happens before enrichment or return effects', () => {
  it('withholds a foreign-issuer failed ticket before private result projection or terminal shelf writes', async () => {
    const foreign = await seedJarvisTicket(f, { status: 'cancelled', title: 'FOREIGN DEAD TICKET' }, JARVIS_TWIN_ISSUER);
    f.state.rows = [jarvisShelfRow(foreign.ticketId, { result: 'FOREIGN CACHED RESULT' }), jarvisShelfRow(null, { kind: 'simple', title: 'Plain own' })];
    const rows = await shelf(); expect(rows.map(r => r.title)).toEqual(['Plain own']);
    expect(JSON.stringify(rows)).not.toContain('FOREIGN CACHED RESULT'); expect(f.state.writes).toEqual([]);
  });

  it('preserves admitted terminal-failure enrichment and the actual guarded return-leg write', async () => {
    const own = await seedJarvisTicket(f, { status: 'cancelled' }); f.state.rows = [jarvisShelfRow(own.ticketId)];
    const rows = await shelf(); expect(rows).toMatchObject([{ status: 'error', ticketId: own.ticketId, error: 'This one was cancelled before it finished.' }]);
    expect(f.state.writes.filter(w => w.sql.includes("SET status = 'error'"))).toHaveLength(1);
    expect(f.state.writes[0].params[1]).toBe(JARVIS_OWNER);
  });

  it('reads an admitted referenced ticket outside the bounded list rather than hiding normal old work', async () => {
    const own = await seedJarvisTicket(f, { status: 'cancelled' }); f.state.rows = [jarvisShelfRow(own.ticketId)];
    f.list.mockResolvedValue([]); expect((await shelf()).map(r => r.ticketId)).toEqual([own.ticketId]);
    expect(f.get).toHaveBeenCalledWith(own.ticketId);
  });

  it('withholds missing or unavailable linked tickets while plain own rows survive and no return write occurs', async () => {
    f.state.rows = [jarvisShelfRow('missing-ticket'), jarvisShelfRow(null, { kind: 'simple', title: 'Plain own' })];
    expect((await shelf()).map(r => r.title)).toEqual(['Plain own']); expect(f.state.writes).toEqual([]);
    f.get.mockRejectedValue(new Error('fixture ticket store unavailable'));
    expect((await shelf()).map(r => r.title)).toEqual(['Plain own']); expect(f.state.writes).toEqual([]);
  });
});

describe('Jarvis existing carrier reuse and close recheck current rights', () => {
  it('selects the admitted durable carrier instead of a newer same-sub other-issuer thread', async () => {
    const session = randomUUID(), own = await carrier(session);
    const foreign = await carrier(session, JARVIS_TWIN_ISSUER, '2026-10-04T11:00:00Z');
    expect(await open(session)).toBe(own); expect(f.open).not.toHaveBeenCalled();
    const response = await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session });
    expect(await response.json()).toEqual({ ok: true, closed: true });
    expect((await f.tickets.getTicket(own))?.status).toBe('complete');
    expect((await f.tickets.getTicket(foreign))?.status).toBe('in_process');
  });

  it('reuses and closes an admitted cached carrier completed externally without opening a replacement', async () => {
    const session = randomUUID(), own = await carrier(session); expect(await open(session)).toBe(own);
    await f.tickets.updateStatus(own, 'complete'); f.statusWrite.mockClear();
    const durableWrites = vi.spyOn(f.store, 'updateStatus');
    expect(await open(session)).toBe(own); expect(f.open).not.toHaveBeenCalled();
    expect(f.statusWrite).not.toHaveBeenCalled();
    const response = await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, closed: true });
    expect(f.statusWrite).toHaveBeenCalledWith(own, 'complete'); expect(durableWrites).not.toHaveBeenCalled();
    expect((await f.tickets.getTicket(own))?.status).toBe('complete');
    expect(await (await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session })).json()).toEqual({ ok: true, closed: false });
    expect(f.open).not.toHaveBeenCalled(); expect(await f.tickets.listTickets()).toHaveLength(1);
  });

  it('rechecks a cached carrier after principal provenance changes and performs no close status write', async () => {
    const session = randomUUID(), own = await carrier(session); expect(await open(session)).toBe(own);
    const ticket = await f.tickets.getTicket(own);
    await f.store.update(own, { metadata: { ...ticket?.metadata, oshalOwnerPrincipalIssuer: JARVIS_TWIN_ISSUER } });
    const response = await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session });
    expect(await response.json()).toEqual({ ok: true, closed: false }); expect(f.statusWrite).not.toHaveBeenCalled();
  });

  it('refuses reuse of an already cached revoked result without opening a replacement carrier', async () => {
    const session = randomUUID(), own = await carrier(session); await protectJarvisTicket(f, own, 'carrier-execution');
    expect(await open(session)).toBe(own); f.state.denied.add('carrier-execution');
    expect(await open(session)).toBeNull(); expect(f.open).not.toHaveBeenCalled();
    expect((await f.tickets.getTicket(own))?.status).toBe('in_process');
  });

});

describe('Jarvis fresh carrier admission preserves normal owner and guest lifecycle', () => {
  it('keeps inactive callers and an unavailable durable lookup from creating new carrier rows', async () => {
    const before = (await f.tickets.listTickets()).length; f.state.active = false;
    expect(await open(randomUUID())).toBeNull(); expect(f.open).not.toHaveBeenCalled();
    f.state.active = true; f.list.mockRejectedValue(new Error('fixture durable list unavailable'));
    expect(await open(randomUUID())).toBeNull(); expect(f.open).not.toHaveBeenCalled();
    f.list.mockRestore(); expect((await f.tickets.listTickets()).length).toBe(before);
  });

  it('preserves the existing close error envelope when its cached record cannot be read and writes nothing', async () => {
    const session = randomUUID(), own = await carrier(session); expect(await open(session)).toBe(own);
    f.get.mockRejectedValue(new Error('fixture cached record unavailable'));
    const response = await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'fixture cached record unavailable' });
    expect(f.statusWrite).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });

  it('creates normal own work when only a foreign-issuer durable carrier shares the session id', async () => {
    const session = randomUUID(), foreign = await carrier(session, JARVIS_TWIN_ISSUER);
    const own = await open(session); expect(own).toBeTruthy(); expect(own).not.toBe(foreign);
    expect((await f.tickets.getTicket(foreign))?.status).toBe('in_process');
    expect((await f.tickets.getTicket(own as string))?.metadata).toMatchObject({ oshalOwnerPrincipalIssuer: JARVIS_ISSUER });
  });

  it('creates one fresh admitted owner carrier, then reuses and closes its ordinary lifecycle', async () => {
    const session = randomUUID(), id = await open(session); expect(id).toBeTruthy();
    expect(await open(session)).toBe(id); expect(f.open).toHaveBeenCalledOnce();
    expect((await f.tickets.getTicket(id as string))?.metadata).toMatchObject({ oshalOwnerPrincipalIssuer: JARVIS_ISSUER });
    expect(await (await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session })).json()).toEqual({ ok: true, closed: true });
    expect(await (await jarvisPrincipalCall(f, '/thread/close', 'owner', { sessionId: session })).json()).toEqual({ ok: true, closed: false });
  });

  it('keeps the signed guest own-carrier lifecycle without inventing an application actor', async () => {
    const session = randomUUID(), id = await open(session, 'guest'); expect(id).toBeTruthy();
    expect((await f.tickets.getTicket(id as string))?.metadata).toMatchObject({ oshalOwnerPrincipalIssuer: GUEST_PRINCIPAL_ISSUER });
    expect(await open(session, 'guest')).toBe(id);
    expect(await (await jarvisPrincipalCall(f, '/thread/close', 'guest', { sessionId: session })).json()).toEqual({ ok: true, closed: true });
  });
});
