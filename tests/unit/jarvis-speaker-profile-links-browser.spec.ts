/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove in Chromium that every Manage Voices row on the real Jarvis page opens that voice's Ambient Recall profile page. The page loads every Jarvis asset through the real router's authenticated allowlist, the rows are rendered by the real Voice & Speakers panel, rows that panel re-renders are linked again, and the link lands on the real person-model surface, which opens that exact profile.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createJarvisRoutes, ensureJarvisSchema } from '@/app/routes/jarvis-routes';
import { createPersonModelRoutes } from '@/app/routes/person-model-routes';
import { AMBIENT_SCENARIOS } from '@/app/routes/test-lab-ambient-scenarios';
import { attachJarvisBrowserAssets } from '../fixtures/jarvis-package-tools-browser';

const OWNER_CONTEXT = {
  available: true, reason: 'private_org_available', selectedTenantId: null,
  currentUser: { userSub: 'fixture-owner', displayName: 'Fixture Owner', profileId: null },
  organizations: [], members: [],
};
const READ_ONLY_CONTEXT = { reason: 'public_tenant', currentUser: { displayName: 'Guest' } };
/** The production /speakers envelope and row shape (ambient-speaker-routes.ts). */
const voice = (profileId: string, label: string, kind = 'custom') => ({
  profileId, label, assignment: { kind, customName: kind === 'custom' ? label : null, tenantId: null, memberSub: null },
  sampleCount: 3, firstSeenAt: '2026-09-14T18:00:00.000Z', lastSeenAt: '2026-09-15T18:00:00.000Z',
});
const ELLA = voice('a1111111-1111-4111-8111-111111111111', 'Ella');
const UNKNOWN = voice('b2222222-2222-4222-8222-222222222222', 'Unidentified Person 2', 'unassigned');
const SAM = voice('c3333333-3333-4333-8333-333333333333', 'Sam');
const profileHref = (id: string) => `/api/jarvis/ambient/person/?tab=people&profile=${id}`;
const linkedRows = (rows: Array<{ profileId: string }>) => rows.map(row => ({
  id: row.profileId, links: [{ href: profileHref(row.profileId), target: '_blank', text: 'Open profile' }],
}));

const state = { context: OWNER_CONTEXT as Record<string, unknown>, voices: [ELLA, UNKNOWN], profileReads: [] as string[] };
const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
let browser: Browser, server: ReturnType<express.Express['listen']>, origin: string;

/** Synthetic voice data at its HTTP boundary; the profile read records which id the surface asked for. */
function voiceRoutes(app: express.Express): void {
  app.get('/api/jarvis/ambient/speaker-context', (_req, res) => { res.json(state.context); });
  app.get('/api/jarvis/ambient/speakers', (_req, res) => { res.json({ profiles: state.voices }); });
  app.get('/api/jarvis/ambient/person/profile/:profileId', (req, res) => {
    state.profileReads.push(req.params.profileId);
    const row = state.voices.find(item => item.profileId === req.params.profileId);
    if (!row) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ profile: { profileId: row.profileId, label: row.label, isSelf: false, utterances: 3, firstHeardAt: null,
      lastHeardAt: null, timeZone: 'UTC', topics: [], presence: [], asks: [], consent: null } });
  });
}

/** The real Jarvis asset allowlist and the real person-model surface; only the voice data is synthetic. */
async function startFixture(): Promise<void> {
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await ensureJarvisSchema(pool as never);
  const jarvis = createJarvisRoutes({ pool } as never, resolve('src/api'));
  const app = express();
  // Every /api/jarvis/assets/<file> request goes through the real allowlist: an unlisted file is a 404.
  app.use('/api/jarvis', (req, res, next) => (req.path.startsWith('/assets/') ? jarvis(req, res, next) : next()));
  attachJarvisBrowserAssets(app);
  voiceRoutes(app);
  app.use('/api/jarvis/ambient/person', createPersonModelRoutes({ pool } as never));
  app.use((_req, res) => { res.status(404).json({ error: 'fixture_unavailable' }); });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => { await startFixture(); browser = await chromium.launch({ headless: true }); }, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
}, 30_000);

/** Load the unchanged Jarvis page, confined to the fixture origin, and open Manage Voices the way its button does. */
async function openManageVoices(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
  const page = await context.newPage();
  await page.goto(`${origin}/api/jarvis/ui`);
  await page.waitForFunction(() => Boolean((window as any).JarvisSpeakers?.getInstance()), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-open-requested', { detail: {} })));
  return { context, page };
}

/** Each rendered voice row in panel order (Needs review, then Known speakers), with every link it carries. */
async function rowLinks(page: Page) {
  return page.locator('.jarvis-speakers__profile-card').evaluateAll(cards => cards.map(card => ({
    id: (card as HTMLElement).dataset.profileId,
    links: [...card.querySelectorAll('a')].map(a => ({ href: a.getAttribute('href'), target: a.target, text: a.textContent })),
  })));
}

it('gives every Manage Voices row a link that opens that exact voice on the Ambient Recall profile page', async () => {
  Object.assign(state, { context: OWNER_CONTEXT, voices: [ELLA, UNKNOWN], profileReads: [] });
  const { context, page } = await openManageVoices();
  try {
    await expect.poll(() => rowLinks(page), { timeout: 15_000 }).toEqual(linkedRows([UNKNOWN, ELLA]));
    const [profilePage] = await Promise.all([
      context.waitForEvent('page'),
      page.locator(`[data-profile-id="${ELLA.profileId}"] a`).click(),
    ]);
    await profilePage.waitForLoadState();
    const landed = new URL(profilePage.url());
    expect(landed.pathname).toBe('/api/jarvis/ambient/person/');
    expect(landed.searchParams.get('tab')).toBe('people');
    expect(landed.searchParams.get('profile')).toBe(ELLA.profileId);
    await expect.poll(() => profilePage.locator('#profile h2').textContent(), { timeout: 15_000 }).toBe('Ella');
    expect(state.profileReads).toEqual([ELLA.profileId]);
  } finally { await context.close(); }
}, 90_000);

it('links the rows the panel re-renders, once each, including read-only sessions without row actions', async () => {
  Object.assign(state, { context: OWNER_CONTEXT, voices: [ELLA], profileReads: [] });
  const { context, page } = await openManageVoices();
  try {
    await expect.poll(() => rowLinks(page), { timeout: 15_000 }).toEqual(linkedRows([ELLA]));
    Object.assign(state, { context: READ_ONLY_CONTEXT, voices: [ELLA, UNKNOWN, SAM] });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-refresh-requested')));
    await expect.poll(() => rowLinks(page), { timeout: 15_000 }).toEqual(linkedRows([UNKNOWN, ELLA, SAM]));
    expect(await page.locator('.jarvis-speakers__read-only').count()).toBe(3);
  } finally { await context.close(); }
}, 90_000);

it('is registered with the Ambient Recall Test Lab scenario', () => {
  const scenario = AMBIENT_SCENARIOS.find(item => item.id === 'ambient-recall');
  const registered = scenario?.regressionTests ?? [];
  expect(registered).toEqual(expect.arrayContaining([
    { level: 'unit', path: 'tests/unit/jarvis-speaker-wiring.spec.ts' },
    { level: 'browser', path: 'tests/unit/jarvis-speaker-profile-links-browser.spec.ts' },
  ]));
  for (const item of registered) expect(existsSync(resolve(item.path)), item.path).toBe(true);
});
