/**
 * Default-brain settings (ADR-127) — which connected provider runs a user's work.
 *
 * The Bot LLM access block on /utilities already CONNECTS things (Claude Code, Codex, free tiers,
 * a bring-your-own endpoint). What it could not do is say which of them is *mine by default*, so
 * resolution was an invisible ladder the user could neither read nor change. These routes are that
 * missing control: read the current choice plus what this caller may actually pick, and set it.
 *
 * A preference is not an authorization. Saving `claude-code` does not grant the CLI carve — the
 * options list only offers what the caller can already use, and resolution re-checks at run time,
 * degrading to the next rung rather than failing the turn.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: GET /options + GET|PUT the caller's default brain, auth-gated and owner-scoped.
 * 2 | Codex                                      | Resolve CLI availability per provider so OSHAL_DEMO_CLI_SUBS users see/save Codex only; operator-only Claude remains unavailable to them in both GET and PUT.
 *
 * @module llm-preference-routes
 */

import { Router, type Request, type Response } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { getUserLlmConnection } from './byo-llm-routes';
import { listFreeTierConnections } from './free-tier-rotation';
import {
  LLM_PREFERENCE_IDS,
  cliBrainAvailable,
  getUserLlmPreference,
  saveUserLlmPreference,
  type LlmPreferenceId,
} from './user-brain-resolution';

const logger = createChildLogger({ module: 'llm-preference-routes' });

/** Authenticated caller, or null. Mirrors the helper the sibling connector routes use. */
function caller(req: Request): { sub: string } | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const sub = (oidc.user || {}).sub || (oidc.user || {}).oid;
  return sub ? { sub: String(sub) } : null;
}

/** One selectable brain: what it is, whether this caller can pick it, and why not when they can't. */
interface BrainOption {
  id: LlmPreferenceId;
  label: string;
  detail: string;
  available: boolean;
}

/**
 * @description The options this caller may choose from, with availability resolved live so the
 * surface never offers a provider the resolver would refuse.
 * @param ctx - app context @param sub - caller's OIDC sub
 * @returns the ordered option list
 */
async function buildOptions(ctx: AppContext, sub: string): Promise<BrainOption[]> {
  const claudeCli = cliBrainAvailable(sub, 'claude-code');
  const codexCli = cliBrainAvailable(sub, 'openai-codex');
  const [byo, freeLanes] = await Promise.all([
    getUserLlmConnection(ctx.pool, sub).catch(() => null),
    listFreeTierConnections(ctx.pool, sub).catch(() => []),
  ]);
  const usableFree = freeLanes.filter((lane) => !lane.cooledDown).length;
  return [
    {
      id: 'auto',
      label: 'Automatic',
      detail: 'Use the best available: your own key first, then whatever this deployment offers.',
      available: true,
    },
    {
      id: 'claude-code',
      label: 'Claude Code (this machine\'s login)',
      detail: claudeCli
        ? 'Runs on the Claude Code subscription signed in on this machine.'
        : 'Available only to the operator of a deployment running in demo mode.',
      available: claudeCli,
    },
    {
      id: 'openai-codex',
      label: 'OpenAI Codex (this machine\'s login)',
      detail: codexCli
        ? 'Runs on the Codex/ChatGPT login signed in on this machine.'
        : 'Available only to an approved user of a deployment running in demo mode.',
      available: codexCli,
    },
    {
      id: 'any-llm',
      label: 'My own endpoint',
      detail: byo
        ? `Your saved endpoint (${byo.model}).`
        : 'Connect an OpenAI-compatible endpoint and key on this page first.',
      available: Boolean(byo),
    },
    {
      id: 'free-tier',
      label: 'My free tiers',
      detail: usableFree
        ? `Rotates across ${usableFree} connected free lane${usableFree === 1 ? '' : 's'}.`
        : 'Connect at least one free provider on this page first.',
      available: usableFree > 0,
    },
  ];
}

/**
 * @description Routes for reading and setting the caller's default brain. Mount auth-gated:
 * every handler is owner-scoped to the authenticated sub and never accepts a subject parameter.
 * @param ctx - app context
 * @returns the router
 */
export function createLlmPreferenceRoutes(ctx: AppContext): Router {
  const router = Router();

  /** GET / — the caller's current default plus the options they may pick. */
  router.get('/', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const [preference, options] = await Promise.all([
      getUserLlmPreference(ctx.pool, me.sub),
      buildOptions(ctx, me.sub),
    ]);
    res.json({ preference, options });
  });

  /** PUT / — set the caller's default. Rejects an unknown id and an option they cannot use. */
  router.put('/', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const preferred = String(req.body?.preferred || '').trim() as LlmPreferenceId;
    if (!LLM_PREFERENCE_IDS.includes(preferred)) {
      res.status(400).json({ error: `preferred must be one of: ${LLM_PREFERENCE_IDS.join(', ')}` });
      return;
    }
    const options = await buildOptions(ctx, me.sub);
    if (!options.find((o) => o.id === preferred)?.available) {
      res.status(409).json({ error: 'that provider is not available to you yet', options });
      return;
    }
    try {
      const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
      const preference = await saveUserLlmPreference(ctx.pool, me.sub, preferred, model);
      res.json({ preference, options });
    } catch (err) {
      logger.error({ err, sub: me.sub, preferred }, 'llm-preference: save failed');
      res.status(500).json({ error: 'could not save your default provider' });
    }
  });

  return router;
}
