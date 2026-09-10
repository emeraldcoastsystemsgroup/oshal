import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHomePlan } from '@/features/swarm-apps/services/app-home-plan';
afterEach(() => vi.unstubAllGlobals());
describe('application-to-application context relay', () => {
  it('exposes source contracts for grouped apps without summary routes', () => {
    const app: any = { name:'travel', displayName:'Travel', ui:{static:[{toolName:'travel-home',iframeUrl:'/api/travel/app'}]}, integrations:{offers:[]} };
    const group: any = { name:'life',displayName:'Life',kind:'group',dependencies:{apps:['travel']} };
    const plan = buildHomePlan([app,group]);
    expect(plan[0].summary).toEqual([]);
    expect(plan[0].integrationSources).toEqual([{app:'travel',surfaces:[{name:'travel-home',url:'/api/travel/app'}],offers:[]}]);
  });
  it('requires owned path, origin and declared query selector', async () => {
    const { ownsSurface } = await import('@/pages/cockpit/js/app-workflows.js' as any);
    vi.stubGlobal('window',{location:{origin:'https://local.example',href:'https://local.example/cockpit/'}});
    const source={surfaces:[{url:'/api/source/app?view=selected'}]};
    expect(ownsSurface(source,'/api/source/app?view=selected&v=1')).toBe(true);
    for(const url of ['/api/other/app?view=selected','https://foreign.example/api/source/app?view=selected','/api/source/app?view=other']) expect(ownsSurface(source,url)).toBe(false);
  });
  it('rejects other frames, removed source, invalid context, and detachment during catalog read', async () => {
    const { bindAppHandoffs } = await import('@/pages/cockpit/js/app-workflows.js' as any);
    let listener: any;const postMessage=vi.fn(),navigate=vi.fn();
    vi.stubGlobal('window',{location:{origin:'https://local.example',href:'https://local.example/cockpit/'},addEventListener:(_:any,fn:any)=>listener=fn,removeEventListener:vi.fn()});
    const frame={src:'https://local.example/api/source/app',isConnected:true,contentWindow:{postMessage,location:{href:'https://local.example/api/source/app'}}};
    const offer={id:'prepare',sourceApp:'source',targetApp:'target',targetAction:'draft',contextType:'brief',version:1,state:'available',surface:'target-home',surfaceUrl:'/api/target',fields:['title']};
    let sources:any[]=[{app:'source',surfaces:[{url:'/api/source/app'}],offers:[offer]}];
    const fetch=vi.fn(async()=>({ok:true,json:async()=>({apps:[{integrationSources:sources}]})}));vi.stubGlobal('fetch',fetch);
    const dispose=bindAppHandoffs(frame,navigate);
    const data={type:'oshal:request-app-context',requestId:'one',app:'source',offer:'prepare',context:{title:'Draft'}};
    const send=(patch:any={},source:any=frame.contentWindow)=>listener({origin:'https://local.example',source,data:{...data,...patch}});
    await send({},{});expect(fetch).not.toHaveBeenCalled();
    await send({context:{token:'forbidden'}});expect(navigate).not.toHaveBeenCalled();
    sources=[];await send();expect(navigate).not.toHaveBeenCalled();
    sources=[{app:'source',surfaces:[{url:'/api/source/app'}],offers:[offer]}];
    await send();expect(navigate).toHaveBeenCalledOnce();expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ok:true}),'https://local.example');
    frame.contentWindow.location.href='https://local.example/api/other/app';await send();expect(navigate).toHaveBeenCalledOnce();
    frame.contentWindow.location.href=frame.src;
    fetch.mockImplementationOnce(async()=>{frame.isConnected=false;return {ok:true,json:async()=>({apps:[{integrationSources:sources}]})};});
    await send();expect(navigate).toHaveBeenCalledOnce();dispose();
  });
});
