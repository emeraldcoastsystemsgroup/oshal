/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 generic per-user dynamic-tool visibility: the manifest-declared endpoint decides which pattern-matching tools each caller sees; cookie is forwarded; unreachable endpoint fails CLOSED; non-matching tools are untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  createToolRoutes,
  registerDynamicToolUI,
  deregisterDynamicToolUI,
  registerDynamicToolVisibility,
  deregisterDynamicToolVisibility,
} from '../../src/app/routes/tool-routes';

let server: Server;
let base: string;
const PORT_BEFORE = process.env.PORT;

beforeAll(async () => {
  const app = express();
  // The app-owned visibility endpoint: only 'lm-class-aaaa1111' is allowed, and ONLY
  // when the caller's cookie arrived (proves the session forward).
  app.get('/api/education/class-tool-keys', (req, res) => {
    if (!req.headers.cookie?.includes('sid=student1')) {
      res.json({ keys: [] });
      return;
    }
    res.json({ keys: ['lm-class-aaaa1111'] });
  });
  // createToolRoutes binds controller methods as route handlers; a Proxy hands every
  // method a no-op handler so the two routes under test (/register, /dynamic) stand alone.
  const noopController = new Proxy({}, { get: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => res.status(501).json({ stub: true }) });
  app.use('/api/tools', createToolRoutes(noopController as never));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.PORT = String(port); // the loopback base the filter uses

  registerDynamicToolUI('lm-class-aaaa1111', 'Algebra', 'i', '/x', 'little-monsters');
  registerDynamicToolUI('lm-class-bbbb2222', 'Biology', 'i', '/x', 'little-monsters');
  registerDynamicToolUI('unrelated-tool', 'Other', 'i', '/y', 'other-app');
});

afterAll(() => {
  deregisterDynamicToolVisibility('little-monsters');
  deregisterDynamicToolUI('lm-class-aaaa1111');
  deregisterDynamicToolUI('lm-class-bbbb2222');
  deregisterDynamicToolUI('unrelated-tool');
  if (PORT_BEFORE === undefined) delete process.env.PORT; else process.env.PORT = PORT_BEFORE;
  server?.close();
});

describe('ADR-085 — generic per-user dynamic-tool visibility', () => {
  it('without a rule, every tool is listed', async () => {
    const body = await (await fetch(`${base}/api/tools/dynamic`)).json();
    expect(body.tools.map((t: { toolName: string }) => t.toolName).sort())
      .toEqual(['lm-class-aaaa1111', 'lm-class-bbbb2222', 'unrelated-tool']);
  });

  it('with a rule, only the endpoint-allowed keys survive; non-matching tools untouched', async () => {
    registerDynamicToolVisibility('little-monsters', { endpoint: '/api/education/class-tool-keys', pattern: 'lm-class-*' });
    const body = await (await fetch(`${base}/api/tools/dynamic`, { headers: { cookie: 'sid=student1' } })).json();
    expect(body.tools.map((t: { toolName: string }) => t.toolName).sort())
      .toEqual(['lm-class-aaaa1111', 'unrelated-tool']); // bbbb hidden; unrelated kept
  });

  it('a caller the app does not recognise sees NO matching tools (app answered keys: [])', async () => {
    const body = await (await fetch(`${base}/api/tools/dynamic`, { headers: { cookie: 'sid=stranger' } })).json();
    expect(body.tools.map((t: { toolName: string }) => t.toolName)).toEqual(['unrelated-tool']);
  });

  it('an unreachable endpoint fails CLOSED (all matching tools hidden)', async () => {
    registerDynamicToolVisibility('little-monsters', { endpoint: '/api/education/no-such-endpoint', pattern: 'lm-class-*' });
    const body = await (await fetch(`${base}/api/tools/dynamic`, { headers: { cookie: 'sid=student1' } })).json();
    expect(body.tools.map((t: { toolName: string }) => t.toolName)).toEqual(['unrelated-tool']);
  });
});
