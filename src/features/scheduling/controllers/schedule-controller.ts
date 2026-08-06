/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added REST controller for Redis-backed schedule CRUD and trigger operations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Captured caller ownerSub on create + scoped getAllSchedules by app queue (?taskType) and caller (?scope=all overrides for admin dashboards)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Object-level authorization (IDOR fix): every by-id handler (get/update/pause/resume/delete/trigger) now verifies the caller owns the schedule (or is an operator, or it is unowned/system) via requireOwnedSchedule() and 404s on mismatch. The ?scope=all list override is now operator-only. Previously any authenticated user could read/edit-cron/delete/run-on-demand another user's scheduled job by guessing its (predictable) id, or enumerate all schedules with ?scope=all.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reserve manifest-owned app/app-route schedules from the user API, require operator authority for workflow schedules, apply ownership checks to the legacy execute callback, and stop logging prompt-bearing request bodies.
 */

import { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ScheduleRunner, ScheduleService } from '../services';
import { MANIFEST_SERVICE_ROUTE_TASK_KIND, type CreateScheduleInput } from '../types';
import { canAccessResource, isOperator } from '@/shared/middleware/authz';

type OwnedSchedule = NonNullable<Awaited<ReturnType<ScheduleService['getSchedule']>>>;

const logger = createChildLogger({ module: 'schedule-controller' });

/**
 * @description HTTP controller for legacy-compatible schedule endpoints.
 */
export class ScheduleController {
  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly scheduleRunner: ScheduleRunner,
  ) {}

  /**
   * @description Creates or replaces a schedule.
   *
   * @param req - Express request containing `taskType`, `schedule`, and `taskData`.
   * @param res - Express response.
   */
  createSchedule = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.readBody(req);
      const taskType = this.readOptionalString(body.taskType);
      logger.info({ taskType }, 'POST /api/v1/agent/schedule-task');
      if (!this.authorizeExternalSchedulePayload(req, res, body)) return;
      const ownerSub = this.readCallerSub(req);
      if (!ownerSub) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }
      // ScheduleService owns schema validation; this cast only restores the old Express `any`
      // boundary after narrowing the body to an object for the authorization checks above.
      const input = { ...body, ownerSub } as unknown as CreateScheduleInput;
      const schedule = await this.scheduleService.createSchedule(input);
      res.json({ success: true, scheduleId: schedule.id, schedule });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create schedule');
      res.status(400).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Lists all schedules.
   *
   * @param _req - Express request.
   * @param res - Express response.
   */
  getAllSchedules = async (req: Request, res: Response): Promise<void> => {
    try {
      const ownerSub = this.readCallerSub(req);
      // ?scope=all (list every user's schedules) is operator-only; others are owner-scoped.
      const scope = req.query.scope === 'all' && isOperator(req) ? 'all' : undefined;
      const taskType = typeof req.query.taskType === 'string' ? req.query.taskType : undefined;
      const queue = typeof req.query.queue === 'string' ? req.query.queue : undefined;
      logger.info({ taskType, queue, scope, scoped: Boolean(ownerSub) }, 'GET /api/v1/agent/schedules');
      const schedules = await this.scheduleService.listSchedules({
        taskType,
        queue,
        ownerSub: ownerSub ?? undefined,
        scope,
      });
      res.json({ success: true, schedules });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list schedules');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Fetches a single schedule by identifier.
   *
   * @param req - Express request with `id` path parameter.
   * @param res - Express response.
   */
  getSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'GET /api/v1/agent/schedules/:id');
      const schedule = await this.requireOwnedSchedule(req, res, scheduleId);
      if (!schedule) return;
      res.json({ success: true, schedule });
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to fetch schedule');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Updates a schedule cron pattern.
   *
   * @param req - Express request with `id` path parameter and update payload.
   * @param res - Express response.
   */
  updateSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'PUT /api/v1/agent/schedules/:id');
      if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      const schedule = await this.scheduleService.updateSchedule(scheduleId, req.body);
      res.json({ success: true, schedule });
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to update schedule');
      res.status(400).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Pauses a schedule.
   *
   * @param req - Express request with `id` path parameter.
   * @param res - Express response.
   */
  pauseSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'POST /api/v1/agent/schedules/:id/pause');
      if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      const schedule = await this.scheduleService.pauseSchedule(scheduleId);
      res.json({ success: true, schedule });
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to pause schedule');
      res.status(400).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Resumes a schedule.
   *
   * @param req - Express request with `id` path parameter.
   * @param res - Express response.
   */
  resumeSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'POST /api/v1/agent/schedules/:id/resume');
      if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      const schedule = await this.scheduleService.resumeSchedule(scheduleId);
      res.json({ success: true, schedule });
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to resume schedule');
      res.status(400).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Deletes a schedule.
   *
   * @param req - Express request with `id` path parameter.
   * @param res - Express response.
   */
  deleteSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'DELETE /api/v1/agent/schedules/:id');
      if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      const deleted = await this.scheduleService.deleteSchedule(scheduleId);
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Schedule not found' });
        return;
      }
      res.json({ success: true, deleted: true });
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to delete schedule');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Triggers immediate execution of a schedule.
   *
   * @param req - Express request with `id` path parameter.
   * @param res - Express response.
   */
  triggerSchedule = async (req: Request, res: Response): Promise<void> => {
    const scheduleId = this.readRouteId(req);
    try {
      logger.info({ scheduleId }, 'POST /api/v1/agent/schedules/:id/trigger');
      if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      const result = await this.scheduleService.triggerSchedule(scheduleId);
      res.json(result);
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to trigger schedule');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Executes an internal worker callback payload.
   *
   * @param req - Express request containing callback payload.
   * @param res - Express response.
   */
  executeScheduledTask = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = this.readBody(req);
      const scheduleId = this.readOptionalString(body.scheduleId) || this.readOptionalString(body.id);
      const taskType = this.readOptionalString(body.taskType);
      logger.info({ scheduleId, taskType }, 'POST /api/v1/agent/execute-scheduled-task');
      if (scheduleId) {
        if (!(await this.requireExternallyMutableSchedule(req, res, scheduleId))) return;
      } else if (!this.authorizeExternalSchedulePayload(req, res, body)) {
        return;
      }
      const result = await this.scheduleService.executeScheduledTask(body);
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Failed to execute scheduled task payload');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Returns health and runtime status for scheduler diagnostics.
   *
   * @param _req - Express request.
   * @param res - Express response.
   */
  getSchedulerStatus = async (_req: Request, res: Response): Promise<void> => {
    try {
      const redisHealthy = await this.scheduleService.healthCheck();
      const runnerStatus = this.scheduleRunner.getStatus();
      res.json({ success: true, redisHealthy, ...runnerStatus });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get scheduler status');
      res.status(500).json({ success: false, error: this.asErrorMessage(error) });
    }
  };

  /**
   * @description Resolves the authenticated caller's OIDC `sub` for owner scoping.
   *
   * @param req - Express request, optionally carrying an `express-openid-connect` session.
   * @returns The caller `sub`, or null when unauthenticated (system/background callers).
   */
  private readCallerSub(req: Request): string | null {
    const sub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
    return typeof sub === 'string' && sub.length > 0 ? sub : null;
  }

  /**
   * @description Object-level authorization guard for schedule by-id routes. Loads the
   * schedule; if it is missing, or the caller is neither its owner nor an operator (unowned
   * system schedules pass), responds 404 (NOT 403, so ids cannot be probed) and returns
   * null. On success returns the loaded schedule.
   */
  private async requireOwnedSchedule(req: Request, res: Response, scheduleId: string): Promise<OwnedSchedule | null> {
    const schedule = await this.scheduleService.getSchedule(scheduleId);
    if (!schedule || !canAccessResource(req, (schedule as { ownerSub?: string | null }).ownerSub ?? null)) {
      res.status(404).json({ success: false, error: 'Schedule not found' });
      return null;
    }
    return schedule;
  }

  /**
   * @description Extends the ordinary ownership check for mutating/execute routes. `app:` and
   * `app-route:` entries are lifecycle-owned by reviewed package manifests, so even an operator
   * must change the manifest or app activation state instead of mutating derived Redis state.
   * `workflow:` schedules are privileged ticket producers and remain operator-only, including
   * when the temporary legacy-unowned compatibility flag is enabled.
   */
  private async requireExternallyMutableSchedule(
    req: Request,
    res: Response,
    scheduleId: string,
  ): Promise<OwnedSchedule | null> {
    const schedule = await this.requireOwnedSchedule(req, res, scheduleId);
    if (!schedule) return null;
    if (this.isManifestManagedTaskType(schedule.taskType)) {
      this.sendManagedScheduleDenial(res);
      return null;
    }
    if (this.isWorkflowTaskType(schedule.taskType) && !isOperator(req)) {
      res.status(403).json({ success: false, error: 'Operator privilege required' });
      return null;
    }
    return schedule;
  }

  /**
   * @description Rejects externally supplied payloads that could impersonate a manifest-owned
   * job. Workflow ticket schedules are accepted only from an explicitly allowlisted operator.
   * Internal boot/reconciliation code calls ScheduleService directly and is therefore unaffected.
   */
  private authorizeExternalSchedulePayload(
    req: Request,
    res: Response,
    payload: Record<string, unknown>,
  ): boolean {
    const taskType = this.readOptionalString(payload.taskType);
    const taskData = this.asRecord(payload.taskData);
    if (this.isManifestManagedTaskType(taskType)
      || taskData?.kind === MANIFEST_SERVICE_ROUTE_TASK_KIND) {
      this.sendManagedScheduleDenial(res);
      return false;
    }
    if (this.isWorkflowTaskType(taskType) && !isOperator(req)) {
      res.status(403).json({ success: false, error: 'Operator privilege required' });
      return false;
    }
    return true;
  }

  /** @description True for schedule namespaces derived exclusively from active app manifests. */
  private isManifestManagedTaskType(taskType: string | undefined): boolean {
    return taskType?.startsWith('app:') === true || taskType?.startsWith('app-route:') === true;
  }

  /** @description True for schedules that create workflow tickets without another user action. */
  private isWorkflowTaskType(taskType: string | undefined): boolean {
    return taskType?.startsWith('workflow:') === true;
  }

  /** @description Sends the stable response used when a caller targets manifest-derived state. */
  private sendManagedScheduleDenial(res: Response): void {
    res.status(403).json({ success: false, error: 'Schedule is managed by an active app manifest' });
  }

  /** @description Coerces an Express body to a plain record without trusting its prototype. */
  private readBody(req: Request): Record<string, unknown> {
    return this.asRecord(req.body) ?? {};
  }

  /** @description Narrows an unknown value to a non-array object. */
  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  /** @description Reads and trims an optional string from an untyped request payload. */
  private readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * @description Reads route `id` parameter with compatibility for array values.
   */
  private readRouteId(req: Request): string {
    const rawId = req.params.id;
    return Array.isArray(rawId) ? rawId[0] : rawId;
  }

  /**
   * @description Converts unknown errors into response-safe text.
   */
  private asErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
