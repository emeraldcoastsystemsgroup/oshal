/**
 * LinkedIn Assistant Routes — the LinkedIn AI Content Assistant surface (the social north-star).
 *
 * The orchestrated flow, ADR-036 accountable-bot rails end to end:
 *  - DRAFT: the accountable **social-writer** bot (a0…0040) writes the post — cost lands in
 *    chat_tasks under its agent_id (executeBotOrInline, the sanctioned direct-sync path).
 *  - GRADE: the shared **quality-judge** concierge scores it against the LinkedIn rubric
 *    (JudgeService, @/features/quality-judge). Below SOCIAL_JUDGE_BAR → one refine pass.
 *  - APPROVE/PUBLISH: human-gated. Publish sends the EXACT approved text to the caller's
 *    LinkedIn via their broker token (no LLM in the path). No LinkedIn connection → a clean,
 *    logged, user-visible skip; the draft stays scheduled and NOTHING is faked.
 *
 * Mounted auth-gated: app.use('/api/linkedin-assistant', requiresAuth, createLinkedInAssistantRoutes(ctx, apiDir)).
 * Every read/write is scoped to the caller's OIDC sub — drafts are personal content, never
 * cross-user visible (not an operator governance surface).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial LinkedIn AI Content Assistant surface: GET /panel, POST /drafts (draft→judge→refine→pending-approval on the accountable bots), GET /drafts (+?state), GET /drafts/:id, POST /drafts/:id/approve (→scheduled+slot), /reject, /publish (confirm-gated, real LinkedIn publish with clean no-connection skip). Wires the linkedin-assistant service to social-writer (draft), quality-judge (grade), and the LinkedIn connector (publish).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review gap-list round2: publisher now resolves the author-id urn from the SAME personal∪shared connection row (resolveConnectionRow) the broker token comes from, instead of a caller-only `WHERE user_sub` query — a user on a household-shared LinkedIn grant now gets a consistent token + author id rather than a misleading "missing author id" skip.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Publish now runs through the CONNECTOR WRITE-ACTION EXECUTOR (runConnectorAction against the create-post action on swarm-apps/connectors/linkedin.yaml) instead of a bespoke fetch() to /v2/ugcPosts. Same brokered caller token, same clean no-connection skip, but the params are validated against the declared schema before any HTTP, the risky-write confirm gate is the shared one, and every attempt writes a connector_action_audit row (migration 083) — a public post on someone's behalf now leaves a trail. The confirm signal is passed because approval already happened upstream: the surface only reaches publish from an APPROVED draft.
 * ---------------------------------------------------------------------------
 * @module linkedin-assistant-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { JudgeService, QUALITY_JUDGE_AGENT_ID } from '@/features/quality-judge';
import {
  ContentDraftStore,
  LinkedInContentService,
  LINKEDIN_RUBRIC,
  type DraftGenerator,
  type DraftGenerationInput,
  type DraftPublisher,
  type Grader,
  type GradeResult,
  type PublishOutcome,
} from '@/features/linkedin-assistant';
import {
  loadConnectorSpec, resolveConnectorActionCreds, runConnectorAction,
  type ConnectorActionAuditPool, type ConnectorSpec,
} from '@/app/connectors/runtime';
import { getValidAccessToken } from './connectors-routes';
import { resolveConnectionRow } from './connector-tenancy';
import { executeBotOrInline } from './inline-bot-execution';
import { confirmationRequiredPayload, hasExplicitWriteConfirmation } from '@/shared/security/explicit-write-confirmation';

const logger = createChildLogger({ module: 'linkedin-assistant-routes' });

/** The accountable social-writer bot (inline concierge / own node) that drafts posts. */
const SOCIAL_WRITER_AGENT_ID = 'a0000000-0000-0000-0000-000000000040';
const botClient = new BotNodeClient(createRegistryEndpointResolver());

/** The brand rails every drafted post follows — accurate, hook-first, scannable, one CTA. */
const BEST_PRACTICES = [
  'Follow these rules:',
  '- HOOK: open with one scroll-stopping line — curiosity or a clear payoff. Never bait-and-switch.',
  '- ACCURATE: state ONLY what is supported. Never invent facts, metrics, quotes, or dates.',
  '- VOICE: confident, credible first-person builder voice — not hypey. 0-2 purposeful emoji max.',
  '- SCANNABLE: a hook, then 2-4 short paragraphs with white space. Not a wall of text.',
  '- CLOSE: end with a soft call-to-action or a genuine question that invites comments.',
  '- 1-3 relevant, specific hashtags at the very end.',
].join('\n');

/** The signed-in caller's OIDC sub, or null. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}

/** Serve a static HTML surface. */
function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) { logger.error({ err, file }, 'Failed to serve LinkedIn assistant surface'); res.status(404).send('Page not found'); }
    });
  };
}

/** Build the draft-generation prompt from the operator's request. */
function generatePrompt(input: DraftGenerationInput): string {
  return [
    `You are my personal-branding communications assistant. Write a ${input.tone || 'credible, professional builder-voice'} LinkedIn post about: ${input.topic}.`,
    input.goal ? `My goal for this post: ${input.goal}` : '',
    input.sourceUrl ? `Share and link this article — include this exact URL once in the post: ${input.sourceUrl}` : '',
    '',
    BEST_PRACTICES,
    'Output ONLY the post text — no preamble, no surrounding quotes, no "Here is".',
  ].filter(Boolean).join('\n');
}

/** Build the single refine prompt, aimed at the judge's critique + weakest dimensions. */
function refinePrompt(input: DraftGenerationInput, currentBody: string, grade: GradeResult): string {
  const weakest = Object.entries(grade.dimensions).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k, v]) => `${k} (${v})`).join('; ');
  return [
    'Revise the LinkedIn post below to raise its quality. An editor scored it and flagged:',
    grade.rationale ? `>> ${grade.rationale}` : '',
    weakest ? `Weakest areas to fix: ${weakest}.` : '',
    'Keep my voice and the core point. Do NOT invent facts, metrics, quotes, or stories.',
    input.sourceUrl ? `Keep the article link exactly once: ${input.sourceUrl}` : '',
    'Output ONLY the revised post text — no preamble, no explanation.',
    '',
    'CURRENT POST:',
    currentBody,
  ].filter(Boolean).join('\n');
}

/**
 * @description Build the draft generator bound to a caller — drafts run on the accountable
 * social-writer bot so cost is captured under its agent_id (ADR-036), never an LLM call from
 * controller code.
 * @param ctx - App context (orchestrator + pool).
 * @param sub - Caller OIDC sub (spend owner).
 * @returns A {@link DraftGenerator}.
 */
function buildGenerator(ctx: AppContext, sub: string): DraftGenerator {
  const run = async (kind: string, prompt: string): Promise<string> => {
    const result = await executeBotOrInline(ctx, botClient, SOCIAL_WRITER_AGENT_ID, {
      text: prompt, taskId: `linkedin-${kind}-${sub}-${Date.now()}`, workspaceFolderId: `linkedin-${sub}`,
      agentId: SOCIAL_WRITER_AGENT_ID, agenticMode: true, direct: true, userSub: sub,
    });
    return (result.response || '').trim();
  };
  return {
    generate: (input) => run('draft', generatePrompt(input)),
    refine: (input, body, grade) => run('refine', refinePrompt(input, body, grade)),
  };
}

/**
 * @description Build the grader bound to a caller — grading runs on the shared quality-judge
 * concierge (cost under the judge's agent_id); degrades to the deterministic lexical lane under
 * FORCE_LLM_PROVIDER=noop or an unavailable bot. Maps the verdict onto the feature's GradeResult
 * so this feature never imports the quality-judge slice.
 * @param ctx - App context.
 * @param sub - Caller OIDC sub.
 * @returns A {@link Grader}.
 */
function buildGrader(ctx: AppContext, sub: string): Grader {
  const judge = new JudgeService({
    invoker: async (taskId, prompt) => {
      const result = await ctx.orchestrator.processMessage(taskId, prompt, {
        agenticMode: true, autoApprove: false, source: 'quality-judge', agentId: QUALITY_JUDGE_AGENT_ID, userSub: sub,
      } as never);
      if (!result.success) throw new Error(result.error || 'judge brain execution failed');
      return String(result.response ?? '');
    },
  });
  return async ({ task, output, rubric }) => {
    const v = await judge.grade({ task, output, rubric: [...rubric] });
    return { score: v.score, dimensions: v.dimensions, rationale: v.rationale, mode: v.mode };
  };
}

/** The declarative LinkedIn connector, loaded once. A missing/broken spec must not be silent. */
let linkedinSpec: ConnectorSpec | null | undefined;
function linkedinConnectorSpec(): ConnectorSpec | null {
  if (linkedinSpec !== undefined) return linkedinSpec;
  try {
    linkedinSpec = loadConnectorSpec(path.join(process.cwd(), 'swarm-apps/connectors/linkedin.yaml'));
  } catch (err) {
    logger.error({ err, stack: err instanceof Error ? err.stack : undefined }, 'LinkedIn connector spec not loadable — publish cannot run through the write-action executor');
    linkedinSpec = null;
  }
  return linkedinSpec;
}

/**
 * @description Build the LinkedIn publisher bound to a caller — sends the EXACT approved text to the
 * caller's own LinkedIn through the connector WRITE-ACTION EXECUTOR (the `create-post` action on
 * swarm-apps/connectors/linkedin.yaml), not a bespoke fetch. The executor is the sanctioned home for
 * a write: params are validated against the declared schema before any HTTP happens, credentials
 * resolve lazily from the broker (the caller's own connection, never an operator key), and every
 * attempt lands in `connector_action_audit` — so a public post made on someone's behalf is
 * reviewable. No LLM in the path.
 *
 * `confirm: true` is passed deliberately: the human gate is UPSTREAM — publish is only reachable from
 * a draft the person already approved, and the route itself is confirm-gated. Re-prompting here would
 * ask the same human the same question twice.
 *
 * A missing connection (or missing author id) still returns a clean SKIP the surface shows as
 * "connect LinkedIn to publish" — never a faked success.
 * Exported for its guard (tests/unit/connectors/connector-write-actions.spec.ts): the fail-closed
 * audit property can only be proven by driving the real publisher.
 * @param ctx - App context (pool for the broker + the audit trail).
 * @returns A {@link DraftPublisher}.
 */
export function buildPublisher(ctx: AppContext): DraftPublisher {
  return async (sub, text): Promise<PublishOutcome> => {
    const spec = linkedinConnectorSpec();
    if (!spec) {
      return { ok: false, code: 502, message: 'LinkedIn connector definition is unavailable — publish is disabled until it loads.' };
    }
    // Resolve the caller's LinkedIn connection with the SAME personal∪shared (household) scoping the
    // token uses, and take the author id (urn) from THAT row — otherwise a user whose only LinkedIn
    // grant is household-shared gets a token but no author id and a misleading skip.
    const conn = await resolveConnectionRow(ctx.pool, sub, 'linkedin');
    if (!conn) {
      return { ok: false, skipped: true, code: 409, message: 'Connect LinkedIn at /utilities to publish. Your draft stays scheduled.' };
    }
    if (!conn.account_id) {
      return { ok: false, skipped: true, code: 409, message: 'Reconnect LinkedIn at /utilities (missing author id). Your draft stays scheduled.' };
    }
    const params = {
      author: `urn:li:person:${conn.account_id}`,
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text }, shareMediaCategory: 'NONE' } },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    };
    const result = await runConnectorAction({
      pool: ctx.pool as unknown as ConnectorActionAuditPool,
      spec,
      resolveCreds: () => resolveConnectorActionCreds(spec, ctx.pool, sub, getValidAccessToken),
      userSub: sub,
      actionName: 'create-post',
      params,
      requestBody: { confirm: true },
    });
    const body = result.body as { ok?: boolean; code?: string; error?: string; data?: { id?: string } };
    if (result.status === 200 && body.ok) {
      return { ok: true, postId: body.data?.id ?? null };
    }
    // The executor's own not-connected outcome maps to the SAME clean skip, so the two paths that can
    // discover a missing credential (row lookup above, broker resolution inside) behave identically.
    if (body.code === 'not_connected') {
      return { ok: false, skipped: true, code: 409, message: 'Connect LinkedIn at /utilities to publish. Your draft stays scheduled.' };
    }
    return { ok: false, code: result.status >= 400 ? result.status : 502, message: body.error || 'LinkedIn rejected the post.' };
  };
}

/** Parse + validate the create-draft body. */
function parseCreateBody(body: unknown): { input?: DraftGenerationInput; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
  if (!topic) return { error: 'topic (non-empty string) is required' };
  return {
    input: {
      topic,
      goal: typeof b.goal === 'string' && b.goal.trim() ? b.goal.trim() : undefined,
      tone: typeof b.tone === 'string' && b.tone.trim() ? b.tone.trim() : undefined,
      sourceUrl: typeof b.sourceUrl === 'string' && b.sourceUrl.trim() ? b.sourceUrl.trim() : undefined,
    },
  };
}

/** Map a service error to an HTTP status (illegal transition → 409, else 502). */
function statusForError(err: unknown): number {
  return (err as { code?: string })?.code === 'illegal_transition' ? 409 : 502;
}

/**
 * @description Build the auth-gated LinkedIn assistant router. Mount:
 * `app.use('/api/linkedin-assistant', requiresAuth, createLinkedInAssistantRoutes(ctx, apiDir))`.
 * @param ctx - App context (orchestrator + Postgres pool).
 * @param apiDir - Directory holding the HTML surfaces.
 * @returns The Express router.
 */
export function createLinkedInAssistantRoutes(ctx: AppContext, apiDir: string): Router {
  const router = Router();
  const store = new ContentDraftStore(ctx.pool);
  store.ensureSchema().catch((err) => logger.error({ err }, 'linkedin-assistant schema bootstrap failed'));
  const publisher = buildPublisher(ctx);

  const serviceFor = (sub: string): LinkedInContentService =>
    new LinkedInContentService({ store, generator: buildGenerator(ctx, sub), grader: buildGrader(ctx, sub), publisher });

  router.get('/panel', servePage(apiDir, 'linkedin-assistant.html'));

  /** POST /drafts — run the orchestrated flow and return the pending-approval draft + score. */
  router.post('/drafts', async (req: Request, res: Response) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const { input, error } = parseCreateBody(req.body);
    if (error || !input) { res.status(400).json({ error: error || 'invalid body' }); return; }
    try {
      const svc = serviceFor(sub);
      const draft = await svc.createDraft(sub, input);
      res.json({ draft, bar: svc.judgeBar, rubric: LINKEDIN_RUBRIC });
    } catch (err) {
      logger.error({ err, stack: (err as Error)?.stack, sub }, 'create draft failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /drafts — the caller's drafts (newest first); optional ?state= filter. */
  router.get('/drafts', async (req: Request, res: Response) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const state = typeof req.query.state === 'string' ? (req.query.state as never) : undefined;
      res.json({ drafts: await store.listByUser(sub, state) });
    } catch (err) {
      logger.error({ err, sub }, 'list drafts failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /drafts/:id — one draft (scoped to the caller). */
  router.get('/drafts/:id', async (req: Request, res: Response) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const draft = await store.getById(sub, id);
      if (!draft) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ draft });
    } catch (err) {
      logger.error({ err, sub, id }, 'get draft failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /drafts/:id/approve — flip pending-approval → scheduled with a real slot. */
  router.post('/drafts/:id/approve', async (req: Request, res: Response) => {
    await mutate(req, res, (svc, sub, id) => svc.approve(sub, id));
  });

  /** POST /drafts/:id/reject — reject a draft (terminal). */
  router.post('/drafts/:id/reject', async (req: Request, res: Response) => {
    await mutate(req, res, (svc, sub, id) => svc.reject(sub, id));
  });

  /** POST /drafts/:id/publish — publish an approved (scheduled) draft now. Confirm-gated. */
  router.post('/drafts/:id/publish', async (req: Request, res: Response) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    if (!hasExplicitWriteConfirmation(req.body)) { res.status(428).json(confirmationRequiredPayload('no-post', 'Publishing a LinkedIn post')); return; }
    try {
      const result = await serviceFor(sub).publishNow(sub, id);
      if (!result) { res.status(404).json({ error: 'not_found' }); return; }
      const { outcome, draft } = result;
      res.status(outcome.ok ? 200 : (outcome.code ?? 502)).json({ ...outcome, draft });
    } catch (err) {
      logger.error({ err, sub, id }, 'publish failed');
      res.status(statusForError(err)).json({ error: (err as Error).message });
    }
  });

  /**
   * @description Shared handler for approve/reject: resolve the caller + id, run the mutation,
   * and map not-found → 404 and an illegal transition → 409.
   * @param req - Express request.
   * @param res - Express response.
   * @param op - The service mutation to run.
   */
  async function mutate(
    req: Request,
    res: Response,
    op: (svc: LinkedInContentService, sub: string, id: number) => Promise<unknown>,
  ): Promise<void> {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const draft = await op(serviceFor(sub), sub, id);
      if (!draft) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ draft });
    } catch (err) {
      logger.error({ err, sub, id }, 'draft mutation failed');
      res.status(statusForError(err)).json({ error: (err as Error).message });
    }
  }

  return router;
}
