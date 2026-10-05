/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise shipped full-swarm, shell and ask transport in an owned Chromium fixture: advisory selected context, exact-frame/document member navigation, fresh-profile reopen refusal and principal-scoped draft/resource recovery. Member APIs, identity and replies are explicit synthetic doubles; this is renderer/transport evidence, not live grants or member authorization acceptance.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Frame, Page } from 'playwright';
import { ContextSchema } from '@/features/surface-bridge';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: BROWSER_HOOK_TIMEOUT_MS });
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>, context: BrowserContext, page: Page;
let issuer: string | null, asks: Array<Record<string, any>>, errors: string[];

beforeAll(async () => { owned = await launchIsolatedBrowser(); });
afterAll(async () => { if (owned) console.info('Member context browser cleanup:', JSON.stringify(await owned.close())); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture(); issuer = 'https://issuer-a.fixture'; asks = []; errors = [];
  fixture.state.ask.polls = 0; fixture.state.education.me.role = 'student';
  context = await owned.browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.route('**/api/auth/user', route => route.fulfill({ json: { authenticated: true, principalIssuer: issuer, user: fixture.state.user } }));
  await context.route('**/api/jarvis/ask', route => { asks.push(route.request().postDataJSON()); return route.continue(); });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
});
afterEach(async () => { try { await context?.close(); } finally { await fixture?.close(); } });

/** @description Open real source rendering through the isolated static-route fixture. */
async function open(layout = 'studio') { await page.goto(fixture.origin + '/' + layout); await page.waitForSelector('.app-shell:not(:has(.loading-shell))'); }
/** @description Select a catalog app using the shipped named-context action. */
async function useContext(app: string) {
  await page.locator('[data-action="directory"]').first().click();
  await page.locator(`#full-dialog [data-catalog-app="${app}"] [data-action="open-app"]`).click();
  await page.locator('#full-dialog [data-action="use-context"]').click();
}
/** @description Host the selected application's admitted surface in its compact aside. */
async function compact(app = 'little-monsters') {
  await useContext(app); await page.locator('.full-context [data-action="toggle-embed"]').click();
  return activeFrame();
}
/** @description The actual member browsing context, rather than a fabricated event source. */
async function activeFrame(): Promise<Frame> {
  const handle = await page.locator('iframe[data-hosted-app]').elementHandle();
  const frame = await handle?.contentFrame(); if (!frame) throw new Error('Missing hosted member frame');
  await frame.waitForSelector('h1'); return frame;
}
/** @description Emit a package navigation request from the real embedded document. */
async function navigate(frame: Frame, data: Record<string, unknown>) { await frame.evaluate(payload => parent.postMessage(payload, location.origin), data); }
/** @description Wait for the shipped frame to reach its owner-defined target. */
async function frameUrl(url: string) { await expect.poll(() => page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe(url); }

describe('selected member context and navigation in shipped experience sources', () => {
  for (const layout of ['studio', 'jarvis', 'orbit', 'commons']) {
    it(layout + ' transports its selected admitted app in the existing advisory ContextSchema', async () => {
      await open(layout); await useContext('finance');
      if (layout === 'orbit') {
        await page.locator('[data-action="orbit-back"]').click();
        await page.locator('[data-action="ask"]').first().click(); await page.fill('#ask-input', 'Discuss this app');
        await page.locator('#ask-form button[type="submit"]').click();
      } else { await page.fill('#message-input', 'Discuss this app'); await page.press('#message-input', 'Enter'); }
      await expect.poll(() => asks.length).toBe(1);
      expect(asks[0].context).toMatchObject({ channel: 'oshal-surface-bridge', v: 1, op: 'context', app: 'finance', can: [], fields: { experience: layout } });
      expect(ContextSchema.safeParse(asks[0].context).success).toBe(true);
      expect(asks[0].context.digest).not.toContain('Synthetic ledger review');
      expect(fixture.state.calls.some(c => /authorization.*(apply|preview)/.test(c))).toBe(false);
      expect(errors).toEqual([]);
    });
  }

  it('follows genuine Little Monsters tools and class resource, preserving Summary/full identity and the shell draft', async () => {
    const classTool = fixture.state.education.tools.find(t => t.id === 'tool-lm-class-c1')!;
    classTool.toolUi.iframeUrl = '/fixture/surface/lm-class-c1?classId=c1&mode=work#assignment-a';
    await open(); await useContext('little-monsters'); await page.fill('#message-input', 'My unsent class question');
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    await navigate(await activeFrame(), { type: 'lm-navigate', view: 'myday' });
    await frameUrl('/fixture/surface/lm-myday?audience=company');
    await navigate(await activeFrame(), { type: 'lm-open-class', classId: 'c1' });
    await frameUrl('/fixture/surface/lm-class-c1?classId=c1&mode=work&audience=company#assignment-a');
    await page.locator('.full-context [data-action="embed-view"][data-view="full"]').click();
    await frameUrl('/fixture/surface/lm-class-c1?classId=c1&mode=work#assignment-a');
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    expect(await page.inputValue('#message-input')).toBe('My unsent class question');
    await page.press('#message-input', 'Enter'); await expect.poll(() => asks.length).toBe(1);
    expect(ContextSchema.parse(asks[0].context)).toMatchObject({ app: 'little-monsters', surface: 'lm-class-c1', recordId: 'c1', can: [] });
  });

  it('ignores wrong-source and wrong-origin requests and refuses unadmitted or unsafe named targets', async () => {
    await open(); await compact(); const baseline = await page.locator('iframe[data-hosted-app]').getAttribute('src');
    const before = fixture.state.calls.filter(c => c === 'GET /api/ui/profile').length;
    await page.evaluate(() => {
      window.postMessage({ type: 'lm-navigate', view: 'myday' }, location.origin);
      const frame = document.querySelector('iframe[data-hosted-app]') as HTMLIFrameElement;
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'https://foreign.fixture', data: { type: 'lm-navigate', view: 'myday' } }));
    });
    await navigate(await activeFrame(), { type: 'lm-navigate', view: 'teacher', url: '/fixture/surface/lm-teacher' });
    await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('not available'));
    expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe(baseline);
    expect(fixture.state.calls.filter(c => c === 'GET /api/ui/profile').length).toBe(before + 1);
    fixture.state.education.tools.push({ id: 'tool-lm-offsite', label: 'Offsite', icon: '', section: 'top', toolUi: { iframeUrl: '/..//foreign.fixture/tool' } });
    await navigate(await activeFrame(), { type: 'app-navigate', tool: 'lm-offsite', url: '/fixture/surface/lm-myday' });
    await expect.poll(() => fixture.state.calls.filter(c => c === 'GET /api/ui/profile').length).toBe(before + 2);
    await navigate(await activeFrame(), { type: 'app-navigate', url: '/fixture/surface/lm-teacher' });
    await navigate(await activeFrame(), { type: 'lm-navigate', view: 'myday' });
    await frameUrl('/fixture/surface/lm-myday?audience=company');
    expect(fixture.state.calls).not.toContain('GET /fixture/surface/lm-teacher');
    expect(errors).toEqual([]);
  });

  it('uses the named tool URL and safe supplemental query without replacing its owned record or fragment', async () => {
    fixture.state.education.tools.find(t => t.id === 'tool-lm-class-c1')!.toolUi.iframeUrl = '/fixture/surface/lm-class-c1?classId=c1#work';
    await open(); await compact();
    await navigate(await activeFrame(), { type: 'app-navigate', tool: 'lm-class-c1', query: 'classId=foreign&starter=outline', iframeUrl: 'https://foreign.fixture/' });
    await frameUrl('/fixture/surface/lm-class-c1?classId=c1&starter=outline&audience=company#work');
    await page.locator('.full-context [data-action="embed-view"][data-view="full"]').click();
    await frameUrl('/fixture/surface/lm-class-c1?classId=c1&starter=outline#work');
    await page.reload(); await frameUrl('/fixture/surface/lm-class-c1?classId=c1&starter=outline#work');
    fixture.state.status.profile = 403;
    await navigate(await activeFrame(), { type: 'lm-navigate', view: 'myday' });
    await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('not available'));
    expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe('/fixture/surface/lm-class-c1?classId=c1&starter=outline#work');
  });

  it('rechecks a cached tool on every reopen, retaining its owned resource and supplemental query only after admission', async () => {
    fixture.state.education.tools.find(t => t.id === 'tool-lm-class-c1')!.toolUi.iframeUrl = '/fixture/surface/lm-class-c1?classId=c1#work';
    await open(); await compact();
    await navigate(await activeFrame(), { type: 'app-navigate', tool: 'lm-class-c1', query: 'starter=outline' });
    await frameUrl('/fixture/surface/lm-class-c1?classId=c1&starter=outline&audience=company#work');
    await activeFrame();
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    await context.route('**/api/ui/profile?name=little-monsters', async route => { await held; await route.continue(); });
    const requested = page.waitForRequest('**/api/ui/profile?name=little-monsters');
    const fetches = fixture.state.calls.filter(c => c === 'GET /fixture/surface/lm-class-c1').length;
    await page.locator('.full-context [data-action="toggle-embed"]').click(); await requested;
    expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe('about:blank');
    expect(fixture.state.calls.filter(c => c === 'GET /fixture/surface/lm-class-c1').length).toBe(fetches);
    expect(await page.locator('[data-member-state]').textContent()).toContain('Checking');
    expect(await page.locator('[data-member-state]').isVisible()).toBe(true);
    release(); await frameUrl('/fixture/surface/lm-class-c1?classId=c1&starter=outline&audience=company#work');
    await expect.poll(() => fixture.state.calls.filter(c => c === 'GET /fixture/surface/lm-class-c1').length).toBe(fetches + 1);
    expect(await page.locator('[data-member-state]').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  for (const refusal of ['withdrawn-tool', 'refused-profile']) {
    it('rechecks a cached tool on reopen and never fetches it after ' + refusal, async () => {
      await open(); await compact();
      await navigate(await activeFrame(), { type: 'lm-open-class', classId: 'c1' }); await frameUrl('/fixture/surface/lm-class-c1?audience=company'); await activeFrame();
      await page.locator('.full-context [data-action="toggle-embed"]').click();
      if (refusal === 'withdrawn-tool') fixture.state.education.tools = fixture.state.education.tools.filter(t => t.id !== 'tool-lm-class-c1');
      else fixture.state.status.profile = 403;
      const before = fixture.state.calls.filter(c => c === 'GET /api/ui/profile').length;
      const fetches = fixture.state.calls.filter(c => c === 'GET /fixture/surface/lm-class-c1').length;
      await page.locator('.full-context [data-action="toggle-embed"]').click();
      await expect.poll(() => fixture.state.calls.filter(c => c === 'GET /api/ui/profile').length).toBe(before + 1);
      await page.waitForFunction(() => document.querySelector('[data-member-state]')?.textContent?.includes('no longer available'));
      expect(await page.locator('[data-member-state]').isVisible()).toBe(true);
      expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe('about:blank');
      expect(await page.locator('iframe[data-hosted-app]').isVisible()).toBe(false);
      expect(fixture.state.calls.filter(c => c === 'GET /fixture/surface/lm-class-c1').length).toBe(fetches);
      expect(errors).toEqual([]);
    });
  }

  for (const destination of ['same-origin-resource', 'opaque-origin-document']) {
    it('drops a held navigation response after the actual member document changes to ' + destination, async () => {
      await open(); const frame = await compact();
      let release!: () => void; const held = new Promise<void>(done => { release = done; });
      await context.route('**/api/ui/profile?name=little-monsters', async route => { await held; await route.continue(); });
      const requested = page.waitForRequest('**/api/ui/profile?name=little-monsters');
      const baseline = await page.locator('iframe[data-hosted-app]').getAttribute('src');
      await navigate(frame, { type: 'lm-navigate', view: 'myday' }); await requested;
      const target = destination === 'same-origin-resource' ? fixture.origin + '/fixture/surface/internal-resource?classId=other'
        : 'data:text/html,' + encodeURIComponent('<h1>Opaque member document</h1>');
      await frame.goto(target); await frame.waitForSelector('h1');
      expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe(baseline);
      const response = page.waitForResponse('**/api/ui/profile?name=little-monsters'); release(); await (await response).finished();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      expect(frame.url()).toBe(target);
      expect(await page.locator('iframe[data-hosted-app]').getAttribute('src')).toBe(baseline);
      expect(fixture.state.calls).not.toContain('GET /fixture/surface/lm-myday');
      expect(errors).toEqual([]);
    });
  }

  it('keeps member-local edits and the original browsing context through unrelated asynchronous history paint', async () => {
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    fixture.state.history = [{ role: 'jarvis', text: 'Completed history read marker' }];
    await context.route('**/api/jarvis/history?*', async route => { await held; await route.continue(); });
    await open(); const frame = await compact();
    await frame.evaluate(() => { (window as any).memberMarker = 'original'; const input = document.createElement('input'); input.id = 'member-draft'; input.value = 'Unsent member edit'; document.body.append(input); });
    const response = page.waitForResponse('**/api/jarvis/history?*'); release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await (await activeFrame()).evaluate(() => [(window as any).memberMarker, (document.getElementById('member-draft') as HTMLInputElement)?.value])).toEqual(['original', 'Unsent member edit']);
    await page.locator('.full-context [data-action="toggle-embed"]').click(); expect(await page.locator('.full-context iframe').count()).toBe(0);
    await page.waitForFunction(() => document.body.textContent?.includes('Completed history read marker'));
  });

  it('restores a focused backward draft selection after a real asynchronous root repaint', async () => {
    let release!: () => void; const held = new Promise<void>(done => { release = done; });
    fixture.state.history = [{ role: 'jarvis', text: 'Backward selection history marker' }];
    await context.route('**/api/jarvis/history?*', async route => { await held; await route.continue(); });
    await open(); await page.fill('#message-input', 'Keep my unsent selection');
    await page.locator('#message-input').evaluate(node => { const input = node as HTMLTextAreaElement; input.focus(); input.setSelectionRange(5, 14, 'backward'); });
    release(); await page.waitForFunction(() => document.body.textContent?.includes('Backward selection history marker'));
    expect(await page.locator('#message-input').evaluate(node => {
      const input = node as HTMLTextAreaElement;
      return [input.value, input === document.activeElement, input.selectionStart, input.selectionEnd, input.selectionDirection];
    })).toEqual(['Keep my unsent selection', true, 5, 14, 'backward']);
  });

  it('drops a profile response after its requesting frame is closed', async () => {
    await open(); await compact(); let release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    await context.route('**/api/ui/profile?name=little-monsters', async route => { await held; await route.continue(); });
    const requested = page.waitForRequest('**/api/ui/profile?name=little-monsters');
    await navigate(await activeFrame(), { type: 'lm-navigate', view: 'myday' }); await requested;
    await page.locator('.full-context [data-action="toggle-embed"]').click(); release();
    await expect.poll(() => fixture.state.calls.includes('GET /api/ui/profile')).toBe(true);
    expect(await page.locator('iframe[data-hosted-app]').count()).toBe(0);
    expect(fixture.state.calls).not.toContain('GET /fixture/surface/lm-myday');
  });

  it('scopes saved selection, drafts and revalidated member resources to exact issuer and layout', async () => {
    await open(); await useContext('little-monsters'); await page.fill('#message-input', 'Issuer A draft');
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    await navigate(await activeFrame(), { type: 'lm-open-class', classId: 'c1' }); await frameUrl('/fixture/surface/lm-class-c1?audience=company');
    issuer = 'https://issuer-b.fixture'; await page.reload(); await page.waitForSelector('#message-input');
    expect(await page.inputValue('#message-input')).toBe(''); expect(await page.locator('iframe[data-hosted-app]').count()).toBe(0);
    issuer = 'https://issuer-a.fixture'; await page.reload(); await frameUrl('/fixture/surface/lm-class-c1?audience=company');
    await page.locator('.full-context [data-action="toggle-embed"]').click(); expect(await page.inputValue('#message-input')).toBe('Issuer A draft');
    await open('jarvis'); expect(await page.inputValue('#message-input')).toBe('');
    expect(errors).toEqual([]);
  });

  it('keeps unknown-issuer selection and drafts in memory without a persisted principal bucket', async () => {
    issuer = null; await open(); await useContext('little-monsters'); await page.fill('#message-input', 'Unknown issuer draft');
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('oshal-live-studio:')))).toEqual([]);
    await page.reload(); await page.waitForSelector('#message-input');
    expect(await page.inputValue('#message-input')).toBe(''); expect(await page.locator('iframe[data-hosted-app]').count()).toBe(0);
  });

  it('refuses a listed unadmitted app as context without granting access or replacing the selected app', async () => {
    await open(); await useContext('unadmitted');
    expect(await page.locator('#toast').textContent()).toContain('not available as your context');
    await page.locator('#full-dialog [data-action="close"]').click();
    await page.fill('#message-input', 'Keep the admitted context'); await page.press('#message-input', 'Enter');
    await expect.poll(() => asks.length).toBe(1); expect(asks[0].context.app).not.toBe('unadmitted');
    expect(ContextSchema.safeParse(asks[0].context).success).toBe(true);
    expect(fixture.state.calls.some(c => /authorization.*(apply|preview)/.test(c))).toBe(false);
  });
});
