/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — execute-time per-caller entitlement gate for the bot-node's POST /api/swarm-execute (BACKLOG "Bot-endpoint privilege model"). Reuses the EXISTING models, invents no store: ADR-087 accessRoles (isBotAccessibleTo, most-restrictive-wins) + the operator allowlist (isOperatorIdentity, OSHAL_OPERATOR_SUBS/EMAILS). Caller classes: no userSub → internal dispatch (trusted, unchanged); userSub without direct → queue/swarm dispatch threading the ticket owner's sub for credential brokering (trusted — queue-manager dispatch must not break); userSub + direct:true → interactive per-user delegation, entitlement-checked. Front-door exemption: a bot whose registry role is assistant/* is the user's own entry point — its operator+swarm scoping is discovery-hiding only (registry comment on oshal-assistant), so identity callers stay entitled to it. Mode env OSHAL_EXECUTE_ENTITLEMENT: off (default — enforcement requires OSHAL_OPERATOR_SUBS on bot containers) | warn (log would-be denials) | enforce (403 + denial log).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Privilege-model rollout (BACKLOG item, diagnosis bot-endpoint-priv): (1) default mode flipped 'off' → 'warn' — the gate was built but OSHAL_EXECUTE_ENTITLEMENT was wired NOWHERE (no compose/.env entry), so every deployment silently ran no check at all; warn is behavior-safe (log-only) and starts the denial soak everywhere without an env change. Unknown values now also fall back to 'warn' (a typo must not silently disable auditing); 'off' remains an explicit opt-out. The warn→enforce flip stays an explicit operator env act. (2) New exports for the CONTROLLER chokepoint (executeBotOrInline — inline bots resolve to a null endpoint and never reach this HTTP gate): assertExecuteEntitlement (mode-aware helper that reuses the SAME pure decision + denial-log shape, throws in enforce) and CallerNotEntitledError (statusCode 403). Denial logging refactored to a transport-neutral field logger so bot-node HTTP + controller denials grep as one line shape.
 */

/**
 * Execute-time entitlement for bot-node LLM execution (BACKLOG "Bot-endpoint privilege
 * model — authorize the ACTUAL endpoint call").
 *
 * The service secret proves *a trusted machine is calling*; it says nothing about whether
 * the END CALLER a request acts for (its `userSub`) is entitled to the targeted bot. This
 * gate closes that gap for interactive per-user delegation (`direct: true` — the marker
 * jarvis-orchestrator/route delegation already sets) while leaving internal swarm dispatch
 * untouched:
 *
 *   - No `userSub`               → anonymous internal dispatch — trusted (existing gate applies).
 *   - `userSub`, not `direct`    → queue/swarm dispatch that threads the ticket owner's sub
 *                                  for the token broker — trusted ('swarm' role).
 *   - `userSub` + `direct: true` → interactive delegation on a user's behalf:
 *       operator sub (allowlist)                 → allowed;
 *       target open to user delegation (ADR-087) → allowed;
 *       target is an assistant/* front door      → allowed (scoping is discovery-hiding only);
 *       otherwise                                → EXPLICIT MISMATCH — denied (403 in enforce).
 *
 * @module bot-node-execute-entitlement
 */

import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { getActiveRegistry, isBotAccessibleTo } from '@/app/extensions/swarm/swarm-bot-registry';

const logger = createChildLogger({ module: 'bot-node-execute-entitlement' });

/** Backlog reference logged on posture + denials so operators can find the design. */
const BACKLOG_ITEM = 'docs/BACKLOG.md § "Bot-endpoint privilege model — authorize the ACTUAL endpoint call"';

/** @description Enforcement mode for the execute-time entitlement gate. */
export type ExecuteEntitlementMode = 'off' | 'warn' | 'enforce';

/** @description The request facts the entitlement decision runs on. */
export interface ExecuteEntitlementInput {
  /** End caller the request acts for (normalized); absent on anonymous internal dispatch. */
  userSub: string | null | undefined;
  /** Interactive per-user delegation marker (BotNodeRequest.direct). */
  direct: boolean;
  /** The bot the request is addressed to (body.agentId, else the node's own id). */
  targetAgentId: string;
}

/** @description Injectable collaborators — defaults reuse the live platform models. */
export interface ExecuteEntitlementDeps {
  /** Operator allowlist check (default: isOperatorIdentity against OSHAL_OPERATOR_SUBS/EMAILS). */
  isOperator?: (sub: string) => boolean;
  /** Whether user-facing delegation may reach the bot (default: isBotAccessibleTo(id, 'jarvis'), ADR-087). */
  isUserDelegationAccessible?: (agentId: string) => boolean;
  /** Whether the bot is an assistant front door (default: every registry def declares an assistant/* role). */
  isAssistantFrontDoor?: (agentId: string) => boolean;
}

/** @description One entitlement decision, with the caller class that produced it. */
export type ExecuteEntitlementDecision =
  | { allowed: true; caller: 'internal-dispatch' | 'swarm-dispatch' | 'operator' | 'entitled-user' | 'front-door' }
  | { allowed: false; caller: 'identity-mismatch'; callerSub: string };

/**
 * @description Parses OSHAL_EXECUTE_ENTITLEMENT into an enforcement mode. Default (and any
 * unknown value) is 'warn': would-be denials are logged, nothing is blocked — behavior-safe
 * on every deployment, and it runs the denial soak an enforce flip needs. 'off' is an
 * EXPLICIT opt-out only. Turning 'enforce' on requires the operator allowlist env on bot
 * containers and a review of the warn-soak denial logs first — so the fail-closed flip is
 * an explicit operator env act, exactly like SWARM_SERVICE_SECRET.
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The active enforcement mode.
 */
export function resolveExecuteEntitlementMode(env: NodeJS.ProcessEnv = process.env): ExecuteEntitlementMode {
  const raw = String(env.OSHAL_EXECUTE_ENTITLEMENT ?? '').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'on' || raw === 'true') return 'enforce';
  if (raw === 'off' || raw === 'false' || raw === 'disabled') return 'off';
  return 'warn';
}

/**
 * @description Pure entitlement decision — see the module contract. Reused by the Express
 * gate and driven directly by the guard spec so there is no policy copy to drift.
 * @param input - Request facts (userSub / direct / target agent).
 * @param deps - Injectable model lookups; defaults reuse the live ADR-087 + operator models.
 * @returns The decision with the caller class (denials carry the sub for the audit log).
 */
export function decideExecuteEntitlement(
  input: ExecuteEntitlementInput,
  deps: ExecuteEntitlementDeps = {},
): ExecuteEntitlementDecision {
  const sub = String(input.userSub ?? '').trim();
  if (!sub) return { allowed: true, caller: 'internal-dispatch' };
  if (!input.direct) return { allowed: true, caller: 'swarm-dispatch' };

  const isOperator = deps.isOperator ?? ((candidate: string) => isOperatorIdentity(candidate, null));
  if (isOperator(sub)) return { allowed: true, caller: 'operator' };

  const isAccessible = deps.isUserDelegationAccessible
    ?? ((agentId: string) => isBotAccessibleTo(agentId, 'jarvis'));
  if (isAccessible(input.targetAgentId)) return { allowed: true, caller: 'entitled-user' };

  const isFrontDoor = deps.isAssistantFrontDoor ?? defaultIsAssistantFrontDoor;
  if (isFrontDoor(input.targetAgentId)) return { allowed: true, caller: 'front-door' };

  return { allowed: false, caller: 'identity-mismatch', callerSub: sub };
}

/**
 * @description Default front-door detector: EVERY active-registry definition for the agent
 * declares an `assistant/*` role (most-restrictive-wins, mirroring isBotAccessibleTo). The
 * assistant front door (oshal-assistant, role assistant/unified-front-door) is invoked
 * directly by id with the caller's own sub on every turn; its operator+swarm accessRoles
 * exist only to hide it from catalogs/call-outs (see the registry comment), so treating
 * that scoping as an execute-time denial would break every non-operator user's Jarvis.
 * @param agentId - Target agent id.
 * @returns True when the agent is a declared assistant front door.
 */
function defaultIsAssistantFrontDoor(agentId: string): boolean {
  const defs = getActiveRegistry().filter((bot) => bot.agentId === agentId);
  return defs.length > 0 && defs.every((def) => String(def.role ?? '').startsWith('assistant/'));
}

/**
 * @description Builds the Express gate for POST /api/swarm-execute. Runs AFTER the
 * shared-secret gate (authorizeBotNodeExecutionCall): that middleware authenticates the
 * MACHINE; this one authorizes the END CALLER against the target bot. Mode is read per
 * request so tests and live env flips need no restart.
 *   - off     → next() (no evaluation).
 *   - warn    → evaluate; WARN on a would-be denial; always next().
 *   - enforce → evaluate; 403 + denial log on an explicit mismatch.
 * @param options - defaultAgentId: the node's own agent id (target when body.agentId is
 *   absent); deps/env injectable for tests.
 * @returns Express middleware.
 */
export function createExecuteEntitlementGate(options: {
  defaultAgentId: string;
  deps?: ExecuteEntitlementDeps;
  env?: NodeJS.ProcessEnv;
}): RequestHandler {
  return (req, res, next) => {
    const mode = resolveExecuteEntitlementMode(options.env ?? process.env);
    if (mode === 'off') { next(); return; }

    const body = (req.body ?? {}) as { agentId?: unknown; userSub?: unknown; direct?: unknown };
    const decision = decideExecuteEntitlement({
      userSub: typeof body.userSub === 'string' ? body.userSub : null,
      direct: body.direct === true,
      targetAgentId: typeof body.agentId === 'string' && body.agentId.trim().length > 0
        ? body.agentId
        : options.defaultAgentId,
    }, options.deps);

    if (decision.allowed) { next(); return; }

    if (mode === 'warn') {
      logDenialFromRequest(req, decision, 'warn-only: allowing');
      next();
      return;
    }
    logDenialFromRequest(req, decision, 'DENIED');
    res.status(403).json({ success: false, error: 'caller_not_entitled_to_agent' });
  };
}

/**
 * @description Thrown by assertExecuteEntitlement in enforce mode when an interactive
 * identity caller is not entitled to the target bot. Carries statusCode 403 + a stable
 * machine code so route error mappers can translate it without string-matching messages.
 */
export class CallerNotEntitledError extends Error {
  /** HTTP status a route should map this denial to. */
  public readonly statusCode = 403;
  /** Stable machine-readable code, mirroring the bot-node HTTP gate's error body. */
  public readonly code = 'caller_not_entitled_to_agent';

  /**
   * @description Builds the denial error.
   * @param targetAgentId - The bot the caller was denied on.
   * @param callerSub - The end caller's sub (audit; never a secret).
   */
  constructor(public readonly targetAgentId: string, public readonly callerSub: string) {
    super(`Caller is not entitled to agent ${targetAgentId}`);
    this.name = 'CallerNotEntitledError';
  }
}

/**
 * @description Controller-side execute-time entitlement assertion — the non-HTTP sibling of
 * createExecuteEntitlementGate for the executeBotOrInline chokepoint, where INLINE bots
 * (null endpoint — bot-node-client CONTROLLER_INLINE_CONTAINERS) never reach the bot-node
 * HTTP gate and remote calls benefit from an early controller-side denial. Reuses the SAME
 * pure decideExecuteEntitlement + the same denial-log shape, so there is no policy copy to
 * drift. Mode semantics match the gate: off → no evaluation; warn → log the would-be denial
 * and return; enforce → log + throw CallerNotEntitledError (statusCode 403).
 * @param input - Request facts plus audit context (taskId, surface — e.g. 'executeBotOrInline').
 * @param deps - Injectable model lookups; defaults reuse the live ADR-087 + operator models.
 * @param env - Environment map (process.env by default; injectable for tests).
 * @throws CallerNotEntitledError in enforce mode on an explicit identity mismatch.
 */
export function assertExecuteEntitlement(
  input: ExecuteEntitlementInput & { taskId?: string | null; surface: string },
  deps: ExecuteEntitlementDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const mode = resolveExecuteEntitlementMode(env);
  if (mode === 'off') return;

  const decision = decideExecuteEntitlement(input, deps);
  if (decision.allowed) return;

  const fields = {
    callerSub: decision.callerSub,
    targetAgentId: input.targetAgentId,
    taskId: input.taskId ?? null,
    surface: input.surface,
  };
  if (mode === 'warn') {
    logDenialFields({ ...fields, outcome: 'warn-only: allowing' });
    return;
  }
  logDenialFields({ ...fields, outcome: 'DENIED' });
  throw new CallerNotEntitledError(input.targetAgentId, decision.callerSub);
}

/** @description Express-request adapter over the shared denial-field logger. */
function logDenialFromRequest(
  req: Request,
  decision: Extract<ExecuteEntitlementDecision, { allowed: false }>,
  outcome: string,
): void {
  const body = (req.body ?? {}) as { agentId?: unknown; taskId?: unknown };
  logDenialFields({
    outcome,
    callerSub: decision.callerSub,
    targetAgentId: typeof body.agentId === 'string' ? body.agentId : null,
    taskId: typeof body.taskId === 'string' ? body.taskId : null,
    surface: req.path,
  });
}

/**
 * @description ONE denial log shape for every transport (bot-node HTTP gate + controller
 * chokepoint) and both modes (warn + enforce), so audits grep a single line.
 */
function logDenialFields(fields: {
  outcome: string;
  callerSub: string;
  targetAgentId: string | null;
  taskId: string | null;
  surface: string;
}): void {
  logger.warn(
    { ...fields, backlogItem: BACKLOG_ITEM },
    'Execute-time entitlement: identity caller is NOT entitled to the target agent (interactive delegation to an operator/swarm-scoped bot)',
  );
}

/**
 * @description One-time startup posture log, the logBotNodeAuthPosture sibling: says which
 * enforcement mode the node booted with and — when off — names the env var + backlog item
 * so the closed posture is one env flip away and impossible to miss in an audit.
 */
export function logExecuteEntitlementPosture(): void {
  const mode = resolveExecuteEntitlementMode();
  if (mode === 'enforce') {
    logger.info('Execute-time entitlement is ENFORCED (OSHAL_EXECUTE_ENTITLEMENT=enforce) — interactive identity callers must be entitled to the target agent (ADR-087 accessRoles + operator allowlist)');
    return;
  }
  if (mode === 'warn') {
    logger.info('Execute-time entitlement is in WARN mode (the default) — would-be denials are logged, nothing is blocked. Review the denial soak, then set OSHAL_EXECUTE_ENTITLEMENT=enforce (with OSHAL_OPERATOR_SUBS on bot containers) to fail closed.');
    return;
  }
  logger.warn(
    { backlogItem: BACKLOG_ITEM },
    'Execute-time entitlement is OFF (explicit opt-out via OSHAL_EXECUTE_ENTITLEMENT=off) — no per-caller entitlement check runs and no denial soak is collected. Unset the var (warn default) or set enforce to activate it.',
  );
}
