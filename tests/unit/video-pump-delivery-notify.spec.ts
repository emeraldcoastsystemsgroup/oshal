/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the creative-studio story-delivery hook (BACKLOG "Telegram notification bot" done-when): a run reaching `delivered` in syncPumpRuns CALLS the notifier — through the real default notifyOperator wiring (partial module mock, so the transport layer never constructs and no test can send live) — with the honest message shape (video-as-link when Drive returned one, node-only text when it did not); a failed episode never notifies; a notify failure never blocks the ledger sync.
 */
/**
 * @description Mutation-proof guards on the delivery notification hook. These assert CALLS, not
 * substrings: delete the hook from syncPumpRuns, reroute its default away from notifyOperator, or
 * let it fire on the failed path, and a spec here goes red. No network, no DB, no live sends —
 * the notifier boundary is stubbed, never the assertions.
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

import { syncPumpRuns, deliveredNotification } from '@/app/series-pump';
import type { AppContext } from '@/app/composition/app-context';
import type { NotificationMessage } from '@/features/notifications';

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
