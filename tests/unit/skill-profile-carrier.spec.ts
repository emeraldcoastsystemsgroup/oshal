/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 skill-profile GENERAL carrier guard (BACKLOG general-carrier item). Proves the carrier end-to-end at its three seams: (1) INLINE path — executeBotOrInline weaves the app's resolved profile into the text handed to processMessage; (2) REMOTE path — executeBotOrInline sets request.pattern (rides to the bot node) and leaves request.text untouched; (3) bot-node-execution-handler appends payload.pattern to the assembled prompt in BOTH the LAYERED branch (after persona assembly — which never reads payload.text, the whole reason the carrier exists) AND the direct/verbatim branch. Also asserts the no-app no-op. This spec cannot compile/pass against pre-change code: BotNodeRequest had no app/capability/pattern and neither injection site existed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the task-controller bridge parameter to anyBotTaskController: the identifier still carried the retired pre-OSHAL product name, contradicting the rename rollout the docs describe. Pure rename, no behavior change.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import { createBotNodeExecutionHandler } from '@/app/bot-node-execution-handler';
import type { BotNodeRequest, BotNodeResponse, MeshEnvelope } from '@/features/agent-management';
import {
  registerAppSkillProfiles,
  unregisterAppSkillProfiles,
  composeSkillProfilePrompt,
  type SkillProfile,
} from '@/shared/skill-profiles';

const APP = 'demo-carrier-app';
const PROFILE: SkillProfile = {
  pattern: 'class-notes',
  instructions: 'Extract key concepts and homework for a K-12 student.',
  sections: ['key-concepts', 'homework'],
};

/** The exact block the controller resolves for this app+capability — the substance the carrier ships. */
const RESOLVED_BLOCK = composeSkillProfilePrompt('', 'summarize', PROFILE);

afterEach(() => unregisterAppSkillProfiles(APP));

/**
 * @description An AppContext stub whose pool throws — the real BudgetService then fails OPEN
 * (loadMatchingBudgets → catch → null → allowed), so the budget gate never blocks the test.
 */
function ctxWith(processMessage: (taskId: string, text: string, opts: unknown) => Promise<unknown>) {
  return {
    pool: { query: async () => { throw new Error('no-db-in-unit-test'); } },
    orchestrator: { processMessage },
  } as never;
}

/** A request carrying the general skill-profile carrier keys (app + capability). */
function carrierRequest(overrides: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'Summarize the notes.',
    taskId: 'demo-carrier-summary-user1',
    workspaceFolderId: 'demo-carrier-user1',
    agentId: 'demo-bot',
    agenticMode: true,
    direct: true,
    userSub: 'user1',
    app: APP,
    capability: 'summarize',
    ...overrides,
  };
}

describe('skill-profile general carrier — INLINE path (executeBotOrInline → processMessage)', () => {
  it('weaves the resolved profile into the text handed to the inline orchestrator', async () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-carrier', profiles: { summarize: PROFILE } });
    let capturedText = '';
    const ctx = ctxWith(async (_taskId, text) => {
      capturedText = text;
      return { success: true, response: 'ok', usageSummary: { inputTokens: 1, outputTokens: 1, totalTokens: 2, totalCost: 0, byModel: {} } };
    });
    const botClient = {
      hasEndpoint: () => false, // force the inline path
      execute: async () => { throw new Error('execute must not run on the inline path'); },
    } as never;

    await executeBotOrInline(ctx, botClient, 'demo-bot', carrierRequest());

    expect(capturedText).toContain('Summarize the notes.');        // original prompt preserved
    expect(capturedText).toContain('class-notes');                 // the app's domain pattern
    expect(capturedText).toContain('Extract key concepts and homework'); // its instructions
  });

  it('is a no-op when the call carries no app/capability (scoped carrier)', async () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-carrier', profiles: { summarize: PROFILE } });
    let capturedText = '';
    const ctx = ctxWith(async (_taskId, text) => {
      capturedText = text;
      return { success: true, response: 'ok', usageSummary: { totalCost: 0, byModel: {} } };
    });
    const botClient = { hasEndpoint: () => false, execute: async () => { throw new Error('nope'); } } as never;

    await executeBotOrInline(ctx, botClient, 'demo-bot', carrierRequest({ app: undefined, capability: undefined }));

    expect(capturedText).toBe('Summarize the notes.'); // untouched — no profile woven in
  });
});

describe('skill-profile general carrier — REMOTE path (executeBotOrInline → BotNodeClient.execute)', () => {
  it('sets request.pattern (rides to the bot node) and leaves request.text untouched', async () => {
    registerAppSkillProfiles({ appName: APP, ticketType: 'demo-carrier', profiles: { summarize: PROFILE } });
    let captured: BotNodeRequest | undefined;
    const botClient = {
      hasEndpoint: () => true, // force the remote path
      execute: async (_agentId: string, req: BotNodeRequest): Promise<BotNodeResponse> => {
        captured = req;
        return {
          success: true, response: 'ok',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: 0, model: 'm', provider: 'p', durationMs: 1,
        };
      },
    } as never;

    const request = carrierRequest();
    await executeBotOrInline(ctxWith(async () => ({ success: true })), botClient, 'demo-bot', request);

    expect(typeof captured?.pattern).toBe('string');
    expect(captured?.pattern).toContain('class-notes');
    expect(captured?.pattern).toContain('Extract key concepts and homework');
    // The remote path ships the block on its own field — it must NOT weave it into text.
    expect(captured?.text).toBe('Summarize the notes.');
  });

  it('does not set request.pattern when no app/capability is present', async () => {
    let captured: BotNodeRequest | undefined;
    const botClient = {
      hasEndpoint: () => true,
      execute: async (_agentId: string, req: BotNodeRequest): Promise<BotNodeResponse> => {
        captured = req;
        return { success: true, response: 'ok', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0, model: 'm', provider: 'p', durationMs: 1 };
      },
    } as never;

    await executeBotOrInline(ctxWith(async () => ({ success: true })), botClient, 'demo-bot', carrierRequest({ app: undefined, capability: undefined }));

    expect(captured?.pattern).toBeUndefined();
  });
});

describe('skill-profile general carrier — bot-node-execution-handler appends payload.pattern', () => {
  /** A handler over a fake any-bot TaskController that records the prompt text it receives. */
  function handlerCapturing(): { run: (env: MeshEnvelope) => Promise<unknown>; text: () => string } {
    let capturedHandlerText = '';
    const anyBotTaskController = {
      getTask: async () => null,
      createTask: async (_t: string, _m: string, opts?: { forceTaskId?: string }) => ({ id: opts?.forceTaskId ?? 'task-x' }),
      processMessage: async (_taskId: string, msg: { text: string }) => {
        capturedHandlerText = msg.text;
        return { messages: [{ say: 'completion_result', text: 'done' }], apiMetrics: { totalCost: 0, totalTokens: 0 }, provider: 'p', model: 'm' };
      },
    };
    const run = createBotNodeExecutionHandler({ anyBotTaskController, providerName: 'p', modelName: 'm' } as never);
    return { run, text: () => capturedHandlerText };
  }

  it('appends the pattern in the LAYERED branch — after persona/user-message assembly (which never reads payload.text)', async () => {
    const h = handlerCapturing();
    const envelope: MeshEnvelope = {
      correlationId: 'corr-1',
      fromAgentId: 'controller',
      toAgentId: 'demo-bot',
      channel: 'oshal:mesh:agent.demo-bot',
      payload: {
        externalId: 'DEMO-CARRIER-1',
        text: 'Summarize the ZEBRA-MARKER quarterly notes.',
        pattern: RESOLVED_BLOCK,
      },
    };

    const result = await h.run(envelope);
    const text = h.text();

    expect((result as { success: boolean }).success).toBe(true);
    // Layered-only framing proves we did NOT take the verbatim branch:
    expect(text).toContain('WORKSPACE RULES');
    expect(text).toContain('ZEBRA-MARKER'); // envelope's user message was assembled
    // The carrier's block was appended to that assembly, AFTER it:
    expect(text).toContain('class-notes');
    expect(text.indexOf('class-notes')).toBeGreaterThan(text.indexOf('WORKSPACE RULES'));
  });

  it('appends the pattern in the direct/verbatim branch too', async () => {
    const h = handlerCapturing();
    const envelope: MeshEnvelope = {
      correlationId: 'corr-2',
      fromAgentId: 'controller',
      toAgentId: 'demo-bot',
      channel: 'oshal:mesh:agent.demo-bot',
      payload: {
        externalId: 'DEMO-CARRIER-2',
        direct: true,
        text: 'Summarize the DIRECT-MARKER notes.',
        pattern: RESOLVED_BLOCK,
      },
    };

    await h.run(envelope);
    const text = h.text();

    expect(text).toContain('DIRECT-MARKER');   // verbatim text
    expect(text).toContain('class-notes');     // pattern appended
    expect(text).not.toContain('WORKSPACE RULES'); // verbatim branch adds no layered framing
  });
});
