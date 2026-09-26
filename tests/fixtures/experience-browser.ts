/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the real experience shells through the real static route registration over an isolated, explicitly synthetic swarm: home plan, listing, navigation, tickets, Jarvis shelf/history/ask, package summaries, Little Monsters, Purchasing, Finance and the user directory, with controllable statuses so honest setup, denial and failure states can be proven in Chromium.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

const ROOT = process.cwd();
const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const day = (offsetDays: number) => { const d = new Date(Date.now() + offsetDays * 24 * HOUR); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** @description One synthetic application across the three catalog reads. Never a real package. */
export function syntheticApp(name: string, suite: string | null, extra: { ticketType?: string; navigable?: boolean; summary?: boolean; inPlan?: boolean } = {}) {
  const display = `Synthetic ${name}`;
  return {
    plan: extra.inPlan === false ? null : { name, displayName: display, kind: 'app', suite: suite ?? undefined, members: [name], description: `Isolated experience test source ${name}.`,
      firstSurface: `${name}-home`, firstSurfaceUrl: extra.navigable === false ? undefined : `/fixture/surface/${name}`,
      summary: extra.summary === false ? [] : [{ app: name, path: `/fixture/probe/${name}`, tilesPointer: '/tiles', itemsPointer: '/items', surfaces: [`${name}-home`] }],
      todos: [], integrationSources: name === 'ledger' ? [{ app: 'finance', surfaces: [], offers: [] }] : [] },
    summary: { name, displayName: display, description: `Isolated experience test source ${name}.`, version: '0.0.1', status: 'active', botCount: 1, toolCount: 2, icon: '', hasSurface: true, suite, connectors: { required: [], optional: [] }, ticketType: extra.ticketType || '' },
    workspace: extra.navigable === false ? null : { name, displayName: display, href: `/cockpit/?app=${name}`, kind: 'app', theme: 'midnight' },
  };
}

/** @description Fresh, fully synthetic swarm state per browser case. */
export function experienceState() {
  const apps = [
    syntheticApp('ledger', 'ai-finance', { ticketType: 'ledger-review' }), syntheticApp('finance', 'ai-finance', { ticketType: 'finance-brief' }),
    syntheticApp('forge', 'ai-engineering'), syntheticApp('bot-only', 'ai-engineering', { navigable: false, summary: false }),
    syntheticApp('stage', 'ai-creative'), syntheticApp('arcade-games', 'ai-creative'), syntheticApp('deck', 'ai-productivity'), syntheticApp('purchasing', 'ai-productivity'),
    syntheticApp('hearth', 'ai-home'), syntheticApp('home', 'ai-home'), syntheticApp('little-monsters', 'ai-home'), syntheticApp('atlas', 'ai-knowledge'),
    syntheticApp('unadmitted', 'ai-knowledge', { inPlan: false, navigable: false }),
  ];
  return {
    apps, authenticated: true, user: { sub: 'synthetic-user', email: 'synthetic@fixture.test', preferred_username: 'synthetic@fixture.test' },
    status: {} as Record<string, number>, calls: [] as string[], asks: [] as Array<{ message: string; sessionId: string }>,
    tickets: [
      { ticketId: '11111111-1111-4111-8111-111111111111', title: 'Synthetic ledger review', status: 'in_process', ticketType: 'ledger-review', updatedAt: iso(-HOUR), description: 'A synthetic ticket for the shells.' },
      { ticketId: '22222222-2222-4222-8222-222222222222', title: 'Synthetic finished brief', status: 'complete', ticketType: 'finance-brief', updatedAt: iso(-5 * HOUR), description: '' },
    ],
    tasks: [
      { id: 'task-1', title: 'Synthetic ledger: weekly picture', status: 'done', kind: 'simple', result: 'Synthetic result text.', createdAt: iso(-2 * HOUR), finishedAt: iso(-2 * HOUR + 60000), files: [{ name: 'summary.txt', downloadUrl: '/api/jarvis/files/synthetic', bytes: 12 }] },
      { id: 'task-2', title: 'Synthetic failed task', status: 'error', error: 'Synthetic error detail', kind: 'simple', createdAt: iso(-3 * HOUR) },
    ],
    bots: [{ agentId: 'a1', name: 'Synthetic Bot', role: 'assistant', online: true, active: true }, { agentId: 'a2', name: 'Idle Bot', role: 'assistant', online: false, active: false }],
    history: [] as Array<{ role: string; text: string }>,
    ask: { status: 202, refuseFirst: false, polls: 2, result: { status: 'done', answer: 'Synthetic answer: the **ledger** is ready.\n\n- one\n- two', handoffs: [{ name: 'Synthetic ledger', deepLink: '/cockpit/?app=ledger' }], files: [] as unknown[], taskId: 'task-9' } },
    jobs: new Map<string, number>(),
    education: {
      meStatus: 200, me: { studentId: 'stu-1', name: 'Synthetic Teacher', email: 'synthetic@fixture.test', role: 'teacher', classCount: 1 },
      classes: [{ class_id: 'c1', name: 'Synthetic Science', subject: 'Science', grade_level: '6', teacher_name: 'Synthetic Teacher', teacher_student_id: 'stu-1', student_count: '2', status: 'active', published: true }],
      students: { c1: [{ student_id: 's1', name: 'Learner One', email: null, enrolled_at: iso(-72 * HOUR) }] } as Record<string, unknown[]>,
      assignments: [{ assignment_id: 'a1', class_id: 'c1', title: 'Observe a seed', description: 'Write one observation.', status: 'open', due_date: day(1), class_name: 'Synthetic Science', assignment_type: 'homework' }],
      events: [{ event_id: 'e1', class_id: 'c1', student_id: null, title: 'Science circle', event_date: day(0), event_time: '09:00:00', event_type: 'lecture', class_name: 'Synthetic Science', subject: 'Science' }],
      created: [] as unknown[],
    },
    purchasing: { lists: [{ list_id: 'l1', name: 'Synthetic list', status: 'active', item_count: '1' }], items: [{ item_id: 'i1', list_id: 'l1', title: 'Synthetic milk', quantity: 1, unit_price: '2.50', status: 'pending', created_at: iso(-24 * HOUR) }], added: [] as unknown[], removed: [] as string[] },
    finance: { status: 200, aggregate: { netWorth: { net: 1234.5, assets: 2000, liabilities: 765.5 }, accounts: [{ name: 'Synthetic Checking', mask: '0001', type: 'depository', subtype: 'checking', balance: 1500 }], spendByMonth: [{ month: '2026-08', spend: 100, income: 50 }, { month: '2026-09', spend: 200, income: 60 }] }, syncedAt: iso(-48 * HOUR), tiles: [{ id: 'nw', label: 'Cached net worth', value: 'USD 1,234.50' }] },
    directory: { status: 200, users: [{ sub: 'synthetic-user', issuer: 'x', label: 'Synthetic Teacher (google; active)', source: 'verified-sign-in', signIn: 'active' }, { sub: 'other', issuer: 'x', label: 'Other Person (google; active)', source: 'verified-sign-in', signIn: 'active' }] },
    voiceStatus: 404,
  };
}
export type ExperienceState = ReturnType<typeof experienceState>;

function statusOr(state: ExperienceState, key: string, fallback = 200) { return state.status[key] ?? fallback; }

/** @description Synthetic caller-scoped reads the shells join, each with a controllable status. */
function swarmRoutes(app: express.Application, state: ExperienceState) {
  app.use((req, _res, next) => { state.calls.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/auth/user', (_req, res) => res.json({ authenticated: state.authenticated, user: state.authenticated ? state.user : null, mode: 'mock', guestMode: false, capabilities: null }));
  app.get('/api/swarm/apps/home-plan', (_req, res) => res.status(statusOr(state, 'plan')).json({ apps: state.apps.map(a => a.plan).filter(Boolean) }));
  app.get('/api/swarm/apps', (_req, res) => res.status(statusOr(state, 'apps')).json({ apps: state.apps.map(a => a.summary) }));
  app.get('/api/ui/workspaces', (_req, res) => res.status(statusOr(state, 'workspaces')).json({ workspaces: state.apps.map(a => a.workspace).filter(Boolean) }));
  app.get('/api/tickets', (_req, res) => res.status(statusOr(state, 'tickets')).json({ tickets: state.tickets, count: state.tickets.length }));
  app.get('/api/jarvis/tasks', (_req, res) => res.status(statusOr(state, 'tasks')).json({ tasks: state.tasks }));
  app.get('/api/jarvis/overview', (_req, res) => res.json({ bots: state.bots, activity: { openCount: state.tickets.filter(t => t.status !== 'complete').length, tickets: [] }, comms: { digest: null, signals: [] }, calendar: { events: [] } }));
  app.get('/api/jarvis/history', (_req, res) => res.json({ turns: state.history }));
  app.post('/api/jarvis/ask', express.json(), (req, res) => {
    const body = req.body || {};
    state.asks.push({ message: String(body.message || ''), sessionId: String(body.sessionId || '') });
    if (state.ask.refuseFirst && state.asks.length === 1) { res.status(404).json({ error: 'session_not_found' }); return; }
    if (state.ask.status !== 202) { res.status(state.ask.status).json({ error: 'Synthetic assistant unavailable' }); return; }
    const jobId = `job-${state.asks.length}`; state.jobs.set(jobId, 0);
    res.status(202).json({ jobId });
  });
  app.get('/api/jarvis/ask/result', (req, res) => {
    const jobId = String(req.query.jobId || ''); const seen = state.jobs.get(jobId);
    if (seen === undefined) { res.json({ status: 'expired' }); return; }
    state.jobs.set(jobId, seen + 1);
    if (seen + 1 <= state.ask.polls) { res.json({ status: 'pending', label: 'synthetic' }); return; }
    res.json({ label: 'synthetic', ...state.ask.result });
  });
  app.post('/api/voice/synthesize', (_req, res) => res.status(state.voiceStatus).json({ error: 'Synthetic voice unavailable' }));
  app.get('/fixture/probe/:name', (req, res) => res.status(statusOr(state, `probe:${req.params.name}`)).json({ tiles: [{ id: 'reported', label: 'Reported items', value: '2', tone: 'neutral' }], items: [{ text: `Update from ${req.params.name}`, detail: 'A synthetic owner-provided detail.', highlight: true }], asOf: iso(0) }));
  app.get('/fixture/surface/:name', (req, res) => res.type('html').send(`<!doctype html><title>Synthetic ${req.params.name}</title><h1>Opened ${req.params.name}</h1>`));
  app.get('/api/user-directory', (_req, res) => res.status(state.directory.status).json({ users: state.directory.users }));
}

/** @description Synthetic package routes: Little Monsters, Purchasing and Finance contracts as the shells read them. */
function packageRoutes(app: express.Application, state: ExperienceState) {
  const edu = state.education, shop = state.purchasing, fin = state.finance;
  app.get('/api/education/me', (_req, res) => edu.meStatus === 200 ? res.json(edu.me) : res.status(edu.meStatus).json({ error: 'Synthetic learner missing' }));
  app.get('/api/education/classes', (_req, res) => res.json({ classes: edu.classes }));
  app.get('/api/education/classes/:id/students', (req, res) => edu.students[req.params.id] ? res.json({ students: edu.students[req.params.id] }) : res.status(403).json({ error: 'You do not teach this class' }));
  app.get('/api/education/assignments', (_req, res) => res.json({ assignments: edu.assignments }));
  app.get('/api/education/calendar', (_req, res) => res.json({ events: edu.events }));
  app.post('/api/education/calendar', express.json(), (req, res) => { edu.created.push(req.body); res.status(201).json({ eventId: `e${edu.created.length + 1}` }); });
  app.get('/api/education/logo-96.png', (_req, res) => res.type('png').send(Buffer.from('89504e470d0a1a0a', 'hex')));
  app.get('/api/education/logo-256.png', (_req, res) => res.type('png').send(Buffer.from('89504e470d0a1a0a', 'hex')));
  app.get('/api/purchasing/lists', (_req, res) => res.json({ lists: shop.lists }));
  app.post('/api/purchasing/lists', express.json(), (req, res) => { const list = { list_id: `l${shop.lists.length + 1}`, name: String(req.body?.name || 'List'), status: 'active', item_count: '0' }; shop.lists.push(list); res.json({ list }); });
  app.get('/api/purchasing/lists/:id/items', (req, res) => res.json({ items: shop.items.filter(i => i.list_id === req.params.id && i.status === 'pending') }));
  app.post('/api/purchasing/lists/:id/items', express.json(), (req, res) => { shop.added.push(req.body); const item = { item_id: `i${shop.items.length + 1}`, list_id: req.params.id, title: String(req.body?.title || ''), quantity: Number(req.body?.quantity || 1), unit_price: null as string | null, status: 'pending', created_at: iso(0) }; shop.items.push(item); res.json({ item }); });
  app.delete('/api/purchasing/lists/:id/items/:itemId', (req, res) => { shop.removed.push(req.params.itemId); const item = shop.items.find(i => i.item_id === req.params.itemId); if (item) item.status = 'removed'; res.json({ ok: true }); });
  app.get('/api/finance/summary', (_req, res) => fin.status === 200 ? res.json({ aggregate: fin.aggregate, syncedAt: fin.syncedAt }) : res.status(fin.status).json({ error: fin.status === 404 ? 'no_data' : 'unavailable', message: 'Sync your accounts first.' }));
  app.get('/api/finance/home-summary', (_req, res) => res.json({ tiles: fin.tiles, metrics: fin.tiles, items: [] }));
  app.get('/cockpit/', (req, res) => res.type('html').send(`<!doctype html><title>Synthetic cockpit</title><h1>Cockpit ${String(req.query.app || req.query.ticket || '')}</h1>`));
  app.get('/login', (_req, res) => res.type('html').send('<!doctype html><title>Synthetic login</title><h1>Sign in</h1>'));
  app.get('/api/jarvis/', (_req, res) => res.type('html').send('<!doctype html><title>Synthetic Jarvis</title>'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Synthetic fixture endpoint unavailable' }));
}

/**
 * @description Start the real experience routes over the synthetic swarm on an ephemeral loopback port.
 * @param options `denyAuth` makes the real requiresAuth seat refuse, proving every experience path is gated.
 * @returns Origin, mutable synthetic state and full cleanup.
 */
export async function startExperienceBrowserFixture(options: { denyAuth?: boolean } = {}) {
  const app = express(), state = experienceState();
  const requiresAuth: express.RequestHandler = options.denyAuth ? (_req, res) => { res.status(401).json({ error: 'unauthorized' }); } : (_req, _res, next) => next();
  swarmRoutes(app, state); packageRoutes(app, state);
  registerCockpitStaticRoutes({ app, requiresAuth, cockpitDir: resolve(ROOT, 'src/pages/cockpit'), uiEnhancedDir: resolve(ROOT, 'any-bot/ui-enhanced'),
    codiconFontsDir: resolve(ROOT, 'node_modules/@vscode/codicons/dist'), sharedUiCssDir: resolve(ROOT, 'src/shared/ui/css'), sharedUiJsDir: resolve(ROOT, 'src/shared/ui/js') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } };
}
