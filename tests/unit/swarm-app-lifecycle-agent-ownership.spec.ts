/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | P8 lifecycle ownership regressions: metadata-only concierge associations are never toggled, while the legacy no-bots workflow worker remains lifecycle-owned even when chatBot names another agent; worker name lookup is duplicate-row deterministic.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Cover the mixed Social shape: activation reconciles both declared bots and a distinct external workflow worker, without turning a borrowed chatBot into lifecycle ownership.
 */

import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SwarmAppService } from '@/features/swarm-apps';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';
const DECLARED_ID = '33333333-3333-3333-3333-333333333333';

type Status = 'active' | 'inactive';

function recordFor(manifest: SwarmAppManifest, agentIds: string[], status: Status = 'active') {
  return {
    appId: `app-${manifest.name}`,
    name: manifest.name,
    displayName: manifest.displayName,
    description: '',
    version: '1.0.0',
    status,
    manifestPath: resolve('tests/fixtures/swarm-apps/oshal-app.yaml'),
    agentIds,
    toolNames: [],
    manifest,
    scope: 'public',
    ownerSub: null,
    tenantId: null,
    guestTierApproved: null,
    loadedAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function harness(
  manifest: SwarmAppManifest,
  agentIds: string[],
  agentsByName: Record<string, string> = {},
  status: Status = 'active',
) {
  const record = recordFor(manifest, agentIds, status);
  const repo = {
    findByName: vi.fn(async (name: string) => name === record.name ? record : null),
    updateStatus: vi.fn(async (name: string, status: Status) => {
      if (name !== record.name) return null;
      record.status = status;
      return record;
    }),
    list: vi.fn(async () => [record]),
  };
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM agents WHERE name/.test(sql)) {
      const agentId = agentsByName[String(params?.[0] ?? '')];
      return { rows: agentId ? [{ agent_id: agentId }] : [], rowCount: agentId ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const updateAgentStatus = vi.fn(async () => undefined);
  const service = new SwarmAppService(
    { query } as never,
    repo as never,
    { updateAgentStatus } as never,
  );

  return { service, query, updateAgentStatus };
}

describe('SwarmAppService lifecycle agent ownership', () => {
  it('does not deactivate a borrowed metadata-only chatBot associated with a surfaced app', async () => {
    const manifest = {
      name: 'surface-borrower',
      displayName: 'Surface Borrower',
      chatBot: 'shared-advisor',
      ui: {
        static: [{ toolName: 'home', label: 'Home', icon: 'i', iframeUrl: '/home' }],
      },
    } as SwarmAppManifest;
    const { service, query, updateAgentStatus } = harness(
      manifest,
      [CHAT_ID],
      { 'shared-advisor': CHAT_ID },
    );

    await service.toggleApp(manifest.name, false);

    expect(updateAgentStatus).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not deactivate a member-owned chatBot borrowed by a group', async () => {
    const manifest = {
      name: 'knowledge-group',
      displayName: 'Knowledge Group',
      kind: 'group',
      chatBot: 'member-concierge',
      dependencies: { apps: ['member-app'] },
    } as SwarmAppManifest;
    const { service, query, updateAgentStatus } = harness(
      manifest,
      [CHAT_ID],
      { 'member-concierge': CHAT_ID },
    );

    await service.toggleApp(manifest.name, false);

    expect(updateAgentStatus).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('continues to deactivate the legacy workflow worker when a manifest declares no bots', async () => {
    const manifest = {
      name: 'legacy-worker-app',
      displayName: 'Legacy Worker App',
      workflow: {
        name: 'Legacy Flow',
        pipeline: 'legacy-flow',
        workerBot: 'legacy-worker',
      },
    } as SwarmAppManifest;
    const { service, query, updateAgentStatus } = harness(
      manifest,
      [WORKER_ID],
      { 'legacy-worker': WORKER_ID },
    );

    await service.toggleApp(manifest.name, false);

    expect(query).toHaveBeenCalledWith(
      'SELECT agent_id FROM agents WHERE name = $1 ORDER BY agent_id LIMIT 1',
      ['legacy-worker'],
    );
    expect(updateAgentStatus).toHaveBeenCalledTimes(1);
    expect(updateAgentStatus).toHaveBeenCalledWith(WORKER_ID, 'inactive');
  });

  it('deactivates only the worker when explicit chatBot and workflow.workerBot differ', async () => {
    const manifest = {
      name: 'split-concierge-worker',
      displayName: 'Split Concierge Worker',
      chatBot: 'shared-advisor',
      workflow: {
        name: 'Split Flow',
        pipeline: 'split-flow',
        workerBot: 'owned-worker',
      },
    } as SwarmAppManifest;
    const { service, query, updateAgentStatus } = harness(
      manifest,
      [CHAT_ID, WORKER_ID],
      { 'shared-advisor': CHAT_ID, 'owned-worker': WORKER_ID },
    );

    await service.toggleApp(manifest.name, false);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT agent_id FROM agents WHERE name = $1 ORDER BY agent_id LIMIT 1',
      ['owned-worker'],
    );
    expect(updateAgentStatus).toHaveBeenCalledTimes(1);
    expect(updateAgentStatus).toHaveBeenCalledWith(WORKER_ID, 'inactive');
    expect(updateAgentStatus).not.toHaveBeenCalledWith(CHAT_ID, expect.anything());
  });

  it('activates both a declared bot and a distinct external workflow worker', async () => {
    const manifest = {
      name: 'mixed-worker-app',
      displayName: 'Mixed Worker App',
      chatBot: 'shared-advisor',
      workflow: {
        name: 'Mixed Flow',
        pipeline: 'mixed-flow',
        workerBot: 'external-worker',
      },
      bots: [{ agentId: DECLARED_ID, name: 'declared-bot' }],
    } as SwarmAppManifest;
    const { service, query, updateAgentStatus } = harness(
      manifest,
      [WORKER_ID, DECLARED_ID, CHAT_ID],
      { 'external-worker': WORKER_ID, 'shared-advisor': CHAT_ID },
      'inactive',
    );

    await service.toggleApp(manifest.name, true);

    expect(query).toHaveBeenCalledWith(
      'SELECT agent_id FROM agents WHERE name = $1 ORDER BY agent_id LIMIT 1',
      ['external-worker'],
    );
    expect(query.mock.calls.filter(([sql]) => /FROM agents WHERE name/.test(String(sql)))).toEqual([
      ['SELECT agent_id FROM agents WHERE name = $1 ORDER BY agent_id LIMIT 1', ['external-worker']],
    ]);
    expect(updateAgentStatus).toHaveBeenCalledTimes(2);
    expect(updateAgentStatus).toHaveBeenNthCalledWith(1, DECLARED_ID, 'active');
    expect(updateAgentStatus).toHaveBeenNthCalledWith(2, WORKER_ID, 'active');
    expect(updateAgentStatus).not.toHaveBeenCalledWith(CHAT_ID, expect.anything());
  });
});
