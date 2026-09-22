/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the completed-task return leg's outward hop. summarizeComplexTask finished the jarvis_tasks row and wrote the thread turn and stopped, so work handed to the swarm - which by definition runs long enough that nobody is watching the thread - finished silently. These cases drive the REAL NotificationRouter (its pref read, its topic resolution, its quiet-hours hold, its availability gate and its email fallback are all the shipped code; only the transport at the very end is a double), so dropping the notice, sending it under a different topic, or letting a failing channel cost the user their answer each go red here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationRouter,
  type PgLike,
  type UserChannelSender,
  type UserNotifyMessage,
} from '@/features/notifications';
import {
  jarvisTaskCompleteTopic,
  notifyJarvisTaskComplete,
  publishJarvisTaskCompletion,
  type JarvisTaskCompletion,
} from '@/app/routes/jarvis-task-complete-notify';

const OWNER = 'auth0|jarvis-task-complete-owner';

/** The finished work one case publishes. */
const COMPLETION: JarvisTaskCompletion = {
  taskId: 'jarvis-task-9f2',
  ticketId: 'ticket-9f2',
  sessionId: 'jarvis-thread-9f2',
  title: 'Build me a bot that watches my inbox',
  summary: 'Your inbox watcher is live. It files anything from the billing alias into a daily digest.',
};

/**
 * A prefs store that holds exactly ONE saved row, under the topic given. A notice sent under any
 * other topic finds no row, falls through to the default channel, and is skipped — which is how a
 * topic that drifted away from the one users saved their preference under is caught here.
 */
function prefsFor(topic: string): PgLike {
  return {
    query: async (_text: string, params?: unknown[]) => {
      const [userSub, asked] = (params ?? []) as [string, string];
      if (userSub !== OWNER || asked !== topic) return { rows: [] };
      return {
        rows: [{
          user_sub: OWNER, topic, channel: 'email', enabled: true,
          quiet_hours_start: null, quiet_hours_end: null,
          phone: null, telegram_chat_id: null, updated_at: new Date().toISOString(),
        }],
      };
    },
  };
}

/** A per-user email sender that records what it was handed. `fail` makes the provider refuse. */
function recordingEmailSender(options: { available?: boolean; fail?: boolean } = {}): UserChannelSender & {
  sent: UserNotifyMessage[];
} {
  const sent: UserNotifyMessage[] = [];
  return {
    channel: 'email',
    sent,
    available: async () => options.available !== false,
    send: async (_sub, _pref, message) => {
      sent.push(message);
      if (options.fail) return { delivered: false, error: 'mailbox unavailable' };
      return { delivered: true, id: 'mail-1' };
    },
  };
}

/** The real router over a real pref read, with only the transport doubled. */
function routerWith(topic: string, sender: UserChannelSender): NotificationRouter {
  return new NotificationRouter({
    pool: prefsFor(topic),
    senders: { email: sender },
    // 'none' by default, so ONLY the saved row under the guarded topic can produce a delivery.
    defaultChannel: async () => 'none',
  });
}

describe('a finished Jarvis task tells its owner', () => {
  it('delivers the completion over the user\'s saved channel, with the work named', async () => {
    const sender = recordingEmailSender();

    const outcome = await notifyJarvisTaskComplete(
      {} as never, OWNER, COMPLETION, routerWith(jarvisTaskCompleteTopic(), sender),
    );

    expect(outcome).toMatchObject({ delivered: true, channel: 'email', id: 'mail-1' });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.subject).toBe(`Done: ${COMPLETION.title}`);
    expect(sender.sent[0]?.body).toContain('Your inbox watcher is live');
    expect(sender.sent[0]?.shortText).toBe(`Finished: ${COMPLETION.title}`);
  });

  it('rides the topic users actually save their preference under', async () => {
    // The pref row exists ONLY under the guarded topic. Renaming the topic in the producer without
    // migrating saved rows silently stops delivering, which is what this pins.
    const sender = recordingEmailSender();

    const outcome = await notifyJarvisTaskComplete(
      {} as never, OWNER, COMPLETION, routerWith('some-other-topic', sender),
    );

    expect(outcome).toMatchObject({ delivered: false, skipped: true });
    expect(sender.sent, 'no saved row and no default channel means nothing is sent').toHaveLength(0);
  });

  it('a refusing channel is reported, never thrown at the return leg', async () => {
    const sender = recordingEmailSender({ fail: true });

    const outcome = await notifyJarvisTaskComplete(
      {} as never, OWNER, COMPLETION, routerWith(jarvisTaskCompleteTopic(), sender),
    );

    expect(outcome).toMatchObject({ delivered: false, reason: 'send-failed', error: 'mailbox unavailable' });
  });

  it('a wedged channel is abandoned at the deadline instead of holding the summarizer', async () => {
    const saved = process.env.JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS;
    process.env.JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS = '1000';
    try {
      const wedged = { notify: () => new Promise<never>(() => {}) };
      const startedAt = Date.now();

      const outcome = await notifyJarvisTaskComplete({} as never, OWNER, COMPLETION, wedged as never);

      expect(outcome, 'a hop that never resolves must return, not hang').toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      if (saved === undefined) delete process.env.JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS;
      else process.env.JARVIS_TASK_COMPLETE_NOTIFY_TIMEOUT_MS = saved;
    }
  });
});

describe('publishJarvisTaskCompletion puts the answer beyond the reach of the outward hop', () => {
  it('finishes the row, writes the thread turn, then notifies — in that order', async () => {
    const order: string[] = [];
    const finish = vi.fn(async () => { order.push('finish'); });
    const persistTurn = vi.fn(async () => { order.push('turn'); });
    const sender = recordingEmailSender();
    const notify = vi.fn(async (ctx: never, sub: string, completion: JarvisTaskCompletion) => {
      order.push('notify');
      return notifyJarvisTaskComplete(ctx, sub, completion, routerWith(jarvisTaskCompleteTopic(), sender));
    });

    const outcome = await publishJarvisTaskCompletion(
      { pool: {} } as never, OWNER, COMPLETION,
      { finish: finish as never, persistTurn: persistTurn as never, notify: notify as never },
    );

    expect(order).toEqual(['finish', 'turn', 'notify']);
    expect(outcome).toMatchObject({ delivered: true, channel: 'email' });
    expect(finish).toHaveBeenCalledWith({}, COMPLETION.taskId, true, COMPLETION.summary, undefined, undefined);
    expect(persistTurn.mock.calls[0]?.slice(1, 4)).toEqual([
      COMPLETION.sessionId, 'assistant', COMPLETION.summary,
    ]);
    expect(sender.sent).toHaveLength(1);
  });

  it('a task with no conversation still finishes and still notifies', async () => {
    const finish = vi.fn(async () => {});
    const persistTurn = vi.fn(async () => {});
    const sender = recordingEmailSender();

    await publishJarvisTaskCompletion(
      { pool: {} } as never, OWNER, { ...COMPLETION, sessionId: null },
      {
        finish: finish as never,
        persistTurn: persistTurn as never,
        notify: ((ctx: never, sub: string, completion: JarvisTaskCompletion) =>
          notifyJarvisTaskComplete(ctx, sub, completion, routerWith(jarvisTaskCompleteTopic(), sender))) as never,
      },
    );

    expect(finish).toHaveBeenCalledTimes(1);
    expect(persistTurn).not.toHaveBeenCalled();
    expect(sender.sent).toHaveLength(1);
  });

  it('an outward hop that fails never costs the user the finished answer', async () => {
    const finish = vi.fn(async () => {});
    const persistTurn = vi.fn(async () => {});

    const outcome = await publishJarvisTaskCompletion(
      { pool: {} } as never, OWNER, COMPLETION,
      {
        finish: finish as never,
        persistTurn: persistTurn as never,
        notify: (async () => null) as never,
      },
    );

    expect(outcome).toBeNull();
    // The two writes the Tasks list and the thread read from happened regardless.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(persistTurn).toHaveBeenCalledTimes(1);
  });
});
