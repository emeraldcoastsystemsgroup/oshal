/**
 * Home schedule dispatch — the home-control branch of the shared scheduler.
 *
 * When a smart-home schedule fires, the system has NO user session, so this module
 * (a) brokers the schedule owner's SmartThings token, (b) dispatches the saved
 * prompt to the home-bot via the fast loop (the user chose bot-LLM execution), and
 * (c) logs a `home-control` ticket owned by that user — so the home Tickets queue
 * becomes their smart-home activity history. Solar (sunrise/sunset) schedules also
 * re-arm their next occurrence; a daily per-user replanner is the backstop.
 *
 * The shared scheduler stays generic: schedule-runtime only branches to here when
 * the taskType is a home one (see isHomeSchedule). The ScheduleService handle is
 * injected (setHomeScheduleService) to avoid a circular import.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — home-control dispatch (broker token → home-bot fast loop → log home-control ticket), solar re-arm, and the per-user daily solar replanner. ScheduleService handle injected to avoid a cycle with schedule-runtime.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scoped the per-user home action (fireHomeAction) to the OWNER's request identity, overriding the schedule-runtime SYSTEM wrap for that branch — the owner's connector-token read + home-control ticket write are the owner's own rows, exactly as the interactive /chat path runs. replanSolar stays SYSTEM (cross-user sweep). Deny-by-default safe either way.
 *
 * @module home-schedule-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult, ScheduleService } from '@/features/scheduling';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { resolveBotCreds } from './routes/connector-token-broker';
import { nextSunEvent, type SunEvent } from '@/shared/utils/sun-times';
import { createChildLogger } from '@/shared/logger';
import { executeBotOrInline } from './routes/inline-bot-execution';

const logger = createChildLogger({ module: 'home-schedule-dispatch' });
const HOME_BOT_AGENT_ID = 'd0000000-0000-0000-0000-000000000001';
const botClient = new BotNodeClient(createRegistryEndpointResolver());

// Injected by schedule-runtime after the service is built (avoids a circular import).
// Also used by home-routes to create/list/delete home schedules.
let scheduleSvc: ScheduleService | null = null;
/** @description Provide the shared ScheduleService to the home schedule layer. */
export function setHomeScheduleService(svc: ScheduleService): void { scheduleSvc = svc; }
/** @description The shared ScheduleService (null until the scheduler runtime is wired). */
export function getHomeScheduleService(): ScheduleService | null { return scheduleSvc; }

/** @description True for schedules this module owns: home actions + the solar replanner. */
export function isHomeSchedule(taskType: string): boolean {
  return taskType.startsWith('home-control') || taskType.startsWith('home-replan');
}

interface SolarTrigger { kind: 'solar'; event: SunEvent; offsetMin: number; lat: number; lng: number; }

/** Build a daily UTC cron (`m h * * *`) for an instant. Solar instants are UTC; we
 *  recompute daily so the few-minutes-per-day drift never accumulates. */
function dailyCronUtc(at: Date): string {
  return `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`;
}

/**
 * @description Dispatch a home schedule that just came due.
 * @param ctx - app context (pool, ticketService)
 * @param schedule - the due schedule record
 * @returns dispatch result for scheduler accounting
 */
export async function dispatchHomeSchedule(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  if (schedule.taskType.startsWith('home-replan')) return replanSolar(schedule);
  return fireHomeAction(ctx, schedule);
}

/** Broker the owner's token, run the saved prompt on the home-bot, log a ticket, re-arm solar. */
async function fireHomeAction(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const userSub = String(td.userSub || '');
  const prompt = String(td.prompt || '');
  const label = String(td.label || prompt).slice(0, 110);
  const taskId = `home-sched-${schedule.id}`;
  if (!userSub || !prompt) return { success: false, scheduleId: schedule.id, error: 'home schedule missing userSub/prompt' };

  // Per-user home action: run under the OWNER's request identity, mirroring the interactive path
  // (a user triggering the same action via /chat runs under their own request identity). Scopes the
  // owner's connector-token read + the home-control ticket write to the owner, and stays visible
  // under OSHAL_DB_GUC_STRICT=deny (the schedule-runtime SYSTEM wrap around this call is overridden
  // by this nested owner identity for the home branch only).
  return runWithRequestIdentity({ sub: userSub, isOperator: false }, async (): Promise<ScheduleDispatchResult> => {
    let success = true;
    let error: string | undefined;
    try {
      const creds = await resolveBotCreds(ctx.pool, userSub, ['smartthings']);
      await executeBotOrInline(ctx, botClient, HOME_BOT_AGENT_ID, {
        text: prompt, taskId, workspaceFolderId: `home-${userSub}`, agentId: HOME_BOT_AGENT_ID,
        agenticMode: true, direct: true, userSub, creds,
      });
    } catch (e) { success = false; error = (e as Error).message; }

    try {
      await ctx.ticketService.createTicket({
        title: `⏰ ${label}`, ticketType: 'home-control', ownerSub: userSub,
        status: success ? 'complete' : 'cancelled', description: prompt,
        priority: 'none', labels: [], workspaceId: null, assignedAgentId: null,
        parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null,
        metadata: { source: 'schedule', scheduleId: schedule.id, firedAt: new Date().toISOString(), ok: success, error: error || null },
      });
    } catch (e) { logger.warn({ err: e, scheduleId: schedule.id }, 'home schedule ticket log failed'); }

    const trigger = td.trigger as SolarTrigger | undefined;
    if (trigger?.kind === 'solar') { try { await rearmSolar(schedule, trigger); } catch (e) { logger.warn({ err: e }, 'solar re-arm failed'); } }

    return { success, scheduleId: schedule.id, taskId, error };
  });
}

/** Recompute one solar schedule's cron to its next occurrence (immediate re-arm after firing). */
async function rearmSolar(schedule: ScheduleRecord, trigger: SolarTrigger): Promise<void> {
  if (!scheduleSvc) return;
  const next = nextSunEvent(trigger.lat, trigger.lng, trigger.event, trigger.offsetMin, new Date(Date.now() + 60_000));
  if (next) await scheduleSvc.updateSchedule(schedule.id, { schedule: dailyCronUtc(next) });
}

/** Daily replanner: re-point every solar home schedule (any user) at today's sun times. */
async function replanSolar(replan: ScheduleRecord): Promise<ScheduleDispatchResult> {
  if (!scheduleSvc) return { success: false, scheduleId: replan.id, error: 'scheduler unavailable' };
  const all = await scheduleSvc.listSchedules();
  let updated = 0;
  for (const s of all) {
    const trigger = (s.taskData as Record<string, unknown>).trigger as SolarTrigger | undefined;
    if (!s.taskType.startsWith('home-control') || trigger?.kind !== 'solar') continue;
    const next = nextSunEvent(trigger.lat, trigger.lng, trigger.event, trigger.offsetMin, new Date());
    if (next) { await scheduleSvc.updateSchedule(s.id, { schedule: dailyCronUtc(next) }); updated++; }
  }
  logger.info({ updated }, 'Solar schedules replanned');
  return { success: true, scheduleId: replan.id };
}
