/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove production legacy and raw-document entries require authentication and checked package opening, preserving shared assets, Nexus and Simple.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn() }) }));
let server: Server, origin: string;
beforeAll(async () => {
  const app = express();
  registerCockpitStaticRoutes({ app, requiresAuth: (req,res,next) => req.get('x-fixture-auth') === '1' ? next() : res.sendStatus(401),
    cockpitDir:resolve('src/pages/cockpit'),uiEnhancedDir:resolve('any-bot/ui-enhanced'),codiconFontsDir:resolve('node_modules/@vscode/codicons/dist'),
    sharedUiCssDir:resolve('src/shared/ui/css'),sharedUiJsDir:resolve('src/shared/ui/js') });
  server=app.listen(0,'127.0.0.1'); await new Promise<void>(done=>server.once('listening',done)); origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
const get=(path:string,authenticated=true)=>fetch(origin+path,{redirect:'manual',headers:authenticated?{'x-fixture-auth':'1'}:{}});
describe('installed experience entry aliases',()=>{
  it('routes all seven legacy entries through their own installed authorization check',async()=>{
    const aliases: Array<[string,string]> = [['/studio','studio'],['/jarvis','jarvis'],['/orbit','orbit'],['/commons','commons'],['/homebase?preset=family','home'],['/homebase?preset=company','business'],['/homebase?preset=classroom','classroom'],['/little-monsters','classroom']];
    for(const [path,name] of aliases){const response=await get(path);expect(response.status,path).toBe(302);expect(response.headers.get('location'),path).toBe(`/api/ui/experiences/${name}-experience/open`);expect(response.headers.get('cache-control')).toContain('no-store');expect((await get(path,false)).status).toBe(401);}
  });
  it('raw legacy HTML cannot bypass the package check, and untrusted query values cannot redirect outside it',async()=>{
    for(const name of ['studio','jarvis','orbit','commons','homebase']){const response=await get(`/experience/${name}.html`);expect(response.status).toBe(302);expect(response.headers.get('location')).toBe(`/api/ui/experiences/${name==='homebase'?'home':name}-experience/open`);}
    expect((await get('/homebase?preset=https://fixture.invalid&app=unrelated')).headers.get('location')).toBe('/api/ui/experiences/home-experience/open');
  });
  it('preserves Nexus, Simple and authenticated shared renderer assets',async()=>{
    for(const path of ['/nexus','/simple','/experience/homebase.js','/experience/full-swarm.js'])expect((await get(path)).status,path).toBe(200);
    expect((await get('/experience/full-swarm.js',false)).status).toBe(401);
  });
});
