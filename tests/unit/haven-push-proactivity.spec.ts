/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for Haven push proactivity (the automation opt-in directive, in code): proactivity-off-by-default (no pref row, and a generic `default` row, both send NOTHING), proactivity-respects-per-user-optin (enabled row delivers; muted/none/daily-cap/already-pushed/teach-nudge do not), delivery goes through the EXISTING NotificationRouter contract, and the ledger is written only after a real delivery so a held send retries instead of being lost.
 */

import { describe, it, expect } from 'vitest';
import {
  HAVEN_PUSH_DAILY_CAP,
  HAVEN_PUSH_TOPIC,
  PUSHABLE_SUGGESTION_KINDS,
  evaluatePushGate,
  formatHavenPush,
  selectPushableSuggestions,
  type PendingSuggestion,
} from '@/features/user-model';
import {
  havenPushDeploymentEnabled,
  pushProactiveForUser,
  type HavenPushDeps,
  type HavenPushModel,
} from '@/app/routes/haven-proactivity-cron';
import type { AppContext } from '@/app/composition/app-context';
import type { NotifyOutcome, UserNotifyMessage } from '@/features/notifications';

const OWNER = 'auth0|owner-1';
/** The pool is never reached: every collaborator a push run touches is injected. */
const ctx = { pool: { query: async () => { throw new Error('the push run must not touch the pool directly'); } } } as unknown as AppContext;

interface Harness {
  deps: HavenPushDeps;
  notified: Array<{ userSub: string; topic: string; message: UserNotifyMessage }>;
  ledger: Array<{ suggestionId: string; channel: string }>;
  swept: string[];
}

function harness(options: {
  pref?: { enabled: boolean; channel: string } | null;
  pending?: PendingSuggestion[];
  alreadyPushed?: string[];
  sentToday?: number;
  outcome?: NotifyOutcome;
  deploymentEnabled?: boolean;
}): Harness {
  const notified: Harness['notified'] = [];
  const ledger: Harness['ledger'] = [];
  const swept: string[] = [];
  const model: HavenPushModel = {
    async sweep(userSub) { swept.push(userSub); },
    async pushesSentLastDay() { return options.sentToday ?? 0; },
    async pendingSuggestions() { return options.pending ?? []; },
    async pushedSuggestionIds() { return options.alreadyPushed ?? []; },
    async recordPush(_userSub, suggestionId, channel) { ledger.push({ suggestionId, channel }); },
  };
  return {
    notified,
    ledger,
    swept,
    deps: {
      model,
      notifier: {
        async notify(userSub, topic, message) {
          notified.push({ userSub, topic, message });
          return options.outcome ?? { delivered: true, channel: 'email', id: 'msg-1' };
        },
      },
      readPreference: async () => options.pref ?? null,
      deploymentEnabled: () => options.deploymentEnabled !== false,
    },
  };
}

const staleGoal: PendingSuggestion = { suggestionId: 's-1', kind: 'stale-goal', message: 'Still working on the boat?' };
const connectorAttention: PendingSuggestion = { suggestionId: 's-2', kind: 'connector-attention', message: 'Your google access expires in 2 days.' };
const teachNudge: PendingSuggestion = { suggestionId: 's-3', kind: 'teach-nudge', message: 'You can teach me standing rules.' };

describe('proactivity-off-by-default', () => {
  it('a user who never opted in is OFF, with an honest reason', () => {
    expect(evaluatePushGate(null)).toEqual({ enabled: false, reason: 'not-opted-in', channel: null });
    expect(evaluatePushGate(undefined)).toEqual({ enabled: false, reason: 'not-opted-in', channel: null });
  });

  it('no pref row → NOTHING is sent, even with push-worthy suggestions waiting', async () => {
    const h = harness({ pref: null, pending: [staleGoal, connectorAttention] });
    const result = await pushProactiveForUser(ctx, OWNER, h.deps);
    expect(result).toEqual({ sent: 0, reason: 'not-opted-in' });
    expect(h.notified).toHaveLength(0);
    expect(h.ledger).toHaveLength(0);
    // It must not even sweep: an opted-out user costs nothing and leaves no trace.
    expect(h.swept).toHaveLength(0);
  });

  it('the gate reads the haven-proactive topic ONLY — a generic `default` opt-in cannot enable it', async () => {
    // The router's own resolveRouting would fall back to the `default` row and then to
    // email-if-Gmail-else-none. The push gate must not: it asks for exactly one topic.
    const askedTopics: string[] = [];
    const h = harness({ pref: null, pending: [staleGoal] });
    const deps: HavenPushDeps = {
      ...h.deps,
      readPreference: async (userSub) => {
        askedTopics.push(HAVEN_PUSH_TOPIC);
        expect(userSub).toBe(OWNER);
        return null; // there IS a `default` row in reality; this topic has none.
      },
    };
    const result = await pushProactiveForUser(ctx, OWNER, deps);
    expect(askedTopics).toEqual([HAVEN_PUSH_TOPIC]);
    expect(result.sent).toBe(0);
    expect(h.notified).toHaveLength(0);
  });

  it('the deployment gate is OFF unless HAVEN_PUSH_CRON is explicitly truthy', async () => {
    expect(havenPushDeploymentEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(havenPushDeploymentEnabled({ HAVEN_PUSH_CRON: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(havenPushDeploymentEnabled({ HAVEN_PUSH_CRON: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);

    const h = harness({ pref: { enabled: true, channel: 'email' }, pending: [staleGoal], deploymentEnabled: false });
    expect(await pushProactiveForUser(ctx, OWNER, h.deps)).toEqual({ sent: 0, reason: 'deployment-disabled' });
    expect(h.notified).toHaveLength(0);
  });
});

describe('proactivity-respects-per-user-optin', () => {
  it('an explicitly enabled row delivers through the shared notifier and ledgers the send', async () => {
    const h = harness({ pref: { enabled: true, channel: 'email' }, pending: [connectorAttention] });
    const result = await pushProactiveForUser(ctx, OWNER, h.deps);

    expect(result).toEqual({ sent: 1, reason: 'delivered' });
    expect(h.swept).toEqual([OWNER]);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0].userSub).toBe(OWNER);
    // Routed on the haven-proactive topic, so the user's own quiet hours + channel apply.
    expect(h.notified[0].topic).toBe(HAVEN_PUSH_TOPIC);
    expect(h.notified[0].message.body).toContain(connectorAttention.message);
    // Every outward message carries the off switch.
    expect(h.notified[0].message.body.toLowerCase()).toContain('turn them off');
    expect(h.ledger).toEqual([{ suggestionId: 's-2', channel: 'email' }]);
  });

  it('a muted row and a row routed to "none" both send nothing', async () => {
    expect(evaluatePushGate({ enabled: false, channel: 'sms' }).reason).toBe('disabled');
    expect(evaluatePushGate({ enabled: true, channel: 'none' }).reason).toBe('channel-none');

    const muted = harness({ pref: { enabled: false, channel: 'sms' }, pending: [staleGoal] });
    expect((await pushProactiveForUser(ctx, OWNER, muted.deps)).sent).toBe(0);
    expect(muted.notified).toHaveLength(0);

    const none = harness({ pref: { enabled: true, channel: 'none' }, pending: [staleGoal] });
    expect((await pushProactiveForUser(ctx, OWNER, none.deps)).sent).toBe(0);
    expect(none.notified).toHaveLength(0);
  });

  it('a teach nudge is never pushed outward, however long it waits', async () => {
    expect(PUSHABLE_SUGGESTION_KINDS.has('teach-nudge')).toBe(false);
    const h = harness({ pref: { enabled: true, channel: 'email' }, pending: [teachNudge] });
    expect(await pushProactiveForUser(ctx, OWNER, h.deps)).toEqual({ sent: 0, reason: 'nothing-to-push' });
    expect(h.notified).toHaveLength(0);
  });

  it('honours the daily cap and never re-pushes a suggestion already delivered', async () => {
    const capped = harness({
      pref: { enabled: true, channel: 'sms' },
      pending: [staleGoal, connectorAttention],
      sentToday: HAVEN_PUSH_DAILY_CAP,
    });
    expect(await pushProactiveForUser(ctx, OWNER, capped.deps)).toEqual({ sent: 0, reason: 'daily-cap' });
    expect(capped.notified).toHaveLength(0);

    const repeat = harness({
      pref: { enabled: true, channel: 'sms' },
      pending: [staleGoal, connectorAttention],
      alreadyPushed: ['s-1'],
    });
    const result = await pushProactiveForUser(ctx, OWNER, repeat.deps);
    expect(result.sent).toBe(1);
    expect(repeat.notified.map((n) => n.message.body)).toEqual([
      expect.stringContaining(connectorAttention.message),
    ]);

    // And the pure selector enforces both bounds on its own.
    expect(selectPushableSuggestions([staleGoal, connectorAttention], ['s-1'], 5))
      .toEqual([connectorAttention]);
    expect(selectPushableSuggestions([staleGoal, connectorAttention], [], 1)).toEqual([staleGoal]);
    expect(selectPushableSuggestions([staleGoal], [], 0)).toEqual([]);
  });

  it('a held or failed send is NOT ledgered, so it retries instead of vanishing', async () => {
    const held = harness({
      pref: { enabled: true, channel: 'email' },
      pending: [connectorAttention],
      outcome: { delivered: false, channel: 'email', skipped: true, reason: 'quiet-hours' },
    });
    const result = await pushProactiveForUser(ctx, OWNER, held.deps);
    expect(result).toEqual({ sent: 0, reason: 'nothing-to-push' });
    expect(held.notified).toHaveLength(1);   // it was attempted…
    expect(held.ledger).toHaveLength(0);     // …and deliberately not recorded as delivered.
  });

  it('the rendered push names itself, links the surface, and fits a short channel', () => {
    const message = formatHavenPush(connectorAttention);
    expect(message.subject.toLowerCase()).toContain('oshal');
    expect(message.body).toContain('/cockpit/?app=jarvis');
    expect(message.shortText.length).toBeLessThanOrEqual(300);
    expect(message.shortText).toContain(connectorAttention.message);
  });
});
