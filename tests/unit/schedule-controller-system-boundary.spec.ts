/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the public schedule API cannot create, replace, mutate, or synthesize manifest-owned jobs and cannot bypass ownership through the legacy execute callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ScheduleController } from '../../src/features/scheduling/controllers/schedule-controller';
import type { ScheduleRunner, ScheduleService } from '../../src/features/scheduling/services';
import type { ScheduleRecord } from '../../src/features/scheduling/types';
import { MANIFEST_SERVICE_ROUTE_TASK_KIND } from '../../src/features/scheduling/types';

interface CapturedResponse extends Response {
  statusCode: number;
  payload: unknown;
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'normal-task',
    taskType: 'normal-task',
    cron: '0 * * * *',
    taskData: { prompt: 'Run the task' },
    status: 'active',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    nextRunAt: '2026-08-05T01:00:00.000Z',
    lastRunAt: null,
    executionCount: 0,
    ownerSub: 'user-1',
    queue: 'normal',
    ...overrides,
  };
}

function request(
  body: Record<string, unknown> = {},
  sub = 'user-1',
  id = 'normal-task',
): Request {
  return {
    body,
    params: { id },
    query: {},
    oidc: { user: { sub } },
  } as unknown as Request;
}

function response(): CapturedResponse {
  const res = {
    statusCode: 200,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return res as unknown as CapturedResponse;
}

function fixture(existing: ScheduleRecord | null = schedule()) {
  const service = {
    createSchedule: vi.fn(async (input: { taskType: unknown; ownerSub?: string | null }) => schedule({
      taskType: String(input.taskType),
      ownerSub: input.ownerSub,
    })),
    getSchedule: vi.fn(async () => existing),
    updateSchedule: vi.fn(async () => existing),
    pauseSchedule: vi.fn(async () => existing),
    resumeSchedule: vi.fn(async () => existing),
    deleteSchedule: vi.fn(async () => true),
    triggerSchedule: vi.fn(async () => ({ success: true, scheduleId: existing?.id ?? 'missing' })),
    executeScheduledTask: vi.fn(async () => ({ success: true, scheduleId: existing?.id ?? 'synthetic' })),
    listSchedules: vi.fn(async () => existing ? [existing] : []),
    healthCheck: vi.fn(async () => true),
  };
  const runner = { getStatus: vi.fn(() => ({ running: true })) };
  const controller = new ScheduleController(
    service as unknown as ScheduleService,
    runner as unknown as ScheduleRunner,
  );
  return { controller, service };
}

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED'] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  saved = {} as typeof saved;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('ScheduleController system-owned boundary', () => {
  it('does not create an unowned record when the authenticated principal is missing', async () => {
    const { controller, service } = fixture();
    const res = response();

    await controller.createSchedule(request({
      taskType: 'ordinary-task', schedule: '0 * * * *', taskData: { prompt: 'Run' },
    }, ''), res);

    expect(res.statusCode).toBe(401);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['app:example-refresh', { prompt: 'forged manifest prompt' }],
    ['app-route:example-policy-tick', { prompt: 'forged route job' }],
    ['ordinary-name', { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'example-policy-tick' }],
  ])('rejects public creation of reserved manifest work (%s)', async (taskType, taskData) => {
    const { controller, service } = fixture();
    const res = response();

    await controller.createSchedule(request({ taskType, schedule: '0 * * * *', taskData }), res);

    expect(res.statusCode).toBe(403);
    expect(service.createSchedule).not.toHaveBeenCalled();
  });

  it('requires explicit operator authority for workflow ticket schedules', async () => {
    const denied = fixture();
    const deniedRes = response();
    await denied.controller.createSchedule(request({
      taskType: 'workflow:daily-report',
      schedule: '0 7 * * *',
      taskData: { prompt: 'Create the report ticket' },
    }), deniedRes);
    expect(deniedRes.statusCode).toBe(403);
    expect(denied.service.createSchedule).not.toHaveBeenCalled();

    process.env.OSHAL_OPERATOR_SUBS = 'operator-1';
    const allowed = fixture();
    const allowedRes = response();
    await allowed.controller.createSchedule(request({
      taskType: 'workflow:daily-report',
      schedule: '0 7 * * *',
      taskData: { prompt: 'Create the report ticket' },
    }, 'operator-1'), allowedRes);
    expect(allowedRes.statusCode).toBe(200);
    expect(allowed.service.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'operator-1' }));
  });

  it('applies ownership to the legacy execute-by-id callback', async () => {
    const { controller, service } = fixture(schedule({ ownerSub: 'owner-1' }));
    const res = response();

    await controller.executeScheduledTask(request({ scheduleId: 'normal-task' }, 'other-user'), res);

    expect(res.statusCode).toBe(404);
    expect(service.executeScheduledTask).not.toHaveBeenCalled();
  });

  it('allows an owner to execute an ordinary persisted schedule', async () => {
    const { controller, service } = fixture(schedule({ ownerSub: 'owner-1' }));
    const res = response();
    const body = { scheduleId: 'normal-task' };

    await controller.executeScheduledTask(request(body, 'owner-1'), res);

    expect(res.statusCode).toBe(200);
    expect(service.executeScheduledTask).toHaveBeenCalledWith(body);
  });

  it('rejects synthetic manifest handler dispatch even without a reserved taskType', async () => {
    const { controller, service } = fixture();
    const res = response();

    await controller.executeScheduledTask(request({
      taskType: 'ordinary-name',
      taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'example-policy-tick' },
    }), res);

    expect(res.statusCode).toBe(403);
    expect(service.executeScheduledTask).not.toHaveBeenCalled();
  });

  it.each([
    'updateSchedule',
    'pauseSchedule',
    'resumeSchedule',
    'deleteSchedule',
    'triggerSchedule',
  ] as const)('keeps manifest-derived state immutable through %s, including for operators', async (method) => {
    process.env.OSHAL_OPERATOR_SUBS = 'operator-1';
    const managed = schedule({
      id: 'app-route_example-policy-tick',
      taskType: 'app-route:example-policy-tick',
      taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'example-policy-tick' },
      ownerSub: null,
    });
    const { controller, service } = fixture(managed);
    const res = response();

    await controller[method](request({ schedule: '5 * * * *' }, 'operator-1', managed.id), res);

    expect(res.statusCode).toBe(403);
    expect(service.updateSchedule).not.toHaveBeenCalled();
    expect(service.pauseSchedule).not.toHaveBeenCalled();
    expect(service.resumeSchedule).not.toHaveBeenCalled();
    expect(service.deleteSchedule).not.toHaveBeenCalled();
    expect(service.triggerSchedule).not.toHaveBeenCalled();
  });

  it('does not let the legacy-unowned switch downgrade workflow mutation to ordinary-user access', async () => {
    process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
    const workflow = schedule({ id: 'workflow_daily', taskType: 'workflow:daily', ownerSub: null });
    const { controller, service } = fixture(workflow);
    const res = response();

    await controller.triggerSchedule(request({}, 'ordinary-user', workflow.id), res);

    expect(res.statusCode).toBe(403);
    expect(service.triggerSchedule).not.toHaveBeenCalled();
  });
});
