/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the tools_name_key boot-error fix: existence checks use getToolByName (getAllTools pages at LIMIT 100, so past-first-page tools looked missing and re-inserts aborted seeding), and seeding tolerates the concurrent-container 23505 race without aborting the loop.
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolRegistryService } from '../../src/features/tool-registry/services/tool-registry-service';
import { TOOL_REGISTRY_BASELINE_TOOLS } from '../../src/features/tool-registry/services/tool-registry-baseline-tools';
import { TOOL_REGISTRY_PERSONA_TOOLS } from '../../src/features/tool-registry/services/tool-registry-persona-tools';

const ALL_SEED_NAMES = [...TOOL_REGISTRY_BASELINE_TOOLS, ...TOOL_REGISTRY_PERSONA_TOOLS].map(
  (t) => t.name,
);

const fakeTool = (name: string) => ({ toolId: `id-${name}`, name } as any);

const makeLogger = () => ({ info: vi.fn(), error: vi.fn() });

describe('tool-registry seeding idempotency (tools_name_key boot error)', () => {
  it('registerTool detects a duplicate by exact name lookup, not a paged getAllTools scan', async () => {
    // Simulates the >100-row table: getAllTools returns a first page WITHOUT 'yq',
    // while the row exists — the old scan-based check inserted and died on 23505.
    const repo: any = {
      getAllTools: vi.fn().mockResolvedValue([fakeTool('not-yq')]),
      getToolByName: vi.fn().mockResolvedValue(fakeTool('yq')),
      createTool: vi.fn(),
    };
    const service = new ToolRegistryService(repo, makeLogger());

    await expect(service.registerTool({ name: 'yq' } as any)).rejects.toThrow(/already exists/);
    expect(repo.createTool).not.toHaveBeenCalled();
  });

  it('seeds only the missing tool and reports every seed name', async () => {
    const repo: any = {
      getAllTools: vi.fn().mockResolvedValue([]),
      getToolByName: vi
        .fn()
        .mockImplementation(async (name: string) => (name === 'yq' ? null : fakeTool(name))),
      createTool: vi.fn().mockImplementation(async (input: any) => fakeTool(input.name)),
    };
    const service = new ToolRegistryService(repo, makeLogger());

    const registered = await service.seedBaselineAgentTools();

    expect(repo.createTool).toHaveBeenCalledTimes(1);
    expect(repo.createTool.mock.calls[0][0].name).toBe('yq');
    expect(registered).toEqual(ALL_SEED_NAMES);
  });

  it('losing the concurrent-container insert race (23505) does not abort the seed loop', async () => {
    const pgDuplicate = Object.assign(
      new Error('duplicate key value violates unique constraint "tools_name_key"'),
      { code: '23505' },
    );
    const repo: any = {
      getAllTools: vi.fn().mockResolvedValue([]),
      getToolByName: vi
        .fn()
        .mockImplementation(async (name: string) => (name === 'yq' ? null : fakeTool(name))),
      createTool: vi.fn().mockRejectedValue(pgDuplicate),
    };
    const service = new ToolRegistryService(repo, makeLogger());

    const registered = await service.seedBaselineAgentTools();

    // The racing insert failed, but seeding completed and every name is accounted for.
    expect(registered).toEqual(ALL_SEED_NAMES);
  });

  it('a non-duplicate database error still aborts seeding', async () => {
    const hardFailure = Object.assign(new Error('connection terminated'), { code: '57P01' });
    const repo: any = {
      getAllTools: vi.fn().mockResolvedValue([]),
      getToolByName: vi
        .fn()
        .mockImplementation(async (name: string) => (name === 'yq' ? null : fakeTool(name))),
      createTool: vi.fn().mockRejectedValue(hardFailure),
    };
    const service = new ToolRegistryService(repo, makeLogger());

    await expect(service.seedBaselineAgentTools()).rejects.toThrow('connection terminated');
  });
});
