/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy-compatible schedule routes for Redis-backed self-scheduling
 */

import { Router } from 'express';
import { ScheduleController } from '@/features/scheduling';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'schedule-routes' });

/**
 * @description Creates and configures routes for the legacy scheduling API surface.
 * All routes are mounted under `/api/v1/agent`.
 *
 * @param controller - Schedule controller instance.
 * @returns Configured Express router.
 */
export function createScheduleRoutes(controller: ScheduleController): Router {
  const router = Router();

  router.get('/scheduler/status', controller.getSchedulerStatus);
  router.post('/schedule-task', controller.createSchedule);

  router.get('/schedules', controller.getAllSchedules);
  router.get('/schedules/:id', controller.getSchedule);
  router.put('/schedules/:id', controller.updateSchedule);
  router.post('/schedules/:id/pause', controller.pauseSchedule);
  router.post('/schedules/:id/resume', controller.resumeSchedule);
  router.post('/schedules/:id/trigger', controller.triggerSchedule);
  router.delete('/schedules/:id', controller.deleteSchedule);

  router.post('/execute-scheduled-task', controller.executeScheduledTask);

  logger.info('Schedule routes registered');
  return router;
}
