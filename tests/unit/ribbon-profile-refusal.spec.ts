/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual refused profile HTTP responses and ribbon initialisation without widening a focused deployment's shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { RibbonNav } from '@/pages/cockpit/js/components/RibbonNav.js';
import { renderProfileRefusal } from '@/pages/cockpit/js/cockpit-profile-refusal.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createUiProfileRoutes, type UiProfileDiscoveryPorts } from '@/app/routes/ui-profile-routes';
import type { UIProfileService } from '@/features/ui-profile';
import type { SwarmAppService } from '@/features/swarm-apps';

const landing = 'intelligent-sales';
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
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
  await new Promise<void>(resolve => { server=app.listen(0,'127.0.0.1',resolve); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/ui/profile?name=home-experience`;
}

/** @description Exercise the actual fetch and init methods while isolating unrelated DOM/tool providers.
 * @param response Profile response or transport failure. @param focused Whether the URL names an application.
 * @param operator Current whoami verdict. @returns The initialized ribbon and observed chrome actions. */
async function initialise(response: () => Promise<Response>, focused = true, operator = false) {
  vi.stubGlobal('window',{location:{search:focused ? '?app=home-experience' : '',replace:vi.fn()}});
  vi.stubGlobal('fetch',vi.fn(response));
  const ribbon = Object.create(RibbonNav.prototype);
  Object.assign(ribbon,{isOperator:operator,profileOperator:true,landingApp:null,studentMode:false,
    _loadGuestState:vi.fn(async () => undefined),_loadOperatorState:vi.fn(async () => undefined),
    _applyAppBranding:vi.fn(),_appendPlatformTools:vi.fn(),_appendPlatformHub:vi.fn(),
    _applyShellLock:vi.fn(),_loadExperiences:vi.fn(async () => undefined),render:vi.fn(),_loadToolViews:vi.fn()});
  await ribbon._init();return ribbon;
}

describe('profile refusal retains focused shell context',() => {
  it('renders the refusal before default or deep-linked ticket navigation', () => {
    const listener = vi.fn();
    const container = { innerHTML:'',querySelector:vi.fn(() => ({ addEventListener:listener })) };
    const reload = vi.fn();vi.stubGlobal('window',{location:{reload}});
    expect(renderProfileRefusal(container,{name:'profile-unavailable'})).toBe(true);
    expect(container.innerHTML).toContain('Application unavailable');
    expect(container.innerHTML).not.toContain('<iframe');
    listener.mock.calls[0][1]();expect(reload).toHaveBeenCalledOnce();
    expect(renderProfileRefusal(null,{name:'profile-unavailable'})).toBe(true);
    expect(renderProfileRefusal(container,{name:'framework-fallback'})).toBe(false);
    const source = readFileSync(resolve(process.cwd(),'src/pages/cockpit/js/app.js'),'utf8');
    const refusalGuard = source.indexOf('if (renderProfileRefusal(');
    const ticketNavigation = source.indexOf('const requestedTicketId = readRequestedTicketId();');
    expect(refusalGuard).toBeGreaterThanOrEqual(0);
    expect(ticketNavigation).toBeGreaterThanOrEqual(0);
    expect(refusalGuard).toBeLessThan(ticketNavigation);
  });
  it.each([403,404,503,500])('real HTTP %s retains landing and current operator verdict',async status => {
    const response = await fetch(await endpoint(status));expect(response.status).toBe(status);
    const data = await response.json();expect(data).toMatchObject({landingApp:landing,operator:false});
    expect(data.profile).toBeUndefined();
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status}));
    expect(ribbon.landingApp).toBe(landing);expect(ribbon.profileOperator).toBe(false);
    expect(ribbon.shellLocked).toBe(true);expect(ribbon._applyShellLock).toHaveBeenCalledOnce();
    expect(ribbon._appendPlatformHub).not.toHaveBeenCalled();expect(ribbon._loadExperiences).not.toHaveBeenCalled();
    expect(ribbon.profile.ribbon.items).toEqual([]);expect(ribbon.profile.ribbon.dynamicTools.allow).toEqual([]);
  });
  it('a network failure does not reuse a prior operator verdict or expose focused chrome',async () => {
    const ribbon = await initialise(async () => {throw new Error('fixture network refusal');});
    expect(ribbon.profileOperator).toBeNull();expect(ribbon.shellLocked).toBe(true);
    expect(ribbon._appendPlatformHub).not.toHaveBeenCalled();expect(ribbon._loadExperiences).not.toHaveBeenCalled();
    expect(ribbon.profile.ribbon.items).toEqual([]);
  });
  it('a non-JSON error stays closed in the focused shell',async () => {
    const ribbon = await initialise(async () => new Response('fixture unavailable',{status:503}));
    expect(ribbon.shellLocked).toBe(true);expect(ribbon._appendPlatformHub).not.toHaveBeenCalled();
    expect(ribbon._loadExperiences).not.toHaveBeenCalled();
  });
  it('keeps an authenticated operator unrestricted after a focused refusal',async () => {
    const response = await fetch(await endpoint(403,true));const data = await response.json();
    const ribbon = await initialise(async () => new Response(JSON.stringify(data),{status:403}),true,true);
    expect(ribbon.shellLocked).toBe(false);expect(ribbon._appendPlatformHub).toHaveBeenCalledOnce();
    expect(ribbon._loadExperiences).toHaveBeenCalledOnce();
  });
  it('preserves ordinary framework fallback without a focused URL or landing',async () => {
    const ribbon = await initialise(async () => {throw new Error('fixture network refusal');},false);
    expect(ribbon.shellLocked).toBe(false);expect(ribbon.profile.name).toBe('framework-fallback');
    expect(ribbon._loadExperiences).toHaveBeenCalledOnce();
  });
});
