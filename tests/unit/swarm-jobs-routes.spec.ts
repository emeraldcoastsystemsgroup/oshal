/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-9): GET /api/admin/jobs answers an operator every scheduler record with its kind derived from the taskType and, for a manifest schedule, the operator's standing override from the same store the schedule control route writes (null for a per-user instance and every other record); every active application's services with their activation state and whether the package registered a catalog; an application whose listing throws becomes a warning and the rest still answer; the built-in timers read their gates and intervals from the environment at request time and nothing else from it (a secret in the environment, and a record's prompt, never reach the reply); a missing scheduler or activation authority is a warning, not a failure; a user is refused 403 and a signed-out caller 401; the production deps read the process-lifetime holders; the real mount line is pinned. Each fails on the tree before the fix.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSwarmJobsRoutes, defaultSwarmJobsDeps, jobKind, manifestScheduleKey,
  type SwarmJobsActivationPorts, type SwarmJobsDeps, type SwarmJobsView,
} from '@/app/routes/swarm-jobs-routes';
import { readBuiltInTimers, readSchedulerGate } from '@/app/routes/swarm-jobs-timers';
import { setApplicationServiceActivations } from '@/app/application-service-activation-wiring';
import type { ApplicationServiceActivationService, ApplicationServicesView } from '@/features/application-authorization';
import type { ManifestScheduleOverride, ScheduleRecord } from '@/features/scheduling';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { requiresOperator } from '@/shared/middleware/authz';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';

const OPERATOR = { sub: 'idp-operator', email: 'operator@example.test', iss: 'https://login.example.test/tenant' };
const USER = { sub: 'idp-user', email: 'user@example.test', iss: 'https://login.example.test/tenant' };
const ISO = '2026-10-06T10:00:00.000Z';
const SECRET_PROMPT = 'secret-prompt-text-7b1c';
const ACTOR = { sub: OPERATOR.sub, issuer: OPERATOR.iss } as unknown as AuthorizationActor;

/** A scheduler record with the fields the listing reads; task data carries a prompt that must never reach the reply. */
function record(over: Partial<ScheduleRecord> & Pick<ScheduleRecord, 'id' | 'taskType'>): ScheduleRecord {
  return { cron: '0 6 * * *', taskData: { prompt: SECRET_PROMPT }, status: 'active', createdAt: ISO, updatedAt: ISO, nextRunAt: ISO, lastRunAt: null, executionCount: 3, ownerSub: null, queue: null, ...over };
}

const RECORDS: ScheduleRecord[] = [
  record({ id: 's1', taskType: 'app-route:intelligent-sales-email-auto-log', queue: 'intelligent-sales', cron: '*/15 * * * *' }),
  record({ id: 's2', taskType: 'app:world-refresh', queue: 'world', timezone: 'America/Chicago' }),
  record({ id: 's3', taskType: 'trading-event-leg:open', ownerSub: 'idp-operator' }),
  record({ id: 's4', taskType: 'workflow:oshal-dev', queue: 'oshal-dev' }),
  record({ id: 's5', taskType: 'jarvis-reminder', ownerSub: 'idp-user', once: true }),
  record({ id: 's6', taskType: 'home-solar-replan' }),
  record({ id: 's7', taskType: 'social-digest', status: 'paused' }),
  record({ id: 's8', taskType: 'app-route:intelligent-sales-email-auto-log:idpuser1', queue: 'intelligent-sales', ownerSub: 'idp-user' }),
];

const OVERRIDES: Record<string, ManifestScheduleOverride> = {
  'intelligent-sales-email-auto-log': { enabled: false, updatedBy: OPERATOR.sub, updatedAt: ISO },
  'world-refresh': { cron: '*/30 * * * *', updatedBy: OPERATOR.sub, updatedAt: ISO },
};

/** One application's services view in the real reply shape. */
function view(app: string, state: ApplicationServicesView['services'][number]['state'], requires: string[]): ApplicationServicesView {
  const services = [{ id: 'email-auto-log', scheduleId: `${app}-email-auto-log`, cron: '*/15 * * * *', proposedRunsAs: 'system' as const, requires: requires.map((permission) => ({ permission })), state, userCount: 0, activeForCaller: false }];
  const awaitingActivation = state === 'not-activated' ? 1 : 0;
  return { app, services, awaitingActivation, ready: awaitingActivation === 0, readyDetail: '', readiness: { app, label: '', path: '', readyPointer: '/ready', detailPointer: '/readyDetail' } };
}

function ports(overrides: Partial<SwarmJobsActivationPorts> = {}): SwarmJobsActivationPorts {
  return {
    activeServiceApps: async () => ['intelligent-sales', 'broken-app', 'catalog-less'],
    listServices: async (_actor, app) => {
      if (app === 'broken-app') throw Object.assign(new Error('boom'), { code: 'authorization_app_not_registered' });
      return view(app, app === 'catalog-less' ? 'not-activated' : 'not-activated', app === 'intelligent-sales' ? ['crm.write'] : []);
    },
    resolveActor: async () => ACTOR,
    describeApp: (app) => (app === 'intelligent-sales' ? { catalog: { permissions: {} } } : app === 'catalog-less' ? { catalog: null } : null),
    ...overrides,
  };
}

function deps(over: Partial<SwarmJobsDeps> = {}): SwarmJobsDeps {
  return {
    scheduler: () => ({ listSchedules: async () => RECORDS, getManifestOverride: async (key) => OVERRIDES[key] ?? null }),
    activations: () => ports(),
    env: () => process.env,
    ...over,
  };
}

const signIn: RequestHandler = (req, _res, next) => {
  const raw = req.headers['x-fixture-user'];
  if (typeof raw === 'string' && raw) Object.assign(req, { oidc: { isAuthenticated: () => true, user: JSON.parse(raw) } });
  next();
};
const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next(); else res.status(401).json({ error: 'unauthorized' });
};

async function serve(d: SwarmJobsDeps) {
  const app = express();
  app.use(signIn);
  app.use('/api/admin/jobs', requiresAuth, requiresOperator, createSwarmJobsRoutes(d));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (user: Record<string, string> | null) => fetch(`${base}/api/admin/jobs`, { headers: user ? { 'x-fixture-user': JSON.stringify(user) } : {} }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ENV_KEYS = ['ENABLE_AGENT_SCHEDULER', 'SCHEDULER_POLL_INTERVAL_MS', 'VIDEO_PUMP_ENABLED', 'GOVCON_CRON', 'UPDATE_CHECK_ENABLED', 'INBOX_INGEST_INTERVAL_MIN', 'JARVIS_BRIEF_CRON', 'HAVEN_PUSH_CRON', 'SESSION_SECRET', 'ANTHROPIC_API_KEY'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  setPrivilegedIdentities([{ sub: OPERATOR.sub, email: OPERATOR.email, role: 'admin' }]);
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  clearPrivilegedIdentities();
  setApplicationServiceActivations(undefined);
});

describe('jobKind and manifestScheduleKey', () => {
  it('derives the kind from the taskType prefix', () => {
    expect(RECORDS.map((r) => jobKind(r.taskType))).toEqual(['service', 'prompt', 'trading', 'workflow', 'reminder', 'home', 'other', 'service']);
  });

  it('names the override key of a manifest schedule only: no per-user suffix, no other kind', () => {
    expect(manifestScheduleKey('app-route:intelligent-sales-email-auto-log')).toBe('intelligent-sales-email-auto-log');
    expect(manifestScheduleKey('app:world-refresh')).toBe('world-refresh');
    expect(manifestScheduleKey('app-route:intelligent-sales-email-auto-log:idpuser1')).toBeNull();
    expect(manifestScheduleKey('app:world-refresh:idpuser1')).toBeNull();
    for (const taskType of ['trading-event-leg:open', 'workflow:oshal-dev', 'jarvis-reminder', 'home-solar-replan', 'social-digest', 'app:', 'app-route:']) expect(manifestScheduleKey(taskType), taskType).toBeNull();
  });
});

describe('the built-in timers registry', () => {
  it('reads each gate and interval as its module does, and nothing else', () => {
    expect(readSchedulerGate(process.env)).toEqual({ enabled: false, pollIntervalMs: 15000 });
    process.env.ENABLE_AGENT_SCHEDULER = 'true';
    process.env.SCHEDULER_POLL_INTERVAL_MS = '2500';
    process.env.VIDEO_PUMP_ENABLED = 'TRUE';
    process.env.GOVCON_CRON = 'yes';
    process.env.UPDATE_CHECK_ENABLED = 'no';
    process.env.INBOX_INGEST_INTERVAL_MIN = '1';
    process.env.HAVEN_PUSH_CRON = '0';
    expect(readSchedulerGate(process.env)).toEqual({ enabled: true, pollIntervalMs: 2500 });
    const timers = readBuiltInTimers(process.env);
    const byId = Object.fromEntries(timers.map((t) => [t.id, t]));
    expect(timers.map((t) => t.id)).toEqual(['schedule-runner', 'inbox-ingest', 'social-signals', 'feeds-indexing', 'gov-contracting', 'update-check', 'travel-farewatch', 'video-pump', 'jarvis-brief', 'haven-push']);
    expect([byId['schedule-runner'].enabled, byId['schedule-runner'].cadence]).toEqual([true, 'polls every 2500 ms']);
    expect(byId['video-pump'].enabled).toBe(true);
    expect(byId['gov-contracting'].enabled).toBe(true);
    expect(byId['update-check'].enabled).toBe(false);
    expect(byId['haven-push'].enabled).toBe(false);
    expect(byId['jarvis-brief'].enabled).toBe(false);
    // The inbox ingest floor is two minutes, as the module clamps it.
    expect(byId['inbox-ingest'].cadence).toBe('every 2 min');
    for (const t of timers) { expect(typeof t.enabled).toBe('boolean'); expect(t.flag).toMatch(/^[A-Z_]+$/); }
  });
});

describe('GET /api/admin/jobs', () => {
  it('refuses a user and a signed-out caller, and answers an operator the schedules with kinds and overrides, the services with catalog standing, a warning for the application that threw, and the timers', async () => {
    process.env.ENABLE_AGENT_SCHEDULER = 'true';
    process.env.SESSION_SECRET = 'sekrit-9f8e7d6c';
    process.env.ANTHROPIC_API_KEY = 'sk-leak-test-1234';
    const app = await serve(deps());
    try {
      expect((await app.get(USER)).status).toBe(403);
      expect((await app.get(null)).status).toBe(401);
      const res = await app.get(OPERATOR);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const forbidden of ['sekrit-9f8e7d6c', 'sk-leak-test-1234', SECRET_PROMPT, 'taskData']) expect(text, forbidden).not.toContain(forbidden);
      const body = JSON.parse(text) as SwarmJobsView;
      expect(body.scheduler).toEqual({ enabled: true, pollIntervalMs: 15000 });
      expect(body.schedules.map((s) => [s.id, s.kind, s.app, s.override])).toEqual([
        ['s1', 'service', 'intelligent-sales', { enabled: false, cron: null }],
        ['s2', 'prompt', 'world', { enabled: true, cron: '*/30 * * * *' }],
        ['s3', 'trading', null, null],
        ['s4', 'workflow', 'oshal-dev', null],
        ['s5', 'reminder', null, null],
        ['s6', 'home', null, null],
        ['s7', 'other', null, null],
        ['s8', 'service', 'intelligent-sales', null],
      ]);
      expect(body.schedules[1].timezone).toBe('America/Chicago');
      expect(body.schedules[4]).toMatchObject({ ownerSub: 'idp-user', once: true });
      expect(body.schedules[6].status).toBe('paused');
      expect(body.services.map((s) => [s.app, s.scheduleId, s.id, s.runsAs, s.requires, s.state, s.catalog])).toEqual([
        ['intelligent-sales', 'intelligent-sales-email-auto-log', 'email-auto-log', 'system', ['crm.write'], 'not-activated', true],
        ['catalog-less', 'catalog-less-email-auto-log', 'email-auto-log', 'system', [], 'not-activated', false],
      ]);
      expect(body.warnings).toEqual([{ app: 'broken-app', error: 'authorization_app_not_registered' }]);
      expect(body.timers.map((t) => t.id)).toContain('schedule-runner');
      expect(body.timers.find((t) => t.id === 'schedule-runner')?.enabled).toBe(true);
      expect(typeof body.generatedAt).toBe('string');
    } finally { await app.close(); }
  });

  it('answers with warnings, not a failure, when the scheduler or the activation authority is not wired', async () => {
    const app = await serve(deps({ scheduler: () => null, activations: () => undefined }));
    try {
      const res = await app.get(OPERATOR);
      expect(res.status).toBe(200);
      const body = await res.json() as SwarmJobsView;
      expect(body.schedules).toEqual([]);
      expect(body.services).toEqual([]);
      expect(body.warnings).toEqual([{ app: 'scheduler', error: 'scheduler_unavailable' }, { app: 'activations', error: 'authorization_service_unavailable' }]);
      expect(body.timers.length).toBe(10);
    } finally { await app.close(); }
  });

  it('answers 500 jobs_unavailable when the scheduler listing itself throws', async () => {
    const app = await serve(deps({ scheduler: () => ({ listSchedules: async () => { throw new Error('redis down'); }, getManifestOverride: async () => null }) }));
    try {
      const res = await app.get(OPERATOR);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'jobs_unavailable' });
    } finally { await app.close(); }
  });

  it('the production deps read the process-lifetime holders: no activation authority before boot, and the composed one after', async () => {
    const d = defaultSwarmJobsDeps();
    expect(d.activations()).toBeUndefined();
    const calls: string[] = [];
    setApplicationServiceActivations({
      service: { listServices: async (_actor: AuthorizationActor, app: string) => { calls.push(app); return view(app, 'active', []); } } as unknown as ApplicationServiceActivationService,
      resolveActor: async () => ACTOR,
      describeApp: () => ({ source: 'manifest', catalogRevision: 'r1', catalog: null, mode: 'enforce' }),
      activeServiceApps: async () => ['composed-app'],
    });
    const composed = d.activations();
    expect(composed).toBeDefined();
    expect(await composed!.activeServiceApps()).toEqual(['composed-app']);
    expect((await composed!.listServices(ACTOR, 'composed-app')).services[0].state).toBe('active');
    expect(calls).toEqual(['composed-app']);
    expect(composed!.describeApp('composed-app')?.catalog).toBeNull();
    expect(d.env()).toBe(process.env);
  });

  it('is mounted behind requiresAuth and requiresOperator beside the households mount', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/admin/jobs', requiresAuth, requiresOperator, createSwarmJobsRoutes(defaultSwarmJobsDeps()));");
  });
});
