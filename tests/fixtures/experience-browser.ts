/**
 * CHANGE LOG
 * 17 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the real experience shells through the real static route registration over an isolated, explicitly synthetic swarm: home plan, listing, navigation, tickets, Jarvis shelf/history/ask, package summaries, Little Monsters, Purchasing, Finance and the user directory, with controllable statuses so honest setup, denial and failure states can be proven in Chromium.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The synthetic ribbon profile answers per application (Little Monsters role-filtered; every other host a home and a more page) so the multi-host presets are exercised against 19 installed applications
 * 3 | maintainer@emeraldcoastsystemsgroup.com | A synthetic application page under the shared audience-view kit (`/fixture/app-view`, its data with a controllable status, and a host page that frames it) so the kit is proven in Chromium: full page by default, audience views on request, hidden full UI, text-only rendering, failure with retry, and the escape that navigates the top window
 * 4 | maintainer@emeraldcoastsystemsgroup.com | fullSwarmGapRoutes: the viewer-scoped app record (GET /api/swarm/apps/:name with manifest bots, chatBot and dependencies, 404 when not visible or when `detail:<name>` says so), a controllable Little Monsters calendar status (`edu-calendar`) and overview calendar events. It is registered ahead of the swarm and package routes because packageRoutes ends in the `/api` 404 catch-all; every path it does not answer falls through untouched.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Central-assistant gap routes (nexusGapRoutes, controlled through `state.nexusGap`): a scripted refusal of POST /api/jarvis/ask (the 503 ai_disabled body), held and per-job /ask/result outcomes for the stale-completion cases, POST /api/jarvis/tasks/:id/delivered, the owner-checked PUT /api/tickets/:ticketId/cancel with refusals, POST /api/voice/transcribe recording what the multipart upload carried, and the owner-checked /api/jarvis/visuals image. The lane router runs ahead of the shared `/api` catch-all; its /ask and /ask/result handlers fall through to the default synthetic routes unless the lane state asks for them, and its other routes always answer
 * 6 | maintainer@emeraldcoastsystemsgroup.com | One request log registered first, then every lane's override routes, then the default synthetic routes with their `/api` 404 catch-all last: the lanes had each worked around the catch-all living inside packageRoutes (a router splice, lane-local logging); the order now makes both unnecessary
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Homebase gap routes (`homebaseGapRoutes`): Little Monsters teacher analytics (pg-shaped counts, server-side summary), classwork through assignments-with-events (teacher-of-class check, calendar event on a due date), a ticket read and its status transition (only approval_required to approved), and the caller's saved content drafts, each with a controllable status. They register with the other lane routes ahead of the default routes, whose `/api` 404 catch-all stays last (as row 6 says).
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Integration review: fullSwarmGapRoutes seats Little Monsters' summary probe at its real path (`/api/little-monsters/home-summary`, status `lm-home-summary`, 403 with the package's setup sentence) so the Jarvis agenda's probe gate is exercised, and can answer the user directory with a refusal code (`fullSwarm.directoryError`); nexusGapRoutes no longer serves POST /api/jarvis/tasks/:id/delivered (the shell never sends it; the request log proves it); the synthetic ticket status transition writes `metadata.lastStatusTransition` the way the ticket service mirrors every transition, keeping the row-level reason/nextAction.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Phase-4 assemblies: the synthetic app-view page provides a classroom builder (a new-tab tile and list item, a tile handled on the page) and `?provides=` limits the builders it registers, so "requested but not provided" stays provable; the host page frames `?audience=` of its choice; assemblyHostRoutes answers the ribbon profile of an installed application from `state.assembly.ribbons`, and installAssemblyHosts gives the ten hosts the presets gained ribbon items shaped like their manifests' surfaces (several for Intelligent Communication, Social and Marketing Engine), installing the nine the default catalog lacks; the default catalog itself is unchanged.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Composed front pages: installFrontPageHosts installs the card applications the assemblies did not (Calendar, Federal CRM with four of its surfaces, Calling Assistant) through the same installHosts helper installAssemblyHosts now uses; each is a synthetic app with the default probe (`/fixture/probe/<name>`, status `probe:<name>`), so a card's tiles, items, refusal and D10 silence are provable per application.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Home build lane (homebaseBuildRoutes, state in `homeBuild`, read with homeBuildState): ADR-169 location state and device opt-out, the caller's groups and members and household creation, a learner's own dashboard, Little Monsters notices with mark-read, Jarvis briefing sources (PUT needs the route's own header) and the caller's schedules with pause/resume, and the global search, each shaped like its real route with a controllable status. Registered with the other lane routes ahead of the default routes.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Full-swarm build routes (portalBuildRoutes, lane "portal", registered first among the lane routes): one ticket's workflow read model shaped like GET /api/v1/tickets/:ticketId/workflow with per-ticket overrides and statuses, and a cancel pre-handler that moves the synthetic ticket to cancelled whenever the existing cancel route will answer 200.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | portalBuildRoutes gains the schedule and workflow-definition reads (scheduleRoutes): an owner-scoped schedule list, pause/resume with the controller's 404 / managed-manifest 403 / operator 403 refusals, and Workflow Studio definition summaries, each with a controllable status.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | portalBuildRoutes gains the membership and own-location reads (peopleRoutes): GET /api/tenants with a controllable status, members-only GET /api/tenants/:id/members, and the caller's GET /api/location/state overview (no coordinates) with a controllable status.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | Central-assistant build routes (lane "orb", `state.nexusBuild`, registered by nexusGapRoutes ahead of the defaults): the caller's busy windows through GET /api/experience/availability (or its refusal body), the Google row of GET /api/connect/list, and Travel's GET /config, GET/POST /profile, GET /flights (four synthetic offers, source, price read) and GET/POST /watches, each with a controllable status and a log of what the page sent; installTravelHost admits Travel into a case's catalog (or installs it outside the plan).
 * 16 | maintainer@emeraldcoastsystemsgroup.com | nexusBuildRoutes keep the fixture's contract: they answer only once a case opts in (enableNexusBuild, which installTravelHost also does) and fall through to the defaults otherwise; the lane can answer POST /api/voice/synthesize with a WAV clip (`nexusBuild.voice.audioData`) for the readback watchdog case.
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
    syntheticApp('presentations', 'ai-productivity'), syntheticApp('switchboard', 'ai-productivity'), syntheticApp('payroll', 'ai-finance'),
    syntheticApp('payments', 'ai-productivity'), syntheticApp('identity', 'ai-productivity'), syntheticApp('cad-studio', 'ai-engineering'),
    syntheticApp('unadmitted', 'ai-knowledge', { inPlan: false, navigable: false }),
  ];
  return {
    apps, authenticated: true, user: { sub: 'synthetic-user', email: 'synthetic@fixture.test', preferred_username: 'synthetic@fixture.test' },
    experiences: ['studio', 'jarvis', 'orbit', 'commons', 'family', 'classroom', 'company'].map(skin => ({ app: `${skin}-experience`, skin, label: `Synthetic ${skin}`, entry: `/fixture/experience/${skin}.html`, shell: 'page' })),
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
    ask: { status: 202, refuseFirst: false, polls: 2, result: { status: 'done', answer: 'Synthetic answer: the **ledger** is ready, see [Synthetic ledger](/cockpit/?app=ledger).\n\n- one\n- two', handoffs: [{ name: 'Synthetic ledger', deepLink: '/cockpit/?app=ledger' }], files: [] as unknown[], taskId: 'task-9' } },
    jobs: new Map<string, number>(),
    education: {
      meStatus: 200, me: { studentId: 'stu-1', name: 'Synthetic Teacher', email: 'synthetic@fixture.test', role: 'teacher', classCount: 1 },
      classes: [{ class_id: 'c1', name: 'Synthetic Science', subject: 'Science', grade_level: '6', teacher_name: 'Synthetic Teacher', teacher_student_id: 'stu-1', student_count: '2', status: 'active', published: true }],
      students: { c1: [{ student_id: 's1', name: 'Learner One', email: null, enrolled_at: iso(-72 * HOUR) }] } as Record<string, unknown[]>,
      assignments: [{ assignment_id: 'a1', class_id: 'c1', title: 'Observe a seed', description: 'Write one observation.', status: 'open', due_date: day(1), class_name: 'Synthetic Science', assignment_type: 'homework' }],
      events: [{ event_id: 'e1', class_id: 'c1', student_id: null, title: 'Science circle', event_date: day(0), event_time: '09:00:00', event_type: 'lecture', class_name: 'Synthetic Science', subject: 'Science' }],
      created: [] as unknown[],
      // The ribbon profile items the classroom reads to host the application's tools; the class tool carries the class id prefix like the real manifest template.
      tools: [
        { id: 'tool-lm-dashboard', label: 'Home', icon: 'codicon codicon-home', section: 'top', toolUi: { iframeUrl: '/fixture/surface/lm-dashboard' } },
        { id: 'tool-lm-myday', label: 'My Day', icon: 'codicon codicon-calendar', section: 'top', toolUi: { iframeUrl: '/fixture/surface/lm-myday' } },
        { id: 'tool-lm-teacher', label: 'Teacher', icon: 'codicon codicon-mortar-board', section: 'bottom', toolUi: { iframeUrl: '/fixture/surface/lm-teacher' } },
        { id: 'tool-lm-class-c1', label: 'Synthetic Science', icon: 'codicon codicon-book', section: 'top', toolUi: { iframeUrl: '/fixture/surface/lm-class-c1' } },
      ],
    },
    delays: { tasks: 0 },
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
  app.get('/api/auth/user', (_req, res) => res.json({ authenticated: state.authenticated, user: state.authenticated ? state.user : null, mode: 'mock', guestMode: false, capabilities: null }));
  app.get('/api/swarm/apps/home-plan', (_req, res) => res.status(statusOr(state, 'plan')).json({ apps: state.apps.map(a => a.plan).filter(Boolean) }));
  app.get('/api/swarm/apps', (_req, res) => res.status(statusOr(state, 'apps')).json({ apps: state.apps.map(a => a.summary) }));
  app.get('/api/ui/workspaces', (_req, res) => res.status(statusOr(state, 'workspaces')).json({ workspaces: state.apps.map(a => a.workspace).filter(Boolean) }));
  app.get('/api/tickets', (_req, res) => res.status(statusOr(state, 'tickets')).json({ tickets: state.tickets, count: state.tickets.length }));
  app.get('/api/jarvis/tasks', (_req, res) => setTimeout(() => res.status(statusOr(state, 'tasks')).json({ tasks: state.tasks }), state.delays.tasks));
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
  app.get('/fixture/surface/:name', (req, res) => res.type('html').send(`<!doctype html><html><head><title>Synthetic ${req.params.name}</title>
  <link rel="stylesheet" href="/shared/ui/css/surface-themes.css"><script src="/shared/ui/js/surface-theme.js"></script></head><body><h1>Opened ${req.params.name}</h1>
  <button id="post-navigate" onclick="parent.postMessage({ type: 'lm-navigate', view: 'myday' }, '*')">navigate</button><button id="post-class" onclick="parent.postMessage({ type: 'lm-open-class', classId: 'c1' }, '*')">class</button><button id="post-teacher" onclick="parent.postMessage({ type: 'lm-navigate', view: 'teacher' }, '*')">teacher</button><button id="post-changed" onclick="parent.postMessage('lm-classes-changed', '*')">changed</button></body></html>`));
  // The shared audience-view kit under a synthetic application page: the full UI is in the body; the kit decides from ?audience= whether to replace it.
  app.get('/fixture/app-view/data', (_req, res) => res.status(statusOr(state, 'appview')).json({ lede: 'Synthetic household reading.', stats: [{ id: 'on', label: 'Lights on', value: '3', tone: 'ok' }, { id: 'bills', label: 'Bills due', value: '2', tone: 'warn' }, { id: 'saved', label: 'Saved', value: '$120' }],
    rooms: [{ name: 'Synthetic kitchen', text: '2 devices on' }, { name: 'Synthetic den', text: 'all off' }], events: [{ title: 'Synthetic recital', text: 'School hall', meta: 'tomorrow', badge: 'family', tone: 'info' }], rows: [['Synthetic ledger', '$1,200'], ['Synthetic payroll', '$980']] }));
  app.get('/fixture/app-view/host', (req, res) => {
    // The framed audience defaults to family; `?audience=` picks another known audience for the frame.
    const audience = ['family', 'company', 'classroom'].includes(String(req.query.audience)) ? String(req.query.audience) : 'family';
    res.type('html').send(`<!doctype html><html><head><title>Synthetic host</title></head><body><iframe id="host-frame" src="/fixture/app-view?audience=${audience}" style="width:900px;height:700px"></iframe></body></html>`);
  });
  app.get('/fixture/app-view', (_req, res) => res.type('html').send(`<!doctype html><html><head><title>Synthetic app view</title>
  <link rel="stylesheet" href="/shared/ui/css/surface-themes.css"><script src="/shared/ui/js/surface-theme.js"></script>
  <link rel="stylesheet" href="/shared/ui/css/app-view.css"><script src="/shared/ui/js/app-view.js"></script>
  <script>
  window.__full = false; window.__fetches = [];
  var q = new URLSearchParams(location.search);
  function data() { return fetch('/fixture/app-view/data', { credentials: 'same-origin' }).then(function (r) { window.__fetches.push(r.status); if (!r.ok) throw new Error('Synthetic data unavailable (HTTP ' + r.status + ')'); return r.json(); }); }
  function family(ctx) { return data().then(function (d) { return { kicker: 'Synthetic / Home', title: q.get('title') || 'Your synthetic home', lede: d.lede,
    actions: [{ label: 'Run a scene', primary: true, onClick: function () { window.__acted = 'scene'; } }, { label: 'Refresh', onClick: function () { ctx.refresh(); } }], stats: d.stats,
    sections: [{ kind: 'tiles', id: 'rooms', title: 'Rooms', items: d.rooms.map(function (r) { return { title: r.name, text: r.text, icon: 'H', onClick: function () { window.__opened = r.name; } }; }) },
      { kind: 'list', id: 'events', title: 'Coming up', items: d.events }, { kind: 'progress', title: 'Budget', items: [{ label: 'Groceries', value: 0.4 }] },
      { kind: 'timeline', title: 'Recent', items: [{ when: 'today', title: 'Synthetic event' }] }, { kind: 'table', id: 'bills', title: 'Bills', columns: ['Bill', { label: 'Amount', align: 'right' }], rows: [['Power', { text: AppView.money(120) }]] },
      { kind: 'list', id: 'empty', title: 'Empty', items: [], empty: 'Nothing planned.' }, { kind: 'custom', id: 'custom', title: 'Custom', render: function (el) { el.textContent = 'Synthetic custom part'; } }] }; }); }
  function company() { return data().then(function (d) { return { kicker: 'Synthetic / Business', title: 'Synthetic operations', stats: d.stats, sections: [{ kind: 'table', id: 'ledger', title: 'Ledger', columns: ['Item', 'Amount'], rows: d.rows }] }; }); }
  function classroom() { return data().then(function (d) { return { kicker: 'Synthetic / Classroom', title: 'Synthetic makers corner', lede: d.lede, actions: [{ label: 'Start making', primary: true, onClick: function () { window.__acted = 'make'; } }], stats: d.stats,
    sections: [{ kind: 'tiles', id: 'starters', title: 'Starters', items: [{ title: 'Synthetic starter', text: 'Opens in a new tab', icon: 'S', href: '/fixture/surface/opened-tab', target: '_blank' }, { title: 'Synthetic kept here', text: 'Handled on the page', icon: 'K', onClick: function () { window.__opened = 'kept'; } }] },
      { kind: 'list', id: 'guides', title: 'Guides', items: [{ title: 'Synthetic guide', text: 'Also a new tab', href: '/fixture/surface/opened-guide', target: '_blank' }] }] }; }); }
  var provided = { family: family, company: company, classroom: classroom }, only = q.get('provides');
  // ?provides=family,company registers only those builders, so a case can request an audience the page does not provide.
  if (only) Object.keys(provided).forEach(function (k) { if (only.split(',').indexOf(k) < 0) delete provided[k]; });
  window.__ctx = AppView.boot({ app: 'synthetic', title: q.get('doc') || undefined, full: function () { window.__full = true; }, audiences: provided });
  </script></head><body><div id="full-ui"><h1>Full synthetic page</h1><p id="full-marker">The complete application UI.</p></div></body></html>`));
  app.get('/api/user-directory', (_req, res) => res.status(state.directory.status).json({ users: state.directory.users }));
}

/** @description Synthetic package routes: Little Monsters, Purchasing and Finance contracts as the shells read them. */
function packageRoutes(app: express.Application, state: ExperienceState) {
  const edu = state.education, shop = state.purchasing, fin = state.finance;
  app.get('/api/ui/profile', (req, res) => {
    const name = String(req.query.name || '');
    const record = state.apps.find(a => a.summary.name === name);
    if (!record) { res.status(404).json({ error: 'Synthetic profile unavailable' }); return; }
    // Little Monsters answers like the real app: the profile arrives already filtered per caller (teacher-only tools only for teachers/admins).
    const teacher = ['teacher', 'admin'].includes(edu.me.role);
    const items = name === 'little-monsters'
      ? edu.tools.filter(t => teacher || !['tool-lm-teacher', 'tool-lm-recorder'].includes(t.id))
      : [{ id: `tool-${name}-home`, label: `${record.summary.displayName} home`, icon: 'codicon codicon-circle-outline', section: 'top', toolUi: { iframeUrl: `/fixture/surface/${name}` } },
        { id: `tool-${name}-more`, label: `${record.summary.displayName} more`, icon: 'codicon codicon-circle-outline', section: 'bottom', toolUi: { iframeUrl: `/fixture/surface/${name}-more` } }];
    res.status(statusOr(state, 'profile')).json({ profile: { name, displayName: record.summary.displayName, theme: 'midnight', defaultView: items[0]?.id, ribbon: { items } } });
  });
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
  // One request log for every case, then each lane's override routes (they answer only what their case state asks
  // for and fall through otherwise), then the default synthetic routes, whose `/api` 404 catch-all stays last.
  app.use((req, _res, next) => { state.calls.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/ui/experiences', requiresAuth, (_req, res) => res.status(state.status.experiences || 200).json({ experiences: state.experiences }));
  app.get('/api/ui/experiences/:name/open', requiresAuth, (req, res) => {
    const experience = state.experiences.find(row => row.app === req.params.name);
    if (!experience) { res.sendStatus(404); return; }
    res.redirect(302, experience.entry);
  });
  app.get('/fixture/experience/:document', requiresAuth, (req, res) => res.type('html').send(`<h1>${req.params.document.replace(/[^a-z.-]/g, '')}</h1>`));
  portalBuildRoutes(app, state);
  fullSwarmGapRoutes(app, state); nexusGapRoutes(app, state); homebaseGapRoutes(app, state);
  assemblyHostRoutes(app, state);
  homebaseBuildRoutes(app, state);
  swarmRoutes(app, state); packageRoutes(app, state);
  app.use('/shared/ui/js', express.static(resolve(ROOT, 'src/shared/ui/js')));
  registerCockpitStaticRoutes({ app, requiresAuth, cockpitDir: resolve(ROOT, 'src/pages/cockpit'), uiEnhancedDir: resolve(ROOT, 'any-bot/ui-enhanced'),
    codiconFontsDir: resolve(ROOT, 'node_modules/@vscode/codicons/dist'), sharedUiCssDir: resolve(ROOT, 'src/shared/ui/css'), sharedUiJsDir: resolve(ROOT, 'src/shared/ui/js') });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state,
    close: async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); } };
}

/**
 * @description Synthetic reads for the full-swarm gap closure: the viewer-scoped app record per application
 * (manifest bots, chatBot, dependencies; 404 when absent or when `status['detail:<name>']` says so), a
 * controllable Little Monsters calendar status (`status['edu-calendar']`), Little Monsters' summary probe at its real
 * path with a controllable status (`status['lm-home-summary']`), a user-directory refusal code (`fullSwarm.directoryError`)
 * and overview calendar events. Registered ahead of the default routes (see startExperienceBrowserFixture); any request
 * it does not answer falls through with next(). The shared request log records every call.
 * @param app The fixture Express application.
 * @param state The synthetic swarm state; gains `fullSwarm.manifests` (overrides by app name), `fullSwarm.overviewEvents` and `fullSwarm.directoryError`.
 * @returns Nothing; routes are registered on `app`.
 */
function fullSwarmGapRoutes(app: express.Application, state: ExperienceState) {
  const gaps = Object.assign(state, { fullSwarm: {
    manifests: { ledger: { bots: [{ agentId: 'a1', name: 'Synthetic Bot', role: 'assistant' }, { agentId: 'synthetic-reviewer', name: 'Synthetic reviewer', role: 'reviewer' }], chatBot: 'Synthetic Bot', uses: ['app-dependencies'], dependencies: { required: { apps: ['finance'] }, optional: { apps: ['synthetic-absent'] } } } } as Record<string, Record<string, unknown>>,
    overviewEvents: [] as Array<{ title: string; when: string }>,
    directoryError: '',
  } }).fullSwarm;
  // Little Monsters declares one summary probe, its read-only home-summary route; the synthetic plan points at the same path.
  const lm = state.apps.find(a => a.summary.name === 'little-monsters');
  if (lm?.plan) lm.plan.summary = [{ app: 'little-monsters', path: '/api/little-monsters/home-summary', tilesPointer: '/tiles', itemsPointer: '/items', surfaces: ['little-monsters-home'] }];
  app.get('/api/little-monsters/home-summary', (_req, res) => {
    const status = statusOr(state, 'lm-home-summary');
    if (status !== 200) { res.status(status).json({ error: status === 403 ? 'Open Little Monsters to complete school setup' : 'Synthetic summary unavailable' }); return; }
    res.json({ tiles: [{ id: 'classes', label: 'Accessible classes', value: '1', tone: 'neutral' }], items: [{ text: 'Update from little-monsters', detail: 'A synthetic owner-provided detail.' }], asOf: iso(0) });
  });
  app.get('/api/user-directory', (_req, res, next) => {
    if (!gaps.directoryError) { next(); return; }
    res.status(403).json({ error: gaps.directoryError });
  });
  app.get('/api/swarm/apps/:name', (req, res, next) => {
    const name = String(req.params.name);
    if (name === 'home-plan') { next(); return; }
    const record = state.apps.find(a => a.summary.name === name);
    const status = statusOr(state, `detail:${name}`, record ? 200 : 404);
    if (!record || status !== 200) { res.status(status).json({ error: 'App not found' }); return; }
    const manifest = { name, displayName: record.summary.displayName, bots: [{ agentId: `${name}-agent`, name: `${record.summary.displayName} assistant`, role: 'assistant' }], ...gaps.manifests[name] };
    res.json({ app: { name, displayName: record.summary.displayName, status: 'active', agentIds: (manifest.bots as Array<{ agentId: string }>).map(b => b.agentId), manifest } });
  });
  app.get('/api/education/calendar', (req, res, next) => {
    const status = statusOr(state, 'edu-calendar');
    if (status === 200) { next(); return; }
    res.status(status).json({ error: 'Synthetic calendar refused' });
  });
  app.get('/api/jarvis/overview', (req, res, next) => {
    if (!gaps.overviewEvents.length) { next(); return; }
    res.json({ bots: state.bots, activity: { openCount: 0, tickets: [] }, comms: { digest: null, signals: [] }, calendar: { events: gaps.overviewEvents } });
  });
}

/**
 * @description Central-assistant gap routes (lane "nexus"), each synthetic and driven through `state.nexusGap`: a scripted
 * /ask refusal, held and per-job /ask/result outcomes, ticket cancel with refusals, the voice transcription upload and the
 * owner-checked visual. The /ask and /ask/result handlers fall through to the default synthetic routes unless the lane state
 * asks for them; the other routes always answer. It is registered ahead of the default routes (see
 * startExperienceBrowserFixture), so no reordering is needed.
 * @param app The fixture application.
 * @param state The per-case synthetic state; `state.nexusGap` is created here.
 * @returns Nothing; the routes are registered on `app`.
 */
function nexusGapRoutes(app: express.Application, state: ExperienceState) {
  const lane = {
    askRefusal: null as null | { status: number; body: Record<string, unknown> }, refusedAsks: 0,
    hold: new Set<string>(), results: {} as Record<string, Record<string, unknown>>, polls: {} as Record<string, number>,
    cancels: [] as string[], cancelStatus: {} as Record<string, number>, visualStatus: 200,
    transcribe: { status: 200, body: { success: true, data: { providerId: 'synthetic-stt', text: 'Synthetic spoken request' } } as unknown },
    uploads: [] as Array<{ contentType: string; audioField: boolean; partType: string; bytes: number }>,
  };
  Object.assign(state, { nexusGap: lane });
  const rows = () => state.tasks as unknown as Array<Record<string, unknown>>;
  const router = express.Router();
  router.post('/api/jarvis/ask', (_req, res, next) => {
    if (!lane.askRefusal) { next(); return; }
    lane.refusedAsks += 1; res.status(lane.askRefusal.status).json(lane.askRefusal.body);
  });
  router.get('/api/jarvis/ask/result', (req, res, next) => {
    const id = String(req.query.jobId || '');
    if (!lane.hold.has(id) && !(id in lane.results)) { next(); return; }
    lane.polls[id] = (lane.polls[id] || 0) + 1;
    if (lane.hold.has(id)) { res.json({ status: 'pending', label: 'synthetic' }); return; }
    res.json({ label: 'synthetic', ...lane.results[id] });
  });
  router.put('/api/tickets/:ticketId/cancel', (req, res) => {
    const id = req.params.ticketId, status = lane.cancelStatus[id] ?? 200; lane.cancels.push(id);
    if (status !== 200) { res.status(status).json(status === 404 ? { error: 'Ticket not found' } : { success: false, error: 'Synthetic cancel failure' }); return; }
    // The real GET /api/jarvis/tasks maps a cancelled ticket to status 'error' with this sentence.
    const row = rows().find(t => t.ticketId === id); if (row) Object.assign(row, { status: 'error', error: 'This one was cancelled before it finished.' });
    res.json({ success: true, status: 'cancelled', ticketId: id });
  });
  router.post('/api/voice/transcribe', express.raw({ type: () => true, limit: '11mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), text = raw.toString('latin1');
    lane.uploads.push({ contentType: String(req.headers['content-type'] || ''), audioField: text.includes('name="audio"'), partType: (/Content-Type: ([^\r\n]+)/i.exec(text) || [])[1] || '', bytes: raw.length });
    res.status(lane.transcribe.status).json(lane.transcribe.body);
  });
  router.get('/api/jarvis/visuals/:artifactId', (_req, res) => {
    if (lane.visualStatus !== 200) { res.status(lane.visualStatus).json({ error: 'visual_not_found' }); return; }
    res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="gray"/></svg>');
  });
  app.use(router);
  nexusBuildRoutes(app, state);
}

/**
 * @description Synthetic contracts for the homebase gap closure, each with a controllable status (`homebase:analytics`, `homebase:classwork`,
 * `homebase:ticket`, `homebase:ticket-status`, `homebase:drafts`): Little Monsters teacher analytics shaped like the package's pg rows (counts as
 * strings, the summary computed server-side), classwork through assignments-with-events, one ticket's read and status transition, and the caller's
 * saved content drafts (seeded through their own POST route). Registered with the other lane routes ahead of the defaults (see
 * startExperienceBrowserFixture); none of its paths overlaps a default route.
 * @param app The fixture application.
 * @param state The synthetic swarm state these routes read and change.
 * @returns Nothing; the routes are registered on `app`.
 */
function homebaseGapRoutes(app: express.Application, state: ExperienceState) {
  const edu = state.education, gap = express.Router(), drafts: Array<{ id: number; topic: string | null; take: string | null; draft: string; created_at: string }> = [];
  const refused = (res: express.Response, key: string, errors: Record<number, string>) => { const status = statusOr(state, key); if (status === 200) return false; res.status(status).json({ error: errors[status] ?? 'Synthetic refusal' }); return true; };
  const count = (v: unknown) => String(Number(v ?? 0));
  gap.get('/api/education/teacher/classes/:classId/analytics', (req, res) => {
    const roster = edu.students[req.params.classId] as Array<Record<string, unknown>> | undefined;
    if (refused(res, 'homebase:analytics', { 403: 'You do not teach this class', 404: 'Class not found' })) return;
    if (!roster) { res.status(403).json({ error: 'You do not teach this class' }); return; }
    const students = roster.map(s => ({ student_id: s.student_id, name: s.name, email: s.email ?? null, xp: Number(s.xp ?? 0), level: Number(s.level ?? 1), streak_days: Number(s.streak_days ?? 0),
      last_active_date: s.last_active_date ?? null, quiz_average: count(s.quiz_average), quiz_count: count(s.quiz_count), cards_reviewed: count(s.cards_reviewed) }));
    const quizzed = students.filter(s => Number(s.quiz_count) > 0);
    res.json({ class: { class_id: req.params.classId }, students, summary: { studentCount: students.length, classQuizAverage: quizzed.length ? Math.round(quizzed.reduce((n, s) => n + Number(s.quiz_average), 0) / quizzed.length) : null,
      studentsWithActivity: students.filter(s => Number(s.quiz_count) > 0 || Number(s.cards_reviewed) > 0).length, totalCardsReviewed: students.reduce((n, s) => n + Number(s.cards_reviewed), 0) } });
  });
  gap.post('/api/education/assignments-with-events', express.json(), (req, res) => {
    const body = req.body || {}, title = String(body.title ?? '').trim(), cls = edu.classes.find(c => c.class_id === String(body.classId ?? ''));
    if (refused(res, 'homebase:classwork', { 403: 'You do not teach this class', 409: 'Class authorization changed' })) return;
    if (!title || title.length > 500) { res.status(400).json({ error: 'title must contain 1-500 characters' }); return; }
    if (!cls || !(edu.me.role === 'admin' || (edu.me.role === 'teacher' && cls.teacher_student_id === edu.me.studentId))) { res.status(403).json({ error: 'You do not teach this class' }); return; }
    const assignmentId = `a${edu.assignments.length + 1}`, dueDate = body.dueDate ? String(body.dueDate) : null, type = String(body.assignmentType || 'homework');
    (edu.assignments as unknown[]).push({ assignment_id: assignmentId, class_id: cls.class_id, title, description: String(body.description || ''), status: 'open', due_date: dueDate, class_name: cls.name, assignment_type: type });
    const eventId = dueDate ? `e${edu.events.length + 1}` : null;
    if (dueDate) (edu.events as unknown[]).push({ event_id: eventId, class_id: cls.class_id, student_id: null, title: `${cls.name}: ${title}`, event_date: dueDate, event_time: '17:00:00', event_type: type === 'test' ? 'test' : type === 'quiz-prep' ? 'quiz' : 'assignment', class_name: cls.name, subject: cls.subject });
    res.status(201).json({ assignmentId, eventId, dueDate });
  });
  gap.get('/api/tickets/:ticketId', (req, res) => {
    const ticket = state.tickets.find(t => t.ticketId === req.params.ticketId);
    if (refused(res, 'homebase:ticket', { 404: 'Ticket not found' })) return;
    if (ticket) res.json(ticket); else res.status(404).json({ error: 'Ticket not found' });
  });
  gap.put('/api/tickets/:ticketId/status', express.json(), (req, res) => {
    const ticket = state.tickets.find(t => t.ticketId === req.params.ticketId), next = String(req.body?.status ?? '');
    if (refused(res, 'homebase:ticket-status', { 400: 'Invalid state transition', 404: 'Ticket not found' })) return;
    if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
    if (!(ticket.status === 'approval_required' && next === 'approved')) { res.status(400).json({ error: `Invalid state transition: ${ticket.status} -> ${next}` }); return; }
    // The ticket service mirrors every transition as metadata.lastStatusTransition ({ status, ...its metadata }) and keeps the
    // row-level reason/nextAction from earlier transitions; this route's body carries no metadata, so the mirror is the status alone.
    const row = ticket as typeof ticket & { metadata?: Record<string, unknown> };
    row.metadata = { ...(row.metadata || {}), lastStatusTransition: { status: next } };
    ticket.status = next; ticket.updatedAt = iso(0);
    res.json({ status: 'updated', newStatus: next });
  });
  gap.get('/api/content/drafts', (_req, res) => { if (!refused(res, 'homebase:drafts', { 401: 'not_authenticated' })) res.json({ drafts: [...drafts].reverse() }); });
  gap.post('/api/content/drafts', express.json(), (req, res) => {
    if (!String(req.body?.draft ?? '').trim()) { res.status(400).json({ error: 'draft required' }); return; }
    drafts.push({ id: drafts.length + 1, topic: req.body.topic || null, take: req.body.take || null, draft: String(req.body.draft), created_at: iso(0) }); res.json({ ok: true });
  });
  app.use(gap);
}

/** One ribbon item as GET /api/ui/profile carries it: `tool-<toolName>` with the surface's frame URL. */
type AssemblyRibbonItem = { id: string; label: string; icon: string; section: string; toolUi: { iframeUrl: string } };
/** The synthetic state the assembly-host routes read: per-application ribbon items that replace the default two-page profile. */
type AssemblyState = ExperienceState & { assembly: { ribbons: Record<string, AssemblyRibbonItem[]> } };

/**
 * The applications the phase-4 assemblies add, each with its suite and its `ui.static` surfaces as its manifest in
 * the store lists them (toolName, label), in manifest order. Only names and shapes are copied; every label the page
 * shows is prefixed "Synthetic".
 */
const ASSEMBLY_HOSTS: Record<string, { suite: string; surfaces: Array<[string, string]> }> = {
  presentations: { suite: 'ai-productivity', surfaces: [['presentations-studio', 'AI Office']] },
  'circuit-lab': { suite: 'ai-engineering', surfaces: [['circuit-lab', 'Circuit Lab']] },
  movies: { suite: 'ai-home', surfaces: [['movies-concierge', 'Movies & TV']] },
  spotify: { suite: 'ai-home', surfaces: [['spotify-concierge', 'Music']] },
  travel: { suite: 'ai-home', surfaces: [['travel-concierge', 'Travel']] },
  'email-summarizer': { suite: 'ai-productivity', surfaces: [['email-myday', 'My Day'], ['email-inbox', 'Inbox'], ['email-social', 'Social']] },
  world: { suite: 'ai-knowledge', surfaces: [['world-dashboard', 'World Intelligence']] },
  social: { suite: 'ai-productivity', surfaces: [['social-composer', 'Composer'], ['social-workspace', 'Workspace'], ['linkedin-assistant', 'LinkedIn Assistant'], ['social-signals', 'Signals'], ['social-accounts', 'Accounts']] },
  'marketing-engine': { suite: 'ai-productivity', surfaces: [['marketing-engine', 'Marketing'], ['marketing-content-studio', 'Content Studio'], ['marketing-linkedin-assistant', 'LinkedIn Assistant']] },
  'venture-plan': { suite: 'ai-finance', surfaces: [['venture-home', 'Venture Plan']] },
};

/**
 * @description Assembly-host routes (lane "assemblies"): GET /api/ui/profile answers from `state.assembly.ribbons` for an
 * installed application that has an entry there, so a preset's hidden prefixes meet the surface ids the real profile
 * lists; any other name falls through to the default two-page synthetic profile. Registered with the other lane routes
 * ahead of the default routes (see startExperienceBrowserFixture). The ribbons start empty, so a case sees them only
 * after installAssemblyHosts.
 * @param app The fixture application.
 * @param state The per-case synthetic state; `state.assembly` is created here.
 * @returns Nothing; the route is registered on `app`.
 */
function assemblyHostRoutes(app: express.Application, state: ExperienceState) {
  const assembly = (Object.assign(state, { assembly: { ribbons: {} } }) as AssemblyState).assembly;
  app.get('/api/ui/profile', (req, res, next) => {
    const name = String(req.query.name || ''), items = assembly.ribbons[name], record = state.apps.find(a => a.summary.name === name);
    if (!items || !record) { next(); return; }
    res.status(statusOr(state, 'profile')).json({ profile: { name, displayName: record.summary.displayName, theme: 'midnight', defaultView: items[0]?.id, ribbon: { items } } });
  });
}

/**
 * @description Install the applications the phase-4 assemblies host (AI Office and Circuit Lab for the classroom; Movies & TV,
 * Music and Travel for Home; Intelligent Communication, World Intelligence, Social, Marketing Engine and Venture Plan for
 * Business) into a case's synthetic catalog, each with a ribbon profile shaped like its manifest's surfaces. A case calls it
 * before opening a preset; the default catalog is left as it was, so counts other cases assert do not move.
 * @param state The case's synthetic state (from the running fixture).
 * @returns The names installed, in ASSEMBLY_HOSTS order.
 */
export function installAssemblyHosts(state: ExperienceState): string[] { return installHosts(state, ASSEMBLY_HOSTS); }

/**
 * The applications the composed front pages add beyond the assemblies (lane "front pages"), each with its suite and its
 * `ui.static` surfaces (toolName, label) as its manifest lists them: Calendar, Federal CRM (the first four of its twenty)
 * and Calling Assistant. Email, documents and payroll come from the assemblies and the default catalog.
 */
const FRONT_PAGE_HOSTS: Record<string, { suite: string; surfaces: Array<[string, string]> }> = {
  calendar: { suite: 'ai-productivity', surfaces: [['calendar-review', 'Calendar']] },
  'capture-crm': { suite: 'ai-knowledge', surfaces: [['federal-home', 'Home'], ['federal-leads', 'Leads'], ['federal-opps', 'Opportunities'], ['federal-import', 'Import']] },
  'calling-assistant': { suite: 'ai-productivity', surfaces: [['calling-settings', 'Calling']] },
};

/**
 * @description Install the front-page card applications the same way installAssemblyHosts does (a synthetic app with a
 * probe, and its ribbon items). A case calls it before opening a preset, after installAssemblyHosts when it wants the
 * assembly hosts too; the default catalog is otherwise left as it was.
 * @param state The case's synthetic state (from the running fixture).
 * @returns The names installed, in FRONT_PAGE_HOSTS order.
 */
export function installFrontPageHosts(state: ExperienceState): string[] { return installHosts(state, FRONT_PAGE_HOSTS); }

/** @description Add each host to the catalog when absent and seat its ribbon items for the assembly-host profile route. */
function installHosts(state: ExperienceState, hosts: Record<string, { suite: string; surfaces: Array<[string, string]> }>): string[] {
  const assembly = (state as AssemblyState).assembly;
  return Object.entries(hosts).map(([name, host]) => {
    if (!state.apps.some(a => a.summary.name === name)) state.apps.push(syntheticApp(name, host.suite));
    assembly.ribbons[name] = host.surfaces.map(([tool, label]) => ({ id: `tool-${tool}`, label: `Synthetic ${label}`, icon: 'codicon codicon-circle-outline', section: 'top', toolUi: { iframeUrl: `/fixture/surface/${tool}` } }));
    return name;
  });
}

/** The synthetic state the full-swarm build routes read (lane "portal"): per-ticket workflow read models and statuses. */
export type PortalFixtureState = {
  ticketWorkflows: Record<string, Record<string, unknown>>;
  workflowStatus: Record<string, number>;
  /** Schedule records as GET /api/v1/agent/schedules returns them; ownerSub decides visibility and the pause/resume refusal. */
  schedules: Array<Record<string, unknown> & { id: string; taskType: string; status: string; ownerSub?: string | null }>;
  schedulesStatus: number;
  /** Workflow Studio definition summaries ({ id, name, description, version, updatedAt, nodeCount, edgeCount }). */
  workflows: Array<Record<string, unknown>>;
  workflowsStatus: number;
  /** The caller's memberships as GET /api/tenants lists them, and each tenant's members (subject and role) for GET /api/tenants/:id/members. */
  tenants: Array<{ tenant_id: string; kind: string; name: string; role: string }>;
  tenantsStatus: number;
  members: Record<string, Array<{ user_sub: string; role: string }>>;
  /** The caller's location overview (GET /api/location/state) and its status; no coordinates, like the real read. */
  location: { status: number; body: Record<string, unknown> };
};

/**
 * @description The full-swarm build lane's synthetic state on a running fixture.
 * @param state The case's synthetic state (from the running fixture).
 * @returns The lane state portalBuildRoutes reads, created when the fixture started.
 */
export function portalState(state: ExperienceState): PortalFixtureState { return (state as ExperienceState & { portal: PortalFixtureState }).portal; }

/**
 * @description Synthetic routes for the full-swarm build (lane "portal"), shaped like the real contracts: one ticket's
 * workflow read model (GET /api/v1/tickets/:ticketId/workflow, the buildWorkflowPayload shape; 404 for a ticket the
 * caller does not own, or the status `workflowStatus[id]` names; `ticketWorkflows[id]` overrides the definition, run,
 * history, gates and children), and a pre-handler on PUT /api/tickets/:ticketId/cancel that moves the ticket to
 * cancelled when the central-assistant lane's cancel route will answer 200, then falls through to that route, which
 * answers and records the call. Registered first among the lane routes (see startExperienceBrowserFixture).
 * @param app The fixture application.
 * @param state The per-case synthetic state; `state.portal` is created here.
 * @returns Nothing; the routes are registered on `app`.
 */
function portalBuildRoutes(app: express.Application, state: ExperienceState) {
  const portal: PortalFixtureState = { ticketWorkflows: {}, workflowStatus: {}, schedules: [], schedulesStatus: 200, workflows: [], workflowsStatus: 200,
    tenants: [], tenantsStatus: 200, members: {}, location: { status: 200, body: { settings: { defaultPrecisionClass: 'place' }, devices: [], current: null, history: { observationCount: 0 }, visibility: { memberShares: [], guardianShares: [], restrictions: [] } } } };
  Object.assign(state, { portal });
  const router = express.Router();
  router.get('/api/v1/tickets/:ticketId/workflow', (req, res) => {
    const id = req.params.ticketId, ticket = state.tickets.find(t => t.ticketId === id), status = portal.workflowStatus[id] ?? (ticket ? 200 : 404);
    if (!ticket || status !== 200) { res.status(status).json({ success: false, error: status === 404 ? 'Ticket not found' : 'Failed to load ticket workflow' }); return; }
    res.json({ success: true, ticket: { ticketId: id, title: ticket.title, ticketType: ticket.ticketType, queueId: '', queueName: '', status: ticket.status, assignedAgentId: '' },
      definition: null, run: null, runHistoryAvailable: true, otherRunCount: 0, history: [], historyAvailable: true, approvalGates: [], children: [], childrenAvailable: true, ...portal.ticketWorkflows[id] });
  });
  scheduleRoutes(router, state, portal);
  peopleRoutes(router, state, portal);
  router.put('/api/tickets/:ticketId/cancel', (req, _res, next) => {
    const lane = (state as ExperienceState & { nexusGap?: { cancelStatus: Record<string, number> } }).nexusGap;
    const ticket = state.tickets.find(t => t.ticketId === req.params.ticketId);
    if (ticket && (lane?.cancelStatus[req.params.ticketId] ?? 200) === 200) ticket.status = 'cancelled';
    next();
  });
  app.use(router);
}

/**
 * @description The schedule and workflow-definition reads of portalBuildRoutes, mirroring the real controllers: the list is
 * owner-scoped (unowned system schedules stay visible), pause/resume answer 404 for a schedule the caller does not own,
 * 403 for an app: / app-route: schedule (managed by its manifest) and for a workflow: schedule (the synthetic caller is no
 * operator), and otherwise flip the status and return the schedule.
 * @param router The lane router.
 * @param state The per-case synthetic state (for the caller's subject).
 * @param portal The lane state.
 * @returns Nothing; the routes are registered on `router`.
 */
function scheduleRoutes(router: express.Router, state: ExperienceState, portal: PortalFixtureState) {
  const visible = (s: PortalFixtureState['schedules'][number]) => !s.ownerSub || s.ownerSub === state.user.sub;
  router.get('/api/v1/agent/schedules', (_req, res) => {
    if (portal.schedulesStatus !== 200) { res.status(portal.schedulesStatus).json({ success: false, error: 'Synthetic schedules unavailable' }); return; }
    res.json({ success: true, schedules: portal.schedules.filter(visible) });
  });
  router.post('/api/v1/agent/schedules/:id/:verb', (req, res, next) => {
    if (!['pause', 'resume'].includes(req.params.verb)) { next(); return; }
    const schedule = portal.schedules.find(s => s.id === req.params.id);
    if (!schedule || !visible(schedule)) { res.status(404).json({ success: false, error: 'Schedule not found' }); return; }
    if (/^app(-route)?:/.test(schedule.taskType)) { res.status(403).json({ success: false, error: 'Schedule is managed by an active app manifest' }); return; }
    if (/^workflow:/.test(schedule.taskType)) { res.status(403).json({ success: false, error: 'Operator privilege required' }); return; }
    schedule.status = req.params.verb === 'pause' ? 'paused' : 'active';
    res.json({ success: true, schedule });
  });
  router.get('/api/workflow-studio/definitions', (_req, res) => {
    if (portal.workflowsStatus !== 200) { res.status(portal.workflowsStatus).json({ success: false, error: 'Synthetic definitions unavailable' }); return; }
    res.json({ success: true, count: portal.workflows.length, definitions: portal.workflows });
  });
}

/**
 * @description The membership and own-location reads of portalBuildRoutes, mirroring the real routes: GET /api/tenants lists the
 * caller's memberships (or the status `tenantsStatus` names), GET /api/tenants/:id/members answers members only (403 "not a
 * member" otherwise) with subject and role, and GET /api/location/state answers the caller's own overview or its status.
 * @param router The lane router.
 * @param state The per-case synthetic state (for the caller's subject).
 * @param portal The lane state.
 * @returns Nothing; the routes are registered on `router`.
 */
function peopleRoutes(router: express.Router, state: ExperienceState, portal: PortalFixtureState) {
  router.get('/api/tenants', (_req, res) => {
    if (portal.tenantsStatus !== 200) { res.status(portal.tenantsStatus).json({ error: 'Synthetic tenants unavailable' }); return; }
    res.json({ tenants: portal.tenants });
  });
  router.get('/api/tenants/:id/members', (req, res) => {
    const members = portal.members[req.params.id] || [];
    if (!members.some(m => m.user_sub === state.user.sub)) { res.status(403).json({ error: 'not a member' }); return; }
    res.json({ members });
  });
  router.get('/api/location/state', (_req, res) => { res.status(portal.location.status).json(portal.location.status === 200 ? portal.location.body : { error: 'location_session_required' }); });
}
/** @description Opt a case into the central assistant's build routes; without it they fall through to the defaults. */
export function enableNexusBuild(state: ExperienceState): void { (state as ExperienceState & { nexusBuild: { active: boolean } }).nexusBuild.active = true; }
/** @description A silent 8 kHz, 8-bit mono WAV clip of the given length, base64, for the synthesize route of a case. */
export function silentWav(seconds = 1): string {
  const samples = Math.round(8000 * seconds), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write('data', 36); header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]).toString('base64');
}
/** The ADR-169 location overview as GET /api/location/state answers it for its owner (places by reference, never coordinates). */
type HomeLocationState = {
  settings: { defaultPrecisionClass: string };
  devices: Array<{ deviceId: string; kind: string; reportingEnabled: boolean; precisionClass: string; lastSeenAt: string | null; createdAt: string }>;
  current: null | { deviceId: string | null; source: string; precisionClass: string; accuracyM: number | null; receivedAt: string; ageSeconds: number; place: null | { placeId: string; name: string; label: string } };
  history: { observationCount: number };
  visibility: { memberShares: Array<Record<string, unknown>>; guardianShares: Array<Record<string, unknown>>; restrictions: Array<Record<string, unknown>> };
};
/** The synthetic state the home-build routes read and change (`state.homeBuild`). */
export type HomeBuildState = {
  location: HomeLocationState;
  tenants: Array<{ tenant_id: string; kind: string; name: string; role: string }>;
  members: Record<string, Array<{ user_sub: string; role: string }>>;
  dashboard: { xp: number; level: number; streak_days: number; quizAverage: number; quizCount: number; flashcardsReviewed: number };
  notices: Array<{ notification_id: string; title: string; body: string; channel: string; read: boolean; sent_at: string }>;
  briefings: Array<{ id: string; title: string; description: string; preference: { enabled: boolean; frequency: string; channel: string } }>;
  schedules: Array<{ id: string; taskType: string; cron: string; taskData: Record<string, unknown>; status: string; nextRunAt: string | null; once?: boolean }>;
  hits: Array<{ id: string; title: string; snippet: string; kind: string; url: string | null; score: number; source: string; ts: string | null }>;
  writes: string[];
};

/**
 * @description Lane "home build" synthetic contracts, each shaped like the real route's answer and driven through
 * `state.homeBuild` plus a per-route status (`home:location`, `home:opt-out`, `home:tenants`, `home:members`,
 * `home:create-tenant`, `home:dashboard`, `home:notices`, `home:notice-read`, `home:briefings`, `home:briefing-put`,
 * `home:schedules`, `home:schedule-toggle`, `home:search`): ADR-169 GET /api/location/state and
 * POST /api/location/devices/:deviceId/opt-out (device_not_found for a device that is not the caller's); the caller's groups
 * (GET /api/tenants, GET /api/tenants/:id/members for members only, POST /api/tenants making the caller admin); a learner's
 * own GET /api/education/student/:id/dashboard (403 for anyone else's); Little Monsters notices (GET, PATCH read); Jarvis
 * briefing sources (GET, and PUT refused without the route's `x-oshal-briefing-request: 1` header); the caller's schedules
 * (GET, POST pause/resume); and GET /api/search. Every write is logged in `homeBuild.writes`. Registered with the other lane
 * routes ahead of the default routes (see startExperienceBrowserFixture); none of its paths overlaps a default route.
 * @param app The fixture application.
 * @param state The per-case synthetic state; `state.homeBuild` is created here with an empty household, location off,
 * no notices and one briefing source.
 * @returns Nothing; the routes are registered on `app`.
 */
function homebaseBuildRoutes(app: express.Application, state: ExperienceState) {
  const home: HomeBuildState = {
    location: { settings: { defaultPrecisionClass: 'block' }, devices: [], current: null, history: { observationCount: 0 }, visibility: { memberShares: [], guardianShares: [], restrictions: [] } },
    tenants: [], members: {},
    dashboard: { xp: 160, level: 2, streak_days: 3, quizAverage: 84, quizCount: 2, flashcardsReviewed: 12 },
    notices: [],
    briefings: [{ id: 'synthetic-morning', title: 'Synthetic morning brief', description: 'A synthetic briefing source.', preference: { enabled: false, frequency: 'daily', channel: 'bubble' } }],
    schedules: [], hits: [], writes: [],
  };
  Object.assign(state, { homeBuild: home });
  const router = express.Router();
  const refused = (res: express.Response, key: string, body: Record<string, unknown> = { error: 'Synthetic refusal' }) => { const status = statusOr(state, key); if (status === 200) return false; res.status(status).json(body); return true; };
  router.get('/api/location/state', (_req, res) => { if (!refused(res, 'home:location', { error: 'browser_session_required', message: 'Location settings are changed from a signed-in browser, not with a token.' })) res.json(home.location); });
  router.post('/api/location/devices/:deviceId/opt-out', (req, res) => {
    home.writes.push(`opt-out ${req.params.deviceId}`);
    const device = home.location.devices.find(d => d.deviceId === req.params.deviceId);
    if (refused(res, 'home:opt-out')) return;
    if (!device) { res.status(404).json({ error: 'device_not_found', message: 'No such device of yours.' }); return; }
    device.reportingEnabled = false;
    const cleared = home.location.current && home.location.current.deviceId === device.deviceId ? 1 : 0; if (cleared) home.location.current = null;
    res.json({ device, currentCleared: cleared });
  });
  homeGroupRoutes(router, state, home, refused);
  homeLearnerRoutes(router, state, home, refused);
  homeRoutineRoutes(router, home, refused);
  router.get('/api/search', (req, res) => { if (!refused(res, 'home:search', { error: 'search failed' })) res.json({ query: String(req.query.q || ''), limit: 10, hits: home.hits.filter(h => h.title.toLowerCase().includes(String(req.query.q || '').toLowerCase())), sourceCounts: {}, unknownSources: [], durationMs: 1 }); });
  app.use(router);
}
type HomeRefusal = (res: express.Response, key: string, body?: Record<string, unknown>) => boolean;
/** @description The caller's groups: list with kind and role, members for members only, and household creation that makes the caller admin. */
function homeGroupRoutes(router: express.Router, state: ExperienceState, home: HomeBuildState, refused: HomeRefusal) {
  router.get('/api/tenants', (_req, res) => { if (!refused(res, 'home:tenants', { error: 'list tenants failed' })) res.json({ tenants: home.tenants }); });
  router.get('/api/tenants/:id/members', (req, res) => {
    if (refused(res, 'home:members', { error: 'not a member' })) return;
    if (!home.tenants.some(t => t.tenant_id === req.params.id)) { res.status(403).json({ error: 'not a member' }); return; }
    res.json({ members: home.members[req.params.id] || [] });
  });
  router.post('/api/tenants', express.json(), (req, res) => {
    const name = String(req.body?.name || '').trim(); home.writes.push(`create-tenant ${name}`);
    if (refused(res, 'home:create-tenant', { error: 'create tenant failed' })) return;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const tenant = { tenant_id: `t-${home.tenants.length + 1}`, kind: String(req.body?.kind || 'space'), name, role: 'admin' };
    home.tenants.push(tenant); home.members[tenant.tenant_id] = [{ user_sub: state.user.sub, role: 'admin' }];
    res.json({ tenant });
  });
}
/** @description A learner's own Little Monsters dashboard (403 for another learner) and their notices with mark-read. */
function homeLearnerRoutes(router: express.Router, state: ExperienceState, home: HomeBuildState, refused: HomeRefusal) {
  router.get('/api/education/student/:studentId/dashboard', (req, res) => {
    if (refused(res, 'home:dashboard', { error: 'You cannot view this student' })) return;
    const me = state.education.me;
    if (req.params.studentId !== me.studentId) { res.status(403).json({ error: 'You cannot view this student' }); return; }
    const d = home.dashboard;
    res.json({ student: { student_id: me.studentId, name: me.name, email: me.email, xp: d.xp, level: d.level, streak_days: d.streak_days, last_active_date: null }, classes: [], upcoming: [], stats: { quizAverage: d.quizAverage, quizCount: d.quizCount, flashcardsReviewed: d.flashcardsReviewed } });
  });
  router.get('/api/education/notifications', (req, res) => {
    if (refused(res, 'home:notices', { error: 'Failed to list notifications' })) return;
    const rows = home.notices.filter(n => req.query.all === 'true' || !n.read);
    res.json({ notifications: rows, unreadCount: rows.filter(n => !n.read).length });
  });
  router.patch('/api/education/notifications/:id/read', (req, res) => {
    home.writes.push(`notice-read ${req.params.id}`);
    if (refused(res, 'home:notice-read', { error: 'Failed to mark notification read' })) return;
    const row = home.notices.find(n => n.notification_id === req.params.id);
    if (!row) { res.status(404).json({ error: 'Notification not found' }); return; }
    row.read = true; res.json({ success: true });
  });
}
/** @description Jarvis briefing sources (PUT refused without the route's own header) and the caller's schedules with pause and resume. */
function homeRoutineRoutes(router: express.Router, home: HomeBuildState, refused: HomeRefusal) {
  router.get('/api/jarvis/briefings', (_req, res) => { if (!refused(res, 'home:briefings', { error: 'briefings_unavailable' })) res.json({ sources: home.briefings.map(b => ({ ...b, channels: ['voice', 'bubble', 'screen'], delivery: 'Jarvis must be open. Voice also requires browser audio permission.' })) }); });
  router.put('/api/jarvis/briefings/:sourceId', express.json(), (req, res) => {
    home.writes.push(`briefing ${req.params.sourceId} ${JSON.stringify(req.body)}`);
    if (req.get('x-oshal-briefing-request') !== '1') { res.status(403).json({ error: 'same_origin_required' }); return; }
    if (refused(res, 'home:briefing-put', { error: 'briefing_access_denied' })) return;
    const source = home.briefings.find(b => b.id === req.params.sourceId), body = req.body || {};
    if (!source) { res.status(403).json({ error: 'briefing_access_denied' }); return; }
    if (typeof body.enabled !== 'boolean' || !['as-available', 'hourly', 'daily', 'weekly'].includes(body.frequency) || !['voice', 'bubble', 'screen'].includes(body.channel) || Object.keys(body).length !== 3) { res.status(400).json({ error: 'invalid_briefing_request' }); return; }
    source.preference = { enabled: body.enabled, frequency: body.frequency, channel: body.channel };
    res.json(source.preference);
  });
  router.get('/api/v1/agent/schedules', (_req, res) => { if (!refused(res, 'home:schedules', { success: false, error: 'Synthetic schedules unavailable' })) res.json({ success: true, schedules: home.schedules }); });
  router.post('/api/v1/agent/schedules/:id/:verb', (req, res, next) => {
    if (!['pause', 'resume'].includes(req.params.verb)) { next(); return; }
    home.writes.push(`schedule ${req.params.verb} ${req.params.id}`);
    if (refused(res, 'home:schedule-toggle', { success: false, error: 'Synthetic schedule refusal' })) return;
    const row = home.schedules.find(s => s.id === req.params.id);
    if (!row) { res.status(404).json({ success: false, error: 'Schedule not found' }); return; }
    row.status = req.params.verb === 'pause' ? 'paused' : 'active';
    res.json({ success: true, schedule: row });
  });
}

/** @description The home-build synthetic state of a running fixture (created by homebaseBuildRoutes). */
export function homeBuildState(state: ExperienceState): HomeBuildState { return (state as ExperienceState & { homeBuild: HomeBuildState }).homeBuild; }
/** A synthetic busy window as GET /api/experience/availability returns it. */
type BusyWindow = { start: string; end: string };
/** A synthetic Travel offer shaped like the package's normalised Duffel card (scripts/oshal-duffel.js normalizeOffer). */
type SyntheticOffer = { id: string; price: number; currency: string; airline: string; cabin: string; expiresAt: string | null;
  slices: Array<{ origin: string; destination: string; originCity?: string; destinationCity?: string; departAt: string; arriveAt: string; duration: string; stops: number; carriers: string[] }> };

/**
 * @description The synthetic state behind the central assistant's build routes (lane "orb"), reachable as `state.nexusBuild`:
 * the caller's busy windows and availability refusal, the Google connection status, and Travel's config, profile, flight
 * search (offers, source, price read) and fare watches, each with a controllable status and a log of what the page sent.
 * @returns The fresh lane state.
 */
function nexusBuildState() {
  return {
    /** Off until the case opts in: an inactive lane falls through to the default routes (the fixture's contract). */
    active: false,
    /** A WAV clip for POST /api/voice/synthesize; empty keeps the default refusal. */
    voice: { audioData: '' },
    availability: { status: 200, state: 'ready', error: '', busy: [] as BusyWindow[], calls: [] as Array<{ timeMin: string; timeMax: string }> },
    google: { status: 200, connected: true, expired: false },
    travel: {
      configStatus: 200, config: { connected: true, mode: 'live', live: false } as Record<string, unknown>,
      profileStatus: 200, profile: { user_sub: 'synthetic-user', home_airport: 'PNS', preferred_cabin: 'economy', onboarded: true } as Record<string, unknown>,
      profileWrites: [] as Array<Record<string, unknown>>, profileWriteStatus: 200,
      flightsStatus: 200, source: 'duffel', error: '', searches: [] as Array<Record<string, string>>,
      price: { verdict: 'typical', advice: 'Typical price — around the recent average ($260). Fine to book, or watch for a dip.', samples: 12, avg: 260, min: 199, p25: 230, currentBest: 218 } as Record<string, unknown>,
      offers: null as SyntheticOffer[] | null,
      watches: [] as Array<Record<string, unknown>>, watchStatus: 200, watchPosts: [] as Array<Record<string, unknown>>,
    },
  };
}

/**
 * @description Four synthetic offers for one search, the way Travel returns them: A 238 one stop 4:20 PM, B 318 nonstop
 * 1:15 PM, C 218 one stop 2:10 PM, D 286 one stop 5:05 PM (so price order is C, A, D, B; nonstop keeps B; after 3pm keeps
 * A and D; both together match nothing).
 * @param q The search query the page sent.
 * @returns The offers.
 */
export function syntheticOffers(q: Record<string, string>): SyntheticOffer[] {
  const back = q.returnDate || q.departDate;
  const offer = (id: string, airline: string, price: number, stops: number, depart: string, duration: string): SyntheticOffer => ({
    id, price, currency: 'USD', airline, cabin: 'economy', expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(),
    slices: [{ origin: q.origin, destination: q.destination, departAt: `${q.departDate}T${depart}:00`, arriveAt: `${q.departDate}T21:30:00`, duration, stops, carriers: [airline] },
      { origin: q.destination, destination: q.origin, departAt: `${back}T18:10:00`, arriveAt: `${back}T23:40:00`, duration: '4h 30m', stops: 0, carriers: [airline] }],
  });
  return [offer('syn-a', 'Synthetic Air A', 238, 1, '16:20', '5h 24m'), offer('syn-b', 'Synthetic Air B', 318, 0, '13:15', '4h 06m'),
    offer('syn-c', 'Synthetic Air C', 218, 1, '14:10', '6h 12m'), offer('syn-d', 'Synthetic Air D', 286, 1, '17:05', '5h 06m')];
}

/**
 * @description Central-assistant build routes (lane "orb"), synthetic and driven through `state.nexusBuild`, mirroring the real
 * shapes: GET /api/experience/availability (busy windows clamped to the asked window, or the route's refusal body), GET
 * /api/connect/list (the Google provider row, status only), and Travel's GET /config, GET/POST /profile, GET /flights (offers,
 * source, price read, error) and GET/POST /watches. Registered by nexusGapRoutes, ahead of the default routes and their `/api`
 * catch-all.
 * @param app The fixture application.
 * @param state The per-case synthetic state; `state.nexusBuild` is created here.
 * @returns Nothing; the routes are registered on `app`.
 */
function nexusBuildRoutes(app: express.Application, state: ExperienceState) {
  const lane = nexusBuildState(), travel = lane.travel;
  Object.assign(state, { nexusBuild: lane });
  const router = express.Router();
  router.use((_req, _res, next) => { if (!lane.active) { next('router'); return; } next(); });
  router.post('/api/voice/synthesize', (_req, res, next) => { if (!lane.voice.audioData) { next(); return; } res.json({ success: true, data: { audioData: lane.voice.audioData, format: 'wav' } }); });
  router.get('/api/experience/availability', (req, res) => {
    const timeMin = String(req.query.timeMin || ''), timeMax = String(req.query.timeMax || ''), a = lane.availability;
    a.calls.push({ timeMin, timeMax });
    if (a.status !== 200) { res.status(a.status).json({ state: a.state, error: a.error }); return; }
    const lo = Date.parse(timeMin), hi = Date.parse(timeMax);
    const busy = a.busy.filter(b => Date.parse(b.end) > lo && Date.parse(b.start) < hi);
    res.json({ state: 'ready', source: 'google-calendar', calendar: 'primary', timeMin, timeMax, checkedAt: iso(0), busy });
  });
  router.get('/api/connect/list', (_req, res) => {
    const g = lane.google;
    if (g.status !== 200) { res.status(g.status).json({ error: 'Synthetic connections unavailable' }); return; }
    res.json({ providers: [{ id: 'google', label: 'Google', connected: g.connected, connections: g.connected ? [{ connectionId: 'c1', label: 'Synthetic', expired: g.expired, expiring: false }] : [] }] });
  });
  router.get('/api/travel/config', (_req, res) => { res.status(travel.configStatus).json(travel.configStatus === 200 ? travel.config : { error: 'Synthetic Travel refused' }); });
  router.get('/api/travel/profile', (_req, res) => { res.status(travel.profileStatus).json(travel.profileStatus === 200 ? { profile: travel.profile } : { error: 'Synthetic Travel refused' }); });
  router.post('/api/travel/profile', express.json(), (req, res) => {
    travel.profileWrites.push(req.body || {});
    if (travel.profileWriteStatus !== 200) { res.status(travel.profileWriteStatus).json({ error: 'Synthetic profile refused' }); return; }
    if (req.body && req.body.homeAirport) travel.profile = { ...travel.profile, home_airport: String(req.body.homeAirport) };
    res.json({ profile: travel.profile });
  });
  router.get('/api/travel/flights', (req, res) => {
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    travel.searches.push(q);
    if (travel.flightsStatus !== 200) { res.status(travel.flightsStatus).json({ error: 'origin, destination and departDate are required' }); return; }
    res.json({ items: travel.offers ?? syntheticOffers(q), source: travel.source, deepLink: 'https://flights.example.invalid/', price: travel.price, routeKey: `flight:${q.origin}-${q.destination}`, error: travel.error || undefined });
  });
  router.get('/api/travel/watches', (_req, res) => { res.json({ items: travel.watches }); });
  router.post('/api/travel/watches', express.json(), (req, res) => {
    travel.watchPosts.push(req.body || {});
    if (travel.watchStatus !== 200) { res.status(travel.watchStatus).json({ error: 'Synthetic watch refused' }); return; }
    const watch = { watch_id: `w${travel.watches.length + 1}`, kind: 'flight', route_key: `flight:${req.body.origin}-${req.body.destination}:${req.body.departDate}`, query: req.body, last_price: req.body.lastPrice, currency: 'USD', status: 'active', last_checked_at: null, created_at: iso(0) };
    travel.watches.unshift(watch); res.json({ watch });
  });
  app.use(router);
}

/**
 * @description Install Travel into a case's synthetic catalog (admitted: in the plan, navigable, with its Travel surface as
 * the manifest lists it), so the central assistant's Travel view is offered; `admitted: false` keeps it installed but
 * outside the caller's plan, which must render nothing and ask nothing (ADR-164 D10).
 * @param state The case's synthetic state (from the running fixture).
 * @param admitted Whether the caller's plan admits Travel.
 * @returns Nothing; the catalog is changed in place.
 */
export function installTravelHost(state: ExperienceState, admitted = true): void {
  enableNexusBuild(state);
  if (admitted) { installHosts(state, { travel: { suite: 'ai-home', surfaces: [['travel-concierge', 'Travel']] } }); return; }
  if (!state.apps.some(a => a.summary.name === 'travel')) state.apps.push(syntheticApp('travel', 'ai-home', { inPlan: false, navigable: false }));
}
