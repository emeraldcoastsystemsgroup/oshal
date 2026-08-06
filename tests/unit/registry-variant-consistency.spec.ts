/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the supported local/default, full, kernel, and dynamic-app registry variants: local is the shared-definition authority, full is an exact superset with six reviewed legacy additions, kernel-required UUID/capability records resolve identically everywhere, and package bots append in every mode.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SWARM_BOT_REGISTRY,
  getActiveRegistry,
  kernelBotAgentIds,
  registerAppBots,
  unregisterAppBots,
  type SwarmBotDefinition,
} from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';

const DYNAMIC_TEST_APP = '__registry-variant-consistency__';
const FULL_ONLY_AGENT_IDS = [
  'a0000000-0000-0000-0000-000000000017', // presentation-bot
  'a0000000-0000-0000-0000-000000000007', // agent-factory
  'a0000000-0000-0000-0000-00000000000a', // security-auditor-bot
  'a0000000-0000-0000-0000-00000000000d', // business-plan-bot
  'a0000000-0000-0000-0000-000000000023', // google-bot
  'a0000000-0000-0000-0000-000000000021', // facebook-bot
] as const;

function definitionsById(
  definitions: ReadonlyArray<SwarmBotDefinition>,
): Map<string, SwarmBotDefinition> {
  return new Map(definitions.map((definition) => [definition.agentId ?? '', definition]));
}

function setRegistryMode(mode: string | undefined): void {
  if (mode === undefined) delete process.env.SWARM_REGISTRY;
  else process.env.SWARM_REGISTRY = mode;
}

describe('bot-registry cross-variant consistency', () => {
  let previousMode: string | undefined;

  beforeEach(() => {
    previousMode = process.env.SWARM_REGISTRY;
    unregisterAppBots(DYNAMIC_TEST_APP);
  });

  afterEach(() => {
    unregisterAppBots(DYNAMIC_TEST_APP);
    setRegistryMode(previousMode);
  });

  it('keeps UUIDs unique and makes full an exact superset of local shared definitions', () => {
    for (const [variant, definitions] of [
      ['local', LOCAL_BOT_REGISTRY],
      ['full', SWARM_BOT_REGISTRY],
    ] as const) {
      const ids = definitions.map((definition) => definition.agentId);
      expect(
        ids.every((id) => typeof id === 'string' && id.length > 0),
        `${variant} contains a definition without a canonical UUID`,
      ).toBe(true);
      expect(
        new Set(ids).size,
        `${variant} contains a duplicate UUID; first-match resolution would hide one definition`,
      ).toBe(ids.length);
      const names = definitions.map((definition) => definition.name);
      expect(
        new Set(names).size,
        `${variant} contains a duplicate name; name-based dispatch would resolve ambiguously`,
      ).toBe(names.length);
    }

    const fullById = definitionsById(SWARM_BOT_REGISTRY);
    for (const localDefinition of LOCAL_BOT_REGISTRY) {
      expect(
        fullById.get(localDefinition.agentId!),
        `full mode dropped required/default bot ${localDefinition.name} (${localDefinition.agentId})`,
      ).toEqual(localDefinition);
    }

    const localIds = new Set(LOCAL_BOT_REGISTRY.map((definition) => definition.agentId));
    const actualFullOnly = SWARM_BOT_REGISTRY
      .filter((definition) => !localIds.has(definition.agentId))
      .map((definition) => definition.agentId)
      .sort();
    expect(
      actualFullOnly,
      'full-only membership changed; review the deployment contract and update this allow-list intentionally',
    ).toEqual([...FULL_ONLY_AGENT_IDS].sort());
  });

  it('resolves every kernel-required identity and capability record identically in all modes', () => {
    const localById = definitionsById(LOCAL_BOT_REGISTRY);
    const fullById = definitionsById(SWARM_BOT_REGISTRY);

    setRegistryMode('kernel');
    const kernelDefinitions = getActiveRegistry();
    const kernelById = definitionsById(kernelDefinitions);

    expect(new Set(kernelDefinitions.map((definition) => definition.agentId))).toEqual(
      new Set(kernelBotAgentIds()),
    );
    for (const agentId of kernelBotAgentIds()) {
      const authoritative = localById.get(agentId);
      expect(authoritative, `kernel UUID ${agentId} is absent from the local authority`).toBeDefined();
      expect(fullById.get(agentId), `full mode drops kernel-required UUID ${agentId}`).toEqual(authoritative);
      expect(kernelById.get(agentId), `kernel mode drops required UUID ${agentId}`).toEqual(authoritative);
    }
  });

  it('maps supported selectors deterministically and appends package bots in every mode', () => {
    const dynamicDefinition: SwarmBotDefinition = {
      agentId: 'feed0000-0000-0000-0000-000000000001',
      name: 'registry-variant-fixture',
      port: 3010,
      container: 'oshal-api',
      role: 'test/fixture',
      capabilities: ['registry-variant-proof'],
      harnessType: 'noop',
      apiType: 'noop',
      accessRoles: ['operator'],
    };
    registerAppBots(DYNAMIC_TEST_APP, [dynamicDefinition]);

    for (const [mode, staticDefinitions] of [
      [undefined, LOCAL_BOT_REGISTRY],
      ['local', LOCAL_BOT_REGISTRY],
      ['stale-legacy-value', LOCAL_BOT_REGISTRY],
      ['full', SWARM_BOT_REGISTRY],
      [
        'kernel',
        LOCAL_BOT_REGISTRY.filter(
          (definition) => definition.agentId && kernelBotAgentIds().has(definition.agentId),
        ),
      ],
    ] as const) {
      setRegistryMode(mode);
      const active = getActiveRegistry();
      expect(active.slice(0, staticDefinitions.length)).toEqual(staticDefinitions);
      expect(active.at(-1), `dynamic app bot was not appended in ${mode ?? 'default'} mode`).toEqual(
        dynamicDefinition,
      );
    }
  });
});
