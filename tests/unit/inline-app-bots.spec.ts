/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard inlineAppBotOwner, the gate that decides which bots the concierge node may run. Over the REAL active registry with packages registered through the real manifestBotDefinition: an inline package bot names its package; a package bot that declares its own container (a dedicated node) does not; a package re-declaring a static inline id does not, because the static governs; an entry with requiresOwnNode does not; an unknown id and an unregistered package do not. The kernel-set refusal is proved with a doubled registry, because every kernel id is also a static entry today and so could never otherwise reach that check.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A reviewed static app concierge (Spaces) is named for its declaring package and refused while no package declares it; the non-reviewed static case now picks a static inline bot outside the reviewed list.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';
import { getActiveRegistry, registerAppBots, unregisterAppBots, type SwarmBotDefinition } from '@/app/extensions/swarm/swarm-bot-registry';
import { inlineAppBotOwner } from '@/app/extensions/swarm/inline-app-bots';
import { CONCIERGE_STATIC_APP_BOT_IDS } from '@/app/extensions/swarm/concierge-static-app-bots';

const APP = 'spec-inline-app-owner';
const OTHER_APP = 'spec-inline-app-other';
const INLINE_BOT = 'c0ffee00-0000-4000-8000-0000000000a1';
const NODE_BOT = 'c0ffee00-0000-4000-8000-0000000000a2';
const OWN_NODE_BOT = 'c0ffee00-0000-4000-8000-0000000000a3';

afterEach(() => {
  unregisterAppBots(APP);
  unregisterAppBots(OTHER_APP);
  vi.doUnmock('@/app/extensions/swarm/swarm-bot-registry');
  vi.resetModules();
});

/** A static inline bot of the real registry, which a package must never be able to claim. */
function staticInlineBot(): SwarmBotDefinition {
  const entry = getActiveRegistry().find((bot) => bot.agentId && bot.container === 'oshal-api' && !bot.requiresOwnNode
    && !CONCIERGE_STATIC_APP_BOT_IDS.has(bot.agentId));
  if (!entry) throw new Error('the active registry has no static inline bot');
  return entry;
}

describe('inlineAppBotOwner', () => {
  it('names the package that owns an inline package bot', () => {
    registerAppBots(APP, [manifestBotDefinition({ agentId: INLINE_BOT, name: 'spec-inline-concierge' })]);
    expect(inlineAppBotOwner(INLINE_BOT)).toBe(APP);
  });

  it('refuses a package bot that runs on its own declared node', () => {
    registerAppBots(APP, [manifestBotDefinition({ agentId: NODE_BOT, name: 'spec-node-concierge', container: 'spec-node' })]);
    expect(inlineAppBotOwner(NODE_BOT)).toBeUndefined();
  });

  it('refuses an inline-container entry that requires its own node', () => {
    registerAppBots(APP, [{ ...manifestBotDefinition({ agentId: OWN_NODE_BOT, name: 'spec-own-node' }), requiresOwnNode: true }]);
    expect(inlineAppBotOwner(OWN_NODE_BOT)).toBeUndefined();
  });

  it('refuses a static id a package re-declares, because the static definition governs', () => {
    const fixed = staticInlineBot();
    registerAppBots(APP, [manifestBotDefinition({ agentId: fixed.agentId!, name: 'spec-claimed-static' })]);
    expect(inlineAppBotOwner(fixed.agentId)).toBeUndefined();
  });

  it('names the declaring package for a reviewed static app concierge, and nothing when no package declares it', () => {
    const spaces = 'b0300000-0000-0000-0000-000000000001';
    expect(CONCIERGE_STATIC_APP_BOT_IDS.has(spaces)).toBe(true);
    expect(inlineAppBotOwner(spaces)).toBeUndefined();
    registerAppBots(APP, [manifestBotDefinition({ agentId: spaces, name: 'spaces-operator' })]);
    expect(inlineAppBotOwner(spaces)).toBe(APP);
  });

  it('names the FIRST registering package when two declare the same inline id', () => {
    registerAppBots(APP, [manifestBotDefinition({ agentId: INLINE_BOT, name: 'spec-first' })]);
    registerAppBots(OTHER_APP, [manifestBotDefinition({ agentId: INLINE_BOT, name: 'spec-second' })]);
    expect(inlineAppBotOwner(INLINE_BOT)).toBe(APP);
  });

  it('refuses unknown, empty and retracted ids', () => {
    expect(inlineAppBotOwner('c0ffee00-0000-4000-8000-0000000000ff')).toBeUndefined();
    expect(inlineAppBotOwner('')).toBeUndefined();
    expect(inlineAppBotOwner(undefined)).toBeUndefined();
    registerAppBots(APP, [manifestBotDefinition({ agentId: INLINE_BOT, name: 'spec-inline-concierge' })]);
    unregisterAppBots(APP);
    expect(inlineAppBotOwner(INLINE_BOT)).toBeUndefined();
  });

  it('refuses a kernel identity even when a package definition would otherwise govern it', async () => {
    const kernelId = 'a0000000-0000-0000-0000-000000000050';
    const packaged = manifestBotDefinition({ agentId: kernelId, name: 'spec-kernel-claim' });
    const inlineOnly = manifestBotDefinition({ agentId: INLINE_BOT, name: 'spec-inline-concierge' });
    vi.resetModules();
    vi.doMock('@/app/extensions/swarm/swarm-bot-registry', () => ({
      getActiveRegistry: () => [packaged, inlineOnly],
      dynamicAppBotsByApp: () => new Map([[APP, [packaged, inlineOnly]]]),
      kernelBotAgentIds: () => new Set([kernelId]),
    }));
    const isolated = await import('@/app/extensions/swarm/inline-app-bots');
    expect(isolated.inlineAppBotOwner(kernelId)).toBeUndefined();
    // The same doubled registry still answers for a non-kernel inline package bot.
    expect(isolated.inlineAppBotOwner(INLINE_BOT)).toBe(APP);
  });
});
