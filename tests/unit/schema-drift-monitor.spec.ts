/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Detector cadence, non-overlap, shutdown, retry and no-alarm states with explicit clock/publisher fixtures; partial catalogs cannot publish or become baselines.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EnvelopeStore } from '@/features/alert-pipeline';
import { createDataModelService, diffDigests, type DataModelService, type DriftOutcome, type SchemaDigest } from '@/features/data-model';
import { createSchemaDriftMonitor } from '@/app/schema-drift-runtime';

const baseline: SchemaDigest = { digestVersion: 1, database: 'fixture', capturedAt: '2026-09-01T00:00:00.000Z',
  migrationCount: 165, fingerprint: 'baseline', unowned: [], relations: [
    { relation: 'fixture.notes', kind: 'table', owners: [], rls: 'forced', policies: ['owner'], keyColumns: ['id'], foreignKeys: [] },
  ] };
const current: SchemaDigest = { ...baseline, capturedAt: '2026-09-02T00:00:00.000Z', fingerprint: 'changed',
  relations: [{ ...baseline.relations[0], policies: [] }] };
const now = Date.parse(current.capturedAt);
const reading = (): DriftOutcome => ({ available: true, digest: current, baseline,
  report: diffDigests(baseline, current, { nowMs: now }), captured: false, unavailableReason: '' });
const pool = {} as Pool;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('schema detector lifecycle', () => {
  it.each(['first-run', 'unchanged', 'explained', 'settling', 'unavailable'])('does not publish or capture %s', async (state) => {
    const outcome = reading();
    outcome.available = state !== 'unavailable';
    outcome.report = { ...outcome.report!, state: state as NonNullable<DriftOutcome['report']>['state'], alarm: false };
    const drift = vi.fn().mockResolvedValue(outcome);
    const publish = vi.spyOn(EnvelopeStore.prototype, 'landInternalEvent').mockResolvedValue({ created: true, eventId: 'fixture-event' });
    const monitor = createSchemaDriftMonitor(pool, { drift } as unknown as DataModelService, { start: false, now: () => now });
    await monitor.tick();
    monitor.stop();
    expect(drift).toHaveBeenCalledExactlyOnceWith({ refresh: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not overlap slow timer reads or publish after shutdown while reading', async () => {
    vi.useFakeTimers();
    let finish!: (value: DriftOutcome) => void;
    const drift = vi.fn(() => new Promise<DriftOutcome>((resolve) => { finish = resolve; }));
    const publish = vi.spyOn(EnvelopeStore.prototype, 'landInternalEvent').mockResolvedValue({ created: true, eventId: 'fixture-event' });
    const monitor = createSchemaDriftMonitor(pool, { drift } as unknown as DataModelService, { intervalMs: 100, now: () => now });
    await vi.advanceTimersByTimeAsync(500);
    expect(drift).toHaveBeenCalledTimes(1);
    monitor.stop();
    finish(reading());
    await vi.advanceTimersByTimeAsync(1000);
    expect(drift).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('surfaces a failed publication and retries the exact same occurrence', async () => {
    const drift = vi.fn().mockResolvedValue(reading());
    const publish = vi.spyOn(EnvelopeStore.prototype, 'landInternalEvent')
      .mockRejectedValueOnce(new Error('fixture unavailable'))
      .mockResolvedValue({ created: false, eventId: 'existing-event' });
    const monitor = createSchemaDriftMonitor(pool, { drift } as unknown as DataModelService, { start: false, now: () => now });
    await monitor.tick();
    expect(monitor.status()).toMatchObject({ state: 'unavailable', eventId: null });
    await monitor.tick();
    expect(monitor.status()).toMatchObject({ state: 'drift', eventId: 'existing-event' });
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    monitor.stop();
  });

  it('does not claim success when the comparison was refused', async () => {
    const drift = vi.fn().mockRejectedValue(Object.assign(new Error('partial catalog'), { code: 'SCHEMA_DIGEST_PARTIAL' }));
    const publish = vi.spyOn(EnvelopeStore.prototype, 'landInternalEvent');
    const monitor = createSchemaDriftMonitor(pool, { drift } as unknown as DataModelService, { start: false });
    await monitor.tick();
    expect(monitor.status().state).toBe('unavailable');
    expect(publish).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('rejects a failed optional catalog even when less than half the relations would be missing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = createDataModelService({ repoRoot: 'fixture-no-source-root', listApps: async () => [],
      readPlatformCatalog: async () => ({ database: 'fixture', tables: [], views: [] }),
      readTimeseriesCatalog: async () => { throw new Error('fixture timeseries unavailable'); },
      digestQueryable: async () => ({ query }),
    });
    await expect(service.drift({ refresh: true, capture: true })).rejects.toMatchObject({ code: 'SCHEMA_DIGEST_PARTIAL' });
    expect(query).not.toHaveBeenCalled();
    expect((await service.snapshot()).catalogWarnings).toHaveLength(1);
  });
});
