/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the real welcome wizard through source review, failed installs, retry, resume and account-management links.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep trust, completion and recovery cases in bounded test groups with shared isolated fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { createOnboardingFixture } from '../fixtures/onboarding';

const database = new DisposableAlertPostgres();
let fixture: Awaited<ReturnType<typeof createOnboardingFixture>>, browser: Browser, context: BrowserContext, page: Page;
beforeAll(async () => {
  const pool = await database.start();
  await pool.query(`CREATE TABLE user_preferences(user_id TEXT PRIMARY KEY, onboarding_completed BOOLEAN DEFAULT FALSE,
    onboarding_step INTEGER DEFAULT 0, onboarding_data JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT now())`);
  fixture = await createOnboardingFixture(pool); browser = await chromium.launch({ headless: true });
}, 30000);
beforeEach(async () => {
  await database.pool.query('TRUNCATE user_preferences');
  await database.pool.query(`INSERT INTO user_preferences(user_id,onboarding_data) VALUES('alice',$1)`,
    [{ stepId: 'sources', provisioning: { source: 'official', selected: [], installed: [] } }]);
  fixture.state.active.clear(); fixture.state.failures.clear(); fixture.state.installs.length = 0;
  fixture.state.previews.length = 0; fixture.state.replacement = false; fixture.state.revoked = false;
  context = await browser.newContext(); await context.addCookies([{ name: 'fixture-user', value: 'alice', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); await page.goto(`${fixture.base}/welcome/`);
  await page.locator('#provisioning-source').waitFor();
}, 30000);
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); await fixture?.close(); await database.stop(); });

const card = (name: string) => page.locator(`[data-package="official/${name}"]`);
async function apps() { await page.locator('#btnNext').click(); await card('alpha').waitFor(); }
async function install(name: string) {
  await card(name).getByRole('button', { name: 'Review installation' }).click();
  await card(name).getByRole('button', { name: `Install ${name}`, exact: true }).click();
}

describe('first-run installation source review and retry', () => {
  it('offers trusted sources only, keeps foreign text inert and requires review before installation', async () => {
    expect(await page.locator('#provisioning-source option').allTextContents()).toEqual(['Choose a source', 'Official fixture source']);
    await apps(); expect(await page.locator('#wizardStep img').count()).toBe(0);
    await card('alpha').getByRole('checkbox').check();
    expect(fixture.state.installs).toEqual([]);
    await install('alpha');
    await expect.poll(() => card('alpha').getByRole('status').textContent()).toContain('alpha: installed.');
    expect(fixture.state.previews).toEqual(['alpha']); expect(fixture.state.installs).toEqual(['alpha']);
    await page.reload(); await card('alpha').waitFor();
    expect(await card('alpha').getByRole('checkbox').isChecked()).toBe(true);
    expect(await card('alpha').getByRole('status').textContent()).toContain('Installed.');
    expect(fixture.state.installs).toHaveLength(1);
  });

  it('retains a successful package when another fails, supports retry, and links existing account management', async () => {
    await apps(); await card('alpha').getByRole('checkbox').check(); await card('beta').getByRole('checkbox').check();
    await install('alpha'); await expect.poll(() => card('alpha').getByRole('status').textContent()).toContain('installed.');
    fixture.state.failures.add('beta'); await install('beta');
    await expect.poll(() => card('beta').getByRole('status').textContent()).toContain('beta: Fixture package cannot start');
    await page.reload(); await card('beta').waitFor();
    expect(await card('alpha').getByRole('status').textContent()).toContain('Installed.');
    fixture.state.failures.clear(); await install('beta');
    await expect.poll(() => card('beta').getByRole('status').textContent()).toContain('beta: installed.');
    expect(fixture.state.installs).toEqual(['alpha', 'beta', 'beta']);
    await page.locator('#btnNext').click(); await page.getByRole('link', { name: 'Open Users', exact: true }).waitFor();
    expect(await page.getByRole('link', { name: 'Open Access Administration' }).getAttribute('href')).toBe('/access/');
  });

});

describe('first-run installation completion and resume', () => {
  it('does not replace another source or finish while a selected package remains pending', async () => {
    await apps(); await card('alpha').getByRole('checkbox').check(); fixture.state.replacement = true;
    await card('alpha').getByRole('button', { name: 'Review installation' }).click();
    await card('alpha').getByRole('link', { name: 'Review source replacement' }).waitFor();
    expect(await card('alpha').getByRole('button', { name: 'Install alpha', exact: true }).count()).toBe(0);
    for (let step = 0; step < 4; step++) await page.locator('#btnNext').click();
    await page.locator('#btnFinish').click();
    await expect.poll(() => page.locator('#wizardStatus').textContent()).toContain('still pending');
    expect(page.url()).toContain('/welcome'); expect(fixture.state.installs).toEqual([]);
    expect((await database.pool.query("SELECT onboarding_completed FROM user_preferences WHERE user_id='alice'")).rows[0].onboarding_completed).toBe(false);
  });

  it('finishes after verified install and re-enters with saved choices when requested', async () => {
    await apps(); await card('alpha').getByRole('checkbox').check(); await install('alpha');
    await expect.poll(() => card('alpha').getByRole('status').textContent()).toContain('installed.');
    for (let step = 0; step < 4; step++) await page.locator('#btnNext').click();
    await page.locator('#btnFinish').click(); await page.waitForURL('**/cockpit');
    expect((await database.pool.query("SELECT onboarding_completed FROM user_preferences WHERE user_id='alice'")).rows[0].onboarding_completed).toBe(true);
    await page.goto(`${fixture.base}/welcome/?resume=1`);
    await page.getByRole('heading', { name: 'Review your setup' }).waitFor();
    expect(page.url()).toContain('/welcome/'); expect(fixture.state.installs).toEqual(['alpha']);
  });

  it('can skip a previously selected package after its source becomes unavailable', async () => {
    await apps(); await card('alpha').getByRole('checkbox').check();
    await expect.poll(async () => (await database.pool.query("SELECT onboarding_data FROM user_preferences WHERE user_id='alice'")).rows[0].onboarding_data.provisioning.selected.length).toBe(1);
    fixture.state.revoked = true; await page.reload();
    await page.getByRole('button', { name: 'Skip this selection' }).click();
    await expect.poll(async () => (await database.pool.query("SELECT onboarding_data FROM user_preferences WHERE user_id='alice'")).rows[0].onboarding_data.provisioning.selected.length).toBe(0);
    expect(fixture.state.installs).toEqual([]);
  });

});

describe('first-run installation scope and state recovery', () => {
  it('allows app-focused completion while retaining unrelated pending global choices', async () => {
    await database.pool.query("UPDATE user_preferences SET onboarding_data=$1 WHERE user_id='alice'",
      [{ stepId: 'done', provisioning: { source: 'official', selected: [{ registry: 'official', name: 'alpha' }], installed: [] } }]);
    await page.goto(`${fixture.base}/welcome/?app=focused&resume=1`);
    await page.locator('#btnFinish').click(); await page.waitForURL('**/cockpit/?app=focused');
    const saved = (await database.pool.query("SELECT onboarding_data FROM user_preferences WHERE user_id='alice'")).rows[0].onboarding_data;
    expect(saved.provisioning.selected).toEqual([{ registry: 'official', name: 'alpha' }]);
    expect(fixture.state.installs).toEqual([]);
  });

  it('invalidates a successful receipt if another source subsequently replaces the package', async () => {
    await apps(); await card('alpha').getByRole('checkbox').check(); await install('alpha');
    await expect.poll(() => card('alpha').getByRole('status').textContent()).toContain('installed.');
    fixture.state.replacement = true;
    for (let step = 0; step < 4; step++) await page.locator('#btnNext').click();
    await page.locator('#btnFinish').click();
    await expect.poll(() => page.locator('#wizardStatus').textContent()).toContain('still pending');
    expect(page.url()).toContain('/welcome'); expect(fixture.state.installs).toEqual(['alpha']);
  });

  it('keeps unavailable saved state from being overwritten and ordinary users from installing', async () => {
    await database.pool.query('ALTER TABLE user_preferences RENAME TO unavailable_preferences');
    try {
      await page.reload(); await expect.poll(() => page.locator('#wizardStatus').textContent()).toContain('progress is unavailable');
      expect(await page.locator('#btnNext').isDisabled()).toBe(true);
    } finally { await database.pool.query('ALTER TABLE unavailable_preferences RENAME TO user_preferences'); }
    await database.pool.query("INSERT INTO user_preferences(user_id,onboarding_data) VALUES('bob',$1)",
      [{ stepId: 'capabilities', provisioning: { source: 'official' } }]);
    await context.addCookies([{ name: 'fixture-user', value: 'bob', url: fixture.base }]); await page.reload();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toContain('Administrator required');
    expect(await page.getByRole('button', { name: 'Review installation' }).count()).toBe(0);
    expect(fixture.state.installs).toEqual([]);
  });
});
