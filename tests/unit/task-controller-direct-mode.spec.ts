/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for INSTALLER-GAPS G12: processMessage with agenticMode:false on an agentic-only node (AgenticController present, no provider implementing generateResponse) used to pass the `activeLlm || agenticController` truthiness check and then throw "activeLlm.generateResponse is not a function" mid-request. It must now return a structured, actionable rejection — and the legacy "LLM service not configured" stub path for nodes with NO engine at all must stay byte-compatible (success:true + stub text), because callers depend on that shape.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin trusted direct-call metadata propagation: the protected single-shot marker, dispatch source and runtime-supplied agent identity must reach the selected provider alongside an explicitly empty enforced tool boundary.
 */

import { createRequire } from 'module';
import { describe, it, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TaskController = require('../../any-bot/server/controllers/TaskController');

interface FakeTask {
  id: string;
  text: string;
  status?: string;
  messages: Array<Record<string, unknown>>;
}

/** A prototype-backed controller with only the collaborators processMessage touches. */
function makeController(task: FakeTask, opts: { agentic: boolean; llm: unknown }) {
  const controller = Object.create(TaskController.prototype);
  controller.getTask = async () => task;
  controller.updateTask = async (_id: string, updates: Record<string, unknown>) => Object.assign(task, updates);
  controller.messageStore = { saveMessage: async () => undefined };
  controller.stream = null;
  controller.llm = opts.llm;
  controller.agenticController = opts.agentic ? {} : null;
  controller.toolRegistry = { getAll: () => [], capture: () => null, isSnapshotCurrent: () => true };
  return controller;
}

describe('TaskController direct (non-agentic) path (INSTALLER-GAPS G12)', () => {
  it('rejects agenticMode:false on an agentic-only node with a structured error, not a TypeError', async () => {
    const task: FakeTask = { id: 't1', text: 'demo', messages: [] };
    const controller = makeController(task, { agentic: true, llm: {} });

    const result = await controller.processMessage('t1', { text: 'hello there' }, { agenticMode: false });

    expect(result.success).toBe(false);
    expect(result.error).toBe('direct_mode_unsupported');
    expect(String(result.message?.text)).toContain('agenticMode:true');
    expect(task.status).toBe('error');
  });

  it('keeps the legacy "LLM service not configured" stub when the node has NO engine at all', async () => {
    const task: FakeTask = { id: 't2', text: 'demo', messages: [] };
    const controller = makeController(task, { agentic: false, llm: null });

    const result = await controller.processMessage('t2', { text: 'hello there' }, { agenticMode: false });

    expect(result.success).toBe(true);
    expect(String(result.message?.text)).toContain('LLM service not configured');
  });

  it('forwards the protected single-shot marker and trusted routing metadata to the direct provider', async () => {
    const task: FakeTask = { id: 't3', text: 'demo', messages: [] };
    let providerOptions: Record<string, unknown> | undefined;
    const assertCurrentAuthorization = vi.fn(async () => undefined);
    const toolBridge = {
      agentId: 'trusted-runtime-agent',
      taskId: 'protected-task',
      userSub: 'protected-user',
      applicationExecutionId: 'protected-execution',
      applicationExecutionToken: 'signed-protected-token',
    };
    const controller = makeController(task, { agentic: true, llm: {
      generateResponse: async (_messages: unknown, options: Record<string, unknown>) => {
        providerOptions = options;
        return { content: 'one answer', provider: 'cline-cli', model: 'gemini-fixture' };
      },
    } });

    const result = await controller.processMessage('t3', { text: 'reason once' }, {
      agenticMode: false,
      toolLess: true,
      singleShotToolless: true,
      source: 'swarm-dispatch',
      agentId: 'trusted-runtime-agent',
      allowedTools: [],
      authorizedScopes: [],
      assertCurrentAuthorization,
      toolBridge,
    });

    expect(result.success).toBe(true);
    expect(providerOptions).toMatchObject({
      singleShotToolless: true,
      protectedSingleShotVerified: true,
      source: 'swarm-dispatch',
      agentId: 'trusted-runtime-agent',
      tools: [],
      enforceToolBoundary: true,
    });
    expect(assertCurrentAuthorization).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing authorization closure', { assertCurrentAuthorization: undefined }],
    ['nonempty original authority', { allowedTools: ['read_file'] }],
    ['mismatched runtime identity', { agentId: 'different-runtime-agent' }],
  ])('rejects a raw single-shot marker with %s before provider use', async (_label, override) => {
    const task: FakeTask = { id: 't4', text: 'demo', messages: [] };
    const generateResponse = vi.fn(async () => ({ content: 'must not run' }));
    const controller = makeController(task, { agentic: true, llm: { generateResponse } });
    const options = {
      agenticMode: false,
      toolLess: true,
      singleShotToolless: true,
      source: 'swarm-dispatch',
      agentId: 'trusted-runtime-agent',
      allowedTools: [],
      authorizedScopes: [],
      assertCurrentAuthorization: vi.fn(async () => undefined),
      toolBridge: {
        agentId: 'trusted-runtime-agent',
        taskId: 'protected-task',
        userSub: 'protected-user',
        applicationExecutionId: 'protected-execution',
        applicationExecutionToken: 'signed-protected-token',
      },
      ...override,
    };

    await expect(controller.processMessage('t4', { text: 'reason once' }, options))
      .rejects.toMatchObject({ code: 'DIRECT_REASONING_BOUNDARY_INVALID' });
    expect(generateResponse).not.toHaveBeenCalled();
  });
});
