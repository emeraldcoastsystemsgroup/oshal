/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard provider-switch-cockpit (headless Chromium over the REAL config-admin page, the REAL AgentProfileController, the REAL /runtime and fleet-default routes, the REAL precedence rule and a REAL ProviderSwitchSnapshot): the per-bot provider select is ENABLED for a registry-declared bot (PR #97 made it read-only because it did nothing; the row makes it do something), its reported source starts at 'registry-harness'; writing the fleet default from the panel is one save and every bot with no row reports 'fleet-default'; saving a provider on one bot writes its own row and it reports 'bot-row' while the other bot stays on the fleet default; clearing the fleet default returns the row-less bot to 'registry-harness'. Doubles: the agent-profile persistence, the config-sync push (pushed:true, persisting into the same in-memory agent_config the switch store reads) and the switch store itself — the database boundary is provider-switch-store-postgres.spec.ts. Chromium is headless; nothing opens on the desktop.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot switch row is an operator-written row of oshal_bot_provider_switch, never the agent_config record: the store double now holds per-bot rows written ONLY through the runtime route's writeBotSwitch seam (wired as agent-provider-mount.ts wires it) and listAll no longer projects agentConfig — the pre-fix projection let the bot-row case pass with the seam absent. The case now asserts the row itself (scope, provider, updatedBy = the session's sub) and that the other bot has none; with the seam unwired the case is red (no bot-row ever appears).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The fallback-order control, driven in a real browser against the real route: an administrator types an ordered list and the stored row carries that EXACT order (asserted as an array - a chain that arrives reordered is a different chain), and an empty box stores [] rather than being guessed as "unchanged". The store double now mirrors the real upsert contract on that argument.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Two cases for the panel defects a review found: editing the MODEL used to wipe a stored fallback chain, because the panel sent fallbackOrder on every save and so could never ask the API to leave it alone; and null ("nothing configured") rendered identically to [] ("deliberately no failover"), so an administrator could not tell which one the fleet had. An untouched control now writes nothing, and a stored empty chain renders as `none`, which round-trips back to [].
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { createAgentProfileRoutes } from '@/app/routes/agent-profile-routes';
import { createConfigRuntimeRoutes } from '@/app/extensions/swarm/routes/config-runtime-routes';
import { createProviderSwitchRoutes } from '@/app/extensions/swarm/routes/provider-switch-routes';
import { getActiveRegistry, registryHarnessEntry } from '@/app/extensions/swarm/swarm-bot-registry';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { buildProviderSwitchCatalog } from '@/app/composition/provider-switch-runtime';
import { AgentProfileController, type AgentProfileService } from '@/features/agent-profile';
import { ProviderSwitchSnapshot, type AgentConfigService, type ProviderSwitchStore } from '@/features/agent-management';
import type { ConfigSyncService } from '@/features/config-sync';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchRow } from '@/shared/llm-runtime';

const OPERATOR = 'provider-switch-browser-operator';
let server: Server | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let origin = '';
let savedOperatorSubs: string | undefined;

/** Two registry bots with a declared LLM harness — the shape the fleet default reaches. */
const [BOT_A, BOT_B] = getActiveRegistry()
  .filter((b) => b.agentId && b.harnessType && b.harnessType !== 'cline' && b.harnessType !== 'a2a')
  .slice(0, 2) as Array<{ agentId: string; name: string; harnessType: string; apiType?: string }>;

/** The persistence doubles: profiles (agents table), agent_config records, and the switch rows (the fleet row and the per-bot rows). */
const profiles = new Map<string, Record<string, unknown>>();
const agentConfig = new Map<string, Record<string, unknown>>();
let fleetRow: ProviderSwitchRow | null = null;
/** The per-bot rows of oshal_bot_provider_switch: written ONLY through the runtime route's writeBotSwitch seam, never projected from agentConfig. */
const perBotRows = new Map<string, ProviderSwitchRow>();

function profileOf(agentId: string, name: string): Record<string, unknown> {
  return {
    agentId, name, status: 'active', providerId: 'openai-codex', modelId: 'gpt-5.5', persona: {},
    baseCapabilities: [], selectorDescriptor: '', routingKeywords: [], projectUrl: '', selectorSkillsText: '',
    avatarUrl: '', themePreference: 'midnight', excludeFromBulkConfig: false, metadata: {}, updatedAt: new Date().toISOString(),
  };
}

/** listAll as the FIXED ProviderSwitchStore reads it: the switch table only — agentConfig is the ADR-034 record beneath the fleet row, never a row here. */
function switchRowsFromDoubles(): ProviderSwitchRow[] {
  return [...(fleetRow ? [fleetRow] : []), ...perBotRows.values()];
}

async function startFixture(): Promise<string> {
  const catalog = buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES));
  const store = {
    listAll: async () => switchRowsFromDoubles(),
    get: async (scopeId: string) => (scopeId === FLEET_DEFAULT_SWITCH_ID ? fleetRow : perBotRows.get(scopeId) ?? null),
    upsert: async (
      scopeId: string, providerId: string, modelId: string | null, updatedBy: string,
      fallbackOrder?: readonly string[] | null,
    ) => {
      const existing = scopeId === FLEET_DEFAULT_SWITCH_ID ? fleetRow : perBotRows.get(scopeId) ?? null;
      const row: ProviderSwitchRow = {
        scopeId, providerId, modelId, updatedBy, updatedAt: new Date().toISOString(),
        // Mirrors the real store: undefined keeps what is there, an explicit array replaces it.
        fallbackOrder: fallbackOrder === undefined ? (existing?.fallbackOrder ?? null) : (fallbackOrder ?? null),
      };
      if (scopeId === FLEET_DEFAULT_SWITCH_ID) fleetRow = row; else perBotRows.set(scopeId, row);
      return row;
    },
    remove: async (scopeId: string) => {
      if (scopeId === FLEET_DEFAULT_SWITCH_ID) { const had = fleetRow !== null; fleetRow = null; return had; }
      return perBotRows.delete(scopeId);
    },
  } as unknown as ProviderSwitchStore;
  const snapshot = new ProviderSwitchSnapshot(store, catalog);
  await snapshot.refresh();
  const resolveSwitch = (agentId: string) => snapshot.resolve(agentId, registryHarnessEntry(agentId));

  const service = {
    listAgents: async () => Array.from(profiles.values()),
    getAgentProfile: async (agentId: string) => profiles.get(agentId) ?? null,
    updateAgentProfile: async (agentId: string, input: Record<string, unknown>) => {
      const next = { ...(profiles.get(agentId) ?? {}), ...input, agentId, updatedAt: new Date().toISOString() };
      profiles.set(agentId, next);
      return next;
    },
  } as unknown as AgentProfileService;
  const controller = new AgentProfileController(service, { info() {}, warn() {}, error() {}, debug() {} }, resolveSwitch, getActiveRegistry);
  const configSync = {
    pushToBot: async (agentId: string, params: Record<string, unknown>) => {
      const before = agentConfig.get(agentId) ?? { configVersion: 0 };
      const newVersion = Number(before.configVersion ?? 0) + 1;
      agentConfig.set(agentId, { ...before, ...params, configVersion: newVersion });
      return { pushed: true, newVersion };
    },
  } as unknown as ConfigSyncService;
  const agentConfigService = {
    getConfig: async (agentId: string) => {
      const values = agentConfig.get(agentId);
      return values ? { configId: `cfg-${agentId}`, agentId, schema: [], values, updatedAt: new Date().toISOString() } : null;
    },
  } as unknown as AgentConfigService;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: OPERATOR } };
    next();
  });
  app.get('/config/', (_req, res) => res.sendFile(resolve('src/pages/config-admin/index.html')));
  app.use('/config-admin', express.static(resolve('src/pages/config-admin')));
  app.get('/shared/ui-debug.js', (_req, res) => res.sendFile(resolve('src/pages/shared/ui-debug.js')));
  app.use('/shared/ui/js', express.static(resolve('src/shared/ui/js')));
  app.use('/shared/ui/css', express.static(resolve('src/shared/ui/css')));
  // surface-theme.js imports the cockpit theme manager and its theme sheets.
  app.use('/cockpit/js', express.static(resolve('src/pages/cockpit/js')));
  app.use('/cockpit/css', express.static(resolve('src/pages/cockpit/css')));
  app.get('/api/config/ownership', (_req, res) => res.json({ ownership: {} }));
  app.get('/api/config/rag', (_req, res) => res.json({ config: {} }));
  app.get('/api/config', (_req, res) => res.json({ config: {} }));
  app.get('/api/providers', (_req, res) => res.json(PROVIDER_DEFINITIONS.map((d) => ({ id: d.id, displayName: d.displayName, models: d.models }))));
  app.get('/api/agents/:agentId/tools', (_req, res) => res.json({ tools: [] }));
  app.get('/api/swarm/agents/:agentId/config', (_req, res) => res.json({ config: null }));
  app.get('/api/:provider/oauth/status', (_req, res) => res.json({ authenticated: true }));
  app.use('/api/agents', createConfigRuntimeRoutes(configSync, agentConfigService, {
    resolveSwitch, catalog: () => catalog, onRuntimeChanged: async () => { await snapshot.refresh(); },
    // Wired exactly as agent-provider-mount.ts wires it: the operator's provider pick is the bot's own row.
    writeBotSwitch: async (agentId, providerId, modelId, updatedBy) => { await store.upsert(agentId, providerId, modelId, updatedBy); },
  }));
  app.use('/api/agents', createProviderSwitchRoutes({ store, snapshot: () => snapshot, catalog: () => catalog }));
  app.use('/api/agents', createAgentProfileRoutes(controller));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server?.once('listening', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  savedOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  profiles.set(BOT_A.agentId, profileOf(BOT_A.agentId, BOT_A.name));
  profiles.set(BOT_B.agentId, profileOf(BOT_B.agentId, BOT_B.name));
  origin = await startFixture();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  // Surface the page's own diagnostics in the runner output, so a failure names the request or
  // script that broke rather than "selector not found".
  page.on('pageerror', (err) => { process.stderr.write(`[browser pageerror] ${err.message}
`); });
  page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') process.stderr.write(`[browser ${msg.type()}] ${msg.text()}
`); });
  page.on('response', (res) => { if (res.status() >= 400) process.stderr.write(`[browser http ${res.status()}] ${res.url()}
`); });
  page.on('requestfailed', (req) => { process.stderr.write(`[browser requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}
`); });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server?.close((err) => (err ? reject(err) : done())));
  }
  if (savedOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS; else process.env.OSHAL_OPERATOR_SUBS = savedOperatorSubs;
});

async function openBot(agentId: string): Promise<void> {
  await page!.click(`[data-agent-config-id="${agentId}"]`);
  await page!.waitForSelector('#agentProviderInput');
}

async function providerSource(): Promise<string | null> {
  return page!.getAttribute('#agentProviderPrecedence', 'data-provider-source');
}

describe('provider-switch-cockpit', () => {
  it('the per-bot provider select is live for a registry-declared bot and reports the registry rung', async () => {
    expect(BOT_A && BOT_B, 'the shipped registry must hold two declared-harness LLM bots').toBeTruthy();
    await page!.goto(`${origin}/config/`, { waitUntil: 'networkidle' });
    await page!.waitForSelector('#fleetDefaultForm[data-fleet-source="registry"]');
    await openBot(BOT_A.agentId);
    expect(await page!.isDisabled('#agentProviderInput')).toBe(false);
    expect(await providerSource()).toBe('registry-harness');
    expect(await page!.textContent('#agentProviderPrecedence')).toMatch(/switch row/i);
  }, 60_000);

  it('saving the fleet default from the panel is ONE write, and a bot with no row reports it', async () => {
    await page!.selectOption('#fleetDefaultProviderInput', 'claude-code');
    await page!.fill('#fleetDefaultModelInput', 'claude-sonnet-4-6');
    await page!.click('#saveFleetDefaultButton');
    await page!.waitForSelector('#fleetDefaultForm[data-fleet-source="fleet-default"]');
    expect(fleetRow).toMatchObject({ scopeId: FLEET_DEFAULT_SWITCH_ID, providerId: 'claude-code', modelId: 'claude-sonnet-4-6', updatedBy: OPERATOR });
    await page!.waitForSelector('#agentProviderPrecedence[data-provider-source="fleet-default"]');
    expect(await page!.textContent('#fleetDefaultStatus')).toContain('claude-code / claude-sonnet-4-6');
  }, 60_000);

  it('the administrator types an ordered fallback chain and the row stores that exact order', async () => {
    // The operator's requirement: as many providers as they want, in the order they want, set in
    // the UX - not curl, not a redeploy. The order is asserted as an ARRAY, because a chain that
    // arrives reordered is a different chain.
    await page!.fill('#fleetDefaultFallbackInput', 'openrouter, anthropic , codex-cli');
    await page!.click('#saveFleetDefaultButton');
    await page!.waitForFunction(
      () => (document.querySelector('#fleetDefaultStatus')?.textContent || '').includes('Fallback order'),
      undefined, { timeout: 20_000 },
    );
    expect(fleetRow?.fallbackOrder).toEqual(['openrouter', 'anthropic', 'codex-cli']);
    expect(await page!.inputValue('#fleetDefaultFallbackInput')).toBe('openrouter, anthropic, codex-cli');

    // An empty box is the deliberate "no failover", stored as [] - never guessed as "unchanged".
    await page!.fill('#fleetDefaultFallbackInput', '');
    await page!.click('#saveFleetDefaultButton');
    await page!.waitForFunction(
      () => (document.querySelector('#fleetDefaultStatus')?.textContent || '').includes('Fallback: none'),
      undefined, { timeout: 20_000 },
    );
    expect(fleetRow?.fallbackOrder).toEqual([]);
  }, 60_000);

  it('an untouched chain control writes NOTHING, so the API is told to leave the chain alone', async () => {
    // null ("no chain configured, inherit") and [] ("configured, deliberately no failover") are
    // different answers, and the API is told which by whether fallbackOrder is PRESENT at all.
    // The panel sent it on every save, so it could never say "leave it alone" — which made the
    // store's own "a provider change must not wipe the chain" protection unreachable from the
    // only UI that writes the row, and rewrote a null chain to [] the first time anyone saved.
    //
    // Asserted on the REQUEST BODY rather than on the resulting row, because the row cannot
    // distinguish "sent the same value back" from "did not send it" — and that distinction is
    // the whole defect.
    const bodies: Array<Record<string, unknown>> = [];
    const capture = (request: { url(): string; method(): string; postData(): string | null }): void => {
      if (request.method() !== 'PUT' || !request.url().includes('/provider-switch/fleet-default')) return;
      try { bodies.push(JSON.parse(request.postData() || '{}')); } catch { /* not our write */ }
    };
    page!.on('request', capture);
    try {
      // Store a chain, then touch ONLY the model.
      await page!.fill('#fleetDefaultFallbackInput', 'openrouter, anthropic');
      await page!.click('#saveFleetDefaultButton');
      await page!.waitForFunction(
        () => (document.querySelector('#fleetDefaultStatus')?.textContent || '').includes('Fallback order'),
        undefined, { timeout: 20_000 },
      );
      expect(bodies.at(-1), 'an edited control sends the chain').toHaveProperty('fallbackOrder');

      await page!.fill('#fleetDefaultModelInput', 'gpt-5.5');
      await page!.click('#saveFleetDefaultButton');
      await page!.waitForFunction(
        () => (document.querySelector('#fleetDefaultStatus')?.textContent || '').includes('gpt-5.5'),
        undefined, { timeout: 20_000 },
      );
      expect(bodies.at(-1), 'the model-only save must have happened').toMatchObject({ modelId: 'gpt-5.5' });
      expect(
        Object.keys(bodies.at(-1) ?? {}),
        'an untouched chain control must omit fallbackOrder entirely',
      ).not.toContain('fallbackOrder');
      expect(fleetRow?.fallbackOrder).toEqual(['openrouter', 'anthropic']);
    } finally {
      page!.off('request', capture);
    }
  }, 60_000);

  it('an explicitly empty chain renders as a word, not as an empty box', async () => {
    // null (nothing configured) and [] (deliberately no failover) are different answers, and an
    // empty box could not tell them apart - so an administrator could not see which one they had.
    await page!.fill('#fleetDefaultFallbackInput', '');
    await page!.click('#saveFleetDefaultButton');
    await page!.waitForFunction(
      () => (document.querySelector('#fleetDefaultStatus')?.textContent || '').includes('Fallback: none'),
      undefined, { timeout: 20_000 },
    );
    expect(fleetRow?.fallbackOrder).toEqual([]);
    expect(await page!.inputValue('#fleetDefaultFallbackInput'), 'a stored empty chain is visible').toBe('none');

    // And typing that same word back is not a provider named "none" — it round-trips to [].
    await page!.click('#saveFleetDefaultButton');
    expect(fleetRow?.fallbackOrder).toEqual([]);
  }, 60_000);

  it('saving a provider on one bot writes its own row (bot-row) while the other stays on the fleet default', async () => {
    await page!.selectOption('#agentProviderInput', 'gemini');
    await page!.click('#saveAgentProfileButton');
    await page!.waitForSelector('#agentProviderPrecedence[data-provider-source="bot-row"]');
    // The rung came from the bot's OWN switch row, written by the route under the session's sub; the
    // agent_config record is still the ADR-034 push-before-persist record beside it, not the rung.
    expect(perBotRows.get(BOT_A.agentId)).toMatchObject({ scopeId: BOT_A.agentId, providerId: 'gemini', updatedBy: OPERATOR });
    expect(perBotRows.has(BOT_B.agentId)).toBe(false);
    expect(agentConfig.get(BOT_A.agentId)).toMatchObject({ providerId: 'gemini' });
    await openBot(BOT_B.agentId);
    expect(await providerSource()).toBe('fleet-default');
  }, 60_000);

  it('clearing the fleet default returns the row-less bot to the registry rung; the bot with a row keeps it', async () => {
    await page!.click('#clearFleetDefaultButton');
    await page!.waitForSelector('#fleetDefaultForm[data-fleet-source="registry"]');
    expect(fleetRow).toBeNull();
    await page!.waitForSelector('#agentProviderPrecedence[data-provider-source="registry-harness"]');
    await openBot(BOT_A.agentId);
    expect(await providerSource()).toBe('bot-row');
  }, 60_000);
});
