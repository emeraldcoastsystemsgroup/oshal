/**
 * Jarvis build hand-off — the tool-less decision that hands a build to the swarm.
 *
 * Until now the ONLY decision Jarvis made about "build me X" was an agentic bot turn raced against
 * DECISION_TIMEOUT_MS (75 s). The persona is model judgment, not a guarantee, so on a build request
 * the codex agent would ignore the hand-off rule and grind the whole build inline — 8.6 minutes and
 * 1.87M tokens were measured on 2026-06-20 — while the route, having lost the race, filed the SAME
 * request with the swarm. Two builds of one ask, and the user waited 75 seconds for the ack.
 *
 * This module is the replacement decision: no model, no tools, no provider call. A message that is
 * unmistakably an imperative build directive is recognised here and filed with the swarm before the
 * agentic turn is ever started, so:
 *  - the acknowledgement is immediate (no provider round trip at all),
 *  - exactly one execution happens — the swarm's,
 *  - and there is no abandoned turn left grinding server-side, because none was started.
 *
 * Precision over recall, deliberately. The detector fires only on an imperative whose FIRST word
 * (after a courtesy wrapper) is a build verb: everything else keeps the existing model turn. That is
 * the lesson of the decision-timeout filing bug — "Hi", "what is 9 times 9" and "what screen am i
 * on" all became escalated build tickets once a heuristic was allowed to be generous. A request this
 * module declines is not dropped; it simply takes the path it took before.
 *
 * Exactly-once is enforced here rather than at the call site, because BOTH the fast path and the
 * decision-timeout fallback file through {@link fileBuildHandoff}: a resent message (a double tap, a
 * reload that replays the send) reuses the first claim instead of opening a second ticket and
 * starting a second swarm build.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: detectBuildRequest (imperative-only, courtesy-prefix aware, unambiguous verbs free-standing and generic verbs object-bound) + fileBuildHandoff (ticket + durable work row + the shared acknowledgement) behind a claim ledger keyed by owner/session/message so one ask files one build exactly once.
 *
 * @module jarvis-build-handoff
 */

import * as crypto from 'crypto';
import type { AppContext } from '@/app/composition/app-context';
import { createChildLogger } from '@/shared/logger';
import { saveTaskPending } from './jarvis-task-store';

const logger = createChildLogger({ module: 'jarvis-build-handoff' });

/**
 * The acknowledgement a filed build gets. Shared by the fast path and the decision-timeout
 * fallback so a user cannot tell which one filed their request — the outcome is identical.
 */
export const BUILD_HANDOFF_ACK =
  "That's a bigger build — I've handed it to the team and I'll let you know when it's ready.";

/**
 * A courtesy wrapper in front of the real directive. Stripped so "can you please build me a bot"
 * is judged on "build me a bot" — the wrapper changes the politeness, never the intent.
 */
const COURTESY_PREFIX = new RegExp(
  '^(?:(?:hey|hi|hello|yo|ok|okay)\\b[\\s,!.]*)?'
  + '(?:jarvis\\b[\\s,!.]*)?'
  + '(?:(?:can|could|would|will)\\s+you\\s+)?'
  + "(?:i(?:'d|\\s+would)?\\s+(?:like|want|need)\\s+(?:you\\s+to\\s+)?)?"
  + '(?:please\\s+)?',
  'i',
);

/**
 * Verbs that mean engineering work whatever follows them. "Build the AttritionAnalyzer with Shared
 * Types and Unit Tests" names no noun this module could enumerate, and it is still a build.
 */
const UNAMBIGUOUS_BUILD_VERB = /^(?:build|implement|develop|scaffold)\b/i;

/**
 * Verbs that mean work only when they take a software object. "make me a sandwich" and "write me a
 * poem" are conversation; "make me a dashboard" and "write a script that renames my files" are not.
 */
const OBJECT_BOUND_BUILD_VERB = /^(?:create|make|write|code|generate|design)\b/i;

/** The software objects that turn a generic verb into a build directive. */
const BUILD_OBJECT = new RegExp(
  '\\b(app|apps|application|bot|agent|tool|script|dashboard|page|screen|feature|integration'
  + '|connector|workflow|pipeline|website|site|service|api|endpoint|plugin|extension|package'
  + '|module|component|form|widget|surface|panel|installer|cli|ui)\\b',
  'i',
);

/** Fewer words than this and the directive is a fragment ("build it") that needs the conversation. */
const MIN_DIRECTIVE_WORDS = 3;

/** Ticket/work-row title bound — the same slice the decision-timeout branch has always used. */
const TITLE_MAX = 120;

/** Claim-ledger bounds (see {@link dedupeWindowMs}). */
const DEDUPE_DEFAULT_MS = 600_000, DEDUPE_MIN_MS = 0, DEDUPE_MAX_MS = 3_600_000;

/** One recognised build directive. */
export interface JarvisBuildRequest {
  /** The user's message, whitespace-normalized. */
  request: string;
  /** The bounded title the ticket and the work row carry. */
  title: string;
}

/** What {@link fileBuildHandoff} did. */
export interface JarvisBuildHandoff {
  /** The acknowledgement to show and persist. */
  ack: string;
  /** The durable jarvis_tasks row id the surface tracks. */
  workJobId: string;
  /** The swarm ticket, when the ticket service accepted it. */
  ticketId?: string;
  /** True when this exact ask was already filed and this call reused that claim. */
  alreadyFiled: boolean;
}

/**
 * @description Is the fast build hand-off active? Config → env JARVIS_FAST_BUILD_HANDOFF. Anything
 * but an explicit `false`/`0`/`off` leaves it on: the kill switch exists so a deployment that finds
 * the detector wrong can fall back to the previous model-turn behaviour without a code change.
 * @returns True when a recognised build directive may be filed without a model turn.
 */
export function buildHandoffEnabled(): boolean {
  const raw = String(process.env.JARVIS_FAST_BUILD_HANDOFF ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

/**
 * @description How long one filed ask stays claimed, so a resend cannot open a second build.
 * Config → env JARVIS_BUILD_DEDUPE_MS (0–3600000) → 600000. Zero disables deduplication.
 * @returns Milliseconds.
 */
export function dedupeWindowMs(): number {
  // An UNSET variable must not read as 0: Number('') is 0, and 0 is a legal value here (it turns
  // deduplication off), so an empty string would silently ship the disabled behaviour as default.
  const raw = String(process.env.JARVIS_BUILD_DEDUPE_MS ?? '').trim();
  if (!raw) return DEDUPE_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= DEDUPE_MIN_MS && n <= DEDUPE_MAX_MS ? Math.round(n) : DEDUPE_DEFAULT_MS;
}

/** One filed ask. The message itself is never retained — only its hash is a key. */
interface BuildClaim { workJobId: string; ticketId?: string; at: number }

const claims = new Map<string, BuildClaim>();

/** Drop claims past the window so a long-lived controller cannot grow this map without bound. */
function expireClaims(now: number, windowMs: number): void {
  for (const [key, claim] of claims) if (now - claim.at >= windowMs) claims.delete(key);
}

/** The ledger key: owner + conversation + the exact ask, hashed so no message text is held in memory. */
function claimKey(sub: string, sessionId: string, request: string): string {
  return crypto.createHash('sha256')
    .update(`${sub}\u0000${sessionId}\u0000${request.toLowerCase()}`)
    .digest('hex');
}

/**
 * @description Recognise an imperative build directive without a model, a tool, or a provider call.
 *
 * Fires only when the message, after its courtesy wrapper, STARTS with a build verb and carries at
 * least a few words. A question ("how do I build a bot?", "did the build succeed?"), a report ("the
 * trading dashboard has been blank"), a request with a non-build verb ("fix the login redirect") and
 * a fragment ("build it") all decline here and keep the existing model turn — this path may only
 * ever take work the model would have handed off anyway.
 * @param message - The raw user message.
 * @returns The recognised directive, or null to leave the turn on its existing path.
 */
export function detectBuildRequest(message: string): JarvisBuildRequest | null {
  if (!buildHandoffEnabled()) return null;
  const request = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!request) return null;
  const directive = request.replace(COURTESY_PREFIX, '').trim();
  if (directive.split(' ').filter(Boolean).length < MIN_DIRECTIVE_WORDS) return null;
  const recognised = UNAMBIGUOUS_BUILD_VERB.test(directive)
    || (OBJECT_BOUND_BUILD_VERB.test(directive) && BUILD_OBJECT.test(directive));
  if (!recognised) return null;
  return { request, title: request.slice(0, TITLE_MAX) };
}

/**
 * @description File one build with the swarm: a ticket the queue manager routes (ADR-083 names no
 * owner, so the call-out routes it and an unclaimed 'complex' ask promotes to the build lane) plus
 * the durable jarvis_tasks row the surface follows. Never throws — a ticket service that refuses is
 * logged and the user still gets the work row and the acknowledgement, exactly as the
 * decision-timeout branch has always behaved.
 *
 * The claim is taken BEFORE the ticket is created, so two asks racing in the same conversation
 * cannot both reach createTicket; a failed creation releases it again, because nothing was filed.
 * @param ctx - App context (ticket service + Postgres pool).
 * @param sub - The owner the ticket and work row belong to.
 * @param sessionId - The conversation the ask arrived on.
 * @param request - The recognised directive.
 * @returns What was filed, or the prior claim when this exact ask was already filed.
 */
export async function fileBuildHandoff(
  ctx: AppContext, sub: string, sessionId: string, request: JarvisBuildRequest,
): Promise<JarvisBuildHandoff> {
  const windowMs = dedupeWindowMs();
  const key = claimKey(sub, sessionId, request.request);
  const now = Date.now();
  expireClaims(now, windowMs);
  const prior = windowMs > 0 ? claims.get(key) : undefined;
  if (prior) {
    logger.info({ sessionId, workJobId: prior.workJobId, ticketId: prior.ticketId ?? null },
      'jarvis: build already filed for this ask — reusing the claim instead of opening a second build');
    return { ack: BUILD_HANDOFF_ACK, workJobId: prior.workJobId, ticketId: prior.ticketId, alreadyFiled: true };
  }
  const workJobId = crypto.randomUUID();
  if (windowMs > 0) claims.set(key, { workJobId, at: now });
  let ticketId: string | undefined;
  try {
    const ticket = await ctx.ticketService.createTicket({
      title: request.title, description: request.request, status: 'approved', priority: 'medium',
      ownerSub: sub, ticketType: 'task',
      metadata: { source: 'jarvis', sessionId, complexity: 'complex', autoFiled: true },
    } as never);
    ticketId = (ticket as { ticketId?: string; id?: string }).ticketId ?? (ticket as { id?: string }).id;
    if (windowMs > 0) claims.set(key, { workJobId, ticketId, at: now });
  } catch (err) {
    // Nothing reached the swarm, so the ask must stay retryable rather than be silently claimed.
    claims.delete(key);
    logger.error({ err, sessionId }, 'jarvis: build hand-off could not open a ticket');
  }
  await saveTaskPending(ctx.pool, workJobId, sub, sessionId, request.title, 'complex', ticketId);
  logger.info({ sessionId, workJobId, ticketId: ticketId ?? null }, 'jarvis: build handed to the swarm without a model turn');
  return { ack: BUILD_HANDOFF_ACK, workJobId, ticketId, alreadyFiled: false };
}

/**
 * @description Forget every claim. Test-only seam: the ledger is process-wide, so a spec that files
 * the same ask twice on purpose needs a clean slate between cases.
 * @returns Nothing.
 */
export function resetBuildHandoffClaims(): void {
  claims.clear();
}
