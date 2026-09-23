/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 profile regressions: a resolved external chatBot is selected and listed before local bots, while unresolved or partial first loads never relabel a local bot or distinct workflow worker as the external concierge; ambiguous name lookup is duplicate-row deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { SwarmAppService } from '@/features/swarm-apps';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

const LOCAL_ID = 'aaaa0000-0000-0000-0000-000000000001';
const EXTERNAL_ID = 'bbbb0000-0000-0000-0000-000000000001';
const WORKER_ID = 'cccc0000-0000-0000-0000-000000000001';

function serviceFor(
  manifest: SwarmAppManifest,
  agentIds: string[],
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ agent_id: string }> }>
    = async () => ({ rows: [] }),
): SwarmAppService {
  const record = {
    appId: 'app-1', name: manifest.name, displayName: manifest.displayName, description: '',
    version: '1.0.0', status: 'active', manifestPath: '/packages/app/oshal-app.yaml',
    agentIds, toolNames: [], manifest, scope: 'public', ownerSub: null, tenantId: null,
    guestTierApproved: null, loadedAt: new Date(0), updatedAt: new Date(0),
  };
  const repo = { findByName: async () => record };
  return new SwarmAppService({ query } as never, repo as never, {} as never);
}

const mixedManifest = {
  name: 'mixed',
  displayName: 'Mixed',
  chatBot: '  shared-advisor  ',
  bots: [{ agentId: LOCAL_ID, name: 'local-worker', persona: 'p.yaml' }],
  ui: {
    static: [{ toolName: 'home', label: 'Home', icon: 'i', iframeUrl: '/home' }],
  },
} as SwarmAppManifest;

describe('SwarmAppService synthesiseProfile concierge mapping', () => {
  it('maps a proven external chatBot id and prepends it to the app-scoped selector', async () => {
    const profile = await serviceFor(mixedManifest, [EXTERNAL_ID, LOCAL_ID]).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toEqual({ agentId: EXTERNAL_ID, name: 'shared-advisor' });
    expect(profile?.chatBots).toEqual([
      { agentId: EXTERNAL_ID, name: 'shared-advisor' },
      { agentId: LOCAL_ID, name: 'local-worker' },
    ]);
  });

  it('leaves chatAgent absent after a first-load resolution miss instead of relabelling a local id', async () => {
    const profile = await serviceFor(mixedManifest, [LOCAL_ID]).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toBeUndefined();
    expect(profile?.chatBots).toEqual([{ agentId: LOCAL_ID, name: 'local-worker' }]);
  });

  it('uses a matching declared bot directly without requiring a repository-only id', async () => {
    const manifest = {
      ...mixedManifest,
      chatBot: ' local-worker ',
    } as SwarmAppManifest;
    const profile = await serviceFor(manifest, [LOCAL_ID]).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toEqual({ agentId: LOCAL_ID, name: 'local-worker' });
  });

  it('selects chatBot rather than a distinct workflow worker when both associations resolve', async () => {
    const manifest = {
      ...mixedManifest,
      bots: undefined,
      workflow: { name: 'flow', pipeline: 'manifest-worker', workerBot: 'owned-worker' },
    } as SwarmAppManifest;
    const profile = await serviceFor(manifest, [EXTERNAL_ID, WORKER_ID]).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toEqual({ agentId: EXTERNAL_ID, name: 'shared-advisor' });
    expect(profile?.chatBots).toEqual([{ agentId: EXTERNAL_ID, name: 'shared-advisor' }]);
  });

  it('does not label a lone resolved worker as chatBot when chatBot failed first resolution', async () => {
    const manifest = {
      ...mixedManifest,
      bots: undefined,
      workflow: { name: 'flow', pipeline: 'manifest-worker', workerBot: 'owned-worker' },
    } as SwarmAppManifest;
    const query = vi.fn(async () => ({ rows: [] as Array<{ agent_id: string }> }));
    const profile = await serviceFor(manifest, [WORKER_ID], query).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toBeUndefined();
    expect(profile?.chatBots).toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      'SELECT agent_id FROM agents WHERE name = $1 ORDER BY agent_id LIMIT 1',
      ['shared-advisor'],
    );
  });
});
