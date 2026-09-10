import { describe, expect, it, vi, afterEach } from 'vitest';
import { validateAppIntegrations, resolveAppIntegrations } from '@/features/swarm-apps/services/app-integrations';
import { buildHomePlan } from '@/features/swarm-apps/services/app-home-plan';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';

const receiver: SwarmAppManifest = {
  name: 'receiver', displayName: 'Receiver',
  ui: { static: [{ toolName: 'receiver-draft', label: 'Draft', icon: 'codicon codicon-edit', iframeUrl: '/api/receiver/draft' }] },
  integrations: { accepts: [{ id: 'draft', contextType: 'research-brief', version: 1, surface: 'receiver-draft', fields: ['title', 'notes'] }] },
};
const sender: SwarmAppManifest = {
  name: 'sender', displayName: 'Sender', summary: { path: '/api/sender/home', itemsPointer: '/items' },
  integrations: { offers: [{ id: 'prepare', label: 'Prepare draft', targetApp: 'receiver', targetAction: 'draft', contextType: 'research-brief', version: 1 }] },
};
afterEach(() => vi.unstubAllGlobals());

describe('loaded application integration contracts', () => {
  it('requires a loaded compatible receiver and does not turn optional offers into install dependencies', () => {
    validateAppIntegrations(receiver, 'receiver'); validateAppIntegrations(sender, 'sender');
    expect(resolveAppIntegrations(sender, [sender])[0].state).toBe('unavailable');
    expect(resolveAppIntegrations(sender, [sender, { ...receiver, status: 'inactive' }])[0].state).toBe('unavailable');
    expect(resolveAppIntegrations(sender, [sender, { ...receiver, integrations: { accepts: [{ ...receiver.integrations!.accepts![0], version: 2 }] } }])[0].state).toBe('incompatible');
    expect(buildHomePlan([sender, receiver])[0].summary[0].integrations![0]).toMatchObject({ state: 'available', surface: 'receiver-draft', fields: ['title', 'notes'] });
    expect(sender.dependencies).toBeUndefined();
  });

  it('rejects unknown fields, foreign surfaces, duplicate ids and unsafe field names', () => {
    for (const patch of [{ surface: 'foreign' }, { fields: ['constructor'] }, { fields: ['title', 'title'] }, { version: 0 }, { autoSend: true }]) {
      const app = structuredClone(receiver);
      Object.assign(app.integrations!.accepts![0], patch);
      expect(() => validateAppIntegrations(app, 'test')).toThrow(/integrations/);
    }
    const app = structuredClone(receiver);
    app.ui!.static![0].iframeUrl = 'https://foreign.example/app';
    expect(() => validateAppIntegrations(app, 'test')).toThrow(/same-origin/);
    app.integrations!.accepts!.push(app.integrations!.accepts![0]);
    expect(() => validateAppIntegrations(app, 'test')).toThrow();
  });

  it('only renders declared actions with receiver-approved text and escapes display content', async () => {
    const { AppsHomeView } = await import('@/pages/cockpit/js/views/AppsHomeView.js' as any);
    const view = new AppsHomeView(); view.cards = new Map();
    const [entry] = buildHomePlan([sender, receiver]);
    const html = await view.loadCard(entry, new Map(), new Map([['/api/sender/home', { ok: true, body: { items: [
      { text: '<img>', detail: '<script>data</script>', integration: 'prepare', context: { title: 'Research' } },
      { text: 'Unknown action', integration: 'execute', context: { title: 'x' } },
      { text: 'Wrong fields', integration: 'prepare', context: { token: 'disallowed' } },
    ] } }]]));
    expect(html.match(/data-integration=/g)).toHaveLength(1);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<img>');
    expect(html).not.toContain('disallowed');
  });

  it('does not promote ordinary metadata into highlights', async () => {
    const { highlights } = await import('@/pages/cockpit/js/views/app-home-model.js' as any);
    const cards = new Map([['sender', { tiles: [], items: [{ text: 'Saved metadata only' }], open: [] }]]);
    expect(highlights([sender], cards, {})).toEqual([]);
    cards.get('sender')!.items = [{ text: 'Result ready', highlight: true } as any];
    expect(highlights([sender], cards, {})[0].text).toBe('Result ready');
  });

  it('delivers once to the exact same-origin frame and bounds context', async () => {
    const { contextFor, stageHandoff, deliverHandoff } = await import('@/pages/cockpit/js/app-handoff.js' as any);
    expect(contextFor(['title'], { title: 'x'.repeat(2001) })).toBeNull();
    expect(contextFor(['title'], { title: 2 })).toBeNull();
    expect(contextFor(['title'], JSON.parse('{"__proto__":"x"}'))).toBeNull();
    vi.stubGlobal('window', { location: { href: 'https://local.example/cockpit/', origin: 'https://local.example' } });
    const offer = resolveAppIntegrations(sender, [sender, receiver])[0];
    const postMessage = vi.fn(); let onload: (() => void) | undefined;
    const frame = { src: '/api/receiver/draft', isConnected: true, contentWindow: { postMessage }, addEventListener: (_: string, fn: () => void) => { onload = fn; } };
    expect(stageHandoff(offer, { title: 'Research' })).toBe(true);
    deliverHandoff(frame, 'other'); expect(onload).toBeUndefined();
    stageHandoff(offer, { title: 'Research' }); deliverHandoff(frame, 'receiver-draft');
    onload!(); expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ targetApp: 'receiver', context: { title: 'Research' } }), 'https://local.example');
    onload = undefined; deliverHandoff(frame, 'receiver-draft'); expect(onload).toBeUndefined();
    stageHandoff(offer, { title: 'Research' }); deliverHandoff({ ...frame, src: 'https://foreign.example/' }, 'receiver-draft'); expect(onload).toBeUndefined();
  });

  it('a receiving app rejects foreign senders, wrong contracts and expired drafts', async () => {
    const { receiveHandoff } = await import('@/pages/cockpit/js/app-handoff.js' as any);
    const parent = {}; const listeners = new Map<string, (event: any) => void>();
    vi.stubGlobal('window', { parent, location: { origin: 'https://local.example' },
      addEventListener: (type: string, fn: any) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type) });
    const onDraft = vi.fn();
    receiveHandoff({ app: 'receiver', action: 'draft', contextType: 'research-brief', version: 1, fields: ['title'] }, onDraft);
    const data = { type: 'oshal:app-context', sourceApp: 'sender', targetApp: 'receiver', action: 'draft', contextType: 'research-brief', version: 1, context: { title: 'Review me' }, expiresAt: Date.now() + 60000 };
    const send = (patch: any = {}, origin = 'https://local.example', source: any = parent) => listeners.get('message')?.({ data: { ...data, ...patch }, source, origin });
    send({}, 'https://foreign.example'); send({}, undefined, {}); send({ targetApp: 'other' }); send({ version: 2 }); send({ expiresAt: 0 }); send({ context: { unauthorizedField: 'no' } });
    expect(onDraft).not.toHaveBeenCalled();
    send(); send(); expect(onDraft).toHaveBeenCalledOnce(); expect(onDraft).toHaveBeenCalledWith({ title: 'Review me' }, { sourceApp: 'sender' });
  });
});
