import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());

it('a late Home summary cannot repaint an application opened while summaries were loading', async () => {
  const { AppsHomeView } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const entry = { name: 'source', displayName: 'Source', suite: 'ai-productivity', members: ['source'], todos: [], summary: [{app:'source',path:'/slow',itemsPointer:'/items',surfaces:[],integrations:[]}] };
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '/slow' ? pending : Promise.resolve(new Response(JSON.stringify(
    url.endsWith('home-plan') ? {apps:[entry]} : url.endsWith('preferences') ? {preferences:{version:1},revision:0} : {tasks:[]},
  ), { status: 200 }))));
  const host = { innerHTML: '', onclick: () => {}, onchange: () => {} };
  const view = new AppsHomeView();
  view.draw = vi.fn(() => { host.innerHTML = 'Home'; });
  const render = view.render(host);
  await vi.waitFor(() => expect(view.draw).toHaveBeenCalledOnce());
  view.destroy();
  host.innerHTML = 'Opened application';
  release(new Response(JSON.stringify({items:[]}), {status:200}));
  await render;
  expect(host.innerHTML).toBe('Opened application');
  expect(view.draw).toHaveBeenCalledOnce();
  expect(host.onclick).toBeNull();
  expect(host.onchange).toBeNull();
});

it('a pending Home action cannot override subsequent navigation', async () => {
  const { AppsHomeView } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const navigate = vi.fn(), view = new AppsHomeView({navigateToView:navigate});
  view.entries = [{name:'source'}];
  view.cards = new Map([['source',{items:[{sourceApp:'source',actions:[{integration:'next',context:{title:'Draft'}}]}]}]]);
  const button = {disabled:false,dataset:{card:'source',item:'0',integration:'next'}};
  const click = view.handleClick({target:{closest:()=>button}});
  view.destroy();
  release(new Response(JSON.stringify({apps:[]}), {status:200}));
  await click;
  expect(navigate).not.toHaveBeenCalled();
  expect(() => view.draw()).not.toThrow();
});
