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
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — runner + per-tool smoke tests +
 *            | two coupled scenarios (job-pack->deck->save->email; birthday+gift) + a Jarvis-routing
 *            | pass. Surface served at /api/test-lab/app.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the registry to
 *            | test-lab-scenarios.ts; added the deterministic rich-visual endpoint (GET
 *            | /visual/:kind.svg) that renders catalog visual kinds through the real renderer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected Test Lab visual
 *            | documentation from the original eight-kind baseline to the current 15-kind catalog.
 * ---------------------------------------------------------------------------
 * @module test-lab-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { SCENARIOS, rollup, type StepResult } from './test-lab-scenarios';
import { renderCatalogVisual } from './test-lab-visual-catalog';

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
export function createTestLabRoutes(_ctx: AppContext): Router {
  const router = Router();

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
    res.json({
      scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group, description: s.description, steps: s.steps.map((st) => ({ id: st.id, app: st.app, label: st.label })) })),
      apps,
    });
  }));

  /** Run one scenario (or ?id=all) and return per-step results. */
  router.post('/run', tester(async (req, res) => {
    const cookie = req.headers.cookie || '';
    const id = String(req.body?.scenarioId || req.query.id || 'all');
    const toRun = id === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.id === id);
    if (!toRun.length) { res.status(404).json({ error: `unknown scenario: ${id}` }); return; }

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
    res.json({ ran: results.length, results });
  }));

  return router;
}
