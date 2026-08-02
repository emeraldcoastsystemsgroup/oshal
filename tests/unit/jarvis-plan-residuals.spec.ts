/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the multi-app planner's honesty residuals: plan-decomposes-and-orders (the compiled node order matches the plan, and the user is SHOWN that order including which step pauses for approval), step-failure-does-not-fabricate-synthesis (an escalated plan reports a failure and is never handed to the completed-task summarizer), and chain-cost-lands-on-the-bot (each step is dispatched to the accountable bot node as a full task run, never answered in the controller).
 */

import { describe, it, expect } from 'vitest';
import {
  compilePlanToProcessDefinition,
  describePlan,
  extractPlanDirective,
  stripPlanDirective,
  type MultiAppPlan,
} from '@/features/swarm-orchestration';
import { EngineServicesAdapter } from '@/features/swarm-orchestration/services/engine-services-adapter';
import {
  jarvisFailureNoteForTicketStatus,
  mapJarvisTaskStatusFromTicketStatus,
} from '@/app/routes/jarvis-task-store';
import { maskPendingComplexSummaries } from '@/app/routes/jarvis-orchestrator';
import type { AppContext } from '@/app/composition/app-context';
import type { TicketService } from '@/features/ticketing';
import type { BotNodeClient } from '@/features/agent-management';
import type { EngineTicketContext } from '@/features/workflow-studio';

/** Inbox → draft → send: ordered, data-dependent, with one outward step. */
const plan: MultiAppPlan = {
  title: 'Inbox → post',
  steps: [
    { id: 'step1', app: 'email', agentId: 'agent-email', prompt: 'Summarize this morning\'s inbox.' },
    { id: 'step2', app: 'social', agentId: 'agent-social', prompt: 'Draft a LinkedIn post about: ${step1}' },
    { id: 'step3', app: 'social', agentId: 'agent-social', prompt: 'Publish: ${step2}', outward: true },
  ],
};

describe('plan-decomposes-and-orders', () => {
  it('compiles to the plan\'s own order, with the approval gate immediately before the outward step', () => {
    const nodes = compilePlanToProcessDefinition(plan).nodeGraph.nodes;
    expect(nodes.map((n) => n.type)).toEqual([
      'start', 'plan-step', 'plan-step', 'approval-gate', 'plan-step', 'deliver',
    ]);
    // Each step keeps its own bot binding and output variable, in plan order.
    expect(nodes.slice(1, 3).map((n) => (n.config as Record<string, unknown>).outputVar)).toEqual(['step1', 'step2']);
    expect((nodes[4].config as Record<string, unknown>).outputVar).toBe('step3');
  });

  it('SHOWS the user the plan: numbered, app-named, in order, flagging the step that will ask first', () => {
    const shown = describePlan(plan);
    expect(shown).toContain('3 steps');
    expect(shown).toContain('1. **email**');
    expect(shown).toContain('2. **social**');
    expect(shown).toContain('3. **social**');
    expect(shown.indexOf('1. **email**')).toBeLessThan(shown.indexOf('2. **social**'));
    // Exactly one step announces the approval pause — the outward one, and only it.
    expect(shown.match(/I'll ask you before this one runs/g)).toHaveLength(1);
    expect(shown.split('\n').find((line) => line.startsWith('3.'))).toContain('I\'ll ask you before this one runs');
    expect(shown.split('\n').find((line) => line.startsWith('1.'))).not.toContain('I\'ll ask you before this one runs');
    // The control channel is never shown to the user.
    expect(shown).not.toContain('oshal:plan');
    expect(describePlan({ title: 'empty', steps: [] })).toBe('');
  });

  it('the ack the surface renders carries the plan, and no control syntax', () => {
    const reply = 'On it.\n```oshal:plan\n' + JSON.stringify(plan) + '\n```';
    const parsed = extractPlanDirective(reply);
    expect(parsed).not.toBeNull();
    const ack = [stripPlanDirective(reply), describePlan(parsed as MultiAppPlan)].filter(Boolean).join('\n\n');
    expect(ack.startsWith('On it.')).toBe(true);
    expect(ack).toContain('Here\'s the plan (3 steps):');
    expect(ack).not.toContain('```');
  });
});

describe('step-failure-does-not-fabricate-synthesis', () => {
  it('an escalated plan ticket lands as an error with an honest note — never a summary', () => {
    expect(mapJarvisTaskStatusFromTicketStatus('escalated')).toBe('error');
    const note = jarvisFailureNoteForTicketStatus('escalated');
    expect(note).toBeTruthy();
    expect(String(note)).toContain('did not finish');
    expect(String(note)).toContain('Nothing was made up');
    expect(jarvisFailureNoteForTicketStatus('cancelled')).toContain('cancelled');
    // A healthy terminal status must NOT get a failure note.
    expect(jarvisFailureNoteForTicketStatus('complete')).toBeNull();
    expect(jarvisFailureNoteForTicketStatus('in_process')).toBeNull();
  });

  it('the completed-task summarizer is never fired for a failed run', async () => {
    const fired: string[] = [];
    const ctx = {
      pool: { query: async () => ({ rowCount: 1, rows: [{ id: 'task-1' }] }) },
    } as unknown as AppContext;
    const tasks: Array<{
      id: string; title: string; status: string; result: string | null; kind: string; ticketId: string | null;
    }> = [
      { id: 'task-1', title: 'Inbox → post', status: 'error', result: null, kind: 'complex', ticketId: 'ticket-1' },
      { id: 'task-2', title: 'Something that worked', status: 'done', result: null, kind: 'complex', ticketId: 'ticket-2' },
    ];

    await maskPendingComplexSummaries(
      ctx, 'auth0|owner-1', tasks,
      async (_ctx: AppContext, _sub: string, taskId: string) => { fired.push(taskId); },
    );

    // Only the genuinely-completed task is summarized. The failed one keeps its error state, so
    // the model is never asked to narrate an outcome that does not exist.
    expect(fired).toEqual(['task-2']);
    expect(tasks[0].status).toBe('error');
    expect(tasks[0].result).toBeNull();
    expect(tasks[1].status).toBe('summarizing');
  });
});

describe('chain-cost-lands-on-the-bot', () => {
  // Shaped exactly as ProcessDefinitionExecutionEngine.buildTicketContext emits it: the adapter
  // reads the ticket id out of `raw`, falling back to externalId — not off a bare `ticketId` field.
  const ticket: EngineTicketContext = {
    externalId: 'ticket-plan-1',
    title: 'Inbox → post',
    body: 'Summarize the inbox, draft a post, publish it.',
    labels: [],
    provider: 'direct',
    depth: 0,
    raw: { ticketId: 'ticket-plan-1', title: 'Inbox → post' },
  };
  const ticketService = { updateStatus: async () => undefined } as unknown as TicketService;

  it('each step is dispatched to the step\'s accountable bot node, carrying the substituted prompt', async () => {
    const calls: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
    const botNodeClient = {
      async execute(agentId: string, payload: Record<string, unknown>) {
        calls.push({ agentId, payload });
        return { success: true, response: `REPLY[${agentId}]` };
      },
    } as unknown as BotNodeClient;

    const adapter = new EngineServicesAdapter({ botNodeClient, ticketService });
    const result = await adapter.dispatchAgentPrompt(ticket, {
      agentId: 'agent-social',
      prompt: 'Draft a LinkedIn post about: yesterday\'s inbox',
      workType: 'plan-step',
    });

    // The CALL is the assertion: the bot node ran it, so recordCost writes chat_tasks under that
    // bot's agent_id. A controller-side shortcut would leave `calls` empty and fail here.
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('agent-social');
    expect(calls[0].payload.agentId).toBe('agent-social');
    expect(calls[0].payload.text).toContain('Draft a LinkedIn post');
    expect(calls[0].payload.taskId).toBe('ticket-plan-1');
    expect(result).toEqual({ dispatched: true, response: 'REPLY[agent-social]', agentId: 'agent-social' });
  });

  it('resolves a bot bound by app name before dispatching — the step still runs on a real bot', async () => {
    const calls: string[] = [];
    const botNodeClient = {
      async execute(agentId: string) {
        calls.push(agentId);
        return { success: true, response: 'ok' };
      },
    } as unknown as BotNodeClient;
    const adapter = new EngineServicesAdapter({
      botNodeClient,
      ticketService,
      resolveAgentIdByName: async (name) => (name === 'email' ? 'agent-email' : undefined),
    });

    const result = await adapter.dispatchAgentPrompt(ticket, { agentBinding: 'email', prompt: 'Summarize.' });
    expect(calls).toEqual(['agent-email']);
    expect(result.agentId).toBe('agent-email');
  });

  it('an unresolvable bot fails honestly — no dispatch, no response, no invented answer', async () => {
    const botNodeClient = {
      async execute() { throw new Error('the controller must not answer a plan step itself'); },
    } as unknown as BotNodeClient;
    const adapter = new EngineServicesAdapter({ botNodeClient, ticketService });

    const result = await adapter.dispatchAgentPrompt(ticket, { prompt: 'Do the thing.' });
    expect(result.dispatched).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.reason).toBe('no bot resolved');
  });
});
