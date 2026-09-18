/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary companion for "a bot's LLM provider is a row in a table": migration 146 as shipped on a DISPOSABLE PostgreSQL this spec owns, the real ProviderSwitchStore and ProviderSwitchSnapshot, and the real GUC pool wrapper — as the ENFORCING oshal_app role (self-validated: current_user, not superuser, not RLS-bypassing, table owner under FORCE RLS). Proves: an operator identity writes the fleet-default and per-bot rows, a non-operator identity is refused by the table's own policy (42501) and still reads, the CHECKs refuse a malformed scope, the snapshot resolves per-bot > fleet > registry from the rows Postgres holds, and a removed row falls back. No double on the boundary; the deployment database is never touched (the fixture publishes its own loopback port).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot row is the real agent_config record (migrations 001 + 011 applied beside 146): the store's listAll is proven to project agent_config.config_values.providerId/modelId/configUpdatedBy into the same ProviderSwitchRow shape as the fleet row, an 'auto' record is proven to be no row, and the table's CHECK is proven to refuse a per-bot scope so the fleet table can never become a second per-bot store. The ladder cases (bot-row > fleet > registry, refusal by name, fall-back on removal) now run over the two stores the deployment actually has.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { ProviderSwitchSnapshot, ProviderSwitchStore } from '@/features/agent-management';
import { FLEET_DEFAULT_SWITCH_ID, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';

const CATALOG: ProviderSwitchCatalog = {
  harnessTypes: Object.keys(HARNESS_FACTORIES),
  clineApiProviders: PROVIDER_DEFINITIONS.map((p) => p.id),
};
const CODEX_REGISTRY = { harnessType: 'codex-cli', apiType: 'openai-codex' };
const BOT_A = randomUUID();
const BOT_B = randomUUID();
const OPERATOR = { sub: 'operator-sub', isOperator: true };
const PERSON = { sub: 'person-sub', isOperator: false };

const database = new DisposablePostgres({
  purpose: 'provider-switch', database: 'provider_switch_fixture',
  migrations: ['001-multi-agent-foundation.sql', '011-agent-config.sql', '146-bot-provider-switch.sql'], max: 4,
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

describe('provider switch rows on a real PostgreSQL, as the enforcing role', () => {
  /** Write a bot's agent_config record the way ConfigSyncService persists it (no RLS on that table). */
  async function writeAgentConfig(agentId: string, values: Record<string, unknown>): Promise<void> {
    await runWithSystemIdentity(() => appPool.query(
      `INSERT INTO agent_config (agent_id, config_values) VALUES ($1, $2::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET config_values = EXCLUDED.config_values, updated_at = NOW()`,
      [agentId, JSON.stringify(values)],
    ));
  }

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

  it('the CHECKs refuse a per-bot scope (the table is the fleet switch only), "auto", and a blank model', async () => {
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_A, 'claude-code', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert('project-manager', 'claude-code', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'auto', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'bad id', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'claude-code', '   ', 'x')))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('a per-bot row is the agent_config record, read through listAll in the same shape as the fleet row', async () => {
    await writeAgentConfig(BOT_A, { providerId: 'openai-codex', modelId: 'gpt-4.1', configVersion: 3, configUpdatedBy: 'operator-sub' });
    // An 'auto' record is the documented no-opinion sentinel: it is NOT a row.
    await writeAgentConfig(BOT_B, { providerId: 'auto', modelId: 'gpt-5.5', configVersion: 1 });
    const rows = await runWithRequestIdentity(PERSON, () => store.listAll());
    expect(rows.map((r) => r.scopeId)).toEqual([FLEET_DEFAULT_SWITCH_ID, BOT_A]);
    expect(rows[1]).toMatchObject({ scopeId: BOT_A, providerId: 'openai-codex', modelId: 'gpt-4.1', updatedBy: 'operator-sub' });
    expect(rows[1].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the snapshot resolves per-bot > fleet-default > registry from the rows Postgres holds', async () => {
    await snapshot.refresh();
    expect(snapshot.status()).toMatchObject({ loaded: true, rowCount: 2, lastError: null });
    // BOT_A has its own agent_config record.
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'bot-row', providerId: 'openai-codex', modelId: 'gpt-4.1' });
    // BOT_B has none (its record says 'auto'): the fleet default answers for a registry LLM bot...
    expect(snapshot.resolve(BOT_B, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'fleet-default', providerId: 'openai-codex', harnessType: 'codex-cli', modelId: 'gpt-5.5' });
    // ...but not for an a2a boundary, and not for a bot the registry does not know.
    expect(snapshot.resolve(BOT_B, { harnessType: 'a2a', apiType: 'a2a' })).toMatchObject({ source: 'registry', harnessType: 'a2a' });
    expect(snapshot.resolve(BOT_B, null)).toMatchObject({ source: 'registry', harnessType: null });
  });

  it('a record naming an id the build cannot run is refused with the reason once it is read back', async () => {
    // agent_config has no CHECK on providerId (the api validates before writing); a bad id that
    // reaches the record by hand must fail CLOSED at resolution, not fall to the registry.
    await writeAgentConfig(BOT_B, { providerId: 'gemini-3.8-flash', configVersion: 2 });
    await snapshot.refresh();
    const r = snapshot.resolve(BOT_B, CODEX_REGISTRY);
    expect(r).toMatchObject({ ok: false, source: 'bot-row', providerId: 'gemini-3.8-flash' });
    if (!r.ok) expect(r.reason).toMatch(/unknown provider id/);
  });

  it('clearing records falls back rung by rung, and the fleet default is one delete', async () => {
    await writeAgentConfig(BOT_B, { configVersion: 3 });
    await writeAgentConfig(BOT_A, { modelId: 'gpt-4.1', configVersion: 4 });
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
