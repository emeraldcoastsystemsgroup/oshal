/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real Cockpit Home and Jarvis documents using isolated, explicitly synthetic app summaries and account preferences.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Mount canonical Cockpit palettes before the retained Jarvis fixture's legacy theme alias.
 */
import express from 'express';
import { resolve } from 'node:path';
import { startWorkspaceNavigationFixture } from './workspace-navigation';
import { attachJarvisBrowserAssets } from './jarvis-package-tools-browser';

/** @description Build an explicit synthetic app entry, never a business account.
 * @param name Stable identity. @param suite Explicit manifest classification. @returns Synthetic home-plan entry. */
export function homeEntry(name: string, suite?: string) {
  return { name, displayName: `Synthetic ${name}`, kind: 'app', suite, members: [name],
    description: 'Isolated daily dashboard test source.', firstSurface: `${name}-home`, firstSurfaceUrl: `/fixture/${name}`,
    summary: [{ app: name, path: `/fixture/probe/${name}`, metricsPointer: '/metrics', itemsPointer: '/items', surfaces: [`${name}-home`] }],
    todos: [{ app: name, label: 'Connect a source', path: `/fixture/probe/${name}`, readyPointer: '/ready' }] };
}

/** @description Make fresh fixture-only account state per browser case. @returns Controllable data and request receipts. */
function homeState() {
  const suites = ['platform', 'ai-productivity', 'ai-knowledge', 'ai-finance', 'ai-creative', 'ai-home', 'ai-engineering'];
  return { entries: [...suites.map((suite, i) => homeEntry(`source-${i}`, suite)), homeEntry('uncategorized')],
    preferences: { version: 1 } as Record<string, any>, revision: 0, preferenceStatus: 200, saveStatus: 200, planStatus: 200,
    taskStatus: 200, status: {} as Record<string, number>, gates: new Map<string, Promise<void>>(),
    calls: [] as string[], writes: [] as unknown[], activeProbes: 0, peakProbes: 0, outcomes: {} as Record<string, unknown> };
}

/** @description Serve deterministic owner facts, recording concurrency and refusing unspecified actions. */
function homeRoutes(app: express.Application, state: ReturnType<typeof homeState>) {
  app.use((req, _res, next) => { state.calls.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/ui/profile', (_req, res) => res.json({ profile: { name: 'framework-default', displayName: 'Synthetic Home',
    defaultView: 'home', ribbon: { items: ['home', 'settings'], dynamicTools: { allow: [] } } } }));
  app.get('/api/swarm/apps/home-plan', (_req, res) => res.status(state.planStatus).json({ apps: state.entries }));
  app.get('/api/home/preferences', (_req, res) => res.status(state.preferenceStatus).json({ preferences: state.preferences, revision: state.revision }));
  app.put('/api/home/preferences', express.json(), (req, res) => {
    state.writes.push(req.body);
    if (state.saveStatus !== 200) { res.status(state.saveStatus).json({ error: 'Synthetic display save unavailable.' }); return; }
    if (req.body.revision !== state.revision) { res.status(409).json({ error: 'Synthetic revision conflict.' }); return; }
    state.preferences = req.body.preferences; state.revision++;
    res.json({ preferences: state.preferences, revision: state.revision });
  });
  app.get('/fixture/probe/:name', async (req, res) => {
    state.activeProbes++; state.peakProbes = Math.max(state.peakProbes, state.activeProbes);
    let settled = false;
    res.once('close', () => { if (!settled) { settled = true; state.activeProbes--; } });
    await state.gates.get(req.params.name);
    if (res.destroyed) return;
    res.status(state.status[req.params.name] || 200).json(state.outcomes[req.params.name] || {
      metrics: [{ id: 'reported', label: 'Reported items', value: '2', tone: 'neutral' }],
      items: [{ text: `Update from ${req.params.name}`, detail: 'A synthetic owner-provided detail.', highlight: true }], ready: false });
  });
  app.get('/fixture/:name', (req, res) => res.type('html').send(`<!doctype html><h1>Opened ${req.params.name}</h1>`));
}

/** @description Reuse the actual Jarvis client with inert read responses and no provider implementation. */
function jarvisRoutes(app: express.Application, state: ReturnType<typeof homeState>) {
  app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
  attachJarvisBrowserAssets(app);
  app.get('/api/jarvis/', (_req, res) => res.sendFile(resolve('src/api/jarvis.html')));
  app.get('/api/jarvis/briefings/client.js', (_req, res) => res.sendFile(resolve('src/pages/jarvis-briefings/client.js')));
  app.get('/api/jarvis/tasks', (_req, res) => res.status(state.taskStatus).json({ tasks: [] }));
  const reads = { '/api/jarvis/ambient/settings': { settings: { enabled: false } },
    '/api/jarvis/ambient/speaker-context': { enrolled: false }, '/api/jarvis/overview': { bots: [], activity: [], comms: {}, calendar: {} },
    '/api/swarm/work-items': { items: [] }, '/api/user-model/suggestions': { suggestions: [] },
    '/api/tickets': { tickets: [] }, '/api/jarvis/history': { turns: [] }, '/api/jarvis/threads': { threads: [] } };
  for (const [url, body] of Object.entries(reads)) app.get(url, (_req, res) => res.json(body));
}

/** @description Boot real app.js, Ribbon, controller, Home and Jarvis over a fresh synthetic HTTP origin.
 * @returns Fixture data, origin and complete cleanup. */
export async function startAppHomeBrowserFixture() {
  const state = homeState();
  const fixture = await startWorkspaceNavigationFixture(app => { homeRoutes(app, state); jarvisRoutes(app, state); });
  return { ...fixture, home: state };
}
