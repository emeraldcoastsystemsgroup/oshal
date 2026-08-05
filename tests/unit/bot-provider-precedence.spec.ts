/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard provider-panel-shows-registry-precedence. Pins the rule itself (a non-cline registry harnessType outranks the per-bot DB record; 'auto' is the no-opinion sentinel, not a provider; the MODEL stays overridable when the provider does not, because the bot-node config bootstrap maps modelId onto the harness's model env var), pins that a FAILED registry read fails CLOSED instead of promoting the DB record (the aliased require() the controller uses does not resolve under vitest, so this environment exercises that branch deterministically), pins that /api/agents carries the resolved fields, and pins that the Utilities panel disables the control FROM providerOverridable, renders the API's own reason verbatim, never sends a providerId from a disabled select, and reports a 502 push refusal as not-applied. The classification runs over the REAL active registry so it is not fixture-only. NOT asserted: "some bot is overridable" - every shipped registry entry declares a harness today, and a gate that a legitimate future cline bot would turn red is a gate nobody can act on.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-pointed the retired Utilities surface guard at Config Admin and added executable refusal coverage proving a disabled provider cannot leak into runtime/profile writes
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveEffectiveBotProvider } from '@/shared/llm-runtime';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { AgentProfileController } from '@/features/agent-profile';
import type { AgentProfileService } from '@/features/agent-profile';
import {
  renderSelectedAgentPanelMarkup,
  saveSelectedAgentProfile,
} from '../../src/pages/config-admin/config-admin-agent-panel.js';

const UTILITIES = path.join(process.cwd(), 'src/api/utilities.html');
const CONFIG_ADMIN_PANEL = path.join(process.cwd(), 'src/pages/config-admin/config-admin-agent-panel.js');

afterEach(() => vi.unstubAllGlobals());

/**
 * @description Blank out comment bodies so a code shape that survives only inside a comment cannot
 * satisfy an assertion. Written after a first attempt at the all-pinned check passed against its own
 * explanatory comment.
 * @param src - Raw file text.
 * @returns The text with comments removed.
 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Drive the REAL controller handler and capture what it would have sent. */
async function listAgentsVia(service: AgentProfileService): Promise<Array<Record<string, unknown>>> {
  const controller = new AgentProfileController(service, { warn: () => {}, info: () => {}, error: () => {} });
  let payload: Record<string, unknown> = {};
  const res = {
    status: () => res,
    json: (body: Record<string, unknown>) => { payload = body; return res; },
  } as unknown as Parameters<typeof controller.listAgents>[1];
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybe = (controller.listAgents as any)({ params: {}, query: {} }, res, (err: unknown) => (err ? reject(err) : resolve()));
    Promise.resolve(maybe).then(() => resolve(), reject);
  });
  return (payload.agents ?? []) as Array<Record<string, unknown>>;
}

describe('provider-panel-shows-registry-precedence', () => {
  it('a non-cline registry harness outranks the per-bot DB provider, and SAYS so', () => {
    const r = resolveEffectiveBotProvider({
      harnessType: 'codex-cli',
      apiType: 'openai-codex',
      dbProviderId: 'anthropic',   // an operator's pick that cannot win
      dbModelId: 'gpt-5-codex',
    });
    expect(r.providerSource).toBe('registry-harness');
    expect(r.effectiveProvider).toBe('openai-codex');
    expect(r.effectiveProvider).not.toBe('anthropic');
    expect(r.providerOverridable).toBe(false);
    expect(r.precedenceNote).toMatch(/registry/i);
    expect(r.precedenceNote).toMatch(/no effect|would have no effect/i);
  });

  it('the MODEL stays overridable even when the provider is pinned', () => {
    // The bot-node config bootstrap maps a pulled modelId onto CODEX_MODEL / CLAUDE_CODE_MODEL, so
    // the model reaches a pinned harness even though the provider does not. Reporting the model as
    // un-settable would be as wrong as offering a provider control that does nothing.
    const r = resolveEffectiveBotProvider({ harnessType: 'claude-code', apiType: 'anthropic', dbModelId: 'claude-opus-4' });
    expect(r.providerOverridable).toBe(false);
    expect(r.modelOverridable).toBe(true);
    expect(r.effectiveModel).toBe('claude-opus-4');
  });

  it("'cline' does NOT short-circuit — the per-bot record wins inside it", () => {
    const r = resolveEffectiveBotProvider({ harnessType: 'cline', apiType: 'bedrock', dbProviderId: 'anthropic' });
    expect(r.providerSource).toBe('agent-profile');
    expect(r.effectiveProvider).toBe('anthropic');
    expect(r.providerOverridable).toBe(true);
  });

  it('the registry apiType is consulted BELOW the per-bot record, not above it', () => {
    const withDb = resolveEffectiveBotProvider({ apiType: 'bedrock', dbProviderId: 'anthropic' });
    expect(withDb.providerSource).toBe('agent-profile');
    expect(withDb.effectiveProvider).toBe('anthropic');

    const withoutDb = resolveEffectiveBotProvider({ apiType: 'bedrock' });
    expect(withoutDb.providerSource).toBe('registry-api-type');
    expect(withoutDb.effectiveProvider).toBe('bedrock');
    expect(withoutDb.providerOverridable).toBe(true);
  });

  it("'auto' is the DB's no-opinion sentinel, not a provider named auto", () => {
    const r = resolveEffectiveBotProvider({ dbProviderId: 'auto', apiType: 'bedrock' });
    expect(r.effectiveProvider).toBe('bedrock');
    expect(r.providerSource).toBe('registry-api-type');

    const bare = resolveEffectiveBotProvider({ dbProviderId: 'AUTO' });
    expect(bare.providerSource).toBe('deployment-default');
    expect(bare.effectiveProvider).toBeNull();
  });

  it('nothing bot-specific set reports the deployment default with a NULL provider, never a guess', () => {
    const r = resolveEffectiveBotProvider({});
    expect(r.providerSource).toBe('deployment-default');
    expect(r.effectiveProvider).toBeNull();
    expect(r.precedenceNote).toMatch(/FORCE_LLM_PROVIDER|global-config/);
  });

  it('every tier returns a non-empty reason, so a surface never has to invent one', () => {
    const cases = [
      { harnessType: 'gemini-cli', apiType: 'gemini' },
      { dbProviderId: 'anthropic' },
      { apiType: 'bedrock' },
      {},
    ];
    for (const c of cases) {
      const r = resolveEffectiveBotProvider(c);
      expect(r.precedenceNote.length, JSON.stringify(c)).toBeGreaterThan(40);
    }
  });

  /**
   * Run the rule over the REAL shipped registry so it is not tested only against fixtures.
   *
   * A finding, deliberately NOT asserted as an invariant: every entry in the default registry
   * declares a non-cline harnessType today, so ZERO shipped bots are provider-overridable. That is
   * exactly why the panel's read-only branch and its "nothing here is changeable" empty state
   * matter more than its writable branch. Asserting "at least one overridable bot exists" would
   * make a legitimate future cline bot the thing that turns this red, and a red gate nobody can act
   * on trains everyone to ignore red — so what is pinned here are the real invariants instead.
   */
  it('the rule classifies every REAL registry entry, and a pinned bot always names a provider', () => {
    const registry = getActiveRegistry() as Array<{ name: string; harnessType?: string; apiType?: string }>;
    expect(registry.length).toBeGreaterThan(0);
    const resolved = registry.map((b) => ({
      name: b.name,
      ...resolveEffectiveBotProvider({ harnessType: b.harnessType ?? null, apiType: b.apiType ?? null }),
    }));
    const KNOWN = ['registry-harness', 'agent-profile', 'registry-api-type', 'deployment-default'];
    // 'registry-unreadable' is deliberately absent: this loop passes the registry it just read.
    for (const r of resolved) expect(KNOWN, r.name).toContain(r.providerSource);
    // A pinned bot must always resolve to a concrete provider name — "pinned to nothing" would
    // render as read-only with no answer, which is worse than being changeable.
    for (const r of resolved.filter((x) => x.providerOverridable === false)) {
      expect(r.effectiveProvider, r.name).toBeTruthy();
    }
    // The registry-pinned branch must be exercised by real data, not only by fixtures.
    expect(resolved.filter((r) => r.providerSource === 'registry-harness').length).toBeGreaterThan(0);
  });

  it('utilities-is-connections-not-bot-config: the connections screen carries no per-bot config', () => {
    // /utilities is LOGIN AUTHORIZATION — the place you grant OSHAL access to an account. Per-bot
    // provider/model is CONFIGURATION and belongs to /config, which already owned it. A duplicate
    // panel here pushed "Your accounts" — the only reason anyone opens this page — below a wall of
    // bot settings, and the operator could not find it when he needed to reconnect a broker before
    // its token expired. Guard the SEPARATION, not the one panel that violated it: any future
    // bot-config control on this page should red this, not just the removed one.
    // Comments stripped (HTML and JS): an earlier guard here passed against its own explanatory
    // comment, and the note explaining this removal names the very symbols it forbids.
    const html = stripComments(readFileSync(UTILITIES, 'utf8'));
    for (const symbol of [
      'BOT_STATE', 'loadBotProviders', 'renderBotProviders', 'saveBotProvider',
      'botProviderOptions', 'PROVIDER_SOURCE_LABEL', 'providerOverridable', 'precedenceNote',
    ]) {
      expect(html, `${symbol} is bot configuration — it belongs to /config, not the connections screen`)
        .not.toContain(symbol);
    }
    // No per-bot runtime push-down from this page either — that write is /config's to make.
    expect(html).not.toMatch(/\/runtime['"`]/);
    // ...while the controls this screen DOES own are still here: starting an account connection.
    expect(html).toMatch(/\/api\/connect\/'\s*\+\s*id\s*\+\s*'\/start/);
  });

  it('GET /api/agents carries the resolved precedence fields for the surface to render', async () => {
    // Two DB rows: one whose registry entry pins a harness, one unknown to the registry.
    const registry = getActiveRegistry() as Array<{ agentId?: string; name: string; harnessType?: string; apiType?: string }>;
    const pinnedEntry = registry.find((b) => b.agentId && b.harnessType && b.harnessType !== 'cline');
    expect(pinnedEntry, 'no registry-pinned bot to test against').toBeTruthy();

    const service = {
      listAgents: async () => [
        // The operator's pick on a pinned bot — must be reported as NOT winning.
        { agentId: pinnedEntry!.agentId, name: pinnedEntry!.name, status: 'active', providerId: 'anthropic', modelId: 'claude-opus-4' },
        // A bot the registry does not know — its own record is the highest tier that applies.
        { agentId: 'ffffffff-0000-0000-0000-00000000dead', name: 'unregistered-bot', status: 'active', providerId: 'groq', modelId: null },
      ],
    } as unknown as AgentProfileService;

    const agents = await listAgentsVia(service);
    const pinned = agents.find((a) => a.agentId === pinnedEntry!.agentId)!;
    const free = agents.find((a) => a.agentId === 'ffffffff-0000-0000-0000-00000000dead')!;

    // Every field the panel renders must be present — a missing one silently degrades the row.
    for (const field of ['effectiveProvider', 'providerSource', 'providerOverridable', 'modelOverridable', 'precedenceNote']) {
      expect(pinned[field], `pinned row missing ${field}`).not.toBeUndefined();
      expect(free[field], `unregistered row missing ${field}`).not.toBeUndefined();
    }
    // The controller reaches the registry through an ALIASED require(), which resolves under the
    // tsx/tsconfig-paths runtime but NOT under vitest — so this environment deterministically
    // exercises the failed-read branch. That is the branch worth pinning here, because it is the
    // one that could quietly lie: if a failed registry read were treated as "no harness declared",
    // the panel would promote the DB record and offer an inert provider control. It must FAIL
    // CLOSED instead. (The successful-read classification is pinned against the REAL registry by
    // the resolver test above.)
    for (const row of [pinned, free]) {
      expect(row.providerSource).toBe('registry-unreadable');
      expect(row.providerOverridable).toBe(false);
      expect(row.modelOverridable).toBe(true);
      expect(String(row.precedenceNote)).toMatch(/could not be read/i);
    }
    // Even fail-closed, the operator's own saved values are reported verbatim, never blanked.
    expect(pinned.providerId).toBe('anthropic');
    expect(pinned.effectiveModel).toBe('claude-opus-4');
    expect(free.effectiveProvider).toBe('groq');
  });

  it('a failed registry read fails CLOSED rather than promoting the per-bot record', () => {
    const readable = resolveEffectiveBotProvider({ harnessType: null, dbProviderId: 'groq' });
    expect(readable.providerSource).toBe('agent-profile');
    expect(readable.providerOverridable).toBe(true);

    const unreadable = resolveEffectiveBotProvider({ harnessType: null, dbProviderId: 'groq', registryReadable: false });
    expect(unreadable.providerSource).toBe('registry-unreadable');
    expect(unreadable.providerOverridable).toBe(false);
    // The saved value is still reported — fail-closed means "do not offer the control", not
    // "pretend the operator never set anything".
    expect(unreadable.effectiveProvider).toBe('groq');
    expect(unreadable.modelOverridable).toBe(true);
  });

  it('Config Admin disables its provider from the API policy and renders the API reason', () => {
    const panel = { innerHTML: '' };
    const note = 'The registry harness wins; this provider choice would have no effect.';
    const app = {
      state: {
        selectedAgentId: 'bot-1', selectedAgentTools: [], selectedAgentRuntimeConfig: null,
        agents: [{ agentId: 'bot-1', name: 'Pinned Bot', providerOverridable: false,
          modelOverridable: true, effectiveProvider: 'openai-codex', providerSource: 'registry-harness', precedenceNote: note }],
        selectedAgentProfile: { agentId: 'bot-1', name: 'Pinned Bot', providerId: 'anthropic', modelId: 'gpt-5' },
        providers: [{ id: 'anthropic', displayName: 'Anthropic', models: [] },
          { id: 'openai-codex', displayName: 'Codex', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
      },
      elements: { agentConfigHeading: { textContent: '' }, selectedAgentPanel: panel },
    } as any;

    renderSelectedAgentPanelMarkup(app);

    expect(panel.innerHTML).toMatch(/id="agentProviderInput"[^>]* disabled/);
    expect(panel.innerHTML).toContain(note);
    expect(panel.innerHTML).toMatch(/value="openai-codex" selected/);
    const source = stripComments(readFileSync(CONFIG_ADMIN_PANEL, 'utf8'));
    expect(source).toMatch(/agent\.providerOverridable\s*===\s*false/);
    expect(source).toMatch(/escapeHtml\(precedenceNote\)/);
  });

  it('a bot-side refusal records no profile and never trusts a disabled provider value', async () => {
    const fields: Record<string, any> = {
      '#agentNameInput': { value: 'Pinned Bot' }, '#agentStatusInput': { value: 'active' },
      '#agentProviderInput': { value: 'anthropic', disabled: true },
      '#agentModelInput': { value: 'gpt-5.1', disabled: false },
      '#agentProjectUrlInput': { value: '' }, '#agentSelectorSkillsInput': { value: '' },
      '#agentThemeInput': { value: 'midnight' }, '#agentExcludeFromBulkInput': { checked: false },
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'worker unreachable' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const statuses: string[] = [];
    const app = {
      state: {
        selectedAgentId: 'bot-1',
        selectedAgentProfile: { agentId: 'bot-1', name: 'Pinned Bot', providerId: 'anthropic', modelId: 'gpt-5' },
        agents: [{ agentId: 'bot-1', providerOverridable: false, effectiveProvider: 'openai-codex' }],
      },
      elements: { selectedAgentPanel: { querySelector: (selector: string) => fields[selector] || null } },
      setStatus: (message: string) => statuses.push(message),
    } as any;

    await saveSelectedAgentProfile(app);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/agents\/bot-1\/runtime$/);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ providerId: 'openai-codex', modelId: 'gpt-5.1' });
    expect(statuses.at(-1)).toMatch(/Not applied.*Nothing was recorded/i);
  });

  it('metadata-only saves do not push unchanged displayed runtime defaults', async () => {
    const fields: Record<string, any> = {
      '#agentNameInput': { value: 'Renamed Bot' }, '#agentStatusInput': { value: 'active' },
      '#agentProviderInput': { value: 'openai-codex', disabled: true, dataset: { originalValue: 'openai-codex' } },
      '#agentModelInput': { value: 'gpt-5', disabled: false, dataset: { originalValue: 'gpt-5' } },
      '#agentProjectUrlInput': { value: '' }, '#agentSelectorSkillsInput': { value: '' },
      '#agentThemeInput': { value: 'midnight' }, '#agentExcludeFromBulkInput': { checked: false },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/profile')) {
        return new Response(JSON.stringify({ profile: { agentId: 'bot-1', name: 'Renamed Bot', providerId: 'anthropic', modelId: 'gpt-5' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ authenticated: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = {
      state: { selectedAgentId: 'bot-1', selectedAgentAuth: {},
        selectedAgentProfile: { agentId: 'bot-1', name: 'Pinned Bot', providerId: 'anthropic', modelId: 'gpt-5' },
        agents: [{ agentId: 'bot-1', providerOverridable: false, effectiveProvider: 'openai-codex' }] },
      elements: { selectedAgentPanel: { querySelector: (selector: string) => fields[selector] || null } },
      setStatus: vi.fn(), render: vi.fn(),
    } as any;

    await saveSelectedAgentProfile(app);

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/agents\/bot-1\/profile$/);
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.endsWith('/runtime'))).toBe(false);
  });
});
