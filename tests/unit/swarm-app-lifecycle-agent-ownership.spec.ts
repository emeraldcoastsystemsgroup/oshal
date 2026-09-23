/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | P8 lifecycle ownership regressions: metadata-only concierge associations are never toggled, while the legacy no-bots workflow worker remains lifecycle-owned even when chatBot names another agent; worker name lookup is duplicate-row deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { SwarmAppService } from '@/features/swarm-apps';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';

type Status = 'active' | 'inactive';

function recordFor(manifest: SwarmAppManifest, agentIds: string[]) {
  return {
    appId: `app-${manifest.name}`,
    name: manifest.name,
    displayName: manifest.displayName,
    description: '',
    version: '1.0.0',
    status: 'active' as Status,
    manifestPath: `/packages/${manifest.name}/oshal-app.yaml`,
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
) {
  const record = recordFor(manifest, agentIds);
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
});
