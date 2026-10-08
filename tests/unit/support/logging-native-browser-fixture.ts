/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve shipped logging modules and a browser-only HTTP double; native tests own authority and persistence proofs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Model full conditional configuration writes without accepting stale acknowledgement preconditions.
 */
import express, { type Request, type Response } from 'express';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

/** @description Synthetic acknowledged logging state, without real administrator authority.
 * @returns The exact browser logging configuration shape. */
export type LoggingBrowserConfig = { level: string; module_levels: Record<string, string> };
type Reply = { status: number; body: unknown };
type Call = { method: string; path: string; query: Record<string, unknown>; body: unknown };
type Held = { method: string; path: string; entered: Promise<void>; seen: () => void;
  wait: Promise<Reply | undefined>; release: (reply?: Reply) => void; used: boolean };

const ASSETS = [
  '/src/pages/cockpit/js/views/LogsView.js', '/src/pages/cockpit/js/views/logging-reader.js',
  '/src/pages/cockpit/js/views/logging-settings.js', '/src/pages/shared/ui-debug.js',
  '/src/pages/cockpit/css/logs-view.css',
];
const HTML = `<!doctype html><html><head><title>Logging browser-only fixture</title>
<link rel="stylesheet" href="/src/pages/cockpit/css/logs-view.css">
<style>body{margin:0;background:#101827;color:#e2e8f0}#fixtureRoot{height:900px}
:root{--text-primary:#e2e8f0;--text-secondary:#94a3b8}</style></head><body>
<div id="fixtureRoot"></div><script type="module">
import { LogsView } from '/src/pages/cockpit/js/views/LogsView.js';
const view = new LogsView(document.getElementById('fixtureRoot'));
window.__loggingBrowser = { view, pending: [] };
// Observe original promises only: every real implementation and fetch still runs unchanged.
function observe(target, name) { const original = target[name]; target[name] = function(...args) {
  const pending = original.apply(this, args); window.__loggingBrowser.pending.push(pending); return pending;
}; }
observe(view, '_loadLogs');
window.__loggingBrowser.ready = view.render().then(() => {
  if (view.settings) observe(view.settings, 'apply');
});
</script></body></html>`;

/** @description Synthetic records exercise real rendering and correlation controls.
 * @param overrides Record fields for an individual browser assertion.
 * @returns An explicitly synthetic structured record. */
export function loggingBrowserRecord(overrides: Record<string, unknown> = {}) {
  return { time: '2026-01-02T03:04:05.000Z', levelLabel: 'info', module: 'api::admission',
    msg: 'Authorized operation completed', ticketId: 'ticket-fixture-A', traceId: 'trace-fixture-A',
    durationMs: 12, ...overrides };
}

/** @description Own a loopback fixture that never calls native/live APIs or supplies sessions.
 * @returns Mutable synthetic responses plus explicit server cleanup. */
export class LoggingNativeBrowserFixture {
  origin = '';
  server?: Server;
  calls: Call[] = [];
  records: Record<string, unknown>[] = [];
  modules: string[] = [];
  config: LoggingBrowserConfig = { level: 'info', module_levels: {} };
  queryStatus = 200;
  settingsStatus = 200;
  updateStatus = 200;
  updateReply: unknown;
  held: Held[] = [];

  reset() {
    this.releaseAll();
    this.calls = [];
    this.records = [loggingBrowserRecord()];
    this.modules = ['api::admission', 'workflow::dispatch'];
    this.config = { level: 'info', module_levels: { 'api::admission': 'warn', worker: 'debug' } };
    this.queryStatus = this.settingsStatus = this.updateStatus = 200;
    this.updateReply = undefined;
    this.held = [];
  }

  async start() {
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.get('/', (_req, res) => res.type('html').send(HTML));
    for (const asset of ASSETS) app.get(asset, async (_req, res) => {
      const content = await readFile(resolve(process.cwd(), asset.slice(1)), 'utf8');
      res.type(asset.endsWith('.css') ? 'css' : 'js').send(content);
    });
    app.use('/api', (req, res) => void this.respond(req, res));
    this.server = app.listen(0, '127.0.0.1');
    await new Promise<void>(done => this.server!.once('listening', done));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.reset();
    return this;
  }

  async respond(req: Request, res: Response) {
    const path = req.originalUrl.split('?')[0];
    this.calls.push({ method: req.method, path, query: { ...req.query }, body: req.body });
    const initial = this.responseFor(req, path);
    const held = this.held.find(item => !item.used && item.method === req.method && item.path === path);
    if (held) { held.used = true; held.seen(); }
    const reply = held ? (await held.wait) || initial : initial;
    res.setHeader('X-OSHAL-Fixture', 'browser-only-http-double');
    if (!res.destroyed) res.status(reply.status).json(reply.body);
  }

  responseFor(req: Request, path: string): Reply {
    if (path === '/api/v1/logs/modules') return { status: 200, body: { modules: this.modules } };
    if (path === '/api/v1/logs/query') return this.queryReply(req);
    if (path === '/api/admin/logging' && req.method === 'GET') {
      return this.settingsStatus === 200 ? { status: 200, body: structuredClone(this.config) }
        : this.refused(this.settingsStatus);
    }
    if (path === '/api/admin/logging' && req.method === 'PUT') {
      if (this.updateStatus !== 200) return this.refused(this.updateStatus);
      const expected = req.body?.expected_config;
      if (JSON.stringify(expected) !== JSON.stringify(this.config)) return this.refused(409);
      this.config = structuredClone({ level: req.body.level, module_levels: req.body.module_levels });
      return { status: 200, body: this.updateReply ?? structuredClone(this.config) };
    }
    return this.refused(404);
  }

  queryReply(req: Request): Reply {
    if (this.queryStatus !== 200) return this.refused(this.queryStatus);
    const records = this.records.filter(row => ['ticketId', 'traceId', 'module'].every(key =>
      !req.query[key] || row[key] === req.query[key]) && (!req.query.level || row.levelLabel === req.query.level)
      && (!req.query.search || String(row.msg).includes(String(req.query.search))));
    return { status: 200, body: { source: 'native-kernel-observer', data: structuredClone(records),
      meta: { total: records.length, hasMore: false, retained: this.records.length, evicted: 7 } } };
  }

  refused(status: number): Reply {
    return { status, body: { error: 'browser_fixture_refusal', message: 'Private detail must not be rendered.' } };
  }

  holdNext(path: string, method = 'GET') {
    let seen!: () => void, release!: (reply?: Reply) => void;
    const held: Held = { path, method, used: false, entered: new Promise(done => { seen = done; }),
      seen: () => seen(), wait: new Promise(done => { release = done; }), release: reply => release(reply) };
    this.held.push(held);
    return held;
  }

  releaseAll() { for (const item of this.held) item.release(); }

  async close() {
    this.releaseAll();
    if (this.server) await new Promise<void>((done, fail) => this.server!.close(error => error ? fail(error) : done()));
  }
}
