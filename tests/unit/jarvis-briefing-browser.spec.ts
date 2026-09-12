/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove browser settings persist and source delivery honors voice/bubble/screen channels.
 */
import { chromium, type Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startBriefingFixture, alice, sourceId } from '../fixtures/jarvis-briefings';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let fixture: Awaited<ReturnType<typeof startBriefingFixture>>, browser: Browser;
beforeAll(async () => { fixture = await startBriefingFixture(); browser = await chromium.launch({ headless: true }); }, 120_000);
afterAll(async () => { await browser?.close(); await fixture?.stop(); });

it('saves preferences from the real page, survives reload, escapes metadata, and follows the light theme', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-auth': '1' } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem('cockpit-theme', 'daylight'));
    await page.goto(fixture.base + '/api/jarvis/briefings/settings');
    const card = page.locator('article'); await card.waitFor();
    expect(await card.locator('h2').textContent()).toBe('Fixture <script> source');
    expect(await card.locator('script').count()).toBe(0);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('daylight');
    expect(await page.getByRole('link', { name: 'Back to Jarvis' }).getAttribute('href')).toBe('/api/jarvis/ui');
    await card.getByLabel('Frequency').selectOption('daily');
    await card.getByLabel('Channel').selectOption('screen');
    await card.getByLabel('Enabled', { exact: true }).uncheck();
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => card.getByRole('status').textContent()).toBe('Saved');
    await page.reload(); await card.waitFor();
    expect(await card.getByLabel('Enabled', { exact: true }).isChecked()).toBe(false);
    expect(await card.getByLabel('Frequency').inputValue()).toBe('daily');
    expect(await card.getByLabel('Channel').inputValue()).toBe('screen');
    expect(await fixture.publish('browser-disabled')).toBe(false);
  } finally { await context.close(); }
}, 30_000);

it('keeps failed selections for retry and shows a readable temporary error', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-auth': '1' } });
  const page = await context.newPage();
  try {
    await page.goto(fixture.base + '/api/jarvis/briefings/settings'); const card = page.locator('article'); await card.waitFor();
    await card.getByLabel('Frequency').selectOption('weekly');
    await page.route(url => decodeURIComponent(url.pathname) === '/api/jarvis/briefings/' + sourceId,
      route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"briefings_unavailable"}' }));
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => card.getByRole('status').textContent()).toBe('Briefings are temporarily unavailable. Please try again.');
    expect(await card.getByLabel('Frequency').inputValue()).toBe('weekly');
    expect(await card.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true);
  } finally { await context.close(); }
}, 30_000);

it('the actual shelf and open-result code purge unavailable briefings and old offers while retaining ordinary work', async () => {
  await fixture.pool.query('TRUNCATE jarvis_tasks,jarvis_briefing_preferences,jarvis_briefing_cursors');
  await fixture.publish('cached-briefing');
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-auth': '1' } }); const page = await context.newPage();
  try {
    await page.goto(fixture.base + '/api/jarvis/briefings/settings'); await page.locator('article').waitFor();
    const html = readFileSync(resolve('src/api/jarvis.html'), 'utf8');
    const poll = html.slice(html.indexOf('async function pollShelf()'), html.indexOf('function startShelfPoller()'));
    const open = html.slice(html.indexOf('async function openJob('), html.indexOf('async function dismissJob('));
    await page.addScriptTag({ content: `
      const durableTaskResults = { ordinary: {id:'ordinary',status:'done',result:'ordinary retained'} };
      let pendingResultOfferId='cached-briefing', pendingCatchupOffer=true, lastShelfJobs=[], shelfPrimed=true;
      const shelfPolling=false, mode='listening'; const statuses=[];
      function renderShelf(){} function setMode(){} function setStatus(value){statuses.push(value);}
      ${poll}\n${open}
      window.briefingShelfFixture={pollShelf,openJob,read:()=>({cache:durableTaskResults,pendingResultOfferId,pendingCatchupOffer,statuses})};
    ` });
    await page.evaluate(() => (window as any).briefingShelfFixture.pollShelf());
    expect(await page.evaluate(() => Boolean((window as any).briefingShelfFixture.read().cache['cached-briefing']))).toBe(true);
    await fixture.service.savePreference(alice, sourceId, { enabled: false, frequency: 'daily', channel: 'screen' });
    await page.evaluate(() => (window as any).briefingShelfFixture.openJob('cached-briefing'));
    await page.evaluate(() => (window as any).briefingShelfFixture.pollShelf());
    const state = await page.evaluate(() => (window as any).briefingShelfFixture.read());
    expect(state.cache).toEqual({ ordinary: { id: 'ordinary', status: 'done', result: 'ordinary retained' } });
    expect(state.pendingResultOfferId).toBeNull(); expect(state.pendingCatchupOffer).toBe(false);
    expect(state.statuses).toContain('That briefing is no longer available.');
  } finally { await context.close(); }
}, 30_000);

it('the real client claims source updates once and invokes only the selected channel', async () => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-auth': '1' } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.goto(fixture.base + '/api/jarvis/briefings/settings'); await page.locator('article').waitFor();
    for (const channel of ['voice', 'bubble', 'screen'] as const) {
      await fixture.service.savePreference(alice, sourceId, { enabled: true, frequency: 'as-available', channel });
      await fixture.publish(`browser-${channel}`);
      const observed = await page.evaluate(async ({ id, sourceId }) => {
        const calls: Array<{ count: number; voice: boolean }> = [];
        const task = { id, status: 'done', title: 'Fixture: update', briefing: { sourceId } };
        await (window as any).OshalBriefings.deliver([task], true, (items: unknown[], _away: boolean, voice: boolean) => calls.push({ count: items.length, voice }));
        await (window as any).OshalBriefings.deliver([task], true, () => calls.push({ count: 99, voice: true }));
        return calls;
      }, { id: `browser-${channel}`, sourceId });
      expect(observed).toEqual(channel === 'screen' ? [] : [{ count: 1, voice: channel === 'voice' }]);
    }
    await fixture.service.savePreference(alice, sourceId, { enabled: true, frequency: 'as-available', channel: 'voice' });
    await fixture.publish('mixed-voice');
    const mixed = await page.evaluate(async sourceId => {
      const calls: Array<{ ids: string[]; voice: boolean }> = [];
      await (window as any).OshalBriefings.deliver([{ id: 'ordinary-mixed' }, { id: 'mixed-voice', briefing: { sourceId } }], false,
        (items: Array<{ id: string }>, _away: boolean, voice: boolean) => calls.push({ ids: items.map(item => item.id), voice }));
      return calls;
    }, sourceId);
    expect(mixed).toEqual([{ ids: ['ordinary-mixed','mixed-voice'], voice: true }]);
    await fixture.publish('claim-failure');
    await page.route('**/api/jarvis/briefings/claim', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    const count = await page.evaluate(async sourceId => {
      let calls = 0;
      try { await (window as any).OshalBriefings.deliver([{ id: 'claim-failure', briefing: { sourceId } }], false, () => calls++); } catch { /* Expected server refusal. */ }
      return calls;
    }, sourceId);
    expect(count).toBe(0);
    const ordinary = await page.evaluate(async sourceId => {
      const ids: string[] = [];
      try { await (window as any).OshalBriefings.deliver([{ id: 'ordinary-after-error' }, { id: 'claim-failure', briefing: { sourceId } }], false,
        (items: Array<{ id: string }>) => ids.push(...items.map(item => item.id))); } catch { /* Only ordinary work is delivered. */ }
      return ids;
    }, sourceId);
    expect(ordinary).toEqual(['ordinary-after-error']);
  } finally { await context.close(); }
}, 30_000);
