/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the live dispatch failure "Authoritative provider config was required but no actionable record was available" (ticket 2fa9f91d, task -> general-bot, 2026-09-17). ADR-034 push-on-dispatch stamps providerConfigRequired unconditionally, but the controller resolver read ONLY agent_config — a table written when something CHANGES a bot provider — so a bot that has always run its registry-declared provider had no row, the stamp carried the marker with no record, and the bot refused before task creation. The guard crosses the REAL registry boundary (no stubbed registry: it asks the live LOCAL_BOT_REGISTRY for general-bot) and carries the resolved stamp through the bot half's parser, so it reproduces the exact refusal end to end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentConfigRuntimeParamsResolver,
  resolveDispatchConfigFields,
} from '../../src/features/agent-management/services/dispatch-runtime-params';
import { pushOnDispatchFields } from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';
// The REAL registry query and the REAL registry behind it — the boundary whose absence caused
// the defect. Nothing here stubs the bot registry.
import { registryDeclaredProvider, getActiveRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { parseCarriedDispatchConfig } from '../../src/app/bot-node-dispatch-config';

/** The live agent that escalated: oshal-local-general-bot, a dedicated bot-node on codex. */
const GENERAL_BOT_AGENT_ID = 'a0000000-0000-0000-0000-000000000099';

/** An agent no store declares — the genuine unknown that MUST stay fail-closed. */
const UNDECLARED_AGENT_ID = '00000000-0000-0000-0000-0000000000ff';

/** A config store with no row for the agent — exactly the live general-bot state. */
const noConfigRow = { getConfig: async () => null };

let previousFlag: string | undefined;

beforeEach(() => {
  previousFlag = process.env.OSHAL_PUSH_ON_DISPATCH;
  process.env.OSHAL_PUSH_ON_DISPATCH = 'on';
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env.OSHAL_PUSH_ON_DISPATCH;
  else process.env.OSHAL_PUSH_ON_DISPATCH = previousFlag;
});

describe('registryDeclaredProvider (ADR-034 §1a tier 3, real registry)', () => {
  it('reads the provider general-bot actually declares — the fixture is a live registry entry', () => {
    const entry = getActiveRegistry().find((b) => b.agentId === GENERAL_BOT_AGENT_ID);
    // Guard the guard: if general-bot ever leaves the registry this spec must fail loudly
    // rather than pass vacuously against an absent fixture.
    expect(entry, 'general-bot must exist in the active registry').toBeDefined();
    expect(registryDeclaredProvider(GENERAL_BOT_AGENT_ID)).toBe(entry?.apiType);
    expect(registryDeclaredProvider(GENERAL_BOT_AGENT_ID)).toBeTruthy();
  });

  it('returns null for an agent the registry does not declare', () => {
    expect(registryDeclaredProvider(UNDECLARED_AGENT_ID)).toBeNull();
  });
});

describe('push-on-dispatch resolves a record for a bot with no agent_config row', () => {
  it('REGRESSION: general-bot with no config row resolves to its declared provider, not null', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow, registryDeclaredProvider);
    const params = await resolver(GENERAL_BOT_AGENT_ID);
    expect(params).not.toBeNull();
    expect(params?.providerId).toBe(registryDeclaredProvider(GENERAL_BOT_AGENT_ID));
  });

  it('REGRESSION: the dispatch no longer carries the required marker with no record', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow, registryDeclaredProvider);
    const fields = await pushOnDispatchFields(resolver, GENERAL_BOT_AGENT_ID);

    expect(fields.providerConfigRequired).toBe(true);
    // The live failure was exactly this pair: marker true, providerId absent.
    expect(fields.providerId).toBeTruthy();

    // Cross into the bot half with the stamp the controller would actually send: the
    // execution handler refuses when providerConfigRequired is set and this parse is null.
    const carried = parseCarriedDispatchConfig(fields);
    expect(carried).not.toBeNull();
    expect(carried?.providerId).toBe(fields.providerId);
  });

  it('keeps the fail-closed refusal for an agent neither store declares', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow, registryDeclaredProvider);
    expect(await resolver(UNDECLARED_AGENT_ID)).toBeNull();

    const fields = await pushOnDispatchFields(resolver, UNDECLARED_AGENT_ID);
    expect(fields.providerConfigRequired).toBe(true);
    expect(fields.providerId).toBeUndefined();
    expect(parseCarriedDispatchConfig(fields)).toBeNull();
  });
});

describe('tier 2 stays authoritative — a bot that resolves today is stamped byte-identically', () => {
  it('the per-agent record wins over the registry declaration', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(
      { getConfig: async () => ({ values: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', configVersion: 4 } }) as never },
      registryDeclaredProvider,
    );
    expect(await resolveDispatchConfigFields(resolver, GENERAL_BOT_AGENT_ID)).toEqual({
      providerId: 'anthropic', model: 'claude-sonnet-4-6', configVersion: 4,
    });
  });

  it('a record with a model but no providerId still falls back, keeping its model and version', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(
      { getConfig: async () => ({ values: { modelId: 'gpt-5.5', configVersion: 9 } }) as never },
      registryDeclaredProvider,
    );
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({
      providerId: registryDeclaredProvider(GENERAL_BOT_AGENT_ID),
      model: 'gpt-5.5',
      configVersion: 9,
    });
  });
});

describe('the tier-3 reader cannot itself break a dispatch', () => {
  it('treats the `auto` sentinel as no declaration, never as a provider', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow, () => 'auto');
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toBeNull();
  });

  it('a throwing registry read fails closed instead of escaping into the dispatch', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow, () => {
      throw new Error('registry unreadable');
    });
    await expect(resolver(GENERAL_BOT_AGENT_ID)).resolves.toBeNull();
  });

  it('omitting the reader preserves the pre-fix tier-2-only behaviour exactly', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver(noConfigRow);
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toBeNull();
  });
});
