/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the explicit agentic-mode marker (BACKLOG "BYO / free-tier connections bypass the agentic loop"): options.toolLess / OSHAL_TOOL_LESS must drive processMessage routing, with the legacy !byoLlm derivation only when the marker is absent, and the direct path must surface toolLess: true on its response.
 */

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js') as {
  resolveToolLessMarker: (
    options: Record<string, unknown> | undefined,
    byoLlm: object | null,
  ) => boolean;
  prototype: {
    processMessage(
      taskId: string,
      userMessage: { text: string },
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
};

interface ControllerStub {
  taskStore: { saveTask(task: Record<string, unknown>): Promise<Record<string, unknown>> };
  messageStore: { saveMessage(taskId: string, message: Record<string, unknown>): Promise<void> };
  activeTasks: Map<string, Record<string, unknown>>;
  toolRegistry: Map<string, unknown>;
  stream: null;
  agenticController: object;
  agenticCalls: number;
  directCalls: number;
  processWithAgenticMode(taskId: string, userMessage: { text: string }, options: Record<string, unknown>): Promise<Record<string, unknown>>;
  processMessage: typeof TaskController.prototype.processMessage;
  _buildByoLlm(conn: unknown): object | null;
  llm: { generateResponse(): Promise<Record<string, unknown>> } | null;
}

const BYO_CONNECTION = { baseUrl: 'http://byo.example', apiKey: 'k', model: 'm' };

/**
 * Build a TaskController with everything stubbed EXCEPT the real processMessage
 * routing under test. The BYO builder is stubbed so no provider module (and no
 * network endpoint) is touched — the routing expression is what this guards.
 */
function makeController(): ControllerStub {
  const controller = Object.create(TaskController.prototype) as ControllerStub;
  const task = { id: 'task-marker', text: 'demo task', messages: [], apiMetrics: {} };
  controller.activeTasks = new Map([[task.id, task]]);
  controller.taskStore = { saveTask: async (saved) => saved };
  controller.messageStore = { saveMessage: async () => undefined };
  controller.toolRegistry = new Map();
  controller.stream = null;
  controller.agenticController = { sentinel: true };
  controller.agenticCalls = 0;
  controller.directCalls = 0;
  controller.processWithAgenticMode = async () => {
    controller.agenticCalls += 1;
    return { success: true, path: 'agentic' };
  };
  controller._buildByoLlm = (conn) => (conn
    ? {
      generateResponse: async () => {
        controller.directCalls += 1;
        return { content: 'byo answer', provider: 'byo', model: 'byo-model' };
      },
    }
    : null);
  controller.llm = {
    generateResponse: async () => {
      controller.directCalls += 1;
      return { content: 'direct answer', provider: 'stub', model: 'stub-model' };
    },
  };
  return controller;
}

describe('any-bot explicit agentic-mode marker', () => {
  const previousEnv = process.env.OSHAL_TOOL_LESS;

  beforeEach(() => {
    delete process.env.OSHAL_TOOL_LESS;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.OSHAL_TOOL_LESS;
    else process.env.OSHAL_TOOL_LESS = previousEnv;
  });

  describe('resolveToolLessMarker', () => {
    it('honors the explicit marker over everything, in both directions', () => {
      expect(TaskController.resolveToolLessMarker({ toolLess: true }, null)).toBe(true);
      expect(TaskController.resolveToolLessMarker({ toolLess: false }, {})).toBe(false);
      // String forms survive env-threaded callers.
      expect(TaskController.resolveToolLessMarker({ toolLess: 'true' }, null)).toBe(true);
      expect(TaskController.resolveToolLessMarker({ toolLess: 'false' }, {})).toBe(false);
      // Explicit marker beats the env default too.
      process.env.OSHAL_TOOL_LESS = 'true';
      expect(TaskController.resolveToolLessMarker({ toolLess: false }, {})).toBe(false);
    });

    it('uses the OSHAL_TOOL_LESS env default when the option is absent', () => {
      process.env.OSHAL_TOOL_LESS = 'true';
      expect(TaskController.resolveToolLessMarker({}, null)).toBe(true);
      process.env.OSHAL_TOOL_LESS = 'false';
      expect(TaskController.resolveToolLessMarker({}, {})).toBe(false);
    });

    it('falls back to the legacy BYO derivation when no marker is set', () => {
      expect(TaskController.resolveToolLessMarker({}, {})).toBe(true);
      expect(TaskController.resolveToolLessMarker({}, null)).toBe(false);
      expect(TaskController.resolveToolLessMarker(undefined, null)).toBe(false);
    });
  });

  describe('processMessage routing', () => {
    it('marker present true forces the tool-less direct path even without BYO', async () => {
      const controller = makeController();
      const result = await controller.processMessage('task-marker', { text: 'hello' }, { toolLess: true });
      expect(controller.agenticCalls).toBe(0);
      expect(controller.directCalls).toBe(1);
      expect(result).toMatchObject({ success: true, toolLess: true });
    });

    it('marker present false forces the agentic loop even with a BYO connection', async () => {
      const controller = makeController();
      const result = await controller.processMessage('task-marker', { text: 'hello' }, {
        toolLess: false,
        byoLlmConnection: BYO_CONNECTION,
      });
      expect(controller.agenticCalls).toBe(1);
      expect(controller.directCalls).toBe(0);
      expect(result).toMatchObject({ path: 'agentic' });
    });

    it('marker absent falls back to !byoLlm: BYO connection routes direct and is surfaced', async () => {
      const controller = makeController();
      const result = await controller.processMessage('task-marker', { text: 'hello' }, {
        byoLlmConnection: BYO_CONNECTION,
      });
      expect(controller.agenticCalls).toBe(0);
      expect(controller.directCalls).toBe(1);
      expect(result).toMatchObject({ success: true, toolLess: true, provider: 'byo' });
    });

    it('marker absent without BYO keeps the agentic loop', async () => {
      const controller = makeController();
      const result = await controller.processMessage('task-marker', { text: 'hello' }, {});
      expect(controller.agenticCalls).toBe(1);
      expect(controller.directCalls).toBe(0);
      expect(result).toMatchObject({ path: 'agentic' });
    });
  });
});
