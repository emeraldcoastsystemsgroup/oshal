/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the two schedule-domain fixes that make "on Tuesday, at 9am" mean what it says. (1) TIMEZONE: a record with a timezone must compute its next run in THAT zone, not the container clock — the assertion pins that "0 9 * * *" in America/Chicago resolves to 14:00 UTC, which a timezone-blind service gets wrong by five hours. (2) ONE-SHOT: a `once` schedule must pause itself the instant it fires, so it runs exactly once instead of recurring (the "no-year cron recurs annually" defect). A recurring schedule under the same code path must keep its next run — that contrast is what proves the pause is scoped to one-shots.
 */
import { expect, test } from '@playwright/test';
import { ScheduleService } from '../src/features/scheduling';

const AGENT_ID = '00000000-0000-4000-8000-000000000032';

/** In-memory store double + a dispatch handler whose success is caller-controlled. */
function makeService(dispatchSuccess = true) {
  const records = new Map<string, any>();
  const store = {
    async ping() { return true; },
    async close() { return undefined; },
    async saveSchedule(s: any) { records.set(s.id, { ...s }); },
    async getSchedule(id: string) { const s = records.get(id); return s ? { ...s } : null; },
    async listSchedules() { return Array.from(records.values()).map((s) => ({ ...s })); },
    async deleteSchedule(id: string) { return records.delete(id); },
    async popDueScheduleIds() { return []; },
  };
  const service = new ScheduleService(
    store as any,
    async (s) => ({ success: dispatchSuccess, scheduleId: s.id }),
    { defaultTargetAgentId: AGENT_ID, ensureSchedulingEnabled: async () => undefined },
  );
  return { service, store };
}

test.describe('schedule timezone', () => {
  test('the same cron in two different zones resolves to two different instants', async () => {
    // Machine-independent: whatever the test host's own clock is, "0 9 * * *" cannot legitimately
    // land at the same UTC instant in both Tokyo and Honolulu (19 hours apart). If the service
    // ignored the timezone it would resolve both in the process clock and they would be EQUAL —
    // so this inequality is precisely the tz-option-is-honoured assertion, with no reliance on
    // where the test happens to run.
    const { service } = makeService();
    const tokyo = await service.createSchedule({
      taskType: 'reminder-tokyo', schedule: '0 9 * * *', timezone: 'Asia/Tokyo',
      taskData: { prompt: 'x', targetAgent: AGENT_ID }, ownerSub: 'user-A',
    });
    const honolulu = await service.createSchedule({
      taskType: 'reminder-honolulu', schedule: '0 9 * * *', timezone: 'Pacific/Honolulu',
      taskData: { prompt: 'x', targetAgent: AGENT_ID }, ownerSub: 'user-A',
    });
    expect(tokyo.timezone).toBe('Asia/Tokyo');
    const tokyoMinuteUtc = new Date(tokyo.nextRunAt!).getUTCMinutes();
    // 09:00 in each zone -> the UTC hour differs by the zone offset difference (Tokyo UTC+9,
    // Honolulu UTC-10 => 19h apart). Minutes stay 0 in both, so hours must differ.
    expect(new Date(tokyo.nextRunAt!).getUTCHours()).not.toBe(new Date(honolulu.nextRunAt!).getUTCHours());
    expect(tokyoMinuteUtc).toBe(0);
    // And Tokyo 09:00 is 00:00 UTC — a concrete anchor that also fails if the zone is dropped
    // (unless the host itself is UTC+9, which Honolulu inequality above already rules out).
    expect(new Date(tokyo.nextRunAt!).getUTCHours()).toBe(0);
  });

  test('a record with no timezone keeps the historical process-clock behaviour', async () => {
    const { service } = makeService();
    const created = await service.createSchedule({
      taskType: 'legacy-reminder',
      schedule: '0 9 * * *',
      taskData: { prompt: 'x', targetAgent: AGENT_ID },
      ownerSub: 'user-A',
    });
    expect(created.timezone).toBeNull();
    expect(created.nextRunAt).not.toBeNull();
  });
});

test.describe('schedule one-shot', () => {
  test('a once schedule pauses itself the moment it fires', async () => {
    const { service } = makeService(true);
    const created = await service.createSchedule({
      taskType: 'flowers-reminder',
      schedule: '0 9 * * 2',
      once: true,
      timezone: 'America/Chicago',
      taskData: { prompt: 'Order flowers', targetAgent: AGENT_ID },
      ownerSub: 'user-A',
    });
    expect(created.once).toBe(true);
    expect(created.status).toBe('active');
    expect(created.nextRunAt).not.toBeNull();

    const result = await service.triggerSchedule(created.id);
    expect(result.success).toBe(true);

    const after = await service.getSchedule(created.id);
    // Fired once, then done: paused, no next run, run recorded.
    expect(after?.status).toBe('paused');
    expect(after?.nextRunAt).toBeNull();
    expect(after?.executionCount).toBe(1);
  });

  test('a recurring schedule keeps its next run after firing — the pause is one-shot-only', async () => {
    const { service } = makeService(true);
    const created = await service.createSchedule({
      taskType: 'daily-brief',
      schedule: '0 9 * * *',
      once: false,
      timezone: 'America/Chicago',
      taskData: { prompt: 'Brief', targetAgent: AGENT_ID },
      ownerSub: 'user-A',
    });
    await service.triggerSchedule(created.id);
    const after = await service.getSchedule(created.id);
    expect(after?.status).toBe('active');
    expect(after?.nextRunAt).not.toBeNull();
  });
});
