/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 profile regressions: a resolved external chatBot is selected and listed before local bots, while unresolved or partial first loads never relabel a local bot or distinct workflow worker as the external concierge; ambiguous name lookup is duplicate-row deterministic.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve a borrowed concierge directly by canonical agent name without requiring it in record.agentIds. That preserves the cockpit selector while preventing a metadata reference from becoming an application-execution ownership claim.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Concierge lookup is identity-bound and active-only: local declarations keep their explicit id, workflow fallbacks stay inside record.agentIds, and only a distinct metadata chatBot may resolve globally when its ACTIVE name is unique.
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
  it('maps an external chatBot without a durable app association and prepends it to the selector', async () => {
    const query = vi.fn(async () => ({ rows: [{ agent_id: EXTERNAL_ID }] }));
    const profile = await serviceFor(mixedManifest, [LOCAL_ID], query).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toEqual({ agentId: EXTERNAL_ID, name: 'shared-advisor' });
    expect(profile?.chatBots).toEqual([
      { agentId: EXTERNAL_ID, name: 'shared-advisor' },
      { agentId: LOCAL_ID, name: 'local-worker' },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/COUNT\(\*\) OVER \(\).*status = 'active'.*candidate_count = 1/s),
      ['shared-advisor'],
    );
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
    const query = vi.fn(async () => ({ rows: [{ agent_id: EXTERNAL_ID }] }));
    const profile = await serviceFor(manifest, [WORKER_ID], query).synthesiseProfile('mixed');

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
      expect.stringMatching(/COUNT\(\*\) OVER \(\).*status = 'active'.*candidate_count = 1/s),
      ['shared-advisor'],
    );
  });

  it('maps a surface-only framework concierge without associating it to the package', async () => {
    const manifest = {
      name: 'person-model', displayName: 'Ambient Recall', chatBot: 'general-bot',
      ui: { static: [{ toolName: 'ambient', label: 'Ambient', icon: 'i', iframeUrl: '/ambient' }] },
    } as SwarmAppManifest;
    const query = vi.fn(async () => ({ rows: [{ agent_id: EXTERNAL_ID }] }));

    const profile = await serviceFor(manifest, [], query).synthesiseProfile('person-model');

    expect(profile?.chatAgent).toEqual({ agentId: EXTERNAL_ID, name: 'general-bot' });
    expect(profile?.chatBots).toEqual([{ agentId: EXTERNAL_ID, name: 'general-bot' }]);
  });

  it('keeps a declared concierge on its explicit manifest id even when a lower-id namesake exists', async () => {
    const manifest = { ...mixedManifest, chatBot: 'local-worker' } as SwarmAppManifest;
    const query = vi.fn(async () => ({ rows: [{ agent_id: EXTERNAL_ID }] }));

    const profile = await serviceFor(manifest, [LOCAL_ID], query).synthesiseProfile('mixed');

    expect(profile?.chatAgent).toEqual({ agentId: LOCAL_ID, name: 'local-worker' });
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves a workflow fallback only inside the app association and only when unique and active', async () => {
    const manifest = {
      name: 'worker-app', displayName: 'Worker',
      workflow: { name: 'flow', pipeline: 'manifest-worker', workerBot: 'owned-worker' },
      ui: { static: [{ toolName: 'home', label: 'Home', icon: 'i', iframeUrl: '/home' }] },
    } as SwarmAppManifest;
    const query = vi.fn(async () => ({ rows: [{ agent_id: WORKER_ID }] }));

    const profile = await serviceFor(manifest, [WORKER_ID], query).synthesiseProfile('worker-app');

    expect(profile?.chatAgent).toEqual({ agentId: WORKER_ID, name: 'owned-worker' });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'active'.*agent_id = ANY\(\$2::uuid\[\]\).*candidate_count = 1/s),
      ['owned-worker', [WORKER_ID]],
    );
  });
});
