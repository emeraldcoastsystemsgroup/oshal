/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove resumable partial onboarding writes, caller ownership and unavailable persistence through real HTTP and disposable PostgreSQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { createOnboardingFixture } from '../fixtures/onboarding';

const database = new DisposableAlertPostgres();
let fixture: Awaited<ReturnType<typeof createOnboardingFixture>>;
beforeAll(async () => {
  const pool = await database.start();
  await pool.query(`CREATE TABLE user_preferences(user_id TEXT PRIMARY KEY, onboarding_completed BOOLEAN DEFAULT FALSE,
    onboarding_step INTEGER DEFAULT 0, onboarding_data JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now())`);
  fixture = await createOnboardingFixture(pool);
}, 30000);
beforeEach(async () => { await database.pool.query('TRUNCATE user_preferences'); });
afterAll(async () => { await fixture?.close(); await database.stop(); });

function call(user = 'alice', body?: unknown, origin?: string) {
  return fetch(`${fixture.base}/api/user/onboarding`, { method: body === undefined ? 'GET' : 'PUT',
    headers: { cookie: `fixture-user=${user}`, origin: origin || fixture.base, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe('first-run progress HTTP boundary', () => {
  it('preserves completed choices during partial updates and isolates users', async () => {
    expect((await call('alice', { completed: true, currentStep: 4, data: { provisioning: { source: 'official' }, savedChoice: 'kept' } })).status).toBe(200);
    expect((await call('alice', { currentStep: 5, data: { stepId: 'people' } })).status).toBe(200);
    expect(await (await call()).json()).toEqual({ completed: true, currentStep: 5,
      data: { provisioning: { source: 'official' }, savedChoice: 'kept', stepId: 'people' } });
    expect(await (await call('bob')).json()).toEqual({ completed: false, currentStep: 0, data: {} });
    expect((await call('bob', { data: { userId: 'alice', harmlessPreference: 'own' } })).status).toBe(200);
    expect((await (await call()).json()).data.harmlessPreference).toBeUndefined();
  });

  it('refuses anonymous, cross-origin and malformed writes without changing progress', async () => {
    expect((await call('unknown')).status).toBe(401);
    expect((await call('unknown', { completed: true })).status).toBe(401);
    expect((await call('alice', { completed: true }, 'https://unrelated.test')).status).toBe(403);
    for (const body of [{ currentStep: -1 }, { currentStep: 1.5 }, { completed: 'true' }, { userId: 'bob' }, { data: { large: 'a'.repeat(17000) } }]) {
      expect((await call('alice', body)).status).toBe(400);
    }
    expect((await database.pool.query('SELECT count(*)::int AS n FROM user_preferences')).rows[0].n).toBe(0);
  });

  it('reports a failed read instead of presenting an existing installation as fresh', async () => {
    await database.pool.query('ALTER TABLE user_preferences RENAME TO unavailable_preferences');
    try { expect((await call()).status).toBe(503); }
    finally { await database.pool.query('ALTER TABLE unavailable_preferences RENAME TO user_preferences'); }
  });
});
