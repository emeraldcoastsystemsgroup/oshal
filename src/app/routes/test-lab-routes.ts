/**
 * AI Test Lab — black-box end-to-end scenario runner across the app swarm (ADR-063).
 *
 * Drives the REAL app endpoints over loopback with the caller's session cookie forwarded, so every
 * step runs exactly as the signed-in user would (same auth + per-user scoping; nothing mocked by the
 * lab). The scenario registry + step runners live in `test-lab-scenarios.ts`; this module is the thin
 * HTTP surface: the catalog, the runner, the app page, and the on-demand rich-visual image endpoint.
 *
 * Result states are honest: pass | degraded (alive but needs a connection / fell back / async) |
 * gap (no capability exists) | fail (error). Surfacing degraded/gap is the point as much as green.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Mount exact-owner local catalog schedule controls beside durable package runs.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Mount asynchronous package execution and durable exact-caller history beside legacy scenarios.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Include caller-visible installed package smokes and version/prerequisite metadata; reuse the installation verifier with operator/caller-scoped authentication.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Register artifact scenarios and expose categorized regression suites in the existing Lab catalog.
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — runner + per-tool smoke tests +
 *            | two coupled scenarios (job-pack->deck->save->email; birthday+gift) + a Jarvis-routing
 *            | pass. Surface served at /api/test-lab/app.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the registry to
 *            | test-lab-scenarios.ts; added the deterministic rich-visual endpoint (GET
 *            | /visual/:kind.svg) that renders catalog visual kinds through the real renderer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected Test Lab visual
 *            | documentation from the original eight-kind baseline to the current 15-kind catalog.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Obtain request-bound caller transport only for declared service smokes, keeping session data out of Node execution and public catalog results.
 * ---------------------------------------------------------------------------
 * @module test-lab-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { SCENARIOS, rollup, type StepResult } from './test-lab-scenarios';
import { renderCatalogVisual } from './test-lab-visual-catalog';
import type { InstalledAppTestCatalog, InstalledTestAuth, InstalledAppTestCase, AppSmokeVerificationOptions } from '@/features/swarm-apps';
import { createTestLabRunRoutes, type TestLabRunRouteOptions } from './test-lab-run-routes';
import { createTestLabScheduleRoutes, type TestLabScheduleRouteOptions } from './test-lab-schedule-routes';

const logger = createChildLogger({ module: 'test-lab-routes' });
const TOOLS_DIR = 'any-bot/server/services/tools/test-lab';

function serveFile(fileName: string): RequestHandler {
  return (_req: Request, res: Response) => {
    const filePath = path.resolve(process.cwd(), TOOLS_DIR, fileName);
    res.sendFile(filePath, (err: unknown) => {
      if (err) { logger.error({ err, fileName }, `Failed to serve ${fileName}`); res.status(404).send(`Page not found: ${fileName}`); }
    });
  };
}

function resolveViewerSub(req: Request): string {
  const oidc = (req as any).oidc;
  if (oidc && typeof oidc.isAuthenticated === 'function' && oidc.isAuthenticated()) {
    const u = oidc.user || {};
    const sub = u.sub || u.oid;
    if (sub) return String(sub);
  }
  if (process.env.MOCK_OIDC === 'true') return 'demo-tester';
  throw Object.assign(new Error('Not authenticated'), { status: 401 });
}

// ── Router ─────────────────────────────────────────────────────────────────────
export interface TestLabRouteOptions extends TestLabRunRouteOptions, TestLabScheduleRouteOptions {
  installedTests?: InstalledAppTestCatalog;
  /** Current app visibility and access policy, evaluated again before every package test. */
  visibleApps?: (req: Request) => Promise<Map<string, string>>;
  /** Server-owned authority only: service credentials may be supplied only for operators. */
  executionAuth?: (req: Request) => InstalledTestAuth;
  /** Request-bound operator transport; raw session bytes never enter run auth or metadata. */
  serviceSmokeFetch?: (req: Request, test: InstalledAppTestCase) => Promise<AppSmokeVerificationOptions['serviceSmokeFetch']>;
  /** Test fixture seam; production is fixed loopback, never supplied by the HTTP caller. */
  apiBaseUrl?: string;
}

/** @description Present installed smokes through the existing Lab scenario/card contract. */
function installedScenario(test: InstalledAppTestCase) {
  return {
    id: test.id, title: `${test.appName}: ${test.name}`, group: 'tool',
    description: test.purpose,
    installedTest: test,
    regressionTests: test.runner.kind === 'smoke' ? [{ level: 'integration', path: 'tests/unit/installed-app-test-lab.spec.ts' }]
      : test.runner.files.map(file => ({ level: test.level,
        path: test.runner.kind !== 'smoke' && test.runner.scope === 'core' ? `core@${test.runner.revision}:${file}` : `package:${file}` })),
    steps: [{ id: test.id, app: test.appName, label: test.name }],
  };
}

export function createTestLabRoutes(_ctx: AppContext, options: TestLabRouteOptions = {}): Router {
  const router = Router();
  router.use(createTestLabRunRoutes(options));
  router.use(createTestLabScheduleRoutes(options));
  const visibleApps = (req: Request) => options.visibleApps?.(req) ?? Promise.resolve(new Map<string, string>());
  const executionAuth = (req: Request) => options.executionAuth?.(req) ?? {};

  const tester =
    (fn: (req: Request, res: Response, sub: string) => Promise<void>): RequestHandler =>
    async (req, res) => {
      let sub: string;
      try { sub = resolveViewerSub(req); }
      catch (e: any) { res.status(e.status || 401).json({ error: e.message }); return; }
      try { await fn(req, res, sub); }
      catch (err: any) { logger.error({ err, path: req.path }, 'test-lab route error'); res.status(500).json({ error: err.message || 'internal error' }); }
    };

  router.get('/app', serveFile('test-lab-app.html'));

  /**
   * The deterministic rich-visual proof: render one of the 15 visual kinds through the REAL renderer
   * and serve it as an SVG the surface can display. Same origin + `requiresAuth` on the mount, so the
   * lab's own images are owner-agnostic sample facts (never a real deliverable).
   */
  router.get('/visual/:kind', tester(async (req, res) => {
    const kind = String(req.params.kind || '').replace(/\.svg$/i, '');
    let rendered;
    try { rendered = renderCatalogVisual(kind); }
    catch (err: any) { logger.error({ err, kind }, 'visual render failed'); res.status(500).json({ error: `render failed for ${kind}` }); return; }
    if (!rendered) { res.status(404).json({ error: `unknown visual kind: ${kind}` }); return; }
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="test-lab-${kind}.svg"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    res.send(rendered.content);
  }));

  /** The catalog: scenarios (with their steps) + the live app roster for "all tools" context. */
  router.get('/catalog', tester(async (req, res) => {
    const cookie = req.headers.cookie || '';
    let apps: any[] = [];
    try { const r = await fetch(`http://localhost:${process.env.PORT || '5000'}/api/swarm/apps?status=active`, { headers: cookie ? { cookie } : {} }); const j: any = await r.json().catch(() => ({})); apps = (j?.apps || []).map((a: any) => ({ name: a.name, displayName: a.displayName, botCount: a.botCount, toolCount: a.toolCount })); } catch { /* best effort */ }
    const visible = await visibleApps(req);
    const installed = options.installedTests?.list(visible, executionAuth(req)) ?? [];
    res.json({
      scenarios: [...SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group, description: s.description, regressionTests: s.regressionTests || [], steps: s.steps.map((st) => ({ id: st.id, app: st.app, label: st.label })) })), ...installed.map(installedScenario)],
      installedApps: options.installedTests?.apps(visible) ?? [],
      apps,
    });
  }));

  /** Run one scenario (or ?id=all) and return per-step results. */
  router.post('/run', tester(async (req, res) => {
    const cookie = req.headers.cookie || '';
    const id = String(req.body?.scenarioId || req.query.id || 'all');
    const expectedCases = req.body?.expectedCases;
    if (expectedCases !== undefined && (!expectedCases || typeof expectedCases !== 'object' || Array.isArray(expectedCases)
      || Object.values(expectedCases).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
      res.status(400).json({ error: 'expectedCases must map installed case IDs to their catalog revisions.' }); return;
    }
    const toRun = id === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.id === id);
    const installed = (options.installedTests?.list(await visibleApps(req), executionAuth(req)) ?? [])
      .filter(test => id === 'all' || test.id === id);
    if (id !== 'all' && installed.some(test => test.runner.kind !== 'smoke' && test.runnable)) {
      res.status(409).json({ error: 'Use the package Run control to create a cancellable run with history.' }); return;
    }
    if (!toRun.length && !installed.length) { res.status(404).json({ error: `unknown scenario: ${id}` }); return; }

    const results = [];
    for (const sc of toRun) {
      const prior: Record<string, any> = {};
      const stepResults: StepResult[] = [];
      for (const st of sc.steps) {
        let r: StepResult;
        try { r = await st.run(cookie, prior); }
        catch (e: any) { r = { app: st.app, label: st.label, state: 'fail', detail: `step threw: ${e?.message || e}` }; }
        if (r.output !== undefined) prior[st.id] = r.output;
        stepResults.push(r);
      }
      results.push({ id: sc.id, title: sc.title, group: sc.group, description: sc.description, state: rollup(stepResults.map((s) => s.state)), steps: stepResults });
    }
    for (const test of installed) {
      if (test.runner.kind !== 'smoke' && test.runnable) continue;
      const selected = expectedCases === undefined ? test : { ...test,
        revision: Object.prototype.hasOwnProperty.call(expectedCases, test.id) ? expectedCases[test.id] : '' };
      const result = await options.installedTests!.run(selected, await visibleApps(req), {
        apiBaseUrl: options.apiBaseUrl ?? `http://127.0.0.1:${process.env.PORT || '5000'}`,
        ...executionAuth(req),
        ...(test.runner.kind === 'smoke' && test.auth === 'service'
          ? { serviceSmokeFetch: await options.serviceSmokeFetch?.(req, test) } : {}),
      });
      const state = result.status === 'passed' ? 'pass' : result.status === 'failed' ? 'fail' : 'degraded';
      results.push({ ...installedScenario(test), state, steps: [{
        app: test.appName, label: test.name, state, status: result.httpStatus,
        detail: result.status === 'pending' ? `Pending: ${result.error}` : result.error ?? `Verified ${test.method} ${test.path}`,
        output: { executionStatus: result.status, appVersion: test.appVersion, source: test.source, revision: test.revision,
          runner: test.runner.kind, durationMs: result.durationMs },
      }] });
    }
    res.json({ ran: results.length, results });
  }));

  return router;
}
