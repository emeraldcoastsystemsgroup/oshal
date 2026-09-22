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
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The two Google CLI options (gemini-cli, antigravity-cli), and every CLI option's availability moved onto cliBrainOffer - the same function the resolver calls, so what is OFFERED and what RESOLVES cannot drift. The first cut of this entry gated Gemini on the carve AND a pushed sign-in, and called that "exactly the conditions the resolver honours"; it was not. Nothing executes a gemini-cli dispatch (botNodeRuntime: null, and it is not a ProviderRegistry id), so pushing a login made the option selectable, PUT accepted it because PUT admits any option whose availability is true, and every turn afterwards was refused by name at the node. Availability is now the executability question for all four, and each unavailable option carries the piece that is missing rather than one generic sentence.
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
import {
  LLM_PREFERENCE_IDS,
  cliBrainAvailable,
  cliBrainOffer,
  getUserLlmPreference,
  saveUserLlmPreference,
  type CliBrainOffer,
  type CliBrainProviderId,
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
  // One question per CLI harness, asked of the SAME function the resolver asks, so an option can
  // never be offered that resolution would not produce. See cliBrainOffer for why that mattered.
  const offer = (id: CliBrainProviderId): CliBrainOffer => cliBrainOffer(id, sub);
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
    cliOption('claude-code', 'Claude Code (signed in on this machine)',
      'Runs on the Claude Code subscription signed in on this machine.', offer('claude-code')),
    cliOption('openai-codex', 'OpenAI Codex (signed in on this machine)',
      'Runs on the Codex/ChatGPT login signed in on this machine.', offer('openai-codex')),
    // Reached only when the option is actually available, which on this deployment it is not:
    // cliBrainOffer supplies the sentence naming what is missing. The copy that used to sit here
    // asserted it "Runs ... through the Gemini CLI" the moment a login was pushed, and that was
    // never true - no bot node resolves gemini-cli, so the turn was refused by name, not run.
    cliOption('gemini-cli', 'Google Gemini (Gemini CLI)',
      'Runs the adopted Google sign-in through the Gemini CLI harness.', offer('gemini-cli')),
    cliOption('antigravity-cli', 'Google Antigravity (signed in on this machine)',
      'Runs on the Google identity signed in to Antigravity on this machine.', offer('antigravity-cli')),
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
 * @description One CLI-harness option, worded by its offer.
 *
 * An UNAVAILABLE option shows the piece that is missing rather than one generic sentence, because
 * the four causes call for four different actions: a caller outside the carve can do nothing, a
 * missing node runtime is a platform gap, an unloadable binary is a machine problem, and an absent
 * credential is a sign-in. Collapsing them into "not available to you yet" is what let an operator
 * believe that pushing a login had fixed something it had not.
 * @param id - The preference id, which is also the harness id
 * @param label - Display label
 * @param availableDetail - What to say when it can actually be chosen
 * @param offer - The verdict from cliBrainOffer
 * @returns The option as the surface renders it
 */
function cliOption(
  id: CliBrainProviderId, label: string, availableDetail: string, offer: CliBrainOffer,
): BrainOption {
  return { id, label, detail: offer.available ? availableDetail : offer.detail, available: offer.available };
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
    // The SAME availability the options list reports, which is the same question the resolver
    // asks — so an id this route accepts is one a turn can actually run on. `detail` is carried
    // because the four ways a CLI brain can be unavailable need four different responses from
    // the person, and "not available to you yet" told them none of it.
    const chosen = options.find((o) => o.id === preferred);
    if (!chosen?.available) {
      logger.warn({ sub: me.sub, preferred, detail: chosen?.detail ?? null }, 'llm-preference: refused an unavailable provider');
      res.status(409).json({
        error: 'that provider is not available to you yet',
        detail: chosen?.detail ?? 'That provider is not one this deployment offers.',
        options,
      });
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
