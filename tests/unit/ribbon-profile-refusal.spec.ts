/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual refused profile HTTP responses and ribbon initialisation without widening a focused deployment's shell.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Behaviour instead of source text. The refusal boot is driven through bootInitialView on the profile the real _init produced (with a ?ticket= deep link): no view opens, no ticket is preselected, the panel renders. Every closed answer (403/404/503/500, network, non-JSON, a 200 without a profile, a timeout) is asserted to be the profile renderProfileRefusal recognises, through the one shared PROFILE_UNAVAILABLE name. A locked shell registers no platform views and never answers the hub handshake or a view navigation; only the registered hub frame may. An unreadable answer on the plain document stays closed. An operator's rail, hub and doors are unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Reject malformed successful profiles and bound both real HTTP identity prerequisites before any profile read or view registration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { RibbonNav, PLATFORM_HUB_ID } from '@/pages/cockpit/js/components/RibbonNav.js';
import { PROFILE_UNAVAILABLE, bootInitialView, renderProfileRefusal } from '@/pages/cockpit/js/cockpit-profile-refusal.js';
import { createUiProfileRoutes, type UiProfileDiscoveryPorts } from '@/app/routes/ui-profile-routes';
import type { UIProfileService } from '@/features/ui-profile';
import type { SwarmAppService } from '@/features/swarm-apps';

const landing = 'intelligent-sales';
const ORIGIN = 'https://cockpit.fixture.invalid';
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  server = undefined;
});

/** @description Start real profile routing with closed synthetic caller/application ports.
 * @param status Refusal selected at an actual route boundary. @param operator Server-owned caller verdict.
 * @returns A loopback profile endpoint. */
async function endpoint(status: number, operator = false): Promise<string> {
  const record = { status:'active', manifest:{ experience:{ entry:'/api/home-experience/app' } } };
  const apps = { getApp:async () => { if (status === 500) throw new Error('fixture read unavailable');return record; },
    getAppForViewer:async () => status === 404 ? null : record } as unknown as SwarmAppService;
  const service = { getEnvSelectedName:() => '',load:() => { throw new Error('No disk fallback for refused experience'); } } as unknown as UIProfileService;
  const discovery = { resolveActor:async () => ({ sub:'fixture-sub',issuer:'https://fixture.invalid',isActive:true,isSwarmAdmin:operator }),
    runtime:{ canDiscover:async () => true,...(status === 503 ? {} : {canNavigateHttpPath:async () => false}) } } as UiProfileDiscoveryPorts;
  const app = express();app.use('/api/ui',createUiProfileRoutes(service,apps,discovery,{landingApp:() => landing,isOperator:() => operator}));
  await new Promise<void>(resolve => { server=app.listen(0,'127.0.0.1',() => resolve()); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ui/profile?name=home-experience`;
}

/** A frame the hub check can see: its window and the src the view controller rendered. */
type Frame = { contentWindow: { postMessage: ReturnType<typeof vi.fn> }; getAttribute: (name: string) => string | null };
const frame = (src: string): Frame => ({ contentWindow: { postMessage: vi.fn() }, getAttribute: (name) => (name === 'src' ? src : null) });

/** @description Exercise the actual fetch and init methods while isolating the DOM edges (doors, branding, rendering).
 * @param response Profile response or transport failure. @param focused Whether the URL names an application.
 * @param operator Current whoami verdict. @param frames Frames on the page, for the hub check.
 * @returns The initialized ribbon. */
async function initialise(response: (init?: RequestInit, url?: string) => Promise<Response>, focused = true, operator = false, frames: Frame[] = [], options: { realIdentity?: boolean; timeoutMs?: number } = {}) {
  vi.stubGlobal('window',{location:{search:focused ? '?app=home-experience&ticket=T-9' : '?ticket=T-9',replace:vi.fn(),origin:ORIGIN,href:`${ORIGIN}/cockpit/`}});
  vi.stubGlobal('document',{querySelectorAll:(selector: string) => (selector === 'iframe' ? frames : [])});
  vi.stubGlobal('fetch',vi.fn((url: string, init?: RequestInit) => response(init, url)));
  const ribbon = Object.create(RibbonNav.prototype);
  Object.assign(ribbon,{isOperator:operator,profileOperator:true,landingApp:'stale-landing',studentMode:false,workspaceNames:[],container:null,
    _loadGuestState:vi.fn(async () => undefined),_loadOperatorState:vi.fn(async () => undefined),
    _applyAppBranding:vi.fn(),_appendPlatformHub:vi.fn(function (this: { views: object[] }) { this.views.push({ id: PLATFORM_HUB_ID, section: 'bottom', toolUi: { iframeUrl: '/cockpit/tools/platform.html' } }); }),
    _applyShellLock:vi.fn(),_openShellDoors:vi.fn(),_loadExperiences:vi.fn(async () => undefined),render:vi.fn(),_loadToolViews:vi.fn(),setActive:vi.fn()});
  ribbon.profileTimeoutMs = options.timeoutMs;
  if (options.realIdentity) { delete ribbon._loadGuestState; delete ribbon._loadOperatorState; }
  await ribbon._init();return ribbon;
}

/** @description Run the cockpit's ribbon-ready step on a ribbon, recording what it opens.
 * @param ribbon The initialised ribbon. @returns The step's result and recorders. */
function boot(ribbon: { profile: object; views: Array<{ id: string }>; getActive?: () => string }) {
  const container = { innerHTML:'',querySelector:vi.fn(() => ({ addEventListener:vi.fn() })) };
  const viewController: { pendingTicketSelection?: string } = {};
  const switchView = vi.fn();
  const result = bootInitialView({ ribbon: Object.assign(Object.create(ribbon), { getActive: () => (ribbon as { activeView?: string }).activeView ?? 'home' }),
    container: container as never, viewController, isBusy: () => false, switchView, ticketId: 'T-9' });
  return { result, container, viewController, switchView };
}

/** The closed fallback the real _init produced, as the boot step and the renderer must both see it. */
function expectClosed(ribbon: { profile: { name: string; ribbon: { items: unknown[]; dynamicTools: { allow: unknown[] } } }; views: unknown[] }) {
  expect(ribbon.profile.name).toBe(PROFILE_UNAVAILABLE);
  expect(renderProfileRefusal(null, ribbon.profile)).toBe(true);
  expect(ribbon.profile.ribbon.items).toEqual([]);
  expect(ribbon.profile.ribbon.dynamicTools.allow).toEqual([]);
  expect(ribbon.views).toEqual([]);
}

describe('profile refusal retains focused shell context',() => {
  it('the refusal stops the boot: no view opens and no ticket is preselected, the panel renders', async () => {
    const response = await fetch(await endpoint(403));const data = await response.json();
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status:403}));
    const { result, container, viewController, switchView } = boot(ribbon);
    expect(result).toBe('refused');
    expect(switchView).not.toHaveBeenCalled();
    expect(viewController.pendingTicketSelection).toBeUndefined();
    expect(container.innerHTML).toContain('Application unavailable');
    expect(container.innerHTML).not.toContain('<iframe');
    const reload = vi.fn();vi.stubGlobal('window',{location:{reload}});
    (container.querySelector.mock.results[0].value.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1]();
    expect(reload).toHaveBeenCalledOnce();
    expect(renderProfileRefusal(null,{name:'framework-fallback'})).toBe(false);
  });
  it.each([403,404,503,500])('real HTTP %s retains landing and current operator verdict',async status => {
    const response = await fetch(await endpoint(status));expect(response.status).toBe(status);
    const data = await response.json();expect(data).toMatchObject({landingApp:landing,operator:false});
    expect(data.profile).toBeUndefined();
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status}));
    expect(ribbon.landingApp).toBe(landing);expect(ribbon.profileOperator).toBe(false);
    expect(ribbon.shellLocked).toBe(true);expect(ribbon._applyShellLock).toHaveBeenCalledOnce();
    expect(ribbon.hidePlatformChrome).toBe(true);expect(ribbon._openShellDoors).not.toHaveBeenCalled();
    expect(ribbon._appendPlatformHub).not.toHaveBeenCalled();expect(ribbon._loadExperiences).not.toHaveBeenCalled();
    expectClosed(ribbon);
  });
  it.each([
    ['a network failure', async () => { throw new Error('fixture network refusal'); }],
    ['a non-JSON 503', async () => new Response('fixture unavailable',{status:503})],
    ['a 200 without a profile', async () => new Response(JSON.stringify({landingApp:landing,operator:false}),{status:200})],
  ])('%s stays closed and does not reuse a prior operator verdict or landing', async (_label, response) => {
    const ribbon = await initialise(response as () => Promise<Response>);
    expect(ribbon.profileOperator === null || ribbon.profileOperator === false).toBe(true);
    expect(ribbon.shellLocked).toBe(true);expect(ribbon.landingApp).not.toBe('stale-landing');
    expect(ribbon._appendPlatformHub).not.toHaveBeenCalled();expect(ribbon._loadExperiences).not.toHaveBeenCalled();
    expectClosed(ribbon);
  });
  it('a profile answer that never arrives is abandoned at the bound and stays closed', async () => {
    const hang = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    vi.stubGlobal('window',{location:{search:'?app=home-experience',replace:vi.fn(),origin:ORIGIN,href:`${ORIGIN}/cockpit/`}});
    vi.stubGlobal('document',{querySelectorAll:() => []});
    vi.stubGlobal('fetch',vi.fn((_url: string, init?: RequestInit) => hang(init)));
    const ribbon = Object.create(RibbonNav.prototype);
    Object.assign(ribbon,{isOperator:false,studentMode:false,profileTimeoutMs:25});
    const profile = await ribbon._fetchProfile();
    expect(renderProfileRefusal(null, profile)).toBe(true);
    expect(ribbon.landingApp).toBe('home-experience');
  });
  it('an unreadable answer on the plain document stays closed too: no framework fallback', async () => {
    const ribbon = await initialise(async () => {throw new Error('fixture network refusal');},false);
    expect(ribbon.shellLocked).toBe(true);expect(ribbon.landingApp).toBeNull();
    expect(ribbon._loadExperiences).not.toHaveBeenCalled();expect(ribbon._openShellDoors).not.toHaveBeenCalled();
    expectClosed(ribbon);
    expect(boot(ribbon).switchView).not.toHaveBeenCalled();
  });
  it.each([{}, 'invalid-profile', { name: 'invalid' }, { name: 'invalid', ribbon: { items: 'invalid' } },
    { name: 'invalid', ribbon: { items: [null] } }, { name: 'invalid', ribbon: { items: [], dynamicTools: { allow: [42] } } }])
  ('a malformed successful profile stays closed on the plain document: %j', async profile => {
    const ribbon = await initialise(async () => new Response(JSON.stringify({ profile }), { status: 200 }), false);
    expectClosed(ribbon); expect(ribbon.shellLocked).toBe(true);
    expect(ribbon._appendPlatformHub).not.toHaveBeenCalled(); expect(ribbon._openShellDoors).not.toHaveBeenCalled();
    expect(boot(ribbon).switchView).not.toHaveBeenCalled();
  });
  it.each(['/api/auth/user', '/api/cli-tokens/whoami'])('a real hanging %s read reaches bounded closed refusal', async hangingPath => {
    const nativeFetch = fetch; const requests: string[] = []; const app = express();
    app.use((req, res) => { requests.push(req.path);
      if (req.path === hangingPath) return;
      res.json(req.path === '/api/auth/user' ? { guestMode: false } : { operator: false });
    });
    await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const ribbon = await initialise((init, url) => nativeFetch(new URL(url!, base), init), true, false, [],
      { realIdentity: true, timeoutMs: 150 });
    expect(requests).toContain(hangingPath); expect(requests).not.toContain('/api/ui/profile');
    expectClosed(ribbon); expect(ribbon.shellLocked).toBe(true); expect(ribbon._openShellDoors).not.toHaveBeenCalled();
    expect(boot(ribbon).switchView).not.toHaveBeenCalled();
  });
  it('a valid empty held rail never boots the native fallback workbench', async () => {
    const data = { profile: { name: landing, ribbon: { items: [], dynamicTools: { allow: [] } }, defaultView: null }, landingApp: landing, operator: false };
    const ribbon = await initialise(async () => new Response(JSON.stringify(data), { status: 200 }));
    const result = boot(ribbon);
    expect(ribbon.shellLocked).toBe(true); expect(ribbon.views).toEqual([]);
    expect(result.result).toBe('empty'); expect(result.switchView).not.toHaveBeenCalled();
    expect(result.viewController.pendingTicketSelection).toBeUndefined(); expect(result.container.innerHTML).toContain('No views available');
    expect(ribbon._loadToolViews).toHaveBeenCalledOnce();
  });
  it('a filtered default selects the admitted own tool instead of Tickets', async () => {
    const data = { profile: { name: landing, defaultView: 'tickets', ribbon: { items: [{ id: 'tool-own', toolUi: { iframeUrl: '/fixture/own' } }], dynamicTools: { allow: [] } } }, landingApp: landing, operator: false };
    const ribbon = await initialise(async () => new Response(JSON.stringify(data), { status: 200 }));
    const result = boot(ribbon);
    expect(result.result).toBe('tool-own'); expect(result.switchView).toHaveBeenCalledWith('tool-own');
    expect(result.viewController.pendingTicketSelection).toBeUndefined();
  });
  it('boot excludes both role-locked and guest-blocked registered views', () => {
    const ribbon = { profile: {}, activeView: 'tickets', views: [{ id: 'tickets', locked: {} }, { id: 'guest-only' }, { id: 'tool-own' }],
      _isGuestBlocked: (view: { id: string }) => view.id === 'guest-only' };
    const result = boot(ribbon);
    expect(result.result).toBe('tool-own'); expect(result.switchView).toHaveBeenCalledWith('tool-own');
    expect(result.viewController.pendingTicketSelection).toBeUndefined();
  });
  it('a locked shell answers neither the hub handshake nor a view navigation, from any sender', async () => {
    const response = await fetch(await endpoint(403));const data = await response.json();
    const sender = frame('/cockpit/tools/platform.html?v=1');
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status:403}),true,false,[sender]);
    for (const data of [{type:'platform-hub-ready'},{type:'app-navigate',view:'operations'},{type:'app-navigate',view:'tool-token-chase'}]) {
      ribbon._handleSurfaceMessage({ data, origin: ORIGIN, source: sender.contentWindow });
    }
    expect(sender.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(ribbon.setActive).not.toHaveBeenCalled();
  });
  it('keeps an authenticated operator unrestricted after a focused refusal, with the hub answering only its own frame', async () => {
    const response = await fetch(await endpoint(403,true));const data = await response.json();
    const hub = frame('/cockpit/tools/platform.html?v=2'), other = frame('/api/other-app/app?v=3');
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status:403}),true,true,[hub, other]);
    expect(ribbon.shellLocked).toBe(false);expect(ribbon._appendPlatformHub).toHaveBeenCalledOnce();
    expect(ribbon._openShellDoors).toHaveBeenCalledOnce();expect(ribbon._loadExperiences).toHaveBeenCalledOnce();
    const platform = ribbon.views.filter((view: { platformTool?: boolean }) => view.platformTool).map((view: { id: string }) => view.id);
    expect(platform).toEqual(expect.arrayContaining(['operations', 'connectors', 'tool-help', 'tool-token-chase', 'tool-dlq', 'tool-app-loader', 'tool-users']));
    ribbon._handleSurfaceMessage({ data:{type:'platform-hub-ready'}, origin:ORIGIN, source:hub.contentWindow });
    expect(hub.contentWindow.postMessage).toHaveBeenCalledOnce();
    expect(hub.contentWindow.postMessage.mock.calls[0][1]).toBe(ORIGIN);
    ribbon._handleSurfaceMessage({ data:{type:'app-navigate',view:'operations'}, origin:ORIGIN, source:hub.contentWindow });
    expect(ribbon.setActive).toHaveBeenCalledWith('operations');
    ribbon._handleSurfaceMessage({ data:{type:'app-navigate',view:'tool-users'}, origin:ORIGIN, source:other.contentWindow });
    ribbon._handleSurfaceMessage({ data:{type:'app-navigate',view:'tool-users'}, origin:'https://elsewhere.invalid', source:hub.contentWindow });
    ribbon._handleSurfaceMessage({ data:{type:'platform-hub-ready'}, origin:ORIGIN, source:other.contentWindow });
    expect(ribbon.setActive).toHaveBeenCalledTimes(1);
    expect(other.contentWindow.postMessage).not.toHaveBeenCalled();
  });
});

describe('the ticket deep link opens Tickets only when Tickets is registered', () => {
  it('a profile without Tickets opens its own view and preselects nothing; one with Tickets opens the ticket', () => {
    const own = boot({ profile: { name: 'fixture-app' }, views: [{ id: 'tool-fixture-app' }], activeView: 'tool-fixture-app' } as never);
    expect(own.result).toBe('tool-fixture-app');
    expect(own.switchView).toHaveBeenCalledWith('tool-fixture-app');
    expect(own.viewController.pendingTicketSelection).toBeUndefined();
    const tickets = boot({ profile: { name: 'oshal-framework' }, views: [{ id: 'tickets' }, { id: 'chat' }], activeView: 'home' } as never);
    expect(tickets.result).toBe('tickets');
    expect(tickets.switchView).toHaveBeenCalledWith('tickets');
    expect(tickets.viewController.pendingTicketSelection).toBe('T-9');
  });
});
