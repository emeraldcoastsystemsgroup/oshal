/**
 * Jarvis morning brief — ROUTES (view layer over jarvis-brief-sections).
 *
 * GET /api/jarvis/brief       → structured JSON {generatedAt, sections[]}
 * GET /api/jarvis/brief.html  → the same brief rendered as a self-contained HTML page
 *
 * Mounted at '/api/jarvis' AHEAD of the general Jarvis router (same precedence trick the
 * ambient routes use): only these two paths are claimed, everything else falls through
 * untouched, so the main router's serviceSecretOr auth semantics are unchanged. Auth is
 * per-route requiresAuth (sanctioned factory-param pattern) — the brief reads per-user
 * connections and stores, so it must never be anonymous-callable. This module also boots
 * the optional morning-delivery cron (opt-in per user; env-gated per deployment), the
 * same colocation career-hunter-routes uses for its cron.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial /api/jarvis/brief (JSON) + /api/jarvis/brief.html (rendered) routes over the guarded section composer; per-route requiresAuth; starts the opt-in morning-delivery cron.
 *
 * @module jarvis-brief-routes
 */
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import {
  composeMorningBrief, defaultBriefDeps,
  type BriefDeps, type MorningBrief, type BriefSection,
} from './jarvis-brief-sections';
import { startJarvisBriefCron } from './jarvis-brief-cron';

const logger = createChildLogger({ module: 'jarvis-brief-routes' });

/**
 * @description Escape a string for safe HTML interpolation. The brief embeds external
 * headline text (outlet-supplied titles) and user store content, so every interpolated
 * value must be neutralized to close the stored-XSS path in the rendered brief page.
 * @param s - The raw string to escape.
 * @returns The string with &, <, >, ", ' replaced by their HTML entities.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render one section as an HTML card — populated sections get their summary, skips their reason. */
function sectionHtml(s: BriefSection): string {
  const body = s.skipped
    ? `<p class="skip">${escapeHtml(s.reason)}</p>`
    : `<p>${escapeHtml(s.summary)}</p>`;
  return `<section class="card${s.skipped ? ' skipped' : ''}">\n<h2>${escapeHtml(s.title)}</h2>\n${body}\n</section>`;
}

/**
 * @description Render the composed brief as a single self-contained HTML page (inline CSS,
 * no external assets — viewable from any browser tab or an email web-view). Skipped
 * sections stay visible but muted, so the user always sees WHY a section is empty
 * instead of wondering whether the brief is broken.
 * @param brief - The composed morning brief.
 * @returns A complete HTML document string.
 */
export function renderBriefHtml(brief: MorningBrief): string {
  const day = brief.generatedAt.slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Morning brief — ${escapeHtml(day)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #f5f6f8; color: #1c2330; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .stamp { color: #5a6472; font-size: 0.85rem; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e2e6ec; border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
  .card h2 { font-size: 1.05rem; margin: 0 0 8px; }
  .card p { margin: 0; line-height: 1.5; }
  .card.skipped { opacity: 0.65; }
  .card.skipped .skip { font-style: italic; color: #5a6472; }
  @media (prefers-color-scheme: dark) {
    body { background: #12161d; color: #e6eaf0; }
    .card { background: #1a2029; border-color: #2a3240; }
    .stamp, .card.skipped .skip { color: #93a0b0; }
  }
</style>
</head>
<body>
<main>
<h1>Your morning brief</h1>
<div class="stamp">Generated ${escapeHtml(brief.generatedAt.replace('T', ' ').slice(0, 16))} UTC</div>
${brief.sections.map(sectionHtml).join('\n')}
</main>
</body>
</html>`;
}

/**
 * @description Build the Jarvis morning-brief router. Mount at '/api/jarvis' BEFORE the
 * general Jarvis router — this router claims only GET /brief and GET /brief.html (each
 * behind requiresAuth) and lets every other path fall through, so the main Jarvis
 * router's own auth middleware still governs its routes. Also starts the opt-in
 * morning-delivery cron once (env-gated inside).
 * @param requiresAuth - The app-level OIDC auth middleware (sanctioned param pattern).
 * @param ctx - App context (Postgres pool for section readers + the delivery cursor).
 * @param depsOverride - Injectable section readers for tests; production omits it.
 * @returns The Express router.
 */
export function createJarvisBriefRoutes(
  requiresAuth: RequestHandler, ctx: AppContext, depsOverride?: BriefDeps,
): Router {
  const router = Router();
  const deps: BriefDeps = depsOverride ?? defaultBriefDeps(ctx);
  startJarvisBriefCron(ctx);

  router.get('/brief', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const brief = await composeMorningBrief(deps, sub, email);
      logger.info({ sub, sections: brief.sections.length, skipped: brief.sections.filter((s) => s.skipped).length, durationMs: Date.now() - startedAt }, 'GET /api/jarvis/brief');
      res.json(brief);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub }, 'GET /api/jarvis/brief failed');
      res.status(500).json({ error: 'brief composition failed' });
    }
  });

  router.get('/brief.html', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).send('unauthorized'); return; }
    try {
      const brief = await composeMorningBrief(deps, sub, email);
      logger.info({ sub, durationMs: Date.now() - startedAt }, 'GET /api/jarvis/brief.html');
      res.type('html').send(renderBriefHtml(brief));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub }, 'GET /api/jarvis/brief.html failed');
      res.status(500).send('brief composition failed');
    }
  });

  return router;
}
