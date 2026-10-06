/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Explicit super-admin role for the Developer Console (ADR-077). Double-gated + fail-closed + debuggable decision trace.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | isSuperAdminSub(sub) for QUEUE-side gating (ADR-081): dispatch has no Request, only ticket.ownerSub. Sub-allowlist-only by design — the console capability flag gates the browser console, not the oshal-dev workflow (the manifest's presence is that capability), and the email allowlist can't be checked without a session.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Match super-admin OIDC subjects exactly and case-sensitively; only email allowlists retain case-insensitive normalization. Whitespace/case variants can no longer alias a privileged subject.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | PRIVILEGED_TICKET_TYPES / isPrivilegedTicketType moved here from dispatch-manifest-worker.ts so the ticket route (refuses a non-super-admin filer at the door) and the queue gate (refuses a non-super-admin owner at dispatch) read ONE definition.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment A: OSHAL_SUPERADMIN_EMAILS counts only with a verified identity-provider issuer (authz operatorRequestIssuer, the rule every operator decision binds to): a local account's email was never verified, and a request carrying no verified issuer is no better, so such a principal qualifies by subject alone. The denial names which list can admit it.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 privileged lane (general fix): the privileged worker is named here beside the privileged ticket type, hardcoded so no manifest can widen it. PRIVILEGED_WORKER_AGENT_IDS / PRIVILEGED_WORKER_NAMES and isPrivilegedWorkerAgent (case-insensitive, trimmed: ids are UUIDs and a variant spelling must not slip past a refusal). PRIVILEGED_WORKFLOW_OWNERS names the one app (swarm-apps/oshal-dev.yaml) that may register each privileged type's workflow. privilegedWorkflowRefusal is the single rule the pipeline registry, the publish compiler and manifest load apply: no other app registers a privileged type, the owner registers it only on the manifest-worker pipeline (the one whose gate checks the owner), and no workflow for another type names the privileged worker (workflowNamedWorkers: workerBot, reviewerBot and every string in the process definition, so a graph node binding is caught too). privilegedManifestRefusal adds the manifest's bot declarations (review: a manifest upserts its bots by id, name included, so any app declaring the developer bot's id could rename its row and reach it under the alias), and isPrivilegedLaneOwnerName reserves the owner's name: the compiler refuses it and manifest read accepts it only from the kernel's swarm-apps directory. Before this, any app workflow could re-register 'oshal-dev' with the graph pipeline (skipping the manifest-worker gate) or declare the developer bot as its workerBot for another type, and the queue sent it the work with no super-admin check.
 */

import type { Request, Response, NextFunction } from 'express';
import { getCaller, operatorMatchKeys, operatorRequestIssuer } from './authz';

/**
 * Super-admin is a DISTINCT, more privileged role than operator. Operator can manage
 * tenants/data; super-admin can reach the Developer Console (diagnose, and — in later
 * phases — edit + recover the platform). It is therefore gated TWICE and fail-closed:
 *
 *   1. The capability must be explicitly ENABLED on the deployment
 *      (OSHAL_DEV_CONSOLE_ENABLED=true). Unset ⇒ the console does not exist for anyone,
 *      so an enterprise install that never opts in is not exposed at all.
 *   2. The caller must be on the DEDICATED super-admin allowlist
 *      (OSHAL_SUPERADMIN_SUBS / OSHAL_SUPERADMIN_EMAILS). Empty ⇒ nobody qualifies.
 *
 * Being an operator does NOT grant super-admin — it is a separate, explicit list, so
 * broadening operator access can never silently widen who can touch platform internals.
 */
export interface SuperAdminChecks {
  /** OSHAL_DEV_CONSOLE_ENABLED is truthy — the capability is turned on for this deployment. */
  capabilityEnabled: boolean;
  /** The request carries a validated OIDC identity (a sub). */
  authenticated: boolean;
  /** The caller's sub or email is on the dedicated super-admin allowlist. */
  onAllowlist: boolean;
}

/** A fully-explained authorization decision — the debuggable core of the gate. */
export interface SuperAdminDecision {
  allowed: boolean;
  /** Human-readable reason for the outcome (safe to log AND to return to the caller). */
  reason: string;
  checks: SuperAdminChecks;
  /** The caller's sub (for server-side logs/audit); null when unauthenticated. */
  sub: string | null;
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * @description Whether the Developer Console capability is enabled on this deployment.
 * Fail-closed: anything other than an explicit truthy value is treated as disabled.
 * @returns true only when OSHAL_DEV_CONSOLE_ENABLED is one of true/1/yes/on.
 */
export function superAdminEnabled(): boolean {
  return TRUTHY.has((process.env.OSHAL_DEV_CONSOLE_ENABLED ?? '').trim().toLowerCase());
}

function parseSubjectAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function parseEmailAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * @description Evaluates the full super-admin decision for a request WITHOUT mutating
 * response state. Pure and side-effect free so it can back both the guard and a
 * caller-facing "am I a super-admin, and why/why not" endpoint.
 * @param req - The Express request (identity read only from the validated OIDC session).
 * @returns A complete, explained decision — never throws.
 */
export function evaluateSuperAdmin(req: Request): SuperAdminDecision {
  const capabilityEnabled = superAdminEnabled();
  const { sub, email } = getCaller(req);
  const authenticated = typeof sub === 'string' && sub.length > 0;
  const subs = parseSubjectAllowlist(process.env.OSHAL_SUPERADMIN_SUBS);
  const emails = parseEmailAllowlist(process.env.OSHAL_SUPERADMIN_EMAILS);
  // The email counts only with a verified identity-provider issuer (ADR-174 Amendment A): a local account's
  // address was never verified, and a request carrying no verified issuer is no better.
  const keys = operatorMatchKeys(sub, email, operatorRequestIssuer(req));
  const onAllowlist =
    (keys.sub !== null && subs.has(keys.sub))
    || (keys.email !== null && emails.has(keys.email.toLowerCase()));

  const checks: SuperAdminChecks = { capabilityEnabled, authenticated, onAllowlist };
  const allowed = capabilityEnabled && authenticated && onAllowlist;

  return { allowed, reason: reasonFor(checks), checks, sub: sub ?? null };
}

/** Reports the FIRST failing gate (or success), so the reason is deterministic + debuggable. */
function reasonFor(checks: SuperAdminChecks): string {
  if (!checks.capabilityEnabled) {
    return 'Developer Console is disabled on this deployment (OSHAL_DEV_CONSOLE_ENABLED is not set).';
  }
  if (!checks.authenticated) {
    return 'Not authenticated.';
  }
  if (!checks.onAllowlist) {
    return 'Caller is not on the super-admin allowlist (OSHAL_SUPERADMIN_SUBS; OSHAL_SUPERADMIN_EMAILS counts only for a verified identity-provider sign-in).';
  }
  return 'Granted: caller is an enabled super-admin.';
}

/**
 * @description Boolean shortcut for the super-admin decision.
 * @param req - The Express request.
 * @returns true only when the capability is enabled AND the authenticated caller is allowlisted.
 */
export function isSuperAdmin(req: Request): boolean {
  return evaluateSuperAdmin(req).allowed;
}

/**
 * @description Sub-only super-admin check for contexts with no Request — the queue-side
 * gate on privileged ticket types (ADR-081: only an allowlisted owner's tickets may reach
 * the oshal-developer bot). Fail-closed: an empty allowlist or missing sub denies. This
 * deliberately does NOT require OSHAL_DEV_CONSOLE_ENABLED (that flag gates the browser
 * Developer Console; a privileged workflow's capability gate is its manifest being loaded)
 * and cannot consult OSHAL_SUPERADMIN_EMAILS (no session email exists on a ticket).
 * @param sub - The acting user's sub (e.g. ticket.ownerSub); null/undefined denies.
 * @returns true only when sub is on OSHAL_SUPERADMIN_SUBS.
 */
export function isSuperAdminSub(sub: string | null | undefined): boolean {
  if (typeof sub !== 'string' || sub.length === 0) return false;
  return parseSubjectAllowlist(process.env.OSHAL_SUPERADMIN_SUBS).has(sub);
}

/** Ticket types whose worker can modify the platform itself (ADR-081). Hardcoded, not
 *  manifest-declared, so a manifest edit can never silently widen who can task the developer bot. */
export const PRIVILEGED_TICKET_TYPES: ReadonlySet<string> = new Set(['oshal-dev']);

/**
 * @description Whether a ticket type is privileged: filing one requires a super-admin at the
 * ticket route, and dispatching one requires a super-admin owner at the queue.
 * @param ticketType - The ticket type to test.
 * @returns true for a privileged type.
 */
export function isPrivilegedTicketType(ticketType: string | null | undefined): boolean {
  return typeof ticketType === 'string' && PRIVILEGED_TICKET_TYPES.has(ticketType);
}

/** The oshal-developer (ADR-081): the one worker whose node works in a push-capable clone of the platform. */
export const PRIVILEGED_WORKER_AGENT_IDS: ReadonlySet<string> = new Set(['de000000-0000-0000-0000-000000000001']);

/** The same worker by the persona name a manifest's workerBot, reviewerBot or graph node binding resolves at dispatch. */
export const PRIVILEGED_WORKER_NAMES: ReadonlySet<string> = new Set(['oshal-developer']);

/**
 * The app that owns each privileged ticket type's workflow (swarm-apps/oshal-dev.yaml), the only one
 * allowed to register it. Hardcoded with the type itself, for the same reason.
 */
export const PRIVILEGED_WORKFLOW_OWNERS: ReadonlyMap<string, string> = new Map([['oshal-dev', 'oshal-dev']]);

/**
 * @description Whether an agent id or persona name names a privileged worker (ADR-081). Agent ids
 * are UUIDs, whose letter case carries no meaning, so the match ignores case and surrounding
 * whitespace: a variant spelling must not slip past a refusal that names it.
 * @param agent - The agent id or persona name to test, such as a ticket's pin or a workflow's workerBot.
 * @returns true for a privileged worker.
 */
export function isPrivilegedWorkerAgent(agent: string | null | undefined): boolean {
  if (typeof agent !== 'string') return false;
  const key = agent.trim().toLowerCase();
  return PRIVILEGED_WORKER_AGENT_IDS.has(key) || PRIVILEGED_WORKER_NAMES.has(key);
}

/** The shape of a workflow as the registry, a manifest and the publish compiler describe it. */
export interface WorkflowWorkerFacts {
  workerBot?: string | null;
  reviewerBot?: string | null;
  processDefinition?: unknown;
}

/**
 * @description Every worker a workflow names: its workerBot, its reviewerBot, and every string
 * anywhere in its process definition (a graph node's agentBinding or agentId, a cluster's agents).
 * Collecting every string rather than known keys means a new node shape cannot hide a binding.
 * @param workflow - The workflow definition or manifest workflow.
 * @returns The distinct names and ids, in discovery order.
 */
export function workflowNamedWorkers(workflow: WorkflowWorkerFacts | null | undefined): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 16 || value === null || value === undefined) return;
    if (typeof value === 'string') { if (value.trim()) found.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
  };
  visit(workflow?.workerBot, 0);
  visit(workflow?.reviewerBot, 0);
  visit(workflow?.processDefinition, 0);
  return Array.from(found);
}

/**
 * @description The one rule for registering a workflow (ADR-081): a privileged ticket type's workflow
 * comes only from the app that owns it, and a workflow for any other type never names the privileged
 * worker. Applied by the pipeline registry, by manifest load and by the publish compiler, so a
 * takeover is refused wherever it is attempted.
 * @param facts - The registering app, the ticket type and the workers the workflow names.
 * @returns The refusal reason, or null when the workflow may be registered.
 */
export function privilegedWorkflowRefusal(facts: {
  appName: string; ticketType: string; pipeline?: string | null; workers: ReadonlyArray<string | null | undefined>;
}): string | null {
  if (isPrivilegedTicketType(facts.ticketType)) {
    const owner = PRIVILEGED_WORKFLOW_OWNERS.get(facts.ticketType);
    if (facts.appName !== owner) return `ticketType '${facts.ticketType}' is privileged (ADR-081): only the '${owner}' app registers its workflow`;
    // The lane is the single-bot manifest-worker dispatch, whose gate checks the owner; no other pipeline runs it.
    if (facts.pipeline && facts.pipeline !== 'manifest-worker') return `ticketType '${facts.ticketType}' is privileged (ADR-081): its workflow runs only on the manifest-worker pipeline, not '${facts.pipeline}'`;
    return null;
  }
  const privileged = facts.workers.find((worker) => isPrivilegedWorkerAgent(worker));
  return privileged === undefined || privileged === null
    ? null
    : `the workflow names the privileged worker '${privileged}' (ADR-081): only a privileged ticket type reaches it`;
}

/**
 * @description Whether an app name is one that owns a privileged lane (ADR-081). Such a name is reserved: the
 * publish compiler refuses it, and manifest read accepts it only from the kernel's own swarm-apps directory, so
 * an operator-published or deployed app cannot borrow the owner's standing (and with it the right to declare the
 * privileged worker as its bot, which would rename the bot's row).
 * @param name - The manifest name.
 * @returns true for a reserved lane-owner name.
 */
export function isPrivilegedLaneOwnerName(name: string | null | undefined): boolean {
  return typeof name === 'string' && Array.from(PRIVILEGED_WORKFLOW_OWNERS.values()).includes(name);
}

/** The parts of an application manifest the privileged-lane rule reads. */
export interface PrivilegedManifestFacts {
  name: string;
  ticketType?: string | null;
  workflow?: (WorkflowWorkerFacts & { pipeline?: string | null }) | null;
  bots?: ReadonlyArray<{ agentId?: string | null; name?: string | null }> | null;
}

/**
 * @description The privileged-lane rule for a whole manifest (ADR-081): its bot declarations may name the
 * privileged worker's id or name only when the app owns a privileged lane (a manifest's bots are upserted
 * into the agents table, name included, so any other app declaring the id would rename the developer bot's
 * row and reach it under the new name), and its workflow obeys {@link privilegedWorkflowRefusal}.
 * @param manifest - The manifest, as read from disk or compiled from a publish.
 * @returns The refusal reason, or null when the manifest may be loaded.
 */
export function privilegedManifestRefusal(manifest: PrivilegedManifestFacts): string | null {
  const ownsALane = isPrivilegedLaneOwnerName(manifest.name);
  if (!ownsALane) {
    const declared = (manifest.bots ?? []).find((bot) => isPrivilegedWorkerAgent(bot.agentId) || isPrivilegedWorkerAgent(bot.name));
    if (declared) return `the manifest declares the privileged worker '${declared.agentId ?? declared.name}' as one of its bots (ADR-081): only its own app may`;
  }
  if (!manifest.workflow) return null;
  return privilegedWorkflowRefusal({
    appName: manifest.name, ticketType: manifest.ticketType ?? manifest.name, pipeline: manifest.workflow.pipeline,
    workers: workflowNamedWorkers(manifest.workflow),
  });
}

/** A request that has passed (or been evaluated by) the super-admin gate. */
export type RequestWithSuperAdmin = Request & { superAdminDecision?: SuperAdminDecision };

/**
 * @description Pure Express guard for super-admin-only routes. Attaches the decision to
 * the request (for downstream handlers/audit), returns 403 with a safe reason when denied,
 * and calls next() only when allowed. Denials are NOT audited here (no DB handle) — use the
 * pool-bound guard in the routes layer when a persisted audit trail is required.
 * @param req - The Express request.
 * @param res - The Express response.
 * @param next - The next middleware.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const decision = evaluateSuperAdmin(req);
  (req as RequestWithSuperAdmin).superAdminDecision = decision;
  if (decision.allowed) {
    next();
    return;
  }
  res.status(403).json({ error: 'Super-admin privilege required', reason: decision.reason });
}
