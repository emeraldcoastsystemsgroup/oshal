/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fake-timer guard for the person-model maintenance schedule: the first pass runs a bounded, jittered delay after boot (env-tunable, clamped, default two minutes) instead of waiting a full day, logs exactly one "person-model maintenance pass complete" line, keeps the daily cadence afterwards, survives a failed pass, and is cancelled by the shutdown hook. A box recreated more often than daily never ran the retention purge before this.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const purgeExpired = vi.fn();
const purgeOrphans = vi.fn();
const hooks: Array<{ name: string; fn: () => void }> = [];
const logged: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];

vi.mock('@/features/person-model', () => ({
  purgeExpiredPersonModelData: (...args: unknown[]) => purgeExpired(...args),
  purgeOrphanChunks: (...args: unknown[]) => purgeOrphans(...args),
  eligibleProfileIds: vi.fn(),
  enrichBatch: vi.fn(),
  TAXONOMY_VERSION: 1,
  ownersWithUnprojectedSegments: vi.fn(),
  projectOwnerSegments: vi.fn(),
}));
vi.mock('@/features/agent-management', () => ({ BotNodeClient: class {}, createRegistryEndpointResolver: () => ({}) }));
vi.mock('@/app/routes/inline-bot-execution', () => ({ executeBotOrInline: vi.fn() }));
vi.mock('@/shared/services/shutdown-hooks', () => ({
  registerShutdownHook: (name: string, fn: () => void) => { hooks.push({ name, fn }); },
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => {
    const record = (level: string) => (fields: Record<string, unknown>, message: string) => { logged.push({ level, message, fields }); };
    return { info: record('info'), error: record('error'), warn: record('warn'), debug: record('debug') };
  },
}));

import { readMaintenanceInitialDelay, startPersonModelMaintenanceRuntime } from '../../src/app/ambient-enrichment-runtime';

const DAY_MS = 86_400_000;
const DELAY_ENV = 'PERSON_MODEL_MAINTENANCE_INITIAL_DELAY_MS';
const JITTER_ENV = 'PERSON_MODEL_MAINTENANCE_JITTER_MS';
const PASS_LINE = 'person-model maintenance pass complete';

/** Drains the promise chain a fired tick leaves behind (runWithSystemIdentity -> pass -> log). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const passLines = (): number => logged.filter((entry) => entry.message === PASS_LINE).length;

describe('person-model maintenance schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.length = 0;
    logged.length = 0;
    purgeExpired.mockReset().mockResolvedValue({ topicDaily: 0, relations: 0 });
    purgeOrphans.mockReset().mockResolvedValue(0);
    delete process.env[DELAY_ENV];
    delete process.env[JITTER_ENV];
  });

  afterEach(() => {
    for (const hook of hooks) hook.fn();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env[DELAY_ENV];
    delete process.env[JITTER_ENV];
  });

  it('runs the first pass a bounded, jittered delay after boot - not a day later - and logs it once', async () => {
    process.env[DELAY_ENV] = '120000';
    process.env[JITTER_ENV] = '30000';
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    startPersonModelMaintenanceRuntime({} as never);
    expect(purgeExpired, 'no pass at boot itself').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(134_999);
    await flush();
    expect(purgeExpired, 'no pass before the jittered delay elapses').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(purgeExpired, 'first pass at base + jitter (120 s + 0.5 * 30 s)').toHaveBeenCalledTimes(1);
    expect(purgeOrphans).toHaveBeenCalledTimes(1);
    expect(passLines(), 'exactly one completion line for a fresh boot').toBe(1);
    // The daily cadence is unchanged: the interval still fires a day after boot, then every day.
    await vi.advanceTimersByTimeAsync(DAY_MS - 135_000);
    await flush();
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await flush();
    expect(purgeExpired).toHaveBeenCalledTimes(3);
    expect(passLines()).toBe(3);
  });

  it('defaults to two minutes plus up to thirty seconds of jitter when nothing is configured', () => {
    expect(readMaintenanceInitialDelay(() => 0)).toBe(120_000);
    expect(readMaintenanceInitialDelay(() => 0.999)).toBe(120_000 + Math.floor(0.999 * 30_000));
  });

  it('clamps the configured delay to [1 s, 24 h], the jitter to [0, 24 h], and ignores garbage', () => {
    process.env[DELAY_ENV] = '0';
    process.env[JITTER_ENV] = '0';
    expect(readMaintenanceInitialDelay(() => 0.9), 'zero delay is clamped up to one second').toBe(1_000);
    process.env[DELAY_ENV] = String(10 * DAY_MS);
    expect(readMaintenanceInitialDelay(() => 0.9), 'a ten-day delay is clamped down to a day').toBe(DAY_MS);
    process.env[DELAY_ENV] = 'soon';
    process.env[JITTER_ENV] = 'a bit';
    expect(readMaintenanceInitialDelay(() => 0), 'garbage falls back to the defaults').toBe(120_000);
    process.env[DELAY_ENV] = '';
    process.env[JITTER_ENV] = '';
    expect(readMaintenanceInitialDelay(() => 0), 'an empty compose passthrough falls back to the defaults').toBe(120_000);
  });

  it('logs a failed first pass at ERROR and still keeps the daily cadence', async () => {
    process.env[DELAY_ENV] = '5000';
    process.env[JITTER_ENV] = '0';
    purgeExpired.mockRejectedValueOnce(new Error('relation missing'));
    startPersonModelMaintenanceRuntime({} as never);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(logged.filter((entry) => entry.level === 'error' && entry.message === 'person-model maintenance failed')).toHaveLength(1);
    expect(passLines()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await flush();
    expect(purgeExpired).toHaveBeenCalledTimes(2);
    expect(passLines()).toBe(1);
  });

  it('the shutdown hook cancels a pending first pass and the daily timer', async () => {
    process.env[DELAY_ENV] = '5000';
    process.env[JITTER_ENV] = '0';
    startPersonModelMaintenanceRuntime({} as never);
    const hook = hooks.find((entry) => entry.name === 'person-model-maintenance');
    expect(hook).toBeDefined();
    hook!.fn();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    await flush();
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it('starts once per pool', () => {
    const pool = {} as never;
    startPersonModelMaintenanceRuntime(pool);
    startPersonModelMaintenanceRuntime(pool);
    expect(hooks.filter((entry) => entry.name === 'person-model-maintenance')).toHaveLength(1);
  });
});
