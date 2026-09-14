/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the actual Jarvis page and panel with bounded disposable HTTP proposal responses for browser boundary tests.
 */
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** @description Construct response metadata without granting authority through tool inputs.
 * @param mode Controller approval posture. @param lifetime Milliseconds until expiry.
 * @returns A fresh display proposal bound to one UUID.
 */
export function browserToolProposal(mode: 'ask' | 'auto' = 'ask', lifetime = 60_000) {
  return { id: randomUUID(), app: 'fixture-app', toolName: 'fixture_change', label: 'Change fixture record', mode,
    input: { recordId: 'fixture-record', label: '<img src=x onerror="window.injected=1">' },
    expiresAt: new Date(Date.now() + lifetime).toISOString() };
}

/** @description Keep transport edge cases separate from the real policy fixture.
 * @returns Fresh disposable HTTP state with no deployment accounts or data.
 */
export function browserToolState() {
  return { proposal: browserToolProposal(), allowed: true, hold: undefined as Promise<void> | undefined,
    calls: [] as Array<{ action: string; body: unknown; marker?: string; origin?: string; cookie?: string }>,
    asks: [] as unknown[], executed: new Set<string>(), result: { value: 'private-fixture-result', html: '<script>window.injected=1</script>' } };
}

function toolEndpoints(app: Express, state: ReturnType<typeof browserToolState>) {
  app.post('/api/jarvis/package-tools/:action', async (req, res) => {
    state.calls.push({ action: req.params.action, body: req.body, marker: req.get('X-OSHAL-Package-Tool'),
      origin: req.get('origin'), cookie: req.get('cookie') });
    if (!state.allowed || req.get('X-OSHAL-Package-Tool') !== '1' || req.body.proposalId !== state.proposal.id) {
      res.status(403).json({ error: 'unavailable' }); return;
    }
    if (Date.parse(state.proposal.expiresAt) <= Date.now()) { res.status(410).json({ error: 'expired' }); return; }
    if (req.params.action === 'result') { res.status(410).json({ error: 'package_tool_result_expired' }); return; }
    if (req.params.action === 'execute') {
      if (state.executed.has(req.body.proposalId)) { res.status(409).json({ error: 'consumed' }); return; }
      state.executed.add(req.body.proposalId);
      await state.hold;
    }
    res.json({ result: state.result, expiresAt: state.proposal.expiresAt });
  });
}

/** @description Use the actual page and imported shared themes for realistic browser behavior.
 * @param app Disposable fixture server. @returns Nothing; mounts static browser assets.
 */
export function attachJarvisBrowserAssets(app: Express): void {
  app.get('/api/jarvis/ui', (_req, res) => res.sendFile(resolve('src/api/jarvis.html')));
  app.use('/shared/ui', express.static(resolve('src/shared/ui')));
  app.use('/cockpit/css/themes', express.static(resolve('src/shared/ui/css/themes')));
  app.use('/api/jarvis/assets', express.static(resolve('src/api')));
}

/** @description Serve browser edge cases without using a deployment database or provider.
 * @returns Isolated loopback server, mutable fixture state and explicit cleanup.
 */
export async function startJarvisPackageBrowserFixture() {
  const state = browserToolState();
  const app = express(); app.use(express.json());
  attachJarvisBrowserAssets(app);
  toolEndpoints(app, state);
  app.post('/api/jarvis/ask', (req, res) => { state.asks.push(req.body); res.json({ jobId: 'browser-fixture-job' }); });
  app.get('/api/jarvis/ask/result', (_req, res) => res.json({ status: 'done', answer: 'Application tool ready.', packageToolProposal: state.proposal }));
  app.get('/api/jarvis/tasks', (_req, res) => res.json({ tasks: [] }));
  app.get('/api/jarvis/threads', (_req, res) => res.json({ threads: [] }));
  app.use((_req, res) => res.status(404).json({ error: 'fixture_unavailable' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, async stop() {
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  } };
}
