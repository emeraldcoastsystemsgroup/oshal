/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the two defects
 *   behind a live duplicate send (2026-07-28). A ticket asking a leaf node to deliver a message
 *   through a website contact form (1) was re-routed into the JOB-APPLICATION dispatcher because the
 *   Chrome install path in its description contains the word "Application", which really submitted an
 *   unrelated job application; and (2) after the stack watchdog restarted the api 15s post-dispatch,
 *   the orphaned in-process await let the queue watchdog roll the ticket back and dispatch it AGAIN —
 *   the contact form was submitted twice. These cover both: intent must come from structured metadata
 *   (never from a file path, never over an explicit node pin), and a ticket already handed to a
 *   machine must never be handed to it a second time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const enqueued: Array<{ clientId: string; env: Record<string, unknown> }> = [];
  const state = {
    client: null as Record<string, unknown> | null,
    completed: new Map<string, Record<string, unknown>>(),
    inFlight: new Set<string>(),
  };
  return { enqueued, state };
});

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: {
    getClient: () => hoisted.state.client,
    enqueueTask: (clientId: string, env: Record<string, unknown>) => {
      hoisted.enqueued.push({ clientId, env });
      return { taskId: env.taskId };
    },
    getCompletedResult: (_clientId: string, taskId: string) => hoisted.state.completed.get(taskId) ?? null,
    getInFlightTask: (_clientId: string, taskId: string) => (hoisted.state.inFlight.has(taskId) ? { taskId } : null),
  },
  taskWorkspaceFolder: (id: string) => `/tmp/${id}`,
}));

import {
  dispatchExplicitRemoteTicket,
  priorRemoteTaskId,
  EXPLICIT_REMOTE_TASK_ID_KEY,
} from '@/app/explicit-remote-ticket-dispatch';
import { stripPathLikeTokens } from '@/features/swarm-orchestration/services/dispatch-manifest-worker';

const NODE = 'oshal-chat-0ce849b6-8b95-4cf5-9223-ce22d638f1c9';
const OWNER = 'owner-sub-1';

/** The exact instruction text that misrouted live: a Chrome path supplies "Application". */
const OUTREACH_DESCRIPTION = [
  'Open a NEW Google Chrome incognito window.',
  'PowerShell: & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -incognito "https://example.com/contact"',
  'Fill in the contact form and send it once, then screenshot the confirmation.',
].join('\n');

function ticket(overrides: Record<string, unknown> = {}): any {
  return {
    ticketId: 'ticket-1',
    title: 'Deliver an introduction note through a website contact form',
    description: OUTREACH_DESCRIPTION,
    ticketType: 'task',
    ownerSub: OWNER,
    metadata: { targetRemoteClientId: NODE },
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.enqueued.length = 0;
  hoisted.state.completed.clear();
  hoisted.state.inFlight.clear();
  hoisted.state.client = {
    clientId: NODE,
    agentId: NODE,
    status: 'online',
    healthy: true,
    capabilities: ['codex.exec', 'shell.exec'],
    ownerSub: OWNER,
  };
});

describe('a file path is not a statement of intent', () => {
  it('strips path-like tokens so a Chrome install path cannot read as the word "Application"', () => {
    const stripped = stripPathLikeTokens(OUTREACH_DESCRIPTION);
    expect(/\b(apply|application|resumes?|job posting)\b/i.test(stripped)).toBe(false);
    expect(/\b(submit|deploy|apply|application)\b/i.test(stripped)).toBe(false);
    // The real prose survives — this must not become a blanket mute of the matcher.
    expect(stripPathLikeTokens('Submit the generated resumes for the job posting')).toContain('resumes');
  });

  it('keeps genuine apply prose matchable once paths are gone', () => {
    const stripped = stripPathLikeTokens('Deploy last-14-days generated resumes to the job postings');
    expect(/\b(apply|application|resumes?|job posting|job postings)\b/i.test(stripped)).toBe(true);
    expect(/\b(submit|deploy|apply|application)\b/i.test(stripped)).toBe(true);
  });

  it('drops URLs too, so a link cannot smuggle intent words', () => {
    expect(stripPathLikeTokens('see https://jobs.example.com/application/submit now')).not.toContain('application');
  });
});

describe('at-most-once for explicit-remote tickets', () => {
  it('records the remote task id BEFORE enqueueing, so a restart cannot lose the dispatch', async () => {
    const recorded: Array<{ ticketId: string; taskId: string }> = [];
    const order: string[] = [];
    const promise = dispatchExplicitRemoteTicket(ticket(), {
      recordDispatch: async (ticketId, taskId) => {
        order.push('record');
        recorded.push({ ticketId, taskId });
      },
    });
    // Let the record + enqueue happen, then complete the task so the await resolves.
    await new Promise((r) => setTimeout(r, 5));
    order.push('enqueue-observed');
    const taskId = String(hoisted.enqueued[0]?.env.taskId);
    hoisted.state.completed.set(taskId, { taskId, status: 'completed' });
    const result = await promise;

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.taskId).toBe(taskId);
    expect(order[0]).toBe('record');
    expect(result.success).toBe(true);
  });

  it('refuses to enqueue at all when the marker cannot be persisted', async () => {
    const result = await dispatchExplicitRemoteTicket(ticket(), {
      recordDispatch: async () => { throw new Error('db down'); },
    });
    expect(hoisted.enqueued).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('at-most-once');
  });

  it('adopts a completed prior dispatch instead of running the action again', async () => {
    hoisted.state.completed.set('ticket-1-prior', { taskId: 'ticket-1-prior', status: 'completed' });
    const result = await dispatchExplicitRemoteTicket(
      ticket({ metadata: { targetRemoteClientId: NODE, [EXPLICIT_REMOTE_TASK_ID_KEY]: 'ticket-1-prior' } }),
    );
    expect(hoisted.enqueued).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.taskId).toBe('ticket-1-prior');
  });

  it('adopts a FAILED prior dispatch rather than retrying an outward action', async () => {
    hoisted.state.completed.set('ticket-1-prior', { taskId: 'ticket-1-prior', status: 'failed', error: 'node said no' });
    const result = await dispatchExplicitRemoteTicket(
      ticket({ metadata: { targetRemoteClientId: NODE, [EXPLICIT_REMOTE_TASK_ID_KEY]: 'ticket-1-prior' } }),
    );
    expect(hoisted.enqueued).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toBe('node said no');
  });

  it('REFUSES when the prior dispatch outcome is unknown — the live double-send shape', async () => {
    // The restart wiped the in-memory registry: no completion, no in-flight record, but the node
    // may well have done the work. This is exactly the state that sent the message twice.
    const result = await dispatchExplicitRemoteTicket(
      ticket({ metadata: { targetRemoteClientId: NODE, [EXPLICIT_REMOTE_TASK_ID_KEY]: 'ticket-1-prior' } }),
    );
    expect(hoisted.enqueued).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already dispatched/i);
  });

  it('resumes waiting when the prior dispatch is still in flight', async () => {
    hoisted.state.inFlight.add('ticket-1-prior');
    const promise = dispatchExplicitRemoteTicket(
      ticket({ metadata: { targetRemoteClientId: NODE, [EXPLICIT_REMOTE_TASK_ID_KEY]: 'ticket-1-prior' } }),
    );
    await new Promise((r) => setTimeout(r, 5));
    hoisted.state.completed.set('ticket-1-prior', { taskId: 'ticket-1-prior', status: 'completed' });
    const result = await promise;
    expect(hoisted.enqueued).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('reads the marker only from structured metadata', () => {
    expect(priorRemoteTaskId(ticket())).toBeNull();
    expect(priorRemoteTaskId(ticket({ metadata: { [EXPLICIT_REMOTE_TASK_ID_KEY]: '  ' } }))).toBeNull();
    expect(priorRemoteTaskId(ticket({ metadata: { [EXPLICIT_REMOTE_TASK_ID_KEY]: 'abc' } }))).toBe('abc');
  });

  it('tells the node to perform outward actions exactly once', async () => {
    const promise = dispatchExplicitRemoteTicket(ticket());
    await new Promise((r) => setTimeout(r, 5));
    const taskId = String(hoisted.enqueued[0]?.env.taskId);
    hoisted.state.completed.set(taskId, { taskId, status: 'completed' });
    await promise;
    const prompt = String((hoisted.enqueued[0]?.env.input as any)?.arguments?.prompt ?? '');
    expect(prompt).toMatch(/EXACTLY ONCE/);
  });
});
