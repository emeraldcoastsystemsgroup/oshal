/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verifies calendar schedule listing filters by app queue (taskType) + caller (ownerSub) so each surface shows only its own view
 */

import { expect, test } from '@playwright/test';
import { ScheduleService } from '../src/features/scheduling';

const AGENT_ID = '00000000-0000-4000-8000-000000000032';

/**
 * @description Builds a ScheduleService over an in-memory fake store with the
 * scheduler enablement guard disabled, for fast deterministic filter coverage.
 */
function makeService() {
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
    async (s) => ({ success: true, scheduleId: s.id }),
    { defaultTargetAgentId: AGENT_ID, ensureSchedulingEnabled: async () => undefined },
  );
  return { service, store };
}

test.describe('Calendar schedule scoping', () => {
  test('persists ownerSub from the create payload', async () => {
    const { service } = makeService();
    const created = await service.createSchedule({
      taskType: 'home-control',
      schedule: '0 9 * * *',
      taskData: { prompt: 'Lights on', targetAgent: AGENT_ID },
      ownerSub: 'user-A',
    });
    expect(created.ownerSub).toBe('user-A');
  });

  test('filters by app queue (taskType) for the respective view', async () => {
    const { service } = makeService();
    await service.createSchedule({ taskType: 'home-control', schedule: '0 9 * * *', taskData: { prompt: 'Lights' }, ownerSub: 'user-A' });
    await service.createSchedule({ taskType: 'finance-brief', schedule: '0 7 * * *', taskData: { prompt: 'Brief' }, ownerSub: 'user-A' });

    const home = await service.listSchedules({ taskType: 'home-control' });
    const finance = await service.listSchedules({ taskType: 'finance-brief' });

    expect(home.map((s) => s.taskType)).toEqual(['home-control']);
    expect(finance.map((s) => s.taskType)).toEqual(['finance-brief']);
  });

  test('scopes to the caller — own + unowned, never another user', async () => {
    const { service, store } = makeService();
    await service.createSchedule({ taskType: 'home-control', schedule: '0 9 * * *', taskData: { prompt: 'A' }, ownerSub: 'user-A' });
    await service.createSchedule({ taskType: 'home-control-b', schedule: '0 9 * * *', taskData: { prompt: 'B' }, ownerSub: 'user-B' });
    // A system/legacy schedule with no owner — must stay visible to everyone.
    await store.saveSchedule({
      id: 'sys-job', taskType: 'home-control-sys', cron: '0 9 * * *',
      taskData: { prompt: 'sys' }, status: 'active',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      nextRunAt: null, lastRunAt: null, executionCount: 0, ownerSub: null,
    });

    const mine = await service.listSchedules({ ownerSub: 'user-A' });
    const owners = mine.map((s) => s.ownerSub);

    expect(owners).toContain('user-A');     // my own
    expect(owners).toContain(null);          // unowned/system stays visible
    expect(owners).not.toContain('user-B');  // another user's is hidden
  });

  test('?scope=all (operator override) returns every schedule', async () => {
    const { service } = makeService();
    await service.createSchedule({ taskType: 'home-control', schedule: '0 9 * * *', taskData: { prompt: 'A' }, ownerSub: 'user-A' });
    await service.createSchedule({ taskType: 'home-control-b', schedule: '0 9 * * *', taskData: { prompt: 'B' }, ownerSub: 'user-B' });

    const all = await service.listSchedules({ ownerSub: 'user-A', scope: 'all' });
    expect(all.map((s) => s.ownerSub).sort()).toEqual(['user-A', 'user-B']);
  });

  test('combines queue + caller scope (the calendar request shape)', async () => {
    const { service } = makeService();
    await service.createSchedule({ taskType: 'home-control', schedule: '0 9 * * *', taskData: { prompt: 'A-home' }, ownerSub: 'user-A' });
    await service.createSchedule({ taskType: 'finance-brief', schedule: '0 7 * * *', taskData: { prompt: 'A-fin' }, ownerSub: 'user-A' });
    await service.createSchedule({ taskType: 'home-control-b', schedule: '0 9 * * *', taskData: { prompt: 'B-home' }, ownerSub: 'user-B' });

    const homeForA = await service.listSchedules({ taskType: 'home-control', ownerSub: 'user-A' });
    expect(homeForA).toHaveLength(1);
    expect(homeForA[0].taskData.prompt).toBe('A-home');
  });
});
