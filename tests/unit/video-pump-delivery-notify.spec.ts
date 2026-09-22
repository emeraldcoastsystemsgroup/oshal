/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the creative-studio story-delivery hook (BACKLOG "Telegram notification bot" done-when): a run reaching `delivered` in syncPumpRuns CALLS the notifier — through the real default notifyOperator wiring (partial module mock, so the transport layer never constructs and no test can send live) — with the honest message shape (video-as-link when Drive returned one, node-only text when it did not); a failed episode never notifies; a notify failure never blocks the ledger sync.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A non-throwing `delivered: false` is a FAILURE, not a success: pin the three endings (delivered / failed / skipped-because-unconfigured) against the shared NotificationResult contract for every registered transport, and pin that a failed send is written onto the run's outcome_reason so it survives in the ledger. Restoring the `.catch`-only handling turns these red.
 */
/**
 * @description Mutation-proof guards on the delivery notification hook. These assert CALLS, not
 * substrings: delete the hook from syncPumpRuns, reroute its default away from notifyOperator, or
 * let it fire on the failed path, and a spec here goes red. No network, no DB, no live sends —
 * the notifier boundary is stubbed, never the assertions.
 *
 * The 2026-09-22 defect these also pin: a transport RESOLVES a failed send instead of throwing, so
 * `.catch`-only handling counted every failure as a delivery. The cases below distinguish a send that
 * arrived, a send that failed, and a transport that is not configured (a no-op, not a failure), and
 * require the failure to reach the run ledger — not just a log line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: { listClients: () => [], enqueueTask: vi.fn(), getCompletedResult: vi.fn(() => null) },
}));

// Partial-mock ONLY notifyOperator so the DEFAULT wiring is observable while the rest of the
// barrel (types, transports the import chain may touch) stays real. vi.hoisted because vi.mock
// factories are hoisted above const initializers.
const { notifyOperatorMock } = vi.hoisted(() => ({
  notifyOperatorMock: vi.fn(async () => ({ delivered: true as const, transport: 'telegram' as const })),
}));
vi.mock('@/features/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/notifications')>();
  return { ...actual, notifyOperator: notifyOperatorMock };
});

import {
  syncPumpRuns, deliveredNotification, classifyDeliveryNotice, reasonWithNoticeFailure, DELIVERY_NOTICE_FAILED,
} from '@/app/series-pump';
import type { AppContext } from '@/app/composition/app-context';
import { TRANSPORT_KINDS, type NotificationMessage, type NotificationResult, type TransportKind } from '@/features/notifications';

/** A pool that answers the run-sync SELECT with the given rows and short-circuits the lease sweep. */
function fakePool(runRows: Array<Record<string, unknown>>): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM video_pump_runs r')) return { rows: runRows };
      if (s.includes("status='rendering'")) return { rows: [{ one: 1 }] }; // still rendering → keep the lease, end the sweep
      return { rows: [] };
    }),
  } as unknown as Pool;
}

const ctx = (pool: Pool): AppContext => ({ pool } as unknown as AppContext);

/** Every statement the fake pool was asked to run, in order — so a ledger WRITE can be asserted. */
function sqlCalls(pool: Pool): Array<{ sql: string; params: unknown[] }> {
  return (pool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => ({ sql: String(call[0]), params: (call[1] as unknown[]) ?? [] }));
}

/** The targeted `SET outcome_reason=$2` write — the one the delivery-notice failure path makes. */
function noticeWrites(pool: Pool): Array<{ sql: string; params: unknown[] }> {
  return sqlCalls(pool).filter((call) => /SET outcome_reason=\$2/.test(call.sql));
}

const deliveredRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_id: 'run-1', show_id: 'show-1', show_slug: 'stupid-superheroes', episode_title: 'The Cape Snag',
  created_at: new Date().toISOString(), ep_status: 'assembled', drive_url: 'https://drive.example/ep1.mp4',
  error: null, ...over,
});

beforeEach(() => { notifyOperatorMock.mockClear(); });

describe('the story-delivery hook calls the notifier', () => {
  it('a delivered episode notifies through the DEFAULT notifyOperator wiring', async () => {
    const changed = await syncPumpRuns(ctx(fakePool([deliveredRow()])));
    expect(changed).toBe(1);
    expect(notifyOperatorMock).toHaveBeenCalledTimes(1);
    const message = notifyOperatorMock.mock.calls[0][0] as unknown as NotificationMessage;
    expect(message.text).toContain('The Cape Snag');
    expect(message.text).toContain('stupid-superheroes');
    expect(message.media).toMatchObject({ kind: 'video', url: 'https://drive.example/ep1.mp4' });
  });

  it('an injected notify seam receives the message and the default is left alone', async () => {
    const notify = vi.fn(async () => ({ delivered: true, transport: 'telegram' as const }));
    await syncPumpRuns(ctx(fakePool([deliveredRow()])), { notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('no Drive link → honest node-only text, no media that implies a link', async () => {
    await syncPumpRuns(ctx(fakePool([deliveredRow({ drive_url: null })])));
    const message = notifyOperatorMock.mock.calls[0][0] as unknown as NotificationMessage;
    expect(message.media).toBeUndefined();
    expect(message.text).toContain('no Drive link');
  });

  it('a FAILED episode never notifies — the hook is delivery-only', async () => {
    const changed = await syncPumpRuns(ctx(fakePool([deliveredRow({ ep_status: 'failed', error: 'render died' })])));
    expect(changed).toBe(1);
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('a notify failure never blocks the ledger sync', async () => {
    const notify = vi.fn(async () => { throw new Error('channel down'); });
    await expect(syncPumpRuns(ctx(fakePool([deliveredRow()])), { notify })).resolves.toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('a notification that did not arrive is not treated as one that did', () => {
  /** A transport answers a failed send by RESOLVING this — it does not throw. */
  const failedSend: NotificationResult = {
    delivered: false, transport: 'telegram', error: 'telegram_sendMessage_http_400:chat not found',
  };
  /** No transport is configured — the opt-in no-op, and explicitly NOT a failure. */
  const skippedSend: NotificationResult = {
    delivered: false, skipped: true, transport: 'telegram', error: 'telegram_not_configured',
  };

  it('DELIVERED: a send that arrived writes no failure note onto the run', async () => {
    const pool = fakePool([deliveredRow()]);
    const notify = vi.fn(async (): Promise<NotificationResult> => ({ delivered: true, transport: 'telegram', id: '42' }));
    await syncPumpRuns(ctx(pool), { notify });
    expect(noticeWrites(pool)).toHaveLength(0);
  });

  it('FAILED: a non-throwing delivered:false reaches the run ledger with its error', async () => {
    const pool = fakePool([deliveredRow()]);
    const notify = vi.fn(async () => failedSend);
    await syncPumpRuns(ctx(pool), { notify });
    const writes = noticeWrites(pool);
    expect(writes).toHaveLength(1);
    expect(writes[0].params[0]).toBe('run-1');
    expect(String(writes[0].params[1])).toContain(DELIVERY_NOTICE_FAILED);
    expect(String(writes[0].params[1])).toContain('telegram_sendMessage_http_400');
  });

  it('FAILED: the run stays `delivered` — the episode was made, the operator just was not told', async () => {
    const pool = fakePool([deliveredRow()]);
    await syncPumpRuns(ctx(pool), { notify: vi.fn(async () => failedSend) });
    expect(sqlCalls(pool).some((c) => /outcome='delivered'/.test(c.sql))).toBe(true);
  });

  it('FAILED: the no-Drive-link note is kept in front of the delivery-notice failure', async () => {
    const pool = fakePool([deliveredRow({ drive_url: null })]);
    await syncPumpRuns(ctx(pool), { notify: vi.fn(async () => failedSend) });
    const reason = String(noticeWrites(pool)[0].params[1]);
    expect(reason).toContain('the Drive upload returned no link');
    expect(reason.indexOf('the Drive upload returned no link')).toBeLessThan(reason.indexOf(DELIVERY_NOTICE_FAILED));
  });

  it('SKIPPED: an unconfigured transport is a no-op, never reported as a failure', async () => {
    const pool = fakePool([deliveredRow()]);
    await syncPumpRuns(ctx(pool), { notify: vi.fn(async () => skippedSend) });
    expect(noticeWrites(pool)).toHaveLength(0);
  });

  it('a thrown notify ALSO reaches the ledger — both endings are handled', async () => {
    const pool = fakePool([deliveredRow()]);
    await syncPumpRuns(ctx(pool), { notify: vi.fn(async () => { throw new Error('channel down'); }) });
    const writes = noticeWrites(pool);
    expect(writes).toHaveLength(1);
    expect(String(writes[0].params[1])).toContain('channel down');
  });
});

describe('classifyDeliveryNotice reads the shared result contract, not one vendor', () => {
  // Every registered transport answers with the same NotificationResult shape (types.ts), so the
  // classifier is pinned across the whole registry — a new sibling is covered the day it lands.
  it.each([...TRANSPORT_KINDS])('%s: delivered / failed / not-configured classify the same way', (kind: TransportKind) => {
    expect(classifyDeliveryNotice({ delivered: true, transport: kind }))
      .toEqual({ outcome: 'sent', transport: kind, error: null });
    expect(classifyDeliveryNotice({ delivered: false, transport: kind, error: `${kind}_http_500` }))
      .toEqual({ outcome: 'failed', transport: kind, error: `${kind}_http_500` });
    expect(classifyDeliveryNotice({ delivered: false, skipped: true, transport: kind, error: `${kind}_not_configured` }))
      .toEqual({ outcome: 'skipped', transport: kind, error: `${kind}_not_configured` });
  });

  it('a delivered:false with no error still fails, with a transport-named reason', () => {
    expect(classifyDeliveryNotice({ delivered: false, transport: 'email' }))
      .toEqual({ outcome: 'failed', transport: 'email', error: 'email_send_failed' });
  });

  it('a thrown error is a failure from an unknown transport', () => {
    expect(classifyDeliveryNotice(new Error('socket hang up')))
      .toEqual({ outcome: 'failed', transport: 'unknown', error: 'socket hang up' });
  });

  it('the merged reason is capped like every other outcome_reason write', () => {
    const merged = reasonWithNoticeFailure('x'.repeat(600), { outcome: 'failed', transport: 'telegram', error: 'boom' });
    expect(merged).toHaveLength(500);
  });
});

describe('deliveredNotification shape', () => {
  it('carries the video as media with the title as caption when a link exists', () => {
    const m = deliveredNotification({ showSlug: 's', title: 'T', link: 'https://x/v.mp4' });
    expect(m.media).toEqual({ kind: 'video', url: 'https://x/v.mp4', caption: 'T' });
  });

  it('says plainly the copy is node-only when there is no link', () => {
    const m = deliveredNotification({ showSlug: 's', title: 'T', link: null });
    expect(m.media).toBeUndefined();
    expect(m.text).toContain('node content folder');
  });
});
