/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added service-level coverage for Redis-backed self scheduling with agent-scheduler toggle enforcement
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Await observable dispatch completion after dispatchDueSchedules intentionally became fire-and-forget, eliminating timing-dependent assertions without weakening cadence coverage.
 */

import { expect, test } from '@playwright/test';
import { ScheduleService } from '../src/features/scheduling';

const DEFAULT_AGENT_ID = '00000000-0000-4000-8000-000000000032';

test.describe('Redis Self Scheduling', () => {
  test('blocks self-schedule creation when the agent-scheduler tool is off', async () => {
    const store = createFakeScheduleStore();
    const service = new ScheduleService(
      store as any,
      async (schedule) => ({ success: true, scheduleId: schedule.id }),
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => {
          throw new Error(`Agent Scheduler is off for agent ${DEFAULT_AGENT_ID}`);
        },
      },
    );

    await expect(service.createSchedule({
      taskType: 'self-bot-report',
      schedule: '* * * * *',
      taskData: { prompt: 'Summarize Redis health.' },
    })).rejects.toThrow(`Agent Scheduler is off for agent ${DEFAULT_AGENT_ID}`);
  });

  test('dispatches self schedules when the scheduler tool is enabled', async () => {
    const store = createFakeScheduleStore();
    const dispatched: string[] = [];
    const service = new ScheduleService(
      store as any,
      async (schedule) => {
        dispatched.push(schedule.id);
        return { success: true, scheduleId: schedule.id, taskId: 'task-1' };
      },
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => undefined,
      },
    );

    const schedule = await service.createSchedule({
      taskType: 'self-bot-report',
      schedule: '* * * * *',
      taskData: { prompt: 'Summarize Redis health.' },
    });
    store.markDue(schedule.id);

    const dispatchedCount = await service.dispatchDueSchedules();

    expect(dispatchedCount).toBe(1);
    await expect.poll(() => [...dispatched]).toEqual([schedule.id]);
    await expect.poll(async () => (await store.getSchedule(schedule.id))?.executionCount).toBe(1);
    const savedSchedule = await store.getSchedule(schedule.id);
    expect(savedSchedule?.executionCount).toBe(1);
    expect(savedSchedule?.lastRunAt).toBeTruthy();
  });

  test('reconciles the due index before dispatching schedules', async () => {
    const store = createFakeScheduleStore();
    const dispatched: string[] = [];
    const service = new ScheduleService(
      store as any,
      async (schedule) => {
        dispatched.push(schedule.id);
        return { success: true, scheduleId: schedule.id, taskId: 'task-reconciled' };
      },
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => undefined,
      },
    );

    const schedule = await service.createSchedule({
      taskType: 'self-bot-report',
      schedule: '* * * * *',
      taskData: { prompt: 'Summarize Redis health.' },
    });
    store.markDueOnReconcile(schedule.id);

    const dispatchedCount = await service.dispatchDueSchedules();

    expect(store.reconcileCalls).toBe(1);
    expect(dispatchedCount).toBe(1);
    await expect.poll(() => [...dispatched]).toEqual([schedule.id]);
  });

  test('advances stale missed schedules instead of dispatching them late', async () => {
    const store = createFakeScheduleStore();
    const dispatched: string[] = [];
    const service = new ScheduleService(
      store as any,
      async (schedule) => {
        dispatched.push(schedule.id);
        return { success: true, scheduleId: schedule.id, taskId: 'task-stale' };
      },
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => undefined,
      },
    );

    const schedule = await service.createSchedule({
      taskType: 'old-home-action',
      schedule: '0 21 17 6 *',
      taskData: { prompt: 'One-time scheduled smart-home action: turn on porch lights.' },
    });
    await store.saveSchedule({
      ...schedule,
      nextRunAt: '2026-06-17T21:00:00.000Z',
    });

    const dispatchedCount = await service.dispatchDueSchedules();
    const savedSchedule = await store.getSchedule(schedule.id);

    expect(dispatchedCount).toBe(0);
    expect(dispatched).toEqual([]);
    expect(savedSchedule?.status).toBe('paused');
    expect(savedSchedule?.nextRunAt).toBeNull();
  });

  test('skips due self schedules after the scheduler tool is toggled off', async () => {
    const store = createFakeScheduleStore();
    let schedulerEnabled = true;
    let schedulerChecks = 0;
    const dispatched: string[] = [];
    const service = new ScheduleService(
      store as any,
      async (schedule) => {
        dispatched.push(schedule.id);
        return { success: true, scheduleId: schedule.id, taskId: 'task-2' };
      },
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => {
          schedulerChecks++;
          if (!schedulerEnabled) {
            throw new Error(`Agent Scheduler is off for agent ${DEFAULT_AGENT_ID}`);
          }
        },
      },
    );

    const schedule = await service.createSchedule({
      taskType: 'self-bot-report',
      schedule: '* * * * *',
      taskData: { prompt: 'Summarize Redis health.', targetAgent: DEFAULT_AGENT_ID },
    });

    schedulerEnabled = false;
    store.markDue(schedule.id);
    const dispatchedCount = await service.dispatchDueSchedules();
    await expect.poll(() => schedulerChecks).toBe(2);
    const savedSchedule = await store.getSchedule(schedule.id);

    expect(dispatchedCount).toBe(1);
    expect(dispatched).toEqual([]);
    expect(savedSchedule?.executionCount).toBe(0);
    expect(savedSchedule?.lastRunAt).toBeNull();
    expect(savedSchedule?.nextRunAt).toBeTruthy();
  });

  test('updates cron and task payload when editing an existing schedule', async () => {
    const store = createFakeScheduleStore();
    const service = new ScheduleService(
      store as any,
      async (schedule) => ({ success: true, scheduleId: schedule.id }),
      {
        defaultTargetAgentId: DEFAULT_AGENT_ID,
        ensureSchedulingEnabled: async () => undefined,
      },
    );

    const schedule = await service.createSchedule({
      taskType: 'cross-bot-report',
      schedule: '0 * * * *',
      taskData: { prompt: 'Draft the hourly report.', targetAgent: DEFAULT_AGENT_ID, action: 'hourly_report' },
    });

    const updated = await service.updateSchedule(schedule.id, {
      pattern: '0 */6 * * *',
      taskData: {
        prompt: 'Draft the six-hour report.',
        workspaceSlug: 'devopscloud-00',
      },
    });

    expect(updated.cron).toBe('0 */6 * * *');
    expect(updated.taskData.prompt).toBe('Draft the six-hour report.');
    expect(updated.taskData.targetAgent).toBe(DEFAULT_AGENT_ID);
    expect(updated.taskData.action).toBe('hourly_report');
    expect(updated.taskData.workspaceSlug).toBe('devopscloud-00');
  });
});

function createFakeScheduleStore() {
  const records = new Map<string, any>();
  const dueIds: string[] = [];
  const reconcileDueIds: string[] = [];

  return {
    reconcileCalls: 0,
    async ping() {
      return true;
    },
    async close() {
      return undefined;
    },
    async saveSchedule(schedule: any) {
      records.set(schedule.id, { ...schedule });
    },
    async getSchedule(scheduleId: string) {
      const schedule = records.get(scheduleId);
      return schedule ? { ...schedule } : null;
    },
    async listSchedules() {
      return Array.from(records.values()).map((schedule) => ({ ...schedule }));
    },
    async deleteSchedule(scheduleId: string) {
      return records.delete(scheduleId);
    },
    async popDueScheduleIds() {
      return dueIds.splice(0, dueIds.length);
    },
    async reconcileScheduleIndex() {
      this.reconcileCalls++;
      dueIds.push(...reconcileDueIds.splice(0, reconcileDueIds.length));
      return { scanned: records.size, indexed: dueIds.length, removed: 0 };
    },
    markDue(scheduleId: string) {
      dueIds.push(scheduleId);
    },
    markDueOnReconcile(scheduleId: string) {
      reconcileDueIds.push(scheduleId);
    },
  };
}
