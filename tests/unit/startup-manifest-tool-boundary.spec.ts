/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: cross the real startup-adapter-to-ToolRegistry boundary to prove sanitized trusted context survives manifest wrapping and undeclared/conflicting approval policy fails closed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireModule = createRequire(import.meta.url);
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry.js');
const {
  manifestToolRequiresApproval,
  registerManifestTool,
  wrapManifestToolHandler,
} = requireModule('../../any-bot/server/app-modules/startup-swarm-runtime.js');

describe('startup manifest tool security boundary', () => {
  let workspaceRoot: string;
  let previousWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-startup-tool-'));
    previousWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = workspaceRoot;
  });

  afterEach(() => {
    if (previousWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspaceDir;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes the ToolRegistry-sanitized identity and workspace into a real manifest handler', async () => {
    const toolRegistry = new ToolRegistry();
    const implementation = vi.fn(async (_params: unknown, context: unknown) => context);
    const handler = wrapManifestToolHandler('context-proof', implementation);
    registerManifestTool({ toolRegistry }, {
      name: 'context-proof',
      requiresApproval: false,
    }, handler);

    const result = await toolRegistry.execute('context-proof', { selected: true }, {
      taskWorkspace: workspaceRoot,
      extraEnv: { OSHAL_USER_SUB: ' owner-a ', PATH: '/model/chosen/bin' },
    });

    expect(implementation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      taskWorkspace: workspaceRoot,
      extraEnv: { OSHAL_USER_SUB: ' owner-a ' },
    });
    expect((result as { extraEnv: Record<string, string> }).extraEnv).not.toHaveProperty('PATH');
  });

  it('requires approval when policy is absent, malformed, true, or conflicting', async () => {
    expect(manifestToolRequiresApproval({})).toBe(true);
    expect(manifestToolRequiresApproval({ requiresApproval: 'false' })).toBe(true);
    expect(manifestToolRequiresApproval({ requires_approval: true })).toBe(true);
    expect(manifestToolRequiresApproval({
      requiresApproval: false,
      requires_approval: true,
    })).toBe(true);

    const toolRegistry = new ToolRegistry();
    const implementation = vi.fn(async () => ({ executed: true }));
    registerManifestTool({ toolRegistry }, { name: 'default-gated' }, implementation);

    await expect(toolRegistry.execute('default-gated', {}, {
      taskWorkspace: workspaceRoot,
      extraEnv: { OSHAL_USER_SUB: 'owner-a' },
    })).rejects.toThrow("requires approval before execution");
    expect(implementation).not.toHaveBeenCalled();
  });

  it('honors an exact false declaration consistently in both registration facades', async () => {
    const toolRegistry = new ToolRegistry();
    const taskController = { registerTool: vi.fn() };
    const implementation = vi.fn(async () => ({ executed: true }));
    const metadata = registerManifestTool({ toolRegistry, taskController }, {
      name: 'explicit-read-only',
      requires_approval: false,
      timeout: 12345,
    }, implementation);

    expect(metadata).toEqual({ requiresApproval: false, timeout: 12345 });
    expect(toolRegistry.getMetadata('explicit-read-only')).toMatchObject({
      requiresApproval: false,
      timeout: 12345,
    });
    expect(taskController.registerTool).toHaveBeenCalledWith(
      'explicit-read-only',
      implementation,
      expect.objectContaining({ requiresApproval: false, timeout: 12345 }),
    );
  });
});
