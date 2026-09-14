/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Serve unchanged Jarvis markup and real client assets over isolated synthetic HTTP for dashboard proofs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Let a case refuse chosen thread ids (or every ask) with the server's real session_not_found contract, so the page's roll-to-a-fresh-thread resend is proven at the HTTP boundary.
 */
import express, { type Express } from 'express';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { attachJarvisBrowserAssets } from './jarvis-package-tools-browser';

export interface DashboardTask {
  id: string; title: string; status: string; createdAt: string; delivered: boolean;
  result?: string; error?: string; briefing?: Record<string, unknown>;
}

/** @description Hold one HTTP response without replacing client behavior. @returns Gate and explicit release. */
export function dashboardGate() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

/** @description Create independent synthetic task data for each browser case. @returns Mutable fixture ports. */
export function dashboardState() {
  return {
    tasks: [] as DashboardTask[], asks: [] as Record<string, unknown>[], mutations: [] as string[],
    result: { status: 'done', answer: 'A **clear answer** with its existing discussion.' } as Record<string, unknown>,
    resultGate: undefined as Promise<void> | undefined, speechGate: undefined as Promise<void> | undefined,
    taskStatus: 200, claims: [] as unknown[], transcription: 'Explain the fixture status.', speechSamples: 4000, denyMicrophone: false,
    // Thread ids /ask answers with the server's 404 session_not_found contract; '*' refuses every ask.
    refusedSessionIds: [] as string[],
  };
}

/** @description Generate local silent PCM audio; no speech service or microphone recording leaves the fixture. */
function silenceWav(samples: number, rate = 8000) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  return data.toString('base64');
}

/** @description Supply a known local PCM input to Chromium instead of accessing a host microphone. @returns File and exact cleanup. */
export async function dashboardMediaFile() {
  const directory = await mkdtemp(join(tmpdir(), 'oshal-jarvis-media-'));
  const path = join(directory, 'input.wav');
  await writeFile(path, Buffer.from(silenceWav(48_000, 48_000), 'base64'));
  return { path, async cleanup() { await unlink(path); await rmdir(directory); } };
}

/** @description Supply current tasks and retain the original delivered/dismiss request contracts. */
function dashboardTaskRoutes(app: Express, state: ReturnType<typeof dashboardState>) {
  app.get('/api/jarvis/tasks', (_req, res) => res.status(state.taskStatus).json({ tasks: state.tasks }));
  app.post('/api/jarvis/tasks/:id/delivered', (req, res) => {
    state.mutations.push(`delivered:${req.params.id}`);
    const task = state.tasks.find(item => item.id === req.params.id); if (task) task.delivered = true;
    res.json({ ok: true });
  });
  app.post('/api/jarvis/ask/dismiss', (req, res) => {
    state.mutations.push(`dismiss:${req.query.jobId}`);
    state.tasks = state.tasks.filter(item => item.id !== req.query.jobId); res.json({ ok: true });
  });
  app.post('/api/jarvis/briefings/claim', (req, res) => { state.claims.push(req.body); res.status(403).json({ error: 'briefing_access_denied' }); });
}

/** @description Model asynchronous answers and speech only at their HTTP boundary. */
function dashboardConversationRoutes(app: Express, state: ReturnType<typeof dashboardState>) {
  app.post('/api/jarvis/ask', (req, res) => {
    state.asks.push(req.body);
    const refused = state.refusedSessionIds.includes('*') || state.refusedSessionIds.includes(String(req.body?.sessionId));
    if (refused) { res.status(404).json({ error: 'session_not_found' }); return; }
    res.json({ jobId: 'dashboard-answer' });
  });
  app.get('/api/jarvis/ask/result', async (_req, res) => { await state.resultGate; res.json(state.result); });
  app.post('/api/voice/synthesize', async (_req, res) => {
    await state.speechGate; res.json({ data: { audioData: silenceWav(state.speechSamples), format: 'wav' } });
  });
  app.post('/api/voice/transcribe', (_req, res) => res.json({ data: { text: state.transcription } }));
  app.post('/api/jarvis/thread/close', (_req, res) => { state.mutations.push('close-thread'); res.json({ ok: true }); });
}

/** @description Keep all local helpers real while returning inert ambient/overview data. */
function dashboardReadRoutes(app: Express) {
  app.get('/api/jarvis/briefings/client.js', (_req, res) => res.sendFile(resolve('src/pages/jarvis-briefings/client.js')));
  app.get('/api/jarvis/ambient/settings', (_req, res) => res.json({ settings: { enabled: false, assistantName: 'Jarvis', speakerDiarizationEnabled: false } }));
  app.get('/api/jarvis/ambient/speaker-context', (_req, res) => res.json({ enrolled: false }));
  app.get('/api/jarvis/overview', (_req, res) => res.json({ bots: [{ agentId: 'engineering-fixture', name: 'Engineering', status: 'online' }], activity: [], comms: {}, calendar: {} }));
  app.get('/api/swarm/work-items', (_req, res) => res.json({ items: [] }));
  app.get('/api/user-model/suggestions', (_req, res) => res.json({ suggestions: [] }));
  app.get('/api/tickets', (_req, res) => res.json({ tickets: [] }));
  app.get('/api/jarvis/history', (_req, res) => res.json({ turns: [] }));
  app.get('/api/jarvis/visuals/c94fc97a-2497-4eeb-8b89-0214e8f4629e', (_req, res) => res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#243854"/><text x="30" y="90" fill="white">Fixture visual</text></svg>'));
}

/** @description Start a disposable HTTP origin with real page/modules and synthetic service ports. @returns Fixture and explicit cleanup. */
export async function startJarvisDashboardFixture() {
  const state = dashboardState(), app = express(); app.use(express.json());
  app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
  attachJarvisBrowserAssets(app);
  app.get('/api/jarvis/', (_req, res) => {
    if (state.denyMicrophone) res.setHeader('Permissions-Policy', 'microphone=()');
    res.sendFile(resolve('src/api/jarvis.html'));
  });
  app.get('/fixture-home', (_req, res) => res.send('<!doctype html><html data-theme="workspace"><body style="margin:0"><iframe title="Jarvis" allow="microphone; camera" src="/api/jarvis/?layout=compact" style="display:block;border:0;width:100%;height:100vh"></iframe></body></html>'));
  dashboardTaskRoutes(app, state); dashboardConversationRoutes(app, state); dashboardReadRoutes(app);
  app.use((_req, res) => res.status(404).json({ error: 'fixture_unavailable' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, async stop() {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  } };
}
