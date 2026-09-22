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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | GET / also reports the operator's HOT FALLBACK (2026-09-22): the configured chain (switch-row fallback_order, ADR-162 precedence, default openai-codex → claude-code), each rung's readiness from the token-free stored status (?refresh=1 probes on demand), whether the two gates admit THIS caller, and the exact PUT that changes the order. Same route, same shape the Settings AI-Providers card already reads — no second status endpoint.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The Google Gemini option, offered on exactly the conditions the resolver honours: the ADR-127 carve AND a pushed sign-in actually present at the mounted path. Availability is not derived from a Google API key on purpose - a key reaches generativelanguage on the free tier, the pushed login reaches cloudcode-pa through the CLI, and offering the option on the key would offer a choice the resolver falls straight back out of.
 *
 * @module llm-preference-routes
 */

import { Router, type Request, type Response } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { getUserLlmConnection } from './byo-llm-routes';
import { listFreeTierConnections } from './free-tier-rotation';
import { resolveHotFallbackChain, type HotFallbackChain } from './byo-hot-fallback';
import { fallbackReadinessSnapshot, refreshFallbackReadiness, type RungReadiness } from './fallback-rail-readiness';
import { geminiPushedLoginPresent } from '@/features/llm-provider';
import {
  LLM_PREFERENCE_IDS,
  cliBrainAvailable,
  getUserLlmPreference,
  saveUserLlmPreference,
  type LlmPreferenceId,
} from './user-brain-resolution';

const logger = createChildLogger({ module: 'llm-preference-routes' });

/** The hot-fallback block of the GET / payload: the chain, its rungs' readiness, and the gates. */
export interface HotFallbackStatus {
  /** Whether the fallback would run for THIS caller: demo deployment AND an operator subject. */
  gate: { demoMode: boolean; operator: boolean; available: boolean };
  chain: HotFallbackChain;
  rungs: RungReadiness[];
  /** When the stored readiness was last refreshed by the loop or on demand; null = never. */
  refreshedAt: number | null;
  /** How the operator changes the order — the endpoint that already exists. */
  setWith: { method: 'PUT'; path: string; body: { providerId: string; fallbackOrder: string[] } };
}

/**
 * @description The hot-fallback status for a caller. Readiness comes from the stored status the
 * loop keeps warm; `refresh` (or a never-probed store) probes now. No turn is spent either way.
 * @param sub - The caller's OIDC sub, for the gate verdict.
 * @param refresh - Probe every rung now instead of reading the stored verdicts.
 * @returns The block, never carrying a token.
 */
export async function describeHotFallback(sub: string, refresh: boolean): Promise<HotFallbackStatus> {
  const chain = resolveHotFallbackChain(null);
  const stored = fallbackReadinessSnapshot(chain.order);
  const rungs = refresh || stored.refreshedAt === null
    ? await refreshFallbackReadiness(chain.order)
    : stored.rungs;
  return {
    gate: { demoMode: demoModeEnabled(), operator: isDeploymentOperatorSub(sub), available: cliBrainAvailable(sub) },
    chain,
    rungs,
    refreshedAt: fallbackReadinessSnapshot(chain.order).refreshedAt,
    setWith: {
      method: 'PUT',
      path: '/api/agents/provider-switch/fleet-default',
      body: { providerId: '<the fleet primary, e.g. claude-code>', fallbackOrder: [...chain.order] },
    },
  };
}

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
  const cli = cliBrainAvailable(sub);
  // A pushed Google SIGN-IN, not a Google API key: the key runs on the free tier and reaches a
  // different endpoint entirely, so offering this option without one would offer a dead choice.
  const geminiPushed = geminiPushedLoginPresent();
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
      detail: cli
        ? 'Runs on the Claude Code subscription signed in on this machine.'
        : 'Available only to the operator of a deployment running in demo mode.',
      available: cli,
    },
    {
      id: 'openai-codex',
      label: 'OpenAI Codex (this machine\'s login)',
      detail: cli
        ? 'Runs on the Codex/ChatGPT login signed in on this machine.'
        : 'Available only to the operator of a deployment running in demo mode.',
      available: cli,
    },
    {
      id: 'gemini-cli',
      label: 'Google Gemini (this machine\'s login)',
      detail: cli
        ? (geminiPushed
          ? 'Runs on the Google sign-in pushed from the oshal client, through the Gemini CLI.'
          : 'Sign in to Google on the oshal client and push it here first — a Google API key alone runs on the free tier and cannot serve this option.')
        : 'Available only to the operator of a deployment running in demo mode.',
      available: cli && geminiPushed,
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

  /** GET / — the caller's current default, the options they may pick, and the hot-fallback status. */
  router.get('/', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const refresh = String(req.query.refresh ?? '') === '1';
    const [preference, options, hotFallback] = await Promise.all([
      getUserLlmPreference(ctx.pool, me.sub),
      buildOptions(ctx, me.sub),
      describeHotFallback(me.sub, refresh).catch((err) => {
        // The card must still render the preference when the fallback status cannot be read.
        logger.error({ err, sub: me.sub }, 'llm-preference: hot-fallback status failed');
        return null;
      }),
    ]);
    res.json({ preference, options, hotFallback });
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
