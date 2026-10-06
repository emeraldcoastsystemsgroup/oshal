/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the reviewed static app-concierge list the concierge node may serve: every id is a static registry entry that runs controller-inline without requiresOwnNode and is never a kernel identity, so the list cannot quietly widen into core bots (vault-bot, codex-packer, Jarvis) or bots with their own nodes.
 */

import { describe, expect, it } from 'vitest';
import { CONCIERGE_STATIC_APP_BOT_IDS } from '@/app/extensions/swarm/concierge-static-app-bots';
import { kernelBotAgentIds, SWARM_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '@/app/extensions/swarm/swarm-bot-registry-local';

const STATIC = [...LOCAL_BOT_REGISTRY, ...SWARM_BOT_REGISTRY];

describe('CONCIERGE_STATIC_APP_BOT_IDS', () => {
  it('lists exactly the eleven reviewed store-package concierges', () => {
    expect(CONCIERGE_STATIC_APP_BOT_IDS.size).toBe(11);
  });

  it.each([...CONCIERGE_STATIC_APP_BOT_IDS])('%s is a controller-inline static entry and never a kernel identity', (id) => {
    expect(kernelBotAgentIds().has(id)).toBe(false);
    const entries = STATIC.filter((bot) => bot.agentId === id);
    expect(entries.length, 'a reviewed id must be a static registry entry').toBeGreaterThan(0);
    for (const entry of entries) {
      expect(['oshal-api', 'oshal-local-api']).toContain(entry.container);
      expect(entry.requiresOwnNode ?? false).toBe(false);
    }
  });

  it('never lists the core inline bots the concierge must not run', () => {
    for (const core of ['a0000000-0000-0000-0000-0000000000d0', 'a0000000-0000-0000-0000-000000000030', 'a0000000-0000-0000-0000-000000000050']) {
      expect(CONCIERGE_STATIC_APP_BOT_IDS.has(core)).toBe(false);
    }
  });
});
