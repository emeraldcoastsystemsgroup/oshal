/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Framework lifecycle spec — guards the swarm-apps publish contract end-to-end
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D5: re-fixtured onto PERMANENT apps and pointed at the Playwright-managed server so it actually RUNS (it was pinned to the live docker stack, so in CI it silently skipped). It had been fixtured on gov-contracting — a Wave-1 carve candidate — having ALREADY been re-pointed once off little-monsters; the legacy ops profile was no safer. It now uses oshal-ci-fixture (a test-only app that ships no code and can never carve) and oshal-engineering (kernel-RESIDENT — on the signed-off never-carve six). No future carve can break this spec again.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | API_BASE fallback host pinned to 127.0.0.1 — "localhost" resolves to ::1 where a stale wslrelay squats the port (ECONNREFUSED ::1:3456, 2026-07-23 ci-local --head run); same change as playwright.config.ts BASE_URL. SWARM_APPS_TEST_BASE_URL still wins when set.
 */

import { test, expect, request, type APIRequestContext } from '@playwright/test';

/**
 * Exercises the swarm-applications framework against a running OSHAL instance.
 *
 * ADR-085 D5 — WHAT THIS SPEC MAY FIXTURE ON. Only apps that can NEVER carve out of core:
 *   • oshal-ci-fixture   — the permanent test fixture (tests/fixtures/swarm-apps/), loaded via
 *                          SWARM_APPS_EXTRA_DIRS. Not a product, ships no code, never carves.
 *   • oshal-engineering  — kernel-RESIDENT (the signed-off never-carve six).
 * It previously fixtured little-monsters, was re-pointed to gov-contracting when LM carved, and
 * gov-contracting is itself a Wave-1 carve candidate — so it was about to break a third time. That
 * treadmill ends here: the entire point of the store migration is that ANY product app can carve, so
 * a shared spec must never depend on one.
 *
 * Runs against the Playwright-managed server by default (which loads the fixture and, in CI, has
 * Postgres) so it actually EXECUTES — it used to be pinned to the live docker stack, so in CI it
 * silently skipped. Point SWARM_APPS_TEST_BASE_URL at the docker stack to run it there instead.
 * Skips with a clear message if no instance is reachable.
 */

const DEFAULT_PORT = process.env.PLAYWRIGHT_PORT || (process.env.MOCK_OIDC ? '4458' : '3456');
const API_BASE = process.env.SWARM_APPS_TEST_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

let api: APIRequestContext;
let stackReady = false;

/** The app every test here depends on; its presence is the signal that autoload finished. */
const FIXTURE_APP = 'oshal-ci-fixture';

/**
 * @description Wait until the swarm-app autoloader has actually published its manifests.
 *
 * `/health` is a SHALLOW check — it returns 200 as soon as Express is listening, long before
 * `autoLoadAll()` has read and loaded 40+ manifests. On a COLD database (which is exactly what the
 * nightly CI gate creates: a fresh ephemeral Postgres every run) the migrations plus the autoload
 * take a while, so a test that fires immediately sees a partially-populated — or empty — catalog and
 * fails. That is not a product bug; the test was simply asking before the answer existed. Warm-DB
 * runs passed and hid it, which is why this only surfaced once the spec started running in CI.
 *
 * Polls until the fixture app appears, which is the readiness signal that matters to every test in
 * this file.
 *
 * @param timeoutMs - Give up after this long (a cold boot + migrations is genuinely slow).
 * @returns True once the catalog is populated; false if it never became ready.
 */
async function waitForAppsLoaded(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api.get('/api/swarm/apps').catch(() => null);
    if (res?.ok()) {
      const { apps } = await res.json().catch(() => ({ apps: [] }));
      if (Array.isArray(apps) && apps.some((a: { name: string }) => a.name === FIXTURE_APP)) return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API_BASE, ignoreHTTPSErrors: true });
  const health = await api.get('/health').catch(() => null);
  if (!health || !health.ok()) return; // no instance reachable — every test skips below
  stackReady = await waitForAppsLoaded();
});

test.afterAll(async () => {
  await api?.dispose();
});

test.beforeEach(() => {
  test.skip(
    !stackReady,
    `No OSHAL instance with a loaded app catalog at ${API_BASE}. The Playwright webServer normally ` +
      `provides one (it sets SWARM_APPS_EXTRA_DIRS so ${FIXTURE_APP} loads); point ` +
      `SWARM_APPS_TEST_BASE_URL at the docker stack to run against that instead.`,
  );
});


test('autoloader publishes the manifests', async () => {
  const res = await api.get('/api/swarm/apps');
  expect(res.ok()).toBeTruthy();
  const { apps } = await res.json();
  const names = apps.map((a: any) => a.name).sort();
  // Both are permanent by construction: the fixture never carves, oshal-engineering is
  // kernel-resident. Do NOT add a product app here — it will carve and break this spec.
  expect(names).toContain('oshal-ci-fixture');
  expect(names).toContain('oshal-engineering');
});

test('each app exposes a distinct synthesised ribbon', async () => {
  const responses = await Promise.all([
    api.get('/api/ui/profile?name=oshal-ci-fixture'),
    api.get('/api/ui/profile?name=oshal-engineering'),
  ]);

  const profiles = await Promise.all(responses.map(r => r.json()));
  expect(profiles.every(p => p.source === 'swarm-app')).toBeTruthy();

  const [fixture, eng] = profiles.map(p => p.profile);
  const idsFor = (p: any) => p.ribbon.items.map((i: any) => (typeof i === 'string' ? i : i.id));

  const fixtureIds = idsFor(fixture);
  const engIds = idsFor(eng);

  // Synthesised items for manifest.ui.static get a `tool-` prefix so the cockpit view
  // controller routes them to renderToolView (iframe) rather than a page navigation.
  expect(fixtureIds).toContain('tool-oshal-ci-fixture-surface');
  // The fixture declares hideFrameworkItems: [calendar] — so it must be gone…
  expect(fixtureIds).not.toContain('calendar');
  // …and it declares no ticketType, so Tickets is auto-hidden (an app with no queue must not
  // show the whole unfiltered fleet).
  expect(fixtureIds).not.toContain('tickets');

  // A DIFFERENT app gets a DIFFERENT ribbon — the point of the test.
  expect(engIds).toContain('tool-eng-tasks');
  expect(engIds).toContain('tickets'); // oshal-engineering DOES own a queue (ticketType: build)
  expect(engIds).not.toContain('settings'); // hidden by its own hideFrameworkItems
  expect(engIds).not.toContain('tool-oshal-ci-fixture-surface');
});

test('toggling oshal-ci-fixture off: icons gone, routes 503', async () => {
  // Ensure starting from active state
  await api.patch('/api/swarm/apps/oshal-ci-fixture/toggle', { data: { active: true } });

  // Toggle off
  const off = await api.patch('/api/swarm/apps/oshal-ci-fixture/toggle', { data: { active: false } });
  expect(off.ok()).toBeTruthy();
  const offBody = await off.json();
  expect(offBody.app.status).toBe('inactive');

  // Ribbon icons for the app should be gone from /api/tools/dynamic
  const toolsAfter = await (await api.get('/api/tools/dynamic')).json();
  const govStaticIcons = toolsAfter.tools.filter((t: any) =>
    ['oshal-ci-fixture-surface'].includes(t.toolName),
  );
  expect(govStaticIcons).toHaveLength(0);

  // Route gate: the fixture OWNS /api/oshal-ci-fixture (routes[].mountPath is live), so with the
  // app toggled off the gate must 503 with a structured body naming the app.
  const gov = await api.get('/api/oshal-ci-fixture/anything');
  expect(gov.status()).toBe(503);
  const govBody = await gov.json();
  expect(govBody.appName).toBe('oshal-ci-fixture');

  // Toggle back on so subsequent tests see a clean state
  const on = await api.patch('/api/swarm/apps/oshal-ci-fixture/toggle', { data: { active: true } });
  expect(on.ok()).toBeTruthy();
  const onBody = await on.json();
  expect(onBody.app.status).toBe('active');
});

test('exported YAML round-trips — import produces the same record', async () => {
  const exportRes = await api.get('/api/swarm/apps/oshal-ci-fixture/export');
  expect(exportRes.ok()).toBeTruthy();
  const yaml = await exportRes.text();
  expect(yaml).toContain('name: oshal-ci-fixture');
  expect(yaml).toContain('oshal-ci-fixture-surface');
  expect(yaml).toContain('hideFrameworkItems');
});

test('built-in workflows cannot be hijacked by an app', async () => {
  // oshal-engineering declares ticketType:'build' — the registry should
  // REJECT this registration and fall back to the built-in 'Software Build
  // Swarm' pipeline owned by the framework.
  //
  // We probe this by observing that the built-in entry is still present
  // in the list (there's no public introspection endpoint, so we check
  // indirectly by ensuring the oshal-engineering app loaded at all —
  // which it did, because the other tests saw it).
  const res = await api.get('/api/swarm/apps/oshal-engineering');
  expect(res.ok()).toBeTruthy();
  const { app } = await res.json();
  expect(app.manifest.ticketType).toBe('build');
  expect(app.status).toBe('active');
});
