/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard TS/JS canonical-ID parity, cross-platform hostile path encoding, TaskController force/ticket/parent containment, link/nonregular refusal, and remote-workspace downstream canonicalization.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalBotWorkspaceId } from '../../src/app/bot-node-request-scope';
import { toRemoteTaskEnvelope } from '../../src/app/routes/remote-client-mesh-task';
import { taskWorkspaceFolder } from '../../src/app/routes/remote-client-workspace-routes';

const requireModule = createRequire(import.meta.url);
const workspaceScope = requireModule('../../any-bot/server/services/codebase/task-workspace-scope.js') as {
  canonicalWorkspaceId(value: unknown): string;
  ensureTaskWorkspace(root: string, value: unknown): { taskId: string; workspaceDir: string; created: boolean };
};
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js') as {
  prototype: {
    createTask(text: string, mode?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
};
const anyBotConfig = requireModule('../../any-bot/server/utils/config.js') as {
  filesystem: { workspaceDir: string };
  gitlab: { enabled: boolean };
};

let root: string;
let outside: string;
let priorWorkspaceRoot: string;
let priorGitlabEnabled: boolean;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-scope-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-outside-'));
  priorWorkspaceRoot = anyBotConfig.filesystem.workspaceDir;
  priorGitlabEnabled = anyBotConfig.gitlab.enabled;
  anyBotConfig.filesystem.workspaceDir = root;
  anyBotConfig.gitlab.enabled = false;
});

afterEach(() => {
  anyBotConfig.filesystem.workspaceDir = priorWorkspaceRoot;
  anyBotConfig.gitlab.enabled = priorGitlabEnabled;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** Build the minimum real TaskController state used by createTask. */
function controllerHarness() {
  const tasks = new Map<string, Record<string, unknown>>();
  const controller = Object.create(TaskController.prototype) as Record<string, unknown> & {
    createTask: typeof TaskController.prototype.createTask;
  };
  controller.taskStore = {
    loadTask: async (id: string) => tasks.get(id) ?? null,
    saveTask: async (task: Record<string, unknown>) => { tasks.set(String(task.id), task); },
  };
  controller.messageStore = { saveMessage: async () => undefined };
  controller.activeTasks = new Map();
  controller.gitlabService = { createTaskProject: async () => ({ success: false }) };
  return controller;
}

/** True only when candidate is root or a descendant on this host. */
function isContained(rootPath: string, candidate: string): boolean {
  const relative = path.relative(fs.realpathSync(rootPath), fs.realpathSync(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Create a directory link without requiring Windows file-symlink privileges. */
function linkDirectory(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('canonical bot workspace IDs', () => {
  it('keeps portable IDs readable and encodes hostile or case-ambiguous values identically in TS and JS', () => {
    const values = [
      'safe-ticket_123', '..', '../escape', '..\\escape', '/absolute/path',
      'C:\\Windows\\System32', '\\\\server\\share\\task', 'Alpha', 'alpha', 'ALPHA',
      'unicode-工作', 'con', 'name/child', 'name\\child',
    ];
    for (const value of values) {
      const ts = canonicalBotWorkspaceId(value);
      const js = workspaceScope.canonicalWorkspaceId(value);
      expect(ts, value).toBe(js);
      expect(ts, value).toMatch(/^[a-z0-9][a-z0-9_-]{0,127}$/);
      expect(ts, value).not.toMatch(/[\\/]/);
    }
    expect(canonicalBotWorkspaceId('safe-ticket_123')).toBe('safe-ticket_123');
    expect(new Set(['Alpha', 'alpha', 'ALPHA'].map(canonicalBotWorkspaceId)).size).toBe(3);
  });

  it('rejects empty, control-bearing, malformed UTF-8, and oversized logical IDs in both runtimes', () => {
    const invalid = ['', 'bad\u0000id', 'bad\u0085id', '\ud800', 'x'.repeat(2_049), 42];
    for (const value of invalid) {
      expect(() => canonicalBotWorkspaceId(value), `TS ${String(value)}`).toThrow();
      expect(() => workspaceScope.canonicalWorkspaceId(value), `JS ${String(value)}`).toThrow();
    }
    expect(canonicalBotWorkspaceId('x'.repeat(2_048))).toMatch(/^scope-[a-f0-9]{64}$/);
  });
});

describe('TaskController workspace containment', () => {
  it('contains forceTaskId, ticketId, and child-ticket branches under real trusted roots', async () => {
    const controller = controllerHarness();
    const forced = await controller.createTask('forced', 'act', { forceTaskId: '../escape', userSub: 'owner-a' });
    const ticket = await controller.createTask('ticket', 'act', { ticketId: 'C:\\hostile\\ticket', userSub: 'owner-a' });
    const parent = workspaceScope.ensureTaskWorkspace(root, 'safe-parent');
    const child = await controller.createTask('child', 'act', {
      ticketId: '..\\child', parentWorkspaceDir: parent.workspaceDir, userSub: 'owner-a',
    });

    for (const task of [forced, ticket]) {
      expect(isContained(root, String(task.workspace_dir))).toBe(true);
      expect(path.basename(String(task.workspace_dir))).toBe(task.id);
    }
    expect(isContained(parent.workspaceDir, String(child.workspace_dir))).toBe(true);
    expect(path.basename(String(child.workspace_dir))).toBe(child.id);
    expect(fs.existsSync(path.join(outside, 'escape'))).toBe(false);
  });

  it('rejects outside, linked, and nonregular parent or task entries before reuse', async () => {
    const controller = controllerHarness();
    await expect(controller.createTask('outside child', 'act', {
      ticketId: 'child', parentWorkspaceDir: outside, userSub: 'owner-a',
    })).rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });

    const linkedParent = path.join(root, 'linked-parent');
    linkDirectory(outside, linkedParent);
    await expect(controller.createTask('linked child', 'act', {
      ticketId: 'child', parentWorkspaceDir: linkedParent, userSub: 'owner-a',
    })).rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });

    const linkedTask = path.join(root, 'linked-task');
    linkDirectory(outside, linkedTask);
    await expect(controller.createTask('linked force', 'act', {
      forceTaskId: 'linked-task', userSub: 'owner-a',
    })).rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });

    fs.writeFileSync(path.join(root, 'plain-file-task'), 'not a directory');
    await expect(controller.createTask('file force', 'act', {
      forceTaskId: 'plain-file-task', userSub: 'owner-a',
    })).rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });
  });

  it('rejects invalid or conflicting directives instead of falling through to a generated workspace', async () => {
    const controller = controllerHarness();
    const invalidOptions = [
      { forceTaskId: '' },
      { forceTaskId: null },
      { ticketId: '' },
      { ticketId: 'bad\u0000ticket' },
      { parentWorkspaceDir: root },
      { forceTaskId: 'force-id', ticketId: 'ticket-id' },
    ];
    for (const options of invalidOptions) {
      await expect(controller.createTask('invalid directive', 'act', options), JSON.stringify(options))
        .rejects.toMatchObject({ code: 'UNSAFE_TASK_WORKSPACE' });
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('remote workspace downstream canonicalization', () => {
  const baseEnvelope = {
    correlationId: 'remote-path-correlation',
    fromAgentId: 'controller',
    toAgentId: 'remote-node',
    channel: 'remote.client.remote-node',
    messageType: 'request' as const,
  };

  it('encodes embedded, swarm, explicit-intent, and route folder sources with one contract', () => {
    const embedded = toRemoteTaskEnvelope({ ...baseEnvelope, payload: { task: {
      taskId: 'embedded-task', intent: 'mcp.call-tool', input: {}, workspacePath: '../embedded',
    } } }, 'remote-node');
    const swarm = toRemoteTaskEnvelope({ ...baseEnvelope, payload: {
      text: 'run', workspaceTaskId: 'task-id', workspaceFolderId: 'C:\\swarm\\folder',
    } }, 'remote-node');
    const explicit = toRemoteTaskEnvelope({ ...baseEnvelope, payload: {
      intent: 'mcp.call-tool', input: {}, workspacePath: '\\\\server\\share\\folder',
    } }, 'remote-node');

    expect(embedded?.workspacePath).toBe(canonicalBotWorkspaceId('../embedded'));
    expect(swarm?.workspacePath).toBe(canonicalBotWorkspaceId('C:\\swarm\\folder'));
    expect(explicit?.workspacePath).toBe(canonicalBotWorkspaceId('\\\\server\\share\\folder'));
    expect(path.basename(taskWorkspaceFolder('../route')!)).toBe(canonicalBotWorkspaceId('../route'));
    expect(taskWorkspaceFolder('bad\u0000route')).toBeNull();
  });
});
