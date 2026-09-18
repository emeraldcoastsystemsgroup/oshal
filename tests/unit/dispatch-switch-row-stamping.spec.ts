/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for tier-1 dispatch stamping (dispatch-runtime-params.ts readSwitchRow): the ONLY path by which a fleet-default or per-bot switch row reaches a DEDICATED bot node. Review of PR #633 proved the gap by mutation — replacing `const switched = resolver(agentId)` with `null` left every related spec green, so a silent regression would have inline bots following a fleet write while every bot-node dispatch kept carrying the agent_config/registry provider. This spec builds the resolver WITH its third argument wired exactly as the composition root wires it (the installed ProviderSwitchSnapshot over the real switch rule and the real catalog, the real registry for general-bot) and pins: the fleet row above a no-opinion agent_config record and above the registry; the per-bot row above the fleet row, answered by the switch rule; no rows byte-identical to the two-argument resolver; a refused id carried as written into the node's fail-closed seam. The fleet-row and refused-id cases are the ones the reviewer's mutation turns red.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot switch row is an operator-written row of oshal_bot_provider_switch, never the agent_config record: ADR-162 §7 failed for all 70 records on the operator box because the store projected each machinery-written record as a bot-row above the fleet default. The listAll double now mirrors the FIXED store (the fleet row plus explicit per-bot rows; agent_config is never projected) and the per-bot cases write that row explicitly. New REGRESSION cases seed the box's three record shapes — manifest-seeded claude-code with blank configUpdatedBy and configVersion 1, gemini 'bot-local', anthropic 'oshal-push' — beside an 'openrouter' fleet row no record names, and pin the fleet row as the stamped record for each, the record's version riding along. Red on the pre-fix projection (each record answered its own provider as 'bot-row'), green after.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgentConfigRuntimeParamsResolver,
  resolveDispatchConfigFields,
  type ProviderSwitchResolver,
} from '../../src/features/agent-management/services/dispatch-runtime-params';
import { pushOnDispatchFields } from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';
// The REAL registry: general-bot's harness/apiType are live registry facts, not fixtures.
import {
  getActiveRegistry,
  registryDeclaredProvider,
  registryHarnessEntry,
} from '../../src/app/extensions/swarm/swarm-bot-registry';
// The REAL installed-snapshot seam the composition root reads for tier 1, and the REAL catalog
// built from HARNESS_FACTORIES + provider-definitions — nothing here stubs the switch rule.
import {
  buildProviderSwitchCatalog,
  resolveInstalledProviderSwitch,
  setInstalledProviderSwitchSnapshot,
} from '../../src/app/composition/provider-switch-runtime';
import { HARNESS_FACTORIES } from '../../src/app/composition/provider-runtime';
import { ProviderSwitchSnapshot } from '../../src/features/agent-management/services/provider-switch-snapshot';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchRow } from '../../src/shared/llm-runtime';
// The bot half: what the node parses off the stamped request, and the switch seam that refuses
// an id by name. A carried id is only useful if this side sees exactly what tier 1 stamped.
import { parseCarriedDispatchConfig } from '../../src/app/bot-node-dispatch-config';
import { resolveBotNodeSwitch } from '../../src/app/bot-node-provider-switch';

/** The live dedicated bot-node this path exists for: general-bot, registry codex-cli/openai-codex. */
const GENERAL_BOT_AGENT_ID = 'a0000000-0000-0000-0000-000000000099';

/** An agent no registry declares — the fleet default must not reach it (no LLM harness). */
const UNDECLARED_AGENT_ID = '00000000-0000-0000-0000-0000000000ff';

/** The catalog exactly as the running api builds it. */
const CATALOG = buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES));

/** The runtimes a bot node builds — the shape resolveBotNodeSwitch reads (name → instance). */
const BUILT_RUNTIMES = { 'openai-codex': {}, 'claude-code': {}, 'cline-cli': {} };

/** A provider id none of the operator box's 70 agent_config records names, so a move onto it cannot be vacuous. */
const FLEET_PROVIDER_NOBODY_HAS = 'openrouter';

/** One agent_config record's config_values, as getConfig returns them. */
interface ConfigValues {
  providerId?: string;
  modelId?: string;
  configVersion?: number;
  /** Who wrote the record on the box: blank (manifest seeding), 'bot-local' (broadcast-up) or 'oshal-push'. */
  configUpdatedBy?: string;
}

/** The in-memory agent_config table: agent id → config_values. */
type AgentConfigTable = Record<string, ConfigValues>;

/** getConfig over the in-memory agent_config table (the only method the resolver uses). */
function agentConfigStore(table: AgentConfigTable) {
  return {
    getConfig: async (agentId: string) => (table[agentId] ? ({ values: table[agentId] } as never) : null),
  };
}

/** A fleet-default row of oshal_bot_provider_switch. */
function fleetRow(providerId: string, modelId: string | null = null): ProviderSwitchRow {
  return { scopeId: FLEET_DEFAULT_SWITCH_ID, providerId, modelId, updatedBy: 'operator', updatedAt: null };
}

/** A bot's own row of oshal_bot_provider_switch — written by an operator through PUT /runtime, never by machinery. */
function botRow(agentId: string, providerId: string, modelId: string | null = null): ProviderSwitchRow {
  return { scopeId: agentId, providerId, modelId, updatedBy: 'operator-sub', updatedAt: null };
}

/**
 * listAll exactly as the FIXED ProviderSwitchStore reads it: the rows of oshal_bot_provider_switch
 * and nothing else — the fleet row first, then the per-bot rows an operator wrote. agent_config is
 * NOT projected here on purpose: its providerId is the ADR-034 tier-2 dispatch record beneath the
 * fleet row, and projecting it is the defect the machinery-written REGRESSION case turns red on.
 */
function switchRows(fleet: ProviderSwitchRow | null, perBot: readonly ProviderSwitchRow[]): ProviderSwitchRow[] {
  return fleet ? [fleet, ...perBot] : [...perBot];
}

/** Install a loaded snapshot over the rows, then hand back the composition root's tier-1 lambda. */
async function installSwitch(fleet: ProviderSwitchRow | null, perBot: readonly ProviderSwitchRow[]): Promise<ProviderSwitchResolver> {
  const snapshot = new ProviderSwitchSnapshot({ listAll: async () => switchRows(fleet, perBot) }, CATALOG);
  await snapshot.refresh();
  setInstalledProviderSwitchSnapshot(snapshot, CATALOG);
  return (agentId) => resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId));
}

/** The resolver as the composition root builds it: agent_config + registry + the switch rows. */
async function resolverWithRows(fleet: ProviderSwitchRow | null, table: AgentConfigTable, perBot: readonly ProviderSwitchRow[] = []) {
  const resolveSwitch = await installSwitch(fleet, perBot);
  return createAgentConfigRuntimeParamsResolver(agentConfigStore(table), registryDeclaredProvider, resolveSwitch);
}

/** Today's two-argument resolver — the tier-2/tier-3 result the no-row case must equal byte for byte. */
function resolverWithoutSwitch(table: AgentConfigTable) {
  return createAgentConfigRuntimeParamsResolver(agentConfigStore(table), registryDeclaredProvider);
}

let previousFlag: string | undefined;

beforeEach(() => {
  previousFlag = process.env.OSHAL_PUSH_ON_DISPATCH;
  process.env.OSHAL_PUSH_ON_DISPATCH = 'on';
});

afterEach(() => {
  setInstalledProviderSwitchSnapshot(null);
  if (previousFlag === undefined) delete process.env.OSHAL_PUSH_ON_DISPATCH;
  else process.env.OSHAL_PUSH_ON_DISPATCH = previousFlag;
});

describe('the fixture is live: general-bot is a registry LLM bot the fleet default reaches', () => {
  it('general-bot exists in the active registry with a harness and an apiType', () => {
    const entry = getActiveRegistry().find((b) => b.agentId === GENERAL_BOT_AGENT_ID);
    expect(entry, 'general-bot must exist in the active registry').toBeDefined();
    expect(registryHarnessEntry(GENERAL_BOT_AGENT_ID)?.harnessType).toBeTruthy();
    expect(registryDeclaredProvider(GENERAL_BOT_AGENT_ID)).toBeTruthy();
    // The catalog must know the ids the cases below switch onto, else a refusal would pass as a switch.
    expect(CATALOG.harnessTypes).toContain('claude-code');
    expect(CATALOG.clineApiProviders).toContain('anthropic');
    expect(CATALOG.clineApiProviders).toContain('nousResearch');
    expect(CATALOG.clineApiProviders).toContain(FLEET_PROVIDER_NOBODY_HAS);
  });
});

describe('tier 1: a fleet-default row is carried above the agent_config record and the registry', () => {
  it('REGRESSION: with no agent_config row, the fleet row — not the registry literal — is stamped', async () => {
    const resolver = await resolverWithRows(fleetRow('anthropic', 'claude-sonnet-4-6'), {});
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(registryDeclaredProvider(GENERAL_BOT_AGENT_ID)).not.toBe('anthropic');
  });

  it('REGRESSION: the fleet row beats a no-opinion agent_config record; the version still rides along', async () => {
    // A model-only record is not a per-bot row (no providerId), so the fleet row is the record:
    // its provider AND its (absent) model, with the agent_config version for the drift log.
    const resolver = await resolverWithRows(fleetRow('claude-code'), {
      [GENERAL_BOT_AGENT_ID]: { modelId: 'gpt-5.5', configVersion: 9 },
    });
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'claude-code', configVersion: 9 });
  });

  it('REGRESSION: the fleet row beats an agent_config record whose providerId is the `auto` sentinel', async () => {
    const resolver = await resolverWithRows(fleetRow('claude-code'), {
      [GENERAL_BOT_AGENT_ID]: { providerId: 'auto', configVersion: 2 },
    });
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'claude-code', configVersion: 2 });
  });

  it("REGRESSION (ADR-162 §7): the fleet row beats a MACHINERY-WRITTEN agent_config record — the operator box's three shapes", async () => {
    // Measured read-only on the operator box (2026-09-17): 70 agent_config records name a provider
    // and none was written by a person — 67 manifest-seeded (blank configUpdatedBy, configVersion 1),
    // 2 'bot-local', 1 'oshal-push'. Each is the ADR-034 tier-2 record, never a switch row, so ONE
    // fleet-default write must move every one of them; the record's version still rides along.
    const shapes: Array<[string, ConfigValues]> = [
      ['manifest-seeded claude-code (blank configUpdatedBy, configVersion 1)', { providerId: 'claude-code', modelId: 'claude-sonnet-4-6', configVersion: 1 }],
      ["the bot's own broadcast-up ('bot-local') gemini", { providerId: 'gemini', modelId: 'gemini-3.1-pro', configVersion: 39, configUpdatedBy: 'bot-local' }],
      ["a ConfigSyncService push ('oshal-push') anthropic", { providerId: 'anthropic', modelId: 'claude-sonnet-4-20250514', configVersion: 1, configUpdatedBy: 'oshal-push' }],
    ];
    for (const [label, record] of shapes) {
      const resolver = await resolverWithRows(fleetRow(FLEET_PROVIDER_NOBODY_HAS, 'anthropic/claude-sonnet-4.6'), { [GENERAL_BOT_AGENT_ID]: record });
      expect(await resolver(GENERAL_BOT_AGENT_ID), label).toEqual({
        providerId: FLEET_PROVIDER_NOBODY_HAS, model: 'anthropic/claude-sonnet-4.6', configVersion: record.configVersion,
      });
      // ...and the node parses exactly that off the stamped request, landing on cline-cli fronting it.
      const carried = parseCarriedDispatchConfig(await pushOnDispatchFields(resolver, GENERAL_BOT_AGENT_ID));
      expect(carried, label).toEqual({ providerId: FLEET_PROVIDER_NOBODY_HAS, model: 'anthropic/claude-sonnet-4.6', configVersion: record.configVersion });
      expect(resolveBotNodeSwitch(carried!.providerId, BUILT_RUNTIMES, CATALOG.clineApiProviders), label)
        .toEqual({ runtime: 'cline-cli', apiProvider: FLEET_PROVIDER_NOBODY_HAS });
    }
  });

  it('REGRESSION: the stamped request the node parses names the fleet row, with the required marker', async () => {
    const resolver = await resolverWithRows(fleetRow('anthropic', 'claude-sonnet-4-6'), {});
    const fields = await pushOnDispatchFields(resolver, GENERAL_BOT_AGENT_ID);
    expect(fields.providerConfigRequired).toBe(true);
    expect(fields.providerId).toBe('anthropic');

    const carried = parseCarriedDispatchConfig(fields);
    expect(carried).toEqual({ providerId: 'anthropic', model: 'claude-sonnet-4-6' });
    // The node translates that id onto its cline-cli runtime fronting anthropic — a real switch.
    expect(resolveBotNodeSwitch(carried!.providerId, BUILT_RUNTIMES, CATALOG.clineApiProviders))
      .toEqual({ runtime: 'cline-cli', apiProvider: 'anthropic' });
  });

  it('the fleet row does NOT reach an agent the registry does not declare — still fail-closed', async () => {
    const resolver = await resolverWithRows(fleetRow('anthropic'), {});
    expect(await resolver(UNDECLARED_AGENT_ID)).toBeNull();
    const fields = await pushOnDispatchFields(resolver, UNDECLARED_AGENT_ID);
    expect(fields.providerConfigRequired).toBe(true);
    expect(fields.providerId).toBeUndefined();
    expect(parseCarriedDispatchConfig(fields)).toBeNull();
  });
});

describe("tier 1: a bot's own switch row — an operator's write — is carried above the fleet row", () => {
  it('REGRESSION: the per-bot row wins over the fleet default AND over the agent_config record beneath both', async () => {
    const resolver = await resolverWithRows(
      fleetRow('gemini', 'gemini-2.5-pro'),
      { [GENERAL_BOT_AGENT_ID]: { providerId: 'openai-codex', modelId: 'gpt-5.5', configVersion: 4 } },
      [botRow(GENERAL_BOT_AGENT_ID, 'claude-code', 'claude-sonnet-4-6')],
    );
    expect(await resolveDispatchConfigFields(resolver, GENERAL_BOT_AGENT_ID)).toEqual({
      providerId: 'claude-code', model: 'claude-sonnet-4-6', configVersion: 4,
    });
  });

  it('REGRESSION: the per-bot rung answers through the switch rule — the id lands in the catalog spelling', async () => {
    // classifyProviderId answers with the catalog's own spelling (`nousResearch`), which tier 2
    // never does: that difference is how this case tells tier 1 from a tier-2 fallback.
    const resolver = await resolverWithRows(
      fleetRow('claude-code'),
      { [GENERAL_BOT_AGENT_ID]: { configVersion: 11 } },
      [botRow(GENERAL_BOT_AGENT_ID, 'nousresearch', 'Hermes-4-405B')],
    );
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({
      providerId: 'nousResearch', model: 'Hermes-4-405B', configVersion: 11,
    });
  });

  it('a per-bot row for one bot does not move another: the other bot still follows the fleet default', async () => {
    const resolver = await resolverWithRows(
      fleetRow('claude-code', 'claude-sonnet-4-6'),
      {},
      [botRow(UNDECLARED_AGENT_ID, 'anthropic')],
    );
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'claude-code', model: 'claude-sonnet-4-6' });
  });
});

describe('no rows: the result is byte-identical to the two-argument resolver', () => {
  const cases: Array<[string, AgentConfigTable]> = [
    ['no agent_config row (registry tier 3)', {}],
    ['a full record (tier 2)', { [GENERAL_BOT_AGENT_ID]: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6', configVersion: 4 } }],
    ['a model-only record (tier 3 with the model and version kept)', { [GENERAL_BOT_AGENT_ID]: { modelId: 'gpt-5.5', configVersion: 9 } }],
  ];

  for (const [label, table] of cases) {
    it(`an installed but EMPTY fleet — ${label}`, async () => {
      const withRows = await resolverWithRows(null, table);
      const today = resolverWithoutSwitch(table);
      expect(await withRows(GENERAL_BOT_AGENT_ID)).toEqual(await today(GENERAL_BOT_AGENT_ID));
      expect(await withRows(UNDECLARED_AGENT_ID)).toEqual(await today(UNDECLARED_AGENT_ID));
    });

    it(`nothing installed at all — ${label}`, async () => {
      setInstalledProviderSwitchSnapshot(null);
      const resolveSwitch: ProviderSwitchResolver = (agentId) =>
        resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId));
      const withSeam = createAgentConfigRuntimeParamsResolver(agentConfigStore(table), registryDeclaredProvider, resolveSwitch);
      const today = resolverWithoutSwitch(table);
      expect(await withSeam(GENERAL_BOT_AGENT_ID)).toEqual(await today(GENERAL_BOT_AGENT_ID));
      expect(await withSeam(UNDECLARED_AGENT_ID)).toEqual(await today(UNDECLARED_AGENT_ID));
    });
  }

  it('the registry-tier-3 result is the literal the registry declares, so the comparison is not vacuous', async () => {
    const withRows = await resolverWithRows(null, {});
    expect(await withRows(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: registryDeclaredProvider(GENERAL_BOT_AGENT_ID) });
  });
});

describe('a refused id is carried AS WRITTEN so the node refuses the dispatch by name', () => {
  it('REGRESSION: a fleet row naming an id this build cannot run is stamped verbatim, model included', async () => {
    const resolver = await resolverWithRows(fleetRow('Not-A-Provider', 'some-model'), {});
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'Not-A-Provider', model: 'some-model' });

    const fields = await pushOnDispatchFields(resolver, GENERAL_BOT_AGENT_ID);
    const carried = parseCarriedDispatchConfig(fields);
    expect(carried?.providerId).toBe('Not-A-Provider');
    // The node's switch seam knows no such id → null → UnknownBotNodeProviderError names it.
    expect(resolveBotNodeSwitch(carried!.providerId, BUILT_RUNTIMES, CATALOG.clineApiProviders)).toBeNull();
  });

  it('a per-bot row naming a refused id is stamped verbatim too, never the fleet row beneath it', async () => {
    const resolver = await resolverWithRows(
      fleetRow('claude-code'),
      { [GENERAL_BOT_AGENT_ID]: { configVersion: 3 } },
      [botRow(GENERAL_BOT_AGENT_ID, 'a2a')],
    );
    expect(await resolver(GENERAL_BOT_AGENT_ID)).toEqual({ providerId: 'a2a', configVersion: 3 });
    expect(resolveBotNodeSwitch('a2a', BUILT_RUNTIMES, CATALOG.clineApiProviders)).toBeNull();
  });
});
