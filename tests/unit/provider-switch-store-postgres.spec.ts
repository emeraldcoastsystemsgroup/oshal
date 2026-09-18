/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary companion for "a bot's LLM provider is a row in a table": migration 147 as shipped on a DISPOSABLE PostgreSQL this spec owns, the real ProviderSwitchStore and ProviderSwitchSnapshot, and the real GUC pool wrapper — as the ENFORCING oshal_app role (self-validated: current_user, not superuser, not RLS-bypassing, table owner under FORCE RLS). Proves: an operator identity writes the fleet-default and per-bot rows, a non-operator identity is refused by the table's own policy (42501) and still reads, the CHECKs refuse a malformed scope, the snapshot resolves per-bot > fleet > registry from the rows Postgres holds, and a removed row falls back. No double on the boundary; the deployment database is never touched (the fixture publishes its own loopback port).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot row is the real agent_config record (migrations 001 + 011 applied beside 147): the store's listAll is proven to project agent_config.config_values.providerId/modelId/configUpdatedBy into the same ProviderSwitchRow shape as the fleet row, an 'auto' record is proven to be no row, and the table's CHECK is proven to refuse a per-bot scope so the fleet table can never become a second per-bot store. The ladder cases (bot-row > fleet > registry, refusal by name, fall-back on removal) now run over the two stores the deployment actually has.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Entry 2 was the defect (ADR-162 §7 failed for every bot on the box): an agent_config record is a machinery-written dispatch artefact, never a switch, and reading it as one let 70 rows outrank a fleet-default write. Inverted, not deleted: listAll is proven to read ONLY oshal_bot_provider_switch (a record that even claims an operator tag is not a row); a per-bot scope is ACCEPTED in the table for an operator and refused by the policy for anyone else; and a new describe reproduces the operator box's exact row shape from tests/fixtures/agent-config-provider-rows-2026-09-17.json (70 agents + agent_config records, blank/bot-local/oshal-push configUpdatedBy, zero switch rows), registers the package bots into the ACTIVE registry as the app loader does, and drives the REAL dispatch resolver (createAgentConfigRuntimeParamsResolver over the real AgentConfigService on this pool) to prove: zero rows = the registry rung and the agent_config record byte-identically; ONE fleet-default write moves ALL 70 (registry and package bots alike) in the resolver and in the stamped dispatch record; a second write moves all 70 again ("switch it to codex tomorrow"); an operator-written per-bot row beats the fleet row for that bot only; clearing returns every bot to where it started. Red on the pre-fix store (70 bots answered 'bot-row' with their agent_config provider after the fleet write).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  AgentConfigService,
  ProviderSwitchSnapshot,
  ProviderSwitchStore,
  createAgentConfigRuntimeParamsResolver,
  type RuntimeParamsResolver,
} from '@/features/agent-management';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';
import {
  registerAppBots,
  registryDeclaredProvider,
  registryHarnessEntry,
  unregisterAppBots,
} from '@/app/extensions/swarm/swarm-bot-registry';
import { manifestBotDefinition } from '@/app/extensions/swarm/manifest-bot-definition';

const CATALOG: ProviderSwitchCatalog = {
  harnessTypes: Object.keys(HARNESS_FACTORIES),
  clineApiProviders: PROVIDER_DEFINITIONS.map((p) => p.id),
};
const CODEX_REGISTRY = { harnessType: 'codex-cli', apiType: 'openai-codex' };
const BOT_A = randomUUID();
const BOT_B = randomUUID();
const OPERATOR = { sub: 'operator-sub', isOperator: true };
const PERSON = { sub: 'person-sub', isOperator: false };

/** One agent_config record as measured on the operator box (see the fixture's _source). */
interface BoxRow {
  agentId: string;
  name: string;
  providerId: string;
  modelId: string | null;
  configUpdatedBy: string | null;
  configVersion: number;
  manifestApp: string | null;
}
const BOX_ROWS: BoxRow[] = (JSON.parse(
  readFileSync(resolve('tests/fixtures/agent-config-provider-rows-2026-09-17.json'), 'utf8'),
) as { rows: BoxRow[] }).rows;
/** A provider id none of the 70 records carries, so a bot that "moves" onto it cannot be vacuous. */
const FLEET_PROVIDER_NOBODY_HAS = 'openrouter';

const database = new DisposablePostgres({
  purpose: 'provider-switch', database: 'provider_switch_fixture',
  migrations: ['001-multi-agent-foundation.sql', '011-agent-config.sql', '147-bot-provider-switch.sql'], max: 4,
});
/** The enforcing role's pool — every statement in the cases below goes through it. */
let appPool: Pool;
let store: ProviderSwitchStore;
let snapshot: ProviderSwitchSnapshot;

beforeAll(async () => {
  process.env.OSHAL_DB_GUC = 'on';
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  const superuser = await database.start();
  const appPassword = randomUUID();
  // The runtime role exactly as app-role-provisioning.sql shapes it: a login role that owns the
  // table (startup DDL) and is therefore scoped ONLY because the table forces row security.
  await superuser.query(`CREATE ROLE oshal_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD '${appPassword}'`);
  await superuser.query('GRANT USAGE ON SCHEMA public TO oshal_app');
  await superuser.query('ALTER TABLE oshal_bot_provider_switch OWNER TO oshal_app');
  // agent_config (no RLS, per migration 011) and its agents FK: the enforcing role reads and writes
  // them exactly as ConfigSyncService does in the deployment.
  await superuser.query('GRANT SELECT, INSERT, UPDATE, DELETE ON agents, agent_config TO oshal_app');
  await superuser.query(
    `INSERT INTO agents (agent_id, name, api_provider_id) VALUES ($1, 'bot-a', 'openai-codex'), ($2, 'bot-b', 'openai-codex')`,
    [BOT_A, BOT_B],
  );
  const conn = database.connection;
  appPool = wrapPoolWithGuc(new Pool({
    host: conn.host, port: conn.port, database: conn.database, user: 'oshal_app', password: appPassword, max: 4,
  }));
  store = new ProviderSwitchStore(appPool);
  snapshot = new ProviderSwitchSnapshot(store, CATALOG);
}, 180_000);

afterAll(async () => {
  snapshot?.stop();
  try { await appPool?.end(); } finally { await database.stop(); }
});

/** Write a bot's agent_config record the way ConfigSyncService persists it (no RLS on that table). */
async function writeAgentConfig(agentId: string, values: Record<string, unknown>): Promise<void> {
  await runWithSystemIdentity(() => appPool.query(
    `INSERT INTO agent_config (agent_id, config_values) VALUES ($1, $2::jsonb)
     ON CONFLICT (agent_id) DO UPDATE SET config_values = EXCLUDED.config_values, updated_at = NOW()`,
    [agentId, JSON.stringify(values)],
  ));
}

describe('provider switch rows on a real PostgreSQL, as the enforcing role', () => {
  it('self-validates the role: oshal_app, not superuser, not RLS-bypassing, owner under FORCE RLS', async () => {
    const who = await runWithSystemIdentity(() => appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; forced: boolean; owner: string }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
         FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.relname = 'oshal_bot_provider_switch'`,
    ));
    expect(who.rows[0]).toEqual({ current_user: 'oshal_app', rolsuper: false, rolbypassrls: false, forced: true, owner: 'oshal_app' });
  });

  it('the operator writes the fleet default: ONE upsert, and a second upsert is an update', async () => {
    const fleet = await runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'claude-code', 'claude-sonnet-4-6', 'operator-sub'));
    expect(fleet).toMatchObject({ scopeId: FLEET_DEFAULT_SWITCH_ID, providerId: 'claude-code', modelId: 'claude-sonnet-4-6', updatedBy: 'operator-sub' });
    expect(fleet.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'openai-codex', 'gpt-5.5', 'operator-sub'));
    expect(again.modelId).toBe('gpt-5.5');
    const count = await runWithSystemIdentity(() => appPool.query<{ n: string }>('SELECT count(*)::text AS n FROM oshal_bot_provider_switch'));
    expect(count.rows[0].n).toBe('1');
  });

  it('a non-operator identity cannot write the fleet row — the TABLE refuses it (42501) — but reads it', async () => {
    await expect(runWithRequestIdentity(PERSON, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'claude-code', null, 'person-sub')))
      .rejects.toMatchObject({ code: '42501' });
    await expect(runWithRequestIdentity(PERSON, () => store.remove(FLEET_DEFAULT_SWITCH_ID))).resolves.toBe(false);
    // ...but reads are open to every identity: resolution runs inside user requests too.
    const rows = await runWithRequestIdentity(PERSON, () => store.listAll());
    expect(rows.map((r) => r.scopeId)).toEqual([FLEET_DEFAULT_SWITCH_ID]);
    const stillThere = await runWithSystemIdentity(() => store.get(FLEET_DEFAULT_SWITCH_ID));
    expect(stillThere?.modelId).toBe('gpt-5.5');
  });

  it('the CHECKs refuse a blank scope, "auto", a provider with whitespace and a blank model', async () => {
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert('   ', 'claude-code', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert('project manager', 'claude-code', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'auto', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'bad id', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'claude-code', '   ', 'x')))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('REGRESSION: an agent_config record is NOT a switch row — listAll reads only this table', async () => {
    // Even a record that carries an operator-looking tag is a dispatch artefact, not a switch: the
    // rung is decided by WHICH TABLE holds the row, never by a string inside config_values.
    await writeAgentConfig(BOT_A, { providerId: 'openai-codex', modelId: 'gpt-4.1', configVersion: 3, configUpdatedBy: 'operator-sub' });
    await writeAgentConfig(BOT_B, { providerId: 'auto', modelId: 'gpt-5.5', configVersion: 1 });
    const rows = await runWithRequestIdentity(PERSON, () => store.listAll());
    expect(rows.map((r) => r.scopeId)).toEqual([FLEET_DEFAULT_SWITCH_ID]);
  });

  it('a per-bot scope is accepted for the operator, refused by the policy for anyone else, and read in the fleet row\'s shape', async () => {
    await expect(runWithRequestIdentity(PERSON, () => store.upsert(BOT_A, 'anthropic', null, 'person-sub')))
      .rejects.toMatchObject({ code: '42501' });
    const row = await runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_A, 'anthropic', 'claude-sonnet-4-6', 'operator-sub'));
    expect(row).toMatchObject({ scopeId: BOT_A, providerId: 'anthropic', modelId: 'claude-sonnet-4-6', updatedBy: 'operator-sub' });
    const rows = await runWithRequestIdentity(PERSON, () => store.listAll());
    expect(rows.map((r) => r.scopeId)).toEqual([FLEET_DEFAULT_SWITCH_ID, BOT_A]);
    expect(rows[1].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the snapshot resolves per-bot > fleet-default > registry from the rows Postgres holds', async () => {
    await snapshot.refresh();
    expect(snapshot.status()).toMatchObject({ loaded: true, rowCount: 2, lastError: null });
    // BOT_A has an operator-written switch row: it wins, in the catalog spelling, with its model.
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'bot-row', providerId: 'anthropic', harnessType: 'cline', modelId: 'claude-sonnet-4-6' });
    // BOT_B has only an agent_config record (and it says 'auto'): the fleet default answers for a
    // registry LLM bot...
    expect(snapshot.resolve(BOT_B, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'fleet-default', providerId: 'openai-codex', harnessType: 'codex-cli', modelId: 'gpt-5.5' });
    // ...but not for an a2a boundary, and not for a bot the registry does not know.
    expect(snapshot.resolve(BOT_B, { harnessType: 'a2a', apiType: 'a2a' })).toMatchObject({ source: 'registry', harnessType: 'a2a' });
    expect(snapshot.resolve(BOT_B, null)).toMatchObject({ source: 'registry', harnessType: null });
  });

  it('a row naming an id the build cannot run is refused with the reason once it is read back', async () => {
    // The table's CHECK only refuses shapes no validator would produce; a bad id written by hand
    // must fail CLOSED at resolution, not fall to the fleet row or the registry.
    await runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_B, 'gemini-3.8-flash', null, 'operator-sub'));
    await snapshot.refresh();
    const r = snapshot.resolve(BOT_B, CODEX_REGISTRY);
    expect(r).toMatchObject({ ok: false, source: 'bot-row', providerId: 'gemini-3.8-flash' });
    if (!r.ok) expect(r.reason).toMatch(/unknown provider id/);
  });

  it('clearing rows falls back rung by rung, and the fleet default is one delete', async () => {
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(BOT_B))).toBe(true);
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(BOT_A))).toBe(true);
    await snapshot.refresh();
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ source: 'fleet-default', providerId: 'openai-codex' });
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(FLEET_DEFAULT_SWITCH_ID))).toBe(true);
    await snapshot.refresh();
    expect(snapshot.status().rowCount).toBe(0);
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toEqual({
      ok: true, source: 'registry', providerId: 'openai-codex', harnessType: 'codex-cli', apiType: 'openai-codex', modelId: null, row: null,
    });
  });

  it('a failed refresh keeps the last good rows and reports the error instead of throwing', async () => {
    const broken = new ProviderSwitchSnapshot({ listAll: async () => { throw new Error('connection reset'); } }, CATALOG);
    await expect(broken.refresh()).resolves.toBeUndefined();
    expect(broken.status()).toMatchObject({ loaded: false, rowCount: 0, lastError: 'connection reset' });
    expect(broken.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ source: 'registry' });
  });
});

describe('the operator box\'s row shape: 70 machinery-written agent_config records, zero switch rows (ADR-162 §7)', () => {
  const FIXTURE_APP_PREFIX = 'provider-switch-fixture:';
  let dispatch: RuntimeParamsResolver;
  let staticRegistryBots = 0;
  let packageBots = 0;

  /** The dispatch record exactly as ADR-034 stamping resolves it (tier 1 switch > tier 2 record > tier 3 registry). */
  const stamped = (agentId: string) => runWithSystemIdentity(() => dispatch(agentId));

  beforeAll(async () => {
    // The two stores the deployment has, in the box's exact shape.
    for (const row of BOX_ROWS) {
      await runWithSystemIdentity(() => appPool.query(
        'INSERT INTO agents (agent_id, name, api_provider_id) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO NOTHING',
        [row.agentId, row.name, row.providerId],
      ));
      await writeAgentConfig(row.agentId, {
        providerId: row.providerId,
        ...(row.modelId ? { modelId: row.modelId } : {}),
        configVersion: row.configVersion,
        ...(row.configUpdatedBy ? { configUpdatedBy: row.configUpdatedBy } : {}),
      });
    }
    // Package bots join the ACTIVE registry at app activation through registerAppBots with the
    // same definition the app loader builds (harness codex-cli unless the manifest says otherwise).
    const byApp = new Map<string, BoxRow[]>();
    for (const row of BOX_ROWS) {
      if (registryHarnessEntry(row.agentId)) { staticRegistryBots += 1; continue; }
      const app = row.manifestApp ?? 'no-manifest';
      byApp.set(app, [...(byApp.get(app) ?? []), row]);
      packageBots += 1;
    }
    for (const [app, rows] of byApp) {
      registerAppBots(`${FIXTURE_APP_PREFIX}${app}`, rows.map((r) => manifestBotDefinition({ agentId: r.agentId, name: r.name })));
    }
    // The REAL dispatch resolver over the REAL agent_config service on this pool, with tier 1 read
    // from this spec's snapshot exactly as the composition root wires the installed one.
    dispatch = createAgentConfigRuntimeParamsResolver(
      new AgentConfigService(appPool),
      registryDeclaredProvider,
      (agentId) => snapshot.resolve(agentId, registryHarnessEntry(agentId)),
    );
    await snapshot.refresh();
  }, 120_000);

  afterAll(() => {
    for (const app of new Set(BOX_ROWS.map((r) => r.manifestApp ?? 'no-manifest'))) unregisterAppBots(`${FIXTURE_APP_PREFIX}${app}`);
  });

  it('the fixture is the box: 70 records, none written by a person, every one an LLM registry bot', async () => {
    const shape = await runWithSystemIdentity(() => appPool.query<{ provider: string; by: string; n: string }>(
      `SELECT config_values->>'providerId' AS provider, coalesce(nullif(config_values->>'configUpdatedBy', ''), '(blank)') AS by, count(*)::text AS n
         FROM agent_config
        WHERE agent_id = ANY($1::uuid[])
        GROUP BY 1, 2 ORDER BY count(*) DESC, 1`,
      [BOX_ROWS.map((r) => r.agentId)],
    ));
    expect(shape.rows).toEqual([
      { provider: 'openai-codex', by: '(blank)', n: '59' },
      { provider: 'claude-code', by: '(blank)', n: '8' },
      { provider: 'anthropic', by: 'oshal-push', n: '1' },
      { provider: 'gemini', by: 'bot-local', n: '1' },
      { provider: 'openai', by: 'bot-local', n: '1' },
    ]);
    expect(BOX_ROWS).toHaveLength(70);
    expect(staticRegistryBots).toBeGreaterThan(0);
    expect(packageBots).toBeGreaterThan(0);
    for (const row of BOX_ROWS) {
      const entry = registryHarnessEntry(row.agentId);
      expect(entry?.harnessType, `${row.name} must be a registry LLM bot`).toMatch(/^(codex-cli|claude-code|cline|gemini-cli)$/);
    }
    expect(snapshot.status().rowCount).toBe(0);
  });

  it('REGRESSION: zero switch rows = the registry rung for every bot, and the dispatch record is the agent_config record, byte for byte', async () => {
    for (const row of BOX_ROWS) {
      expect(snapshot.resolve(row.agentId, registryHarnessEntry(row.agentId)).source, row.name).toBe('registry');
      expect(await stamped(row.agentId), row.name).toEqual({
        providerId: row.providerId, ...(row.modelId ? { model: row.modelId } : {}), configVersion: row.configVersion,
      });
    }
    // The bot-local and push-written records are carried as today: nothing moved because a table appeared.
    expect(await stamped(BOX_ROWS.find((r) => r.name === 'project-manager')!.agentId)).toMatchObject({ providerId: 'gemini', model: 'gemini-3.1-pro', configVersion: 39 });
  });

  it('REGRESSION (ADR-162 §7): ONE fleet-default write moves ALL 70 — resolver and dispatch record — registry bots and package bots alike', async () => {
    expect(BOX_ROWS.some((r) => r.providerId === FLEET_PROVIDER_NOBODY_HAS)).toBe(false);
    await runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, FLEET_PROVIDER_NOBODY_HAS, 'anthropic/claude-sonnet-4.6', 'operator-sub'));
    await snapshot.refresh();
    let moved = 0;
    for (const row of BOX_ROWS) {
      const resolved = snapshot.resolve(row.agentId, registryHarnessEntry(row.agentId));
      expect(resolved, `${row.name} (agent_config ${row.providerId}, configUpdatedBy ${row.configUpdatedBy ?? 'blank'})`)
        .toMatchObject({ ok: true, source: 'fleet-default', providerId: FLEET_PROVIDER_NOBODY_HAS, harnessType: 'cline' });
      expect(await stamped(row.agentId), row.name).toEqual({
        providerId: FLEET_PROVIDER_NOBODY_HAS, model: 'anthropic/claude-sonnet-4.6', configVersion: row.configVersion,
      });
      moved += 1;
    }
    expect(moved).toBe(70);
    // The table holds exactly the one row the operator wrote: nothing was seeded beside it.
    expect(snapshot.status().rowCount).toBe(1);
    // "im not going to switch it to codex tomorrow and we have to hard code a bunch of shit": the
    // second move is the same one write, and every bot follows it — the 8 claude-code, the
    // gemini/openai/anthropic records included.
    await runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'openai-codex', 'gpt-5.5', 'operator-sub'));
    await snapshot.refresh();
    for (const row of BOX_ROWS) {
      expect(snapshot.resolve(row.agentId, registryHarnessEntry(row.agentId)), row.name).toMatchObject({ source: 'fleet-default', providerId: 'openai-codex' });
      expect(await stamped(row.agentId), row.name).toEqual({ providerId: 'openai-codex', model: 'gpt-5.5', configVersion: row.configVersion });
    }
  });

  it('an operator-written per-bot switch row still beats the fleet row — for that bot only — and releasing it rejoins the fleet', async () => {
    const pm = BOX_ROWS.find((r) => r.name === 'project-manager')!;
    await runWithRequestIdentity(OPERATOR, () => store.upsert(pm.agentId, 'claude-code', 'claude-sonnet-4-6', 'operator-sub'));
    await snapshot.refresh();
    expect(snapshot.resolve(pm.agentId, registryHarnessEntry(pm.agentId))).toMatchObject({ source: 'bot-row', providerId: 'claude-code', row: { updatedBy: 'operator-sub' } });
    expect(await stamped(pm.agentId)).toEqual({ providerId: 'claude-code', model: 'claude-sonnet-4-6', configVersion: pm.configVersion });
    for (const row of BOX_ROWS.filter((r) => r.agentId !== pm.agentId)) {
      expect(snapshot.resolve(row.agentId, registryHarnessEntry(row.agentId)).source, row.name).toBe('fleet-default');
    }
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(pm.agentId))).toBe(true);
    await snapshot.refresh();
    expect(snapshot.resolve(pm.agentId, registryHarnessEntry(pm.agentId))).toMatchObject({ source: 'fleet-default', providerId: 'openai-codex' });
  });

  it('clearing the fleet row returns all 70 to the registry rung and their agent_config record, exactly as before the write', async () => {
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(FLEET_DEFAULT_SWITCH_ID))).toBe(true);
    await snapshot.refresh();
    expect(snapshot.status().rowCount).toBe(0);
    for (const row of BOX_ROWS) {
      expect(snapshot.resolve(row.agentId, registryHarnessEntry(row.agentId)).source, row.name).toBe('registry');
      expect(await stamped(row.agentId), row.name).toEqual({
        providerId: row.providerId, ...(row.modelId ? { model: row.modelId } : {}), configVersion: row.configVersion,
      });
    }
  });
});
