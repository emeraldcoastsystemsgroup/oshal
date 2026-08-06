/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verifies calendar schedule listing filters by app queue (taskType) + caller (ownerSub) so each surface shows only its own view
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove create-or-replace ids are tenant- and exact-task-scoped while retaining stable unowned system ids.
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

  test('isolates create-or-replace records when tenants choose the same taskType', async () => {
    const { service } = makeService();
    const firstA = await service.createSchedule({
      taskType: 'shared-report', schedule: '0 8 * * *',
      taskData: { prompt: 'A version one' }, ownerSub: 'user-A',
    });
    const firstB = await service.createSchedule({
      taskType: 'shared-report', schedule: '0 9 * * *',
      taskData: { prompt: 'B version' }, ownerSub: 'user-B',
    });
    const secondA = await service.createSchedule({
      taskType: 'shared-report', schedule: '0 10 * * *',
      taskData: { prompt: 'A version two' }, ownerSub: 'user-A',
    });

    expect(firstA.id).not.toBe(firstB.id);
    expect(secondA.id).toBe(firstA.id);
    const all = await service.listSchedules({ scope: 'all' });
    expect(all).toHaveLength(2);
    expect(all.find((entry) => entry.ownerSub === 'user-A')?.taskData.prompt).toBe('A version two');
    expect(all.find((entry) => entry.ownerSub === 'user-B')?.taskData.prompt).toBe('B version');
  });

  test('does not alias lossy-normalized taskTypes and preserves stable system ids', async () => {
    const { service } = makeService();
    const colon = await service.createSchedule({
      taskType: 'report:daily', schedule: '0 8 * * *',
      taskData: { prompt: 'Colon task' }, ownerSub: 'user-A',
    });
    const underscore = await service.createSchedule({
      taskType: 'report_daily', schedule: '0 9 * * *',
      taskData: { prompt: 'Underscore task' }, ownerSub: 'user-A',
    });
    const system = await service.createSchedule({
      taskType: 'system-refresh', schedule: '0 * * * *',
      taskData: { prompt: 'System task' }, ownerSub: null,
    });

    expect(colon.id).not.toBe(underscore.id);
    expect(system.id).toBe('system-refresh');
  });

  test('replaces an exact-owner legacy record in place without permitting a takeover', async () => {
    const { service, store } = makeService();
    await store.saveSchedule({
      id: 'legacy-report', taskType: 'legacy-report', cron: '0 6 * * *',
      taskData: { prompt: 'Legacy version' }, status: 'active',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      nextRunAt: null, lastRunAt: null, executionCount: 0, ownerSub: 'user-A',
    });

    const sameOwner = await service.createSchedule({
      taskType: 'legacy-report', schedule: '0 7 * * *',
      taskData: { prompt: 'Owner update' }, ownerSub: 'user-A',
    });
    const otherOwner = await service.createSchedule({
      taskType: 'legacy-report', schedule: '0 8 * * *',
      taskData: { prompt: 'Other tenant' }, ownerSub: 'user-B',
    });

    expect(sameOwner.id).toBe('legacy-report');
    expect(otherOwner.id).not.toBe('legacy-report');
    const all = await service.listSchedules({ scope: 'all' });
    expect(all).toHaveLength(2);
    expect(all.find((entry) => entry.id === 'legacy-report')?.taskData.prompt).toBe('Owner update');
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
