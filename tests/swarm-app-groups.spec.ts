/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-141 application groups, end to end: a group loads active, its synthesised ribbon is the kernel setup-dashboard tile followed by every toolbar surface borrowed BY REFERENCE from the member's own manifest, the setup plan resolves each member's declared readiness probe, the probes answer as the caller, and the dashboard page serves. Real loader, real routes, real gate — the unit spec doubles the repository; this one doubles nothing. Runs against the Playwright-managed server on the permanent fixture group by default; point SWARM_APPS_TEST_BASE_URL + SWARM_APP_GROUP_UNDER_TEST (+ SWARM_APPS_TEST_PAT on a real-OIDC box) at a live stack to prove a real group such as intelligent-career.
 */

import { test, expect, request, type APIRequestContext } from '@playwright/test';

const DEFAULT_PORT = process.env.PLAYWRIGHT_PORT || (process.env.MOCK_OIDC ? '4458' : '3456');
const API_BASE = process.env.SWARM_APPS_TEST_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const GROUP = process.env.SWARM_APP_GROUP_UNDER_TEST || 'oshal-ci-fixture-group';
const PAT = process.env.SWARM_APPS_TEST_PAT || '';

type Manifest = {
  name: string; kind?: string; dependencies?: { apps?: string[] };
  toolbar?: Array<{ app: string; surface: string; group?: string; section?: string }>;
  setup?: Array<{ label: string; app: string; readiness: string; fix?: string }>;
  ui?: { static?: Array<{ toolName: string; label: string; icon: string; iframeUrl: string }> };
  readiness?: Array<{ name: string; path: string; readyPointer: string; detailPointer?: string }>;
};

let api: APIRequestContext;
let stackReady = false;
let group: Manifest;
const members = new Map<string, Manifest>();

/** The manifest an app record carries, as GET /api/swarm/apps/:name returns it. */
async function manifestOf(name: string): Promise<Manifest | null> {
  const res = await api.get(`/api/swarm/apps/${name}`).catch(() => null);
  if (!res?.ok()) return null;
  const body = await res.json();
  return (body.app?.manifest ?? body.manifest ?? null) as Manifest | null;
}

async function waitForGroupLoaded(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api.get('/api/swarm/apps').catch(() => null);
    if (res?.ok()) {
      const body = await res.json().catch(() => ({ apps: [] }));
      if ((body.apps ?? []).some((a: { name: string }) => a.name === GROUP)) return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

test.beforeAll(async () => {
  // A cold server (fresh DB + migrations + 40 manifests) takes longer than the 30 s hook default.
  test.setTimeout(150_000);
  api = await request.newContext({
    baseURL: API_BASE,
    ignoreHTTPSErrors: true,
    ...(PAT ? { extraHTTPHeaders: { authorization: `Bearer ${PAT}` } } : {}),
  });
  const health = await api.get('/health').catch(() => null);
  if (!health || !health.ok()) return;
  stackReady = await waitForGroupLoaded();
  if (!stackReady) return;
  const g = await manifestOf(GROUP);
  if (!g || g.kind !== 'group') { stackReady = false; return; }
  group = g;
  for (const name of g.dependencies?.apps ?? []) {
    const m = await manifestOf(name);
    if (m) members.set(name, m);
  }
});

test.beforeEach(() => {
  test.skip(!stackReady, `No OSHAL instance with the group ${GROUP} loaded at ${API_BASE} (the Playwright server sets SWARM_APPS_EXTRA_DIRS so the fixture group loads; a live box needs SWARM_APP_GROUP_UNDER_TEST + a PAT)`);
});

test('the group is active and every member it depends on is active', async () => {
  const res = await api.get('/api/swarm/apps');
  expect(res.ok()).toBeTruthy();
  const apps = (await res.json()).apps as Array<{ name: string; status: string }>;
  expect(apps.find((a) => a.name === GROUP)?.status).toBe('active');
  for (const name of group.dependencies?.apps ?? []) {
    expect(apps.find((a) => a.name === name)?.status, `member ${name}`).toBe('active');
  }
});

test('the ribbon is the setup-dashboard tile followed by every toolbar surface borrowed by reference', async () => {
  const res = await api.get(`/api/ui/profile?name=${GROUP}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.source).toBe('swarm-app');
  type Item = { id: string; label: string; group?: string; section: string; toolUi?: { iframeUrl: string } };
  const items = (body.profile.ribbon.items as Array<string | Item>).filter((i): i is Item => typeof i !== 'string');
  expect(items[0].id).toBe(`tool-${GROUP}-setup`);
  expect(items[0].toolUi?.iframeUrl).toBe(`/api/swarm/apps/${GROUP}/setup-dashboard?group=${GROUP}`);
  expect(body.profile.defaultView).toBe(`tool-${GROUP}-setup`);
  const toolbar = group.toolbar ?? [];
  expect(items.length).toBe(toolbar.length + 1);
  toolbar.forEach((entry, i) => {
    const declared = members.get(entry.app)?.ui?.static?.find((s) => s.toolName === entry.surface);
    expect(declared, `${entry.app}/${entry.surface} declared by the member`).toBeTruthy();
    const item = items[i + 1];
    expect(item.id).toBe(`tool-${entry.surface}`);
    expect(item.toolUi?.iframeUrl).toBe(declared?.iframeUrl); // the member's own URL, never a copy in the group YAML
    expect(item.label).toBe(declared?.label);
    if (entry.group) expect(item.group).toBe(entry.group);
    expect(item.section).toBe(entry.section ?? 'top');
  });
});

test('the setup plan resolves each member readiness probe, the probes answer as the caller, and the dashboard serves', async () => {
  const plan = await api.get(`/api/swarm/apps/${GROUP}/setup`);
  expect(plan.ok()).toBeTruthy();
  const body = await plan.json();
  expect(body.group).toBe(GROUP);
  expect(body.members).toEqual(group.dependencies?.apps ?? []);
  expect(body.firstSurface).toBe(group.toolbar?.[0]?.surface);
  expect(body.steps).toHaveLength((group.setup ?? []).length);
  for (const [i, step] of (group.setup ?? []).entries()) {
    const decl = members.get(step.app)?.readiness?.find((r) => r.name === step.readiness);
    expect(decl, `${step.app} declares readiness ${step.readiness}`).toBeTruthy();
    if (!decl) continue;
    expect(body.steps[i].fix).toBe(step.fix);
    expect(body.steps[i].probe).toEqual({
      path: decl.path,
      readyPointer: decl.readyPointer,
      ...(decl.detailPointer ? { detailPointer: decl.detailPointer } : {}),
    });
    // A probe answers the caller with JSON, or the gate refuses it — never a 5xx, never HTML.
    const probe = await api.get(decl.path);
    expect([200, 401, 403, 404, 503], `${decl.path} -> ${probe.status()}`).toContain(probe.status());
    if (probe.status() === 200) expect(probe.headers()['content-type']).toContain('application/json');
  }

  const page = await api.get(`/api/swarm/apps/${GROUP}/setup-dashboard?group=${GROUP}`);
  expect(page.ok()).toBeTruthy();
  expect(page.headers()['content-type']).toContain('text/html');
  expect(await page.text()).toContain('ADR-141');

  // An ordinary app is not a group: no plan, no dashboard — never an empty checklist.
  const member = (group.dependencies?.apps ?? [])[0];
  expect((await api.get(`/api/swarm/apps/${member}/setup`)).status()).toBe(404);
});
