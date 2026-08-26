/**
 * RingCentral call-log reader boundary guards (screen-pop v2 call history).
 *
 * The reader is the ONLY place a RingCentral token meets the call-log API. Pins: record
 * normalization keeps just the bounded fields and picks the true counterpart per direction;
 * unusable records drop rather than guess; status mapping distinguishes not_connected /
 * reconnect_required / missing_permission (403 = the app lacks ReadCallLog) / unavailable;
 * the cooldown serves the cached result instead of re-hitting the Heavy rate group.
 * No network, no credentials.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial normalization, status, and cooldown guards with injected seams.
 *
 * @module tests/unit/connectors/ringcentral-call-log
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRingcentralCallLogReader, normalizeCallRecord,
} from '@/app/routes/ringcentral-call-log';

describe('normalizeCallRecord', () => {
  it('keeps bounded fields and picks the counterpart per direction', () => {
    const inbound = normalizeCallRecord({
      id: 'c1', direction: 'Inbound', result: 'Missed', startTime: '2026-08-26T01:00:00Z', duration: 0,
      from: { phoneNumber: '+15550142001', name: 'WIRELESS CALLER' }, to: { phoneNumber: '+15550142999' },
      sessionId: 'secret-session', extension: { id: 22 },
    });
    expect(inbound).toEqual({
      id: 'c1', direction: 'Inbound', result: 'Missed', counterpartNumber: '+15550142001',
      counterpartName: 'WIRELESS CALLER', startedAt: '2026-08-26T01:00:00Z', durationSeconds: 0,
    });
    const outbound = normalizeCallRecord({
      id: 'c2', direction: 'Outbound', result: 'Call connected', startTime: '2026-08-26T02:00:00Z', duration: 95,
      from: { phoneNumber: '+15550142999' }, to: { phoneNumber: '+15550142002' },
    });
    expect(outbound?.counterpartNumber).toBe('+15550142002');
    expect(outbound?.durationSeconds).toBe(95);
  });

  it('drops unusable records instead of guessing', () => {
    expect(normalizeCallRecord(null)).toBeNull();
    expect(normalizeCallRecord({ direction: 'Inbound', startTime: 'x' })).toBeNull();     // no id
    expect(normalizeCallRecord({ id: 'c3', direction: 'Inbound' })).toBeNull();           // no start
    expect(normalizeCallRecord({ id: 'c4', direction: 'Sideways', startTime: 'x' })).toBeNull();
  });
});

function reader(overrides: {
  connections?: unknown[]; token?: string | null; tokenError?: string;
  status?: number; records?: unknown[]; fetchSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const fetchSpy = overrides.fetchSpy ?? vi.fn(async () => ({
    ok: (overrides.status ?? 200) < 300, status: overrides.status ?? 200,
    json: async () => ({ records: overrides.records ?? [] }),
  } as unknown as Response));
  const r = createRingcentralCallLogReader({} as never, {
    listConnections: (async () => overrides.connections ?? [{ connection_id: 'x' }]) as never,
    getAccessToken: (async () => {
      if (overrides.tokenError) throw new Error(overrides.tokenError);
      return overrides.token === undefined ? 'tok' : overrides.token;
    }) as never,
    fetchImpl: fetchSpy as unknown as typeof fetch,
  });
  return { r, fetchSpy };
}

describe('createRingcentralCallLogReader', () => {
  it('maps connection and provider states to honest statuses', async () => {
    expect((await reader({ connections: [] }).r({ userSub: 'u1' })).status).toBe('not_connected');
    expect((await reader({ tokenError: 'refresh 400' }).r({ userSub: 'u2' })).status).toBe('reconnect_required');
    expect((await reader({ status: 401 }).r({ userSub: 'u3' })).status).toBe('reconnect_required');
    expect((await reader({ status: 403 }).r({ userSub: 'u4' })).status).toBe('missing_permission');
    expect((await reader({ status: 500 }).r({ userSub: 'u5' })).status).toBe('unavailable');
  });

  it('returns normalized calls and serves the cooldown cache on the second read', async () => {
    const { r, fetchSpy } = reader({
      records: [
        { id: 'a', direction: 'Inbound', result: 'Missed', startTime: '2026-08-26T01:00:00Z', duration: 0, from: { phoneNumber: '+15550142001' } },
        { bogus: true },
      ],
    });
    const first = await r({ userSub: 'u6', sinceDays: 7 });
    expect(first.status).toBe('connected');
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0].id).toBe('a');
    const second = await r({ userSub: 'u6' });
    expect(second).toBe(first);                 // cached object — no second provider hit
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('/restapi/v1.0/account/~/extension/~/call-log');
    expect(url).toContain('view=Simple');
  });
});
