/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary companion for "a bot's LLM provider is a row in a table": migration 146 as shipped on a DISPOSABLE PostgreSQL this spec owns, the real ProviderSwitchStore and ProviderSwitchSnapshot, and the real GUC pool wrapper — as the ENFORCING oshal_app role (self-validated: current_user, not superuser, not RLS-bypassing, table owner under FORCE RLS). Proves: an operator identity writes the fleet-default and per-bot rows, a non-operator identity is refused by the table's own policy (42501) and still reads, the CHECKs refuse a malformed scope, the snapshot resolves per-bot > fleet > registry from the rows Postgres holds, and a removed row falls back. No double on the boundary; the deployment database is never touched (the fixture publishes its own loopback port).
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
  migrations: ['146-bot-provider-switch.sql'], max: 4,
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
  it('self-validates the role: oshal_app, not superuser, not RLS-bypassing, owner under FORCE RLS', async () => {
    const who = await runWithSystemIdentity(() => appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; forced: boolean; owner: string }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
         FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.relname = 'oshal_bot_provider_switch'`,
    ));
    expect(who.rows[0]).toEqual({ current_user: 'oshal_app', rolsuper: false, rolbypassrls: false, forced: true, owner: 'oshal_app' });
  });

  it('the operator writes the fleet default and a per-bot row: one upsert each', async () => {
    const fleet = await runWithRequestIdentity(OPERATOR, () => store.upsert(FLEET_DEFAULT_SWITCH_ID, 'claude-code', 'claude-sonnet-4-6', 'operator-sub'));
    expect(fleet).toMatchObject({ scopeId: FLEET_DEFAULT_SWITCH_ID, providerId: 'claude-code', modelId: 'claude-sonnet-4-6', updatedBy: 'operator-sub' });
    expect(fleet.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const bot = await runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_A, 'openai-codex', 'gpt-5.5', 'operator-sub'));
    expect(bot.scopeId).toBe(BOT_A);
    // A second upsert on the same scope is an UPDATE, not a duplicate.
    const again = await runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_A, 'openai-codex', 'gpt-4.1', 'operator-sub'));
    expect(again.modelId).toBe('gpt-4.1');
    const count = await runWithSystemIdentity(() => appPool.query<{ n: string }>('SELECT count(*)::text AS n FROM oshal_bot_provider_switch'));
    expect(count.rows[0].n).toBe('2');
  });

  it('a non-operator identity cannot write a switch row — the TABLE refuses it (42501)', async () => {
    await expect(runWithRequestIdentity(PERSON, () => store.upsert(BOT_B, 'claude-code', null, 'person-sub')))
      .rejects.toMatchObject({ code: '42501' });
    await expect(runWithRequestIdentity(PERSON, () => store.remove(BOT_A))).resolves.toBe(false);
    // ...but reads are open to every identity: resolution runs inside user requests too.
    const rows = await runWithRequestIdentity(PERSON, () => store.listAll());
    expect(rows.map((r) => r.scopeId)).toEqual([FLEET_DEFAULT_SWITCH_ID, BOT_A]);
    const stillThere = await runWithSystemIdentity(() => store.get(BOT_A));
    expect(stillThere?.modelId).toBe('gpt-4.1');
  });

  it('the CHECK constraints refuse a malformed scope, a blank or "auto" provider, and a blank model', async () => {
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert('project-manager', 'claude-code', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_B, 'auto', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_B, 'bad id', null, 'x')))
      .rejects.toMatchObject({ code: '23514' });
    await expect(runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_B, 'claude-code', '   ', 'x')))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('the snapshot resolves per-bot > fleet-default > registry from the rows Postgres holds', async () => {
    await snapshot.refresh();
    expect(snapshot.status()).toMatchObject({ loaded: true, rowCount: 2, lastError: null });
    // BOT_A has its own row.
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'bot-row', providerId: 'openai-codex', modelId: 'gpt-4.1' });
    // BOT_B has none: the fleet default answers for a registry LLM bot...
    expect(snapshot.resolve(BOT_B, CODEX_REGISTRY)).toMatchObject({ ok: true, source: 'fleet-default', providerId: 'claude-code', harnessType: 'claude-code' });
    // ...but not for an a2a boundary, and not for a bot the registry does not know.
    expect(snapshot.resolve(BOT_B, { harnessType: 'a2a', apiType: 'a2a' })).toMatchObject({ source: 'registry', harnessType: 'a2a' });
    expect(snapshot.resolve(BOT_B, null)).toMatchObject({ source: 'registry', harnessType: null });
  });

  it('a row naming an id the build cannot run is refused with the reason once it is read back', async () => {
    // The CHECK is deliberately loose (the api validates before writing); a bad id that reaches
    // the table by hand must fail CLOSED at resolution, not fall to the registry.
    await runWithRequestIdentity(OPERATOR, () => store.upsert(BOT_B, 'gemini-3.8-flash', null, 'by-hand'));
    await snapshot.refresh();
    const r = snapshot.resolve(BOT_B, CODEX_REGISTRY);
    expect(r).toMatchObject({ ok: false, source: 'bot-row', providerId: 'gemini-3.8-flash' });
    if (!r.ok) expect(r.reason).toMatch(/unknown provider id/);
  });

  it('removing rows falls back rung by rung, and the fleet default is one delete', async () => {
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(BOT_B))).toBe(true);
    expect(await runWithRequestIdentity(OPERATOR, () => store.remove(BOT_A))).toBe(true);
    await snapshot.refresh();
    expect(snapshot.resolve(BOT_A, CODEX_REGISTRY)).toMatchObject({ source: 'fleet-default', providerId: 'claude-code' });
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
