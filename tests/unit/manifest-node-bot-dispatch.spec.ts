/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards ADR-093 Tier 2 end to end: a package bot that declares `container:` must actually DISPATCH to that node. It never did — the mapper registered the container, but a package cannot set requiresOwnNode and an omitted harnessType inherits codex-cli, so the resolver's prefer-inline codex rule silently sent every packaged node bot to the controller. Live cost: career-hunter won its bid, ran inline, and reported the operator's resume database as missing. These cases run the REAL mapper, the REAL registry registration, and the REAL resolver — a doubled registry would not have caught this, because each piece was individually correct.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';
import {
  resolveBotNodeEndpoint,
  type EndpointResolutionLogger,
} from '@/app/extensions/swarm/resolve-bot-node-endpoint';
import {
  getActiveRegistry,
  registerAppBots,
  unregisterAppBots,
  type SwarmBotDefinition,
} from '@/app/extensions/swarm/swarm-bot-registry';
import { isControllerInlineContainer } from '@/features/agent-management';

const TEST_APP = '__manifest-node-bot-dispatch-spec__';

/** Records what the resolver explained, so silence is itself assertable. */
function recordingLogger(): EndpointResolutionLogger & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (_o, msg) => { infos.push(msg); },
    warn: (_o, msg) => { warns.push(msg); },
  };
}

/** Registers a manifest declaration through the REAL mapper + registry, then resolves it. */
function resolveThroughRealRegistry(
  declaration: Parameters<typeof manifestBotDefinition>[0],
  logger?: EndpointResolutionLogger,
): string | null {
  registerAppBots(TEST_APP, [manifestBotDefinition(declaration)]);
  return resolveBotNodeEndpoint(declaration.agentId, getActiveRegistry(), isControllerInlineContainer, logger);
}

afterEach(() => {
  unregisterAppBots(TEST_APP);
});

describe('a packaged bot that declares a dedicated node dispatches to that node', () => {
  it('resolves to the node even though it inherits the codex harness (the live defect)', () => {
    // The career-hunter shape, verbatim: container declared, harnessType omitted. Omitting
    // harnessType is the NORM for store packages, so this is the common case, not an edge one.
    const endpoint = resolveThroughRealRegistry({
      agentId: 'cb000000-0000-0000-0000-000000000001',
      name: 'career-hunter',
      container: 'career-bot',
      port: 5000,
    });
    expect(endpoint).toBe('http://career-bot:5000');
  });

  it('sets requiresOwnNode on the definition a declared container produces', () => {
    const def = manifestBotDefinition({
      agentId: 'cb000000-0000-0000-0000-000000000001',
      name: 'career-hunter',
      container: 'career-bot',
      port: 5000,
    });
    expect(def.requiresOwnNode).toBe(true);
    expect(def.container).toBe('career-bot');
    // The inherited fleet default is what made the old code send it inline — assert it is
    // still inherited, so this guard proves the FIX rather than a changed default.
    expect(def.harnessType).toBe('codex-cli');
  });

  it('reaches the node for the intelligent-sales shape too', () => {
    expect(resolveThroughRealRegistry({
      agentId: '15000000-0000-0000-0000-000000000001',
      name: 'sales-concierge',
      container: 'sales-bot',
    })).toBe('http://sales-bot:5000');
  });

  it('registers the bot into the ACTIVE registry, not a private list', () => {
    resolveThroughRealRegistry({ agentId: 'cb000000-0000-0000-0000-000000000001', name: 'career-hunter', container: 'career-bot' });
    const found = getActiveRegistry().find((d) => d.agentId === 'cb000000-0000-0000-0000-000000000001');
    expect(found?.container).toBe('career-bot');
  });
});

describe('the inline path is preserved for everything that did not opt out', () => {
  it('keeps a package bot WITHOUT a container on the controller-inline path', () => {
    const logger = recordingLogger();
    const endpoint = resolveThroughRealRegistry(
      { agentId: 'aa000000-0000-0000-0000-0000000000ff', name: 'inline-concierge' },
      logger,
    );
    expect(endpoint).toBeNull();
    expect(logger.infos.join(' ')).toMatch(/controller-inline/);
    // An ordinary inline package bot is not an anomaly — it must not warn.
    expect(logger.warns).toEqual([]);
  });

  it('does not set requiresOwnNode when no container is declared', () => {
    const def = manifestBotDefinition({ agentId: 'aa000000-0000-0000-0000-0000000000ff', name: 'inline-concierge' });
    expect(def.requiresOwnNode).toBeUndefined();
    expect(def.container).toBe('oshal-api');
  });

  it('returns null for an agent that is not registered at all', () => {
    expect(resolveBotNodeEndpoint('00000000-0000-0000-0000-0000000000zz'.replace('zz', '00'), getActiveRegistry(), isControllerInlineContainer))
      .toBeNull();
  });
});

describe('the codex prefer-inline rule stays, but stops being silent', () => {
  const codexNodeBotMissingTheFlag: SwarmBotDefinition = {
    agentId: 'dd000000-0000-0000-0000-000000000001',
    name: 'legacy-node-bot',
    container: 'legacy-node-bot',
    port: 5000,
    role: '',
    capabilities: [],
    harnessType: 'codex-cli',
    apiType: 'openai-codex',
  };

  it('still forces a codex bot inline when requiresOwnNode is absent (behavior preserved)', () => {
    expect(resolveBotNodeEndpoint(codexNodeBotMissingTheFlag.agentId!, [codexNodeBotMissingTheFlag], isControllerInlineContainer))
      .toBeNull();
  });

  it('WARNS when it does so, naming the flag that fixes it', () => {
    // The silence is what made the live misroute cost an hour: the bot won its bid, ran in the
    // wrong process, and nothing in the logs said why.
    const logger = recordingLogger();
    resolveBotNodeEndpoint(codexNodeBotMissingTheFlag.agentId!, [codexNodeBotMissingTheFlag], isControllerInlineContainer, logger);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toMatch(/requiresOwnNode/);
  });

  it('dispatches a non-codex node bot to its node, as before', () => {
    const claudeNodeBot: SwarmBotDefinition = {
      ...codexNodeBotMissingTheFlag,
      harnessType: 'claude-code',
      apiType: 'claude-code',
    };
    expect(resolveBotNodeEndpoint(claudeNodeBot.agentId!, [claudeNodeBot], isControllerInlineContainer))
      .toBe('http://legacy-node-bot:5000');
  });
});
