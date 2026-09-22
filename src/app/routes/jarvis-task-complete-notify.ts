/**
 * Jarvis task completion — publish the finished work, then tell the owner it is finished.
 *
 * Work Jarvis hands to the swarm comes back through summarizeComplexTask: the row is finished, the
 * summary is written into the conversation, and that was the end of it. If the user was not looking
 * at the Jarvis thread when the swarm finished — which, for work that takes long enough to be handed
 * off, is the normal case — nothing told them. The hand-off experience was therefore one-way: you
 * could ask for something and never learn it was done.
 *
 * This module is the return leg's outward hop. It rides the EXISTING per-user NotificationRouter
 * (`buildNotificationRouter`), so the user's own saved channel preference, their quiet hours, their
 * Gmail connection and the email fallback all apply unchanged, and a deployment with no channel
 * wired degrades to a logged `skipped` exactly like every other producer. No new transport, no SMTP
 * secret, no second notifier.
 *
 * Ordering is the contract: the durable row is finished FIRST, the conversation turn is written
 * SECOND, and the notification is attempted LAST, inside a deadline. The answer must never be lost
 * to a wedged or failing outward channel — a notification is how the user hears about the result,
 * never where the result lives.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: publishJarvisTaskCompletion (finish row, then thread turn, then bounded notification) and notifyJarvisTaskComplete over the per-user NotificationRouter, so a task the swarm finished reaches the owner's inbox instead of waiting to be noticed.
 *
 * @module jarvis-task-complete-notify
 */

import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import type { NotificationRouter, NotifyOutcome } from '@/features/notifications';
import type { VisualResponseArtifact } from '@/features/visual-response';
import { buildNotificationRouter } from './notify-routes';
import { finishTask, persistJarvisTurn } from './jarvis-task-store';
import type { CapturedFile } from './jarvis-deliverable-files';

const logger = createChildLogger({ module: 'jarvis-task-complete-notify' });

/** Outward-hop bounds (see {@link notifyTimeoutMs}). */
const NOTIFY_TIMEOUT_DEFAULT_MS = 20_000, NOTIFY_TIMEOUT_MIN_MS = 1_000, NOTIFY_TIMEOUT_MAX_MS = 120_000;

/** How much of the summary the message body carries; the full result stays on the task. */
const BODY_MAX = 4_000;

/** One finished piece of work, as the summarizer has it. */
export interface JarvisTaskCompletion {
  /** The jarvis_tasks row id. */
  taskId: string;
  /** The swarm ticket the work ran under. */
  ticketId: string;
  /** The conversation to write the answer into, when the task still has one. */
  sessionId: string | null;
  /** What the user asked for. */
  title: string;
  /** Jarvis's summary of the result, links already substituted. */
  summary: string;
  /** The visual that accompanies the summary, when one was produced. */
  visual?: VisualResponseArtifact;
  /** Deliverables already copied into the owner's private folder. */
  files?: CapturedFile[];
}

/** The seams {@link publishJarvisTaskCompletion} writes through; production defaults are the real ones. */
export interface JarvisCompletionDeps {
  finish?: typeof finishTask;
  persistTurn?: typeof persistJarvisTurn;
  notify?: typeof notifyJarvisTaskComplete;
}

/**
 * @description The NotificationRouter topic a task-complete notice rides. Config → env
 * JARVIS_TASK_COMPLETE_TOPIC (letters/digits/dashes) → 'jarvis-task-complete'. It is the key a
 * user's saved preference is stored under, so it must stay stable once operators have set one.
 * @returns The topic name.
 */
export function jarvisTaskCompleteTopic(): string {
  const topic = String(process.env.JARVIS_TASK_COMPLETE_TOPIC ?? '').trim();
  return /^[a-z0-9][a-z0-9-]{0,60}$/i.test(topic) ? topic : 'jarvis-task-complete';
}

/**
 * @description How long the outward hop may take before the return leg stops waiting for it. The
 * senders really talk to Gmail, Twilio and Telegram; a wedged one must not hold the summarizer.
 * Config → env JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS (1000–120000) → 20000.
 * @returns Milliseconds.
 */
export function notifyTimeoutMs(): number {
  const n = Number(String(process.env.JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n >= NOTIFY_TIMEOUT_MIN_MS && n <= NOTIFY_TIMEOUT_MAX_MS
    ? Math.round(n) : NOTIFY_TIMEOUT_DEFAULT_MS;
}

/**
 * @description Tell the owner their handed-off work is finished, over their own preferred channel.
 * Never throws and never blocks past the deadline: an unconfigured channel, a refusing provider and
 * a wedged sender all resolve to a logged outcome, because the answer is already durable by the time
 * this runs.
 * @param ctx - App context (pool, for the router's pref reads and per-user senders).
 * @param sub - The owner to notify.
 * @param completion - The finished work.
 * @param notifier - The router to dispatch through; defaults to the production per-user router.
 * @returns The router outcome, or null when the outward hop failed or timed out.
 */
export async function notifyJarvisTaskComplete(
  ctx: AppContext,
  sub: string,
  completion: Pick<JarvisTaskCompletion, 'taskId' | 'title' | 'summary'>,
  notifier?: Pick<NotificationRouter, 'notify'>,
): Promise<NotifyOutcome | null> {
  const title = String(completion.title || 'your request').trim().slice(0, 120);
  const subject = `Done: ${title}`;
  const body = String(completion.summary || '').trim().slice(0, BODY_MAX)
    || 'The team finished this one — open it in oshal for the full result.';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Built INSIDE the deadline: buildNotificationRouter reads connections, so the build itself is
    // part of the outward hop it is bounding.
    const deadline = notifyTimeoutMs();
    return await Promise.race([
      (async () => (notifier ?? buildNotificationRouter(ctx))
        .notify(sub, jarvisTaskCompleteTopic(), { subject, body, shortText: `Finished: ${title}` }))(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`task-complete notice exceeded ${deadline}ms`)), deadline);
      }),
    ]);
  } catch (err) {
    logger.error({ err, taskId: completion.taskId }, 'jarvis: task-complete notice failed or exceeded its deadline');
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @description The whole return leg for one finished task, in the order that cannot lose the answer:
 * finish the durable row, write the summary into the conversation, then attempt the outward notice.
 * The notice is last and bounded on purpose — the two writes above it are what the user's Tasks list
 * and thread read from, and neither may depend on a channel being reachable.
 * @param ctx - App context.
 * @param sub - The owner of the work.
 * @param completion - The finished work and its summary.
 * @param deps - Injectable seams (tests); production uses the real store and router.
 * @returns The notification outcome, or null when nothing was delivered.
 */
export async function publishJarvisTaskCompletion(
  ctx: AppContext,
  sub: string,
  completion: JarvisTaskCompletion,
  deps: JarvisCompletionDeps = {},
): Promise<NotifyOutcome | null> {
  const finish = deps.finish ?? finishTask;
  const persistTurn = deps.persistTurn ?? persistJarvisTurn;
  const notify = deps.notify ?? notifyJarvisTaskComplete;
  await finish(ctx.pool, completion.taskId, true, completion.summary, completion.visual, completion.files);
  if (completion.sessionId) {
    await persistTurn(ctx, completion.sessionId, 'assistant', completion.summary, {
      sourceJarvisTaskId: completion.taskId,
      sourceTicketId: completion.ticketId,
      ...(completion.visual ? { visual: completion.visual } : {}),
      ...(completion.files?.length ? { files: completion.files } : {}),
    });
  }
  const outcome = await notify(ctx, sub, completion);
  logger.info({
    taskId: completion.taskId, ticketId: completion.ticketId,
    delivered: outcome?.delivered ?? false, channel: outcome?.channel ?? null, reason: outcome?.reason ?? null,
  }, 'jarvis: finished work published to the owner');
  return outcome;
}
