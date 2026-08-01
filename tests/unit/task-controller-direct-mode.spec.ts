/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for INSTALLER-GAPS G12: processMessage with agenticMode:false on an agentic-only node (AgenticController present, no provider implementing generateResponse) used to pass the `activeLlm || agenticController` truthiness check and then throw "activeLlm.generateResponse is not a function" mid-request. It must now return a structured, actionable rejection — and the legacy "LLM service not configured" stub path for nodes with NO engine at all must stay byte-compatible (success:true + stub text), because callers depend on that shape.
 */

import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

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
});
