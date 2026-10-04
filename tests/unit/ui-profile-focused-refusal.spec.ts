/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | A non-operator held to a focused landing never receives the disk or built-in full-operator profile: the real createUiProfileRoutes over loopback, the real UIProfileService (config-seed/profiles), and the refusal body fed into the real RibbonNav._init. Unknown, disk-only, wrong-case and caller-invisible names answer 404 experience_unavailable with exactly the lock fields; no name serves the landing application through synthesis; the 503 discovery refusal keeps the lock fields; operators and unfocused deployments keep the fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createUiProfileRoutes, type UiProfileDiscoveryPorts } from '@/app/routes/ui-profile-routes';
import { UIProfileService } from '@/features/ui-profile';
import type { SwarmAppService } from '@/features/swarm-apps';
import { RibbonNav } from '@/pages/cockpit/js/components/RibbonNav.js';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => log }));

const LANDING = 'intelligent-sales';
const LOCK_KEYS = ['error', 'landingApp', 'operator'];
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
});

/** The landing application's synthesised profile, and an experience package's, keyed by exact name (the repository's `name = $1`). */
const SYNTHESISED: Record<string, object> = {
  [LANDING]: { name: LANDING, displayName: 'Synthetic Sales', defaultView: 'tool-sales-home',
    ribbon: { items: [{ id: 'tool-sales-home', label: 'Sales', toolUi: { iframeUrl: `/api/${LANDING}/app` } }], dynamicTools: { allow: [] } } },
  'home-experience': { name: 'home-experience', experience: { entry: '/api/home-experience/app', shell: 'rail' },
    ribbon: { items: [], dynamicTools: { allow: [] } } },
};

/**
 * @description Applications as the caller's database scope sees them: only the synthesising names exist,
 * so an unknown, a disk-only, a wrong-case or an RLS-hidden name reads as no row (getApp null).
 * @param visible - Names the caller can read.
 * @returns The application port the route consumes.
 */
function apps(visible = Object.keys(SYNTHESISED)): SwarmAppService {
  const row = (name: string) => (visible.includes(name) ? { status: 'active', manifest: { name, ...('experience' in SYNTHESISED[name] ? { experience: (SYNTHESISED[name] as { experience: object }).experience } : {}) } } : null);
  return {
    getApp: async (name: string) => row(name),
    getAppForViewer: async (name: string) => row(name),
    synthesiseProfile: async (name: string) => (visible.includes(name) ? structuredClone(SYNTHESISED[name]) : null),
  } as unknown as SwarmAppService;
}

/** Discovery that admits everything: this suite's subject is the fallback, not app.open. */
const admitAll: UiProfileDiscoveryPorts = {
  resolveActor: async () => ({ sub: 'fixture-member', issuer: 'https://fixture.invalid', isActive: true, isSwarmAdmin: false } as never),
  runtime: { canDiscover: async () => true, canNavigateHttpPath: async () => true },
};

/**
 * @description Mount the real profile router on a loopback port.
 * @param options - Landing, operator verdict, visible rows and discovery port.
 * @returns The profile URL prefix.
 */
async function endpoint(options: { landing?: string | null; operator?: boolean; visible?: string[]; discovery?: UiProfileDiscoveryPorts | null } = {}): Promise<string> {
  const landing = options.landing === undefined ? LANDING : options.landing;
  const app = express();
  app.use('/api/ui', createUiProfileRoutes(new UIProfileService(), apps(options.visible),
    options.discovery === null ? undefined : (options.discovery ?? admitAll),
    { landingApp: () => landing, isOperator: () => options.operator === true }));
  await new Promise<void>((done) => { server = app.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ui/profile`;
}

/**
 * @description Feed one answer into the real RibbonNav._init with only its DOM and network edges stubbed.
 * @param answer - The route's status and JSON body. @returns The initialised ribbon.
 */
async function ribbonFor(answer: { status: number; body: unknown }) {
  vi.stubGlobal('window', { location: { search: '?app=zzz&ticket=T-9', replace: vi.fn() } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status })));
  const ribbon = Object.create(RibbonNav.prototype);
  Object.assign(ribbon, { isOperator: false, studentMode: false,
    _loadGuestState: vi.fn(async () => undefined), _loadOperatorState: vi.fn(async () => undefined), _applyAppBranding: vi.fn(),
    _applyShellLock: vi.fn(), _loadExperiences: vi.fn(async () => undefined), render: vi.fn(), _loadToolViews: vi.fn() });
  await ribbon._init();
  return ribbon;
}

describe('a non-operator held to a focused landing', () => {
  it.each([
    ['an unknown name', 'zzz'],
    ['a disk-only profile', 'oshal-framework'],
    ['a case variant of the landing application', 'Intelligent-Sales'],
    ['an experience whose row the caller cannot read', 'home-experience'],
    ['a traversal-shaped name', '..%2F..%2Fpackage'],
  ])('is refused %s with exactly the lock fields', async (_label, name) => {
    const base = await endpoint({ visible: [LANDING] });
    const res = await fetch(`${base}?name=${name}`);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(Object.keys(body).sort()).toEqual([...LOCK_KEYS].sort());
    expect(body).toEqual({ error: 'experience_unavailable', landingApp: LANDING, operator: false });
  });

  it('gets the landing application, not the deployment profile, when no name is requested', async () => {
    const res = await fetch(await endpoint());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ requested: LANDING, source: 'swarm-app', landingApp: LANDING, operator: false });
    expect(body.profile.name).toBe(LANDING);
    expect(body.profile.ribbon.items.map((item: { id: string }) => item.id)).toEqual(['tool-sales-home']);
  });

  it('is refused when the landing application itself does not synthesise for them', async () => {
    const res = await fetch(await endpoint({ visible: [] }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'experience_unavailable', landingApp: LANDING, operator: false });
  });

  it('keeps the ribbon closed on the refusal: no rail items, no framework allowlist, locked to the landing', async () => {
    const res = await fetch(`${await endpoint({ visible: [LANDING] })}?name=zzz`);
    const ribbon = await ribbonFor({ status: res.status, body: await res.json() });
    expect(ribbon.shellLocked).toBe(true);
    expect(ribbon.landingApp).toBe(LANDING);
    expect(ribbon.profile.ribbon.items).toEqual([]);
    expect(ribbon.profile.ribbon.dynamicTools.allow).toEqual([]);
    expect(ribbon.views.filter((view: { platformTool?: boolean }) => !view.platformTool)).toEqual([]);
  });

  it('keeps the lock fields on the 503 that refuses an experience without a discovery port', async () => {
    const res = await fetch(`${await endpoint({ discovery: null })}?name=home-experience`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'experience_discovery_unavailable', landingApp: LANDING, operator: false });
  });
});

describe('callers the lock does not hold keep the fallback exactly as before', () => {
  it('an operator on the focused landing still gets the built-in profile for an unknown name and the env profile with no name', async () => {
    const base = await endpoint({ operator: true });
    const unknown = await (await fetch(`${base}?name=zzz`)).json();
    expect(unknown).toMatchObject({ source: 'disk', landingApp: LANDING, operator: true });
    expect(unknown.profile.description).toBe('Default full-operator profile (built-in fallback)');
    const plain = await (await fetch(base)).json();
    expect(plain).toMatchObject({ source: 'disk', requested: new UIProfileService().getEnvSelectedName(), operator: true });
  });

  it('a non-operator on a deployment without a focused landing still gets the disk fallback', async () => {
    const base = await endpoint({ landing: null });
    const unknown = await fetch(`${base}?name=zzz`);
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).profile.description).toBe('Default full-operator profile (built-in fallback)');
    const plain = await (await fetch(base)).json();
    expect(plain).toMatchObject({ source: 'disk', requested: new UIProfileService().getEnvSelectedName(), landingApp: null, operator: false });
  });
});
