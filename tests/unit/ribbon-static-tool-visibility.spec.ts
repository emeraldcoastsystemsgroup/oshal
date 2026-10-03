/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Per-caller visibility for the static rail: the profile route passes synthesised `tool-*` items through the app's manifest-declared visibility rule with the caller's session (cookie or Authorization header), keeps framework items and unmatched tools, and fails closed when the app cannot answer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 */
/** Real Express and the real profile route; the swarm-app service is a double that returns one synthesised profile. */
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUiProfileRoutes } from '../../src/app/routes/ui-profile-routes';
import { deregisterDynamicToolVisibility, registerDynamicToolVisibility } from '../../src/app/routes/tool-routes';
import { UIProfileService } from '../../src/features/ui-profile';
import type { SwarmAppService } from '../../src/features/swarm-apps';

let server: Server;
let base: string;
const PORT_BEFORE = process.env.PORT;
const item = (toolName: string, section: 'top' | 'bottom' = 'top') => ({ id: `tool-${toolName}`, icon: 'codicon codicon-circle-outline', label: toolName, section, toolUi: { iframeUrl: `/api/education/${toolName}`, sidebarLabel: toolName } });
const synthesised = () => ({
  name: 'little-monsters', displayName: 'Little Monsters',
  ribbon: { items: [item('lm-dashboard'), item('lm-teacher', 'bottom'), 'tickets', item('lm-class-aaaa1111'), { ...item('little-monsters--lm-teacher'), toolUi: { ...item('lm-teacher').toolUi, visibilityToolName: 'lm-teacher' } }], dynamicTools: { allow: [], section: 'top' as const } },
  defaultView: 'lm-dashboard',
});
const swarmApps = { synthesiseProfile: async () => synthesised() } as unknown as SwarmAppService;
const ids = (body: { profile: { ribbon: { items: Array<string | { id: string }> } } }) => body.profile.ribbon.items.map(i => (typeof i === 'string' ? i : i.id));

beforeAll(async () => {
  const app = express();
  // The app-owned visibility endpoint: a learner cookie admits the dashboard and one class; a teacher token admits the teacher tab too.
  app.get('/api/education/tool-keys', (req, res) => {
    if (req.headers.authorization === 'Bearer teacher-token') { res.json({ keys: ['lm-dashboard', 'lm-teacher', 'lm-class-aaaa1111'] }); return; }
    if (req.headers.cookie?.includes('sid=learner')) { res.json({ keys: ['lm-dashboard', 'lm-class-aaaa1111'] }); return; }
    res.json({ keys: [] });
  });
  app.use('/api/ui', createUiProfileRoutes(new UIProfileService(), swarmApps));
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PORT = String((server.address() as AddressInfo).port);
});
afterAll(async () => {
  deregisterDynamicToolVisibility('little-monsters');
  if (PORT_BEFORE === undefined) delete process.env.PORT; else process.env.PORT = PORT_BEFORE;
  await new Promise<void>(r => server.close(() => r()));
});

describe('ribbon profile: per-caller visibility of the static rail', () => {
  it('without a rule every synthesised item is served', async () => {
    const body = await (await fetch(`${base}/api/ui/profile?name=little-monsters`)).json();
    expect(ids(body)).toEqual(['tool-lm-dashboard', 'tool-lm-teacher', 'tickets', 'tool-lm-class-aaaa1111', 'tool-little-monsters--lm-teacher']);
  });

  it('a learner session keeps only the tools the app admits; framework items are untouched', async () => {
    registerDynamicToolVisibility('little-monsters', { endpoint: '/api/education/tool-keys', pattern: 'lm-*' });
    const body = await (await fetch(`${base}/api/ui/profile?name=little-monsters`, { headers: { cookie: 'sid=learner' } })).json();
    expect(ids(body)).toEqual(['tool-lm-dashboard', 'tickets', 'tool-lm-class-aaaa1111']);
    expect(body.profile.defaultView).toBe('lm-dashboard');
  });

  it('a token-authenticated teacher is judged by the app too (Authorization header forwarded)', async () => {
    const body = await (await fetch(`${base}/api/ui/profile?name=little-monsters`, { headers: { authorization: 'Bearer teacher-token' } })).json();
    expect(ids(body)).toEqual(['tool-lm-dashboard', 'tool-lm-teacher', 'tickets', 'tool-lm-class-aaaa1111', 'tool-little-monsters--lm-teacher']);
  });

  it('a caller the app does not recognise sees no matching tool at all (fail-closed), never a widened rail', async () => {
    const body = await (await fetch(`${base}/api/ui/profile?name=little-monsters`)).json();
    expect(ids(body)).toEqual(['tickets']);
  });

  it('an unreachable endpoint fails closed for the pattern and leaves the rest of the rail', async () => {
    registerDynamicToolVisibility('little-monsters', { endpoint: '/api/education/no-such-endpoint', pattern: 'lm-*' });
    const body = await (await fetch(`${base}/api/ui/profile?name=little-monsters`, { headers: { cookie: 'sid=learner' } })).json();
    expect(ids(body)).toEqual(['tickets']);
  });
});
