/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the in-app help affordances end to end: the covered-surface list answers only guides that exist, the cockpit header affordance lands a covered surface on its OWN guide (real router, real docs/guides markdown) and degrades honestly on an uncovered one, a parked Intelligent Processing row states WHY it is parked, and the getting-started strip no longer suppresses itself on the full framework profile. The registered Test Lab readiness step is exercised against the same live router rather than a stubbed fetch, so a coverage claim and the Lab card cannot drift apart.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin the ribbon-spelled ids for the thirteen documented screens whose help button used to fall through to the index; the existing landing loop then proves each of them renders a real guide rather than just appearing on the list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BUDGET_PARK_FLAG } from '@/features/alert-triage';
import { APPEARANCE_SCENARIOS } from '@/app/routes/test-lab-appearance-scenarios';
import { startSurfaceHelpFixture } from '../fixtures/surface-help';

let fixture: Awaited<ReturnType<typeof startSurfaceHelpFixture>>;
let browser: Browser, context: BrowserContext, page: Page;

beforeAll(async () => {
  fixture = await startSurfaceHelpFixture();
  browser = await chromium.launch({ headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); await fixture?.close(); });

beforeEach(async () => {
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  // Nothing may leave the fixture origin - no CDN, no provider, no analytics.
  await context.route('**/*', route =>
    new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort('failed'));
  page = await context.newPage();
  page.setDefaultTimeout(10000);
});
afterEach(async () => { await context?.close(); fixture.tickets.length = 0; });

/** @description Wait for the real ribbon to finish rendering its buttons. */
async function ribbonReady(): Promise<void> {
  await page.locator('.ribbon-btn[data-view="tickets"]').waitFor();
}

/** @description Resolve the help link's href against the fixture origin. */
async function helpTarget(): Promise<string> {
  const href = await page.locator('#surfaceHelpBtn').getAttribute('href');
  const url = new URL(href ?? '', fixture.origin);
  return url.pathname + url.search;
}

it('answers a covered-surface list, and every surface on it reaches a real guide', async () => {
  const listed = await (await fetch(`${fixture.origin}/api/help/surfaces`)).json() as { surfaces?: string[] };
  const surfaces = listed.surfaces ?? [];
  expect(surfaces).toEqual(expect.arrayContaining(
    ['tickets', 'tool-tickets', 'settings', 'calendar', 'devices', 'intelligent-processing']));
  // Ribbon ids as config-seed/profiles/oshal-framework.json actually spells them, for screens whose
  // guide exists. These landed on the index until the map learned the ribbon's vocabulary.
  expect(surfaces).toEqual(expect.arrayContaining([
    'tool-storage-files', 'tool-cloud-accounts', 'tool-kalshi-home', 'tool-sports-edge-home',
    'tool-embodied', 'tool-animatronics', 'tool-drone-relay', 'tool-cad-studio', 'tool-circuit-lab',
    'tool-scan-to-print', 'tool-aero-lab', 'tool-ocean-lab-harvest-console', 'tool-ocean-lab-blade-studio',
  ]));
  // The list is a promise: every entry on it must actually land on a rendered guide.
  const landings = [] as Array<{ surface: string; status: number; guide: boolean }>;
  for (const surface of surfaces) {
    const response = await fetch(`${fixture.origin}/api/help?for=${encodeURIComponent(surface)}`, { redirect: 'follow' });
    landings.push({ surface, status: response.status, guide: new URL(response.url).pathname.startsWith('/api/help/') });
  }
  expect(landings.filter(landing => landing.status !== 200 || !landing.guide)).toEqual([]);
  // A surface nobody documented must NOT be advertised as covered.
  expect(surfaces).not.toContain('tool-fixture-editor');
});

it('reports the same coverage through the registered Test Lab readiness step', async () => {
  // The step addresses 127.0.0.1:$PORT; pointing PORT at the fixture makes it exercise the REAL
  // router and the REAL guide corpus rather than a stubbed fetch.
  const previous = process.env.PORT;
  process.env.PORT = new URL(fixture.origin).port;
  try {
    const scenario = APPEARANCE_SCENARIOS.find(item => item.id === 'in-app-help');
    expect(scenario?.regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/in-app-surface-help-browser.spec.ts' });
    const result = await scenario!.steps[0].run('');
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('deep-links to its own page');
  } finally {
    if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous;
  }
});

it('lands a covered cockpit surface on its own guide from the screen itself', async () => {
  await page.goto(`${fixture.origin}/cockpit/`);
  await ribbonReady();
  await page.locator('.ribbon-btn[data-view="tickets"]').click();
  const help = page.locator('#surfaceHelpBtn');
  await expect.poll(() => help.getAttribute('data-help-surface')).toBe('tickets');
  expect(await help.getAttribute('data-help-covered')).toBe('true');
  const opened = context.waitForEvent('page');
  await help.click();
  const guide = await opened;
  await guide.waitForLoadState('domcontentloaded');
  expect(new URL(guide.url()).pathname).toBe('/api/help/tickets');
  expect(await guide.locator('article h1').innerText()).toBe('Tickets — user guide (as-built)');
  await guide.close();
});

it('degrades honestly to the guide index on a surface no guide covers', async () => {
  await page.goto(`${fixture.origin}/cockpit/`);
  await ribbonReady();
  await page.locator('.ribbon-btn[data-view="tool-fixture-editor"]').click();
  const help = page.locator('#surfaceHelpBtn');
  await expect.poll(() => help.getAttribute('data-help-covered')).toBe('false');
  expect(await helpTarget()).toBe('/api/help');
  expect(await help.getAttribute('title')).toBe('User guides');
});

it('states on screen why each Intelligent Processing row is parked', async () => {
  fixture.tickets.push(
    { ticketId: 'a0000000-0000-4000-8000-000000000001', title: 'Synthetic disk pressure', status: 'backlog',
      ticketType: 'intelligent-processing',
      labels: ['prometheus', 'intake:backlog'], createdAt: new Date().toISOString(),
      metadata: { alertname: 'SyntheticDiskPressure', target: 'fixture-node', severity: 'warning', incident: { flags: [] } } },
    { ticketId: 'a0000000-0000-4000-8000-000000000002', title: 'Synthetic restart loop', status: 'backlog',
      ticketType: 'intelligent-processing',
      labels: ['prometheus', 'intake:approved', BUDGET_PARK_FLAG], createdAt: new Date().toISOString(),
      metadata: { alertname: 'SyntheticRestartLoop', target: 'fixture-bot', severity: 'critical', incident: { flags: [BUDGET_PARK_FLAG] } } },
  );
  await page.goto(`${fixture.origin}/intelligent-processing/`);
  const waiting = page.locator('tr', { hasText: 'SyntheticDiskPressure' });
  const budget = page.locator('tr', { hasText: 'SyntheticRestartLoop' });
  await expect.poll(() => waiting.count()).toBe(1);
  expect(await waiting.locator('.park-reason').innerText()).toMatch(/waiting for a person/i);
  expect(await budget.locator('.park-reason').innerText()).toMatch(/budget/i);
});

it('shows the getting-started strip on the full framework profile', async () => {
  await page.goto(`${fixture.origin}/cockpit/?profile=oshal-framework`);
  await expect.poll(() => page.locator('#oshalFirstRun .ofr-gs').count()).toBe(1);
  expect(await page.locator('#oshalFirstRun .ofr-gs').innerText()).toContain('New here?');
});
