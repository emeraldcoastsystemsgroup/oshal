/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added REST controller for Redis-backed schedule CRUD and trigger operations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Captured caller ownerSub on create + scoped getAllSchedules by app queue (?taskType) and caller (?scope=all overrides for admin dashboards)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Object-level authorization (IDOR fix): every by-id handler (get/update/pause/resume/delete/trigger) now verifies the caller owns the schedule (or is an operator, or it is unowned/system) via requireOwnedSchedule() and 404s on mismatch. The ?scope=all list override is now operator-only. Previously any authenticated user could read/edit-cron/delete/run-on-demand another user's scheduled job by guessing its (predictable) id, or enumerate all schedules with ?scope=all.
 */

import { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ScheduleRunner, ScheduleService } from '../services';
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
      logger.info({ body: req.body }, 'POST /api/v1/agent/schedule-task');
      const ownerSub = this.readCallerSub(req);
      const schedule = await this.scheduleService.createSchedule({ ...(req.body || {}), ownerSub });
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
      logger.info({ scheduleId, body: req.body }, 'PUT /api/v1/agent/schedules/:id');
      if (!(await this.requireOwnedSchedule(req, res, scheduleId))) return;
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
      if (!(await this.requireOwnedSchedule(req, res, scheduleId))) return;
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
      if (!(await this.requireOwnedSchedule(req, res, scheduleId))) return;
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
      if (!(await this.requireOwnedSchedule(req, res, scheduleId))) return;
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
      if (!(await this.requireOwnedSchedule(req, res, scheduleId))) return;
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
      logger.info({ body: req.body }, 'POST /api/v1/agent/execute-scheduled-task');
      const result = await this.scheduleService.executeScheduledTask(req.body || {});
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
