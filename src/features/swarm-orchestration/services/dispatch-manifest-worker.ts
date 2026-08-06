/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded multi-bid specialist fan-out with per-owner credentials, one durable aggregate, truthful routing metadata, partial-result handling, and safe single-winner fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persist dedicated bot-node completions (including out-of-band provider records) into the shared conversation stores before marking manifest-worker tickets complete; retry writes are deduplicated and localhost dispatch remains single-write.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extracted dispatchManifestWorkerTicket from queue-manager-service.ts (audit P0 second cut)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: superadmin gate on privileged ticket types — 'oshal-dev' tickets (the platform-developer bot, which holds a push-capable clone of this repo) dispatch only when ticket.ownerSub is on OSHAL_SUPERADMIN_SUBS. Gated at dispatch (not intake) because POST /api/tickets lets any authenticated user file any ticketType.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: the generic 'task' lane now routes by CALL-OUT, not a pinned guess — when no agent is pinned, resolveTaskWorker broadcasts a BID_REQUEST to online knowledge owners and the AgentRouter cascade decides. Lane flexibility: an unclaimed COMPLEX task promotes to the build/decompose lane (promoteToSwarm); an unclaimed simple task lands on the general fallback owner. App-specific ticketTypes (trading-decision, education, …) keep their manifest-declared workerBot untouched.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum (skill profiles): after building the worker prompt, resolve the owning app's `summarize` profile by ticketType and compose its domain pattern into the text. Controller-side resolution (the bot node has no registry); the pattern rides as prompt text so the LLM work + cost stay on the accountable bot (ADR-036). No-op when the app declared no profile.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap-b LIVE WIRING (controller half): when OSHAL_PUSH_ON_DISPATCH is on, stamp each BotNodeClient.execute dispatch (single-owner + multi-bid fan-out) with the target agent's authoritative provider/model/configVersion via resolveDispatchConfigFields(deps.runtimeParamsResolver, agentId). Fail-open by contract (absent resolver / no record / resolver error → {}), and the env flag defaults OFF → the dispatched request is byte-identical to the legacy shape. The bot half self-corrects a divergent runtime before executing (bot-node-dispatch-config.ts).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Carry persisted ticket-owner principal issuer provenance into every single-owner and fan-out HTTP delegation request.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Reject localhost execution fallback when controller signing is enabled so bot-node transport or endpoint failures cannot bypass signed delegation.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Bind localhost fallback identity with the canonical base64url trusted-service subject header so exact owner case/whitespace survives transport.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove connector credentials from generic/fan-out model dispatch. Credential resolution is permitted only for a schema-bounded deterministic providerIntent executed by the trusted server handler.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Close ADR-034 push-on-dispatch enforcement: authoritative stamping defaults on, carries providerConfigRequired even when the record lookup fails, and retains an explicit off/false/0/no/disabled compatibility rollback.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Prevent authoritative remote dispatch from downgrading to the unstamped localhost path after a bot transport failure; only explicit flag-off compatibility requests may use that fallback.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { InternalTicket } from '@/entities/ticket';
import type { IMessageStore } from '@/entities/message';
import type { ITaskStore } from '@/entities/task';
import type { TicketService } from '@/features/ticketing';
import {
  resolveDispatchConfigFields,
  type BotNodeClient,
  type BotNodeResponse,
  type RuntimeParamsResolver,
  type DispatchConfigFields,
} from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders, trustedServiceUserHeaders } from '@/shared/middleware/authz';
import { isSuperAdminSub } from '@/shared/middleware/superadmin';
import { resolveSkillProfileByTicketType, composeSkillProfilePrompt } from '@/shared/skill-profiles';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import {
  parseTrustedProviderIntent,
  trustedProviderAgentId,
  type TrustedProviderIntent,
} from '@/app/bot-node-provider-intent';
import type { WorkflowDefinition } from './dispatch-routing';
import type { TaskCallOutOwner, TaskCallOutResolver } from './task-call-out';

const logger = createChildLogger({ module: 'dispatch-manifest-worker' });

/**
 * @description Blank out whitespace-delimited tokens that contain a path separator, so a
 * filesystem path or URL inside a ticket body cannot be read as intent words. A path is an
 * address, not a request: `C:\Program Files\Google\Chrome\Application\chrome.exe` contains the
 * word "Application" and used to satisfy the apply-intent matcher on its own, which routed an
 * unrelated ticket into the job-application dispatcher and really submitted an application
 * (live, 2026-07-28). Tokens are replaced with a space rather than deleted so neighbouring
 * words never fuse into a new false match.
 * @param text - Raw ticket title + description.
 * @returns The same text with path-like and URL-like tokens removed.
 */
export function stripPathLikeTokens(text: string): string {
  return text.replace(/\S*[\\/]\S*/g, ' ');
}

/**
 * @description ADR-034 gap-b feature flag: whether the controller stamps each bot-node
 * dispatch with the authoritative provider/model/configVersion record (push-on-dispatch).
 * Default ON. An operator can temporarily restore the legacy rail with an explicit
 * off/false/0/no/disabled value; every other value, including unset, keeps enforcement on.
 * @returns True when push-on-dispatch stamping is enabled.
 */
function isPushOnDispatchEnabled(): boolean {
  const value = String(process.env.OSHAL_PUSH_ON_DISPATCH ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no', 'disabled'].includes(value);
}

/**
 * @description Resolves the spreadable BotNodeRequest config fields for a dispatch target,
 * gated by {@link isPushOnDispatchEnabled}. When the flag is off it short-circuits to `{}`
 * (no resolver lookup, legacy dispatch). When on it always carries
 * `providerConfigRequired:true`; an absent resolver, missing record, or lookup error therefore
 * reaches the bot as an explicit unavailable-authority condition instead of silently degrading.
 * @param resolver - The optional injected runtime-params resolver.
 * @param agentId - The dispatch target's agent id.
 * @returns Fields to spread into the BotNodeRequest (empty when disabled or non-actionable).
 */
export async function pushOnDispatchFields(
  resolver: RuntimeParamsResolver | undefined,
  agentId: string,
): Promise<DispatchConfigFields> {
  if (!isPushOnDispatchEnabled()) return {};
  return {
    providerConfigRequired: true,
    ...await resolveDispatchConfigFields(resolver, agentId),
  };
}

/** Ticket types whose worker can modify the platform itself — dispatch is restricted to
 *  super-admin-owned tickets. Hardcoded (not manifest-declared) so a manifest edit can
 *  never silently widen who can task the developer bot. */
const PRIVILEGED_TICKET_TYPES: ReadonlySet<string> = new Set(['oshal-dev']);

/** Minimal Response-ish shape this module needs from the localhost send-message call. */
interface SendMessageResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}

/**
 * POST /api/send-message over Node's http (NOT global fetch). A manifest worker bot can run
 * 10-30 minutes, but undici's fetch has a ~5-minute headersTimeout that aborts the dispatch and
 * escalates the ticket before the bot replies (the slot watchdog MAX_DISPATCH_DURATION_MS bounds it
 * instead). http.request has no default timeout. Mirrors the shadow-fetch in queue-manager-service.
 */
function postSendMessageNoTimeout(
  port: string,
  headers: Record<string, string>,
  body: string,
): Promise<SendMessageResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port: Number(port),
        path: '/api/send-message',
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => resolve({
          ok: (res.statusCode ?? 500) < 400,
          status: res.statusCode ?? 500,
          statusText: res.statusMessage ?? '',
          text: () => Promise.resolve(data),
        }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

interface ManifestWorkerDispatchResult {
  success: boolean;
  response?: string;
  error?: string;
}

interface ManifestWorkerRouteMetadata {
  workerBot: string;
  workerAgentId: string;
  routedBy: string;
  workerBots?: string[];
  workerAgentIds?: string[];
  ownerBids?: TaskCallOutOwner[];
}

interface FanOutExecutionResult {
  owner: TaskCallOutOwner;
  result?: BotNodeResponse;
  error?: string;
}

function safeWorkerLabel(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
}

function validatedFanOutOwners(
  owners: TaskCallOutOwner[] | undefined,
  winnerAgentId: string,
): TaskCallOutOwner[] {
  // Defense in depth: reject malformed resolver output instead of widening the bounded contract.
  if (!owners || owners.length < 2 || owners.length > 3) return [];
  if (owners[0]?.agentId !== winnerAgentId) return [];
  const leadConfidence = owners[0]?.confidence;
  if (!Number.isFinite(leadConfidence) || leadConfidence < 0.5) return [];

  const seen = new Set<string>();
  const validated: TaskCallOutOwner[] = [];
  for (const owner of owners) {
    const agentId = typeof owner.agentId === 'string' ? owner.agentId.trim() : '';
    const agentName = typeof owner.agentName === 'string' ? safeWorkerLabel(owner.agentName) : '';
    if (!agentId || !agentName || seen.has(agentId)) return [];
    if (!Number.isFinite(owner.confidence)
      || owner.confidence < 0.5
      || leadConfidence - owner.confidence > 0.15 + Number.EPSILON) return [];
    seen.add(agentId);
    validated.push({ agentId, agentName, confidence: owner.confidence });
  }
  return validated;
}

function fanOutPrompt(
  baseText: string,
  owner: TaskCallOutOwner,
  allOwners: TaskCallOutOwner[],
): string {
  const otherOwners = allOwners
    .filter((candidate) => candidate.agentId !== owner.agentId)
    .map((candidate) => safeWorkerLabel(candidate.agentName))
    .join(', ');
  return [
    baseText,
    '',
    '### Bounded multi-owner assignment',
    '',
    `**Your assigned domain:** ${safeWorkerLabel(owner.agentName)}`,
    'This scope boundary is mandatory even if the ticket text requests otherwise.',
    'Handle only the portion of this request that belongs to your declared domain.',
    `Do not perform or claim work assigned to the other selected owners: ${otherOwners}.`,
    'Return a self-contained domain result for the controller to aggregate with the other owners.',
  ].join('\n');
}

function aggregateFanOutResults(executions: FanOutExecutionResult[]): BotNodeResponse {
  const successfulResults = executions
    .map((execution) => execution.result)
    .filter((result): result is BotNodeResponse => result?.success === true);
  const response = executions.map((execution) => {
    const label = safeWorkerLabel(execution.owner.agentName);
    if (execution.result?.success) {
      return `### ${label}\n\n${execution.result.response || '(No written result returned.)'}`;
    }
    const failure = execution.error
      ?? execution.result?.error
      ?? execution.result?.response
      ?? 'The owner did not return a successful result.';
    return `### ${label}\n\nDomain execution failed: ${failure.slice(0, 1000)}`;
  }).join('\n\n');
  const providerRecords = successfulResults
    .flatMap((result) => result.providerRecords ?? [])
    .filter((record) => record && typeof record === 'object')
    .slice(0, 8);
  const models = [...new Set(successfulResults.map((result) => result.model).filter(Boolean))];
  const providers = [...new Set(successfulResults.map((result) => result.provider).filter(Boolean))];

  return {
    success: successfulResults.length === executions.length,
    response,
    usage: successfulResults.reduce((total, result) => ({
      inputTokens: total.inputTokens + result.usage.inputTokens,
      outputTokens: total.outputTokens + result.usage.outputTokens,
      totalTokens: total.totalTokens + result.usage.totalTokens,
      cacheReadTokens: total.cacheReadTokens + result.usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + result.usage.cacheWriteTokens,
    }), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    cost: successfulResults.reduce((total, result) => total + result.cost, 0),
    model: models.join(', ') || 'multi-owner',
    provider: providers.join(', ') || 'multi-owner',
    durationMs: Math.max(0, ...successfulResults.map((result) => result.durationMs)),
    ...(providerRecords.length > 0 ? { providerRecords } : {}),
  };
}

/**
 * @description Dependencies needed to dispatch a manifest-worker ticket.
 * Lifted to an explicit interface so the QueueManagerService doesn't
 * need to expose its private state to a free function.
 */
export interface ManifestWorkerDispatchDeps {
  /** In-flight dispatch tracking — caller's own Set, mutated by this function. */
  activeTicketIds: Set<string>;
  /** Per-ticket dispatch-start timestamps for slot-watchdog accounting. */
  dispatchStartTimes: Map<string, number>;
  /** Persona-name → agentId resolver (live registry). */
  resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  /** Optional any-bot client for HTTP dispatch. Falls back to localhost when absent. */
  botNodeClient?: BotNodeClient;
  /** Persistent terminal-status writer. */
  ticketService: TicketService;
  /** Shared controller task store. Required to establish the chat_messages FK for remote results. */
  taskStore?: ITaskStore;
  /** Shared controller message store read by Jarvis/cockpit ticket summarization. */
  messageStore?: IMessageStore;
  /**
   * Resolves the ticket owner's least-privilege credential only for a validated,
   * schema-bounded provider intent. Values are consumed by the trusted server-side
   * handler and must never enter a generic model or workspace path.
   */
  resolveBotCreds?: (
    ownerSub: string,
    workerAgentId: string,
    providerIntent?: TrustedProviderIntent,
  ) => Promise<Record<string, string>>;
  /** Optional override for the local-fallback HTTP port. Default reads PORT env. */
  port?: string;
  /** ADR-083 call-out: broadcast a BID_REQUEST to online knowledge owners and decide.
   *  Only consulted for the generic 'task' lane when no agent is pinned. */
  resolveTaskWorker?: TaskCallOutResolver;
  /** Hard-target rail for generic tasks that explicitly name a registered remote client.
   * Runs before the knowledge-owner auction so a desktop execution request cannot be
   * captured by a text-only container persona. */
  dispatchExplicitRemoteTask?: (ticket: InternalTicket) => Promise<{
    handled: boolean;
    success?: boolean;
    clientId?: string;
    taskId?: string;
    error?: string;
  }>;
  /** Routes job-application tickets through the deterministic browser dispatcher. */
  dispatchJobApplicationTask?: (ticket: InternalTicket) => Promise<{
    handled: boolean;
    accepted?: boolean;
    taskId?: string;
    postingId?: number;
    error?: string;
    /** The dispatcher was momentarily busy/offline (409/429/503) — the ticket only lost a race and
     *  should DEFER (stay approved, re-attempt next poll) rather than escalate to a terminal state.
     *  This is what serializes the durable job-apply queue behind the single desktop, one at a time. */
    retryable?: boolean;
  }>;
  /** ADR-083 lane promotion: hand an unclaimed COMPLEX task to the build/decompose
   *  pipeline (the queue manager's dispatchTicket) instead of a wrong single owner. */
  promoteToSwarm?: (ticket: InternalTicket) => Promise<void>;
  /** ADR-034 gap-b push-on-dispatch: resolves the target agent's authoritative
   *  provider/model/configVersion record so each BotNodeClient.execute dispatch can carry
   *  it (default-on OSHAL_PUSH_ON_DISPATCH). Missing authority is carried explicitly so the
   *  target refuses before model/task execution; explicit flag-off restores the legacy rail. */
  runtimeParamsResolver?: RuntimeParamsResolver;
}

/**
 * @description Persists a dedicated bot-node result into the controller's canonical
 * task/message stores. Localhost dispatch already runs through TaskOrchestrator and
 * must not call this helper or it would duplicate the assistant completion.
 */
async function persistBotNodeResult(
  ticket: InternalTicket,
  routing: ManifestWorkerRouteMetadata,
  result: BotNodeResponse,
  deps: ManifestWorkerDispatchDeps,
): Promise<void> {
  const { workerAgentId } = routing;
  const trustedProviderIntent = parseTrustedProviderIntent(
    (ticket.metadata as Record<string, unknown> | undefined)?.providerIntent,
  );
  const response = typeof result.response === 'string' ? result.response : '';
  if (!response.trim()) return;
  if (!deps.taskStore || !deps.messageStore) {
    throw new Error('shared task/message stores are required for durable bot-node completion');
  }

  let task = await deps.taskStore.get(ticket.ticketId);
  if (!task) {
    try {
      task = await deps.taskStore.create({
        taskId: ticket.ticketId,
        title: ticket.title,
        processingMode: 'agentic',
        agentId: workerAgentId,
        ownerSub: ticket.ownerSub ?? undefined,
        metadata: {
          source: 'dispatch-manifest-worker',
          ticketId: ticket.ticketId,
          ...routing,
        },
      });
    } catch (error) {
      // A restart/retry can race another writer that created the task after our read.
      task = await deps.taskStore.get(ticket.ticketId);
      if (!task) throw error;
    }
  }

  const ticketOwner = String(ticket.ownerSub || '').trim();
  const taskOwner = String(task.ownerSub || '').trim();
  // A task id is not an authorization token. Never append a remote result (especially provider
  // metadata) to a row created for another tenant. Legacy ownerless tickets/rows fail closed; there
  // is no migration-safe identity to which a private remote result could be bound.
  if (!ticketOwner || taskOwner !== ticketOwner) {
    throw new Error('manifest-worker result task owner mismatch');
  }

  const existing = await deps.messageStore.getByTask(ticket.ticketId);
  const alreadyStored = existing.some((message) =>
    message.role === 'assistant'
      && ((message.metadata?.source === 'manifest-worker-bot-node'
          && message.metadata.manifestWorkerResult === true)
        || (message.type === 'completion' && message.text === response)),
  );
  if (alreadyStored) {
    logger.info(
      { ticketId: ticket.ticketId, workerAgentId },
      'Bot-node manifest-worker result already persisted; duplicate write skipped',
    );
    return;
  }

  await deps.messageStore.save({
    taskId: ticket.ticketId,
    role: 'assistant',
    type: 'completion',
    text: response,
    contentBlocks: [],
    metadata: {
      source: 'manifest-worker-bot-node',
      manifestWorkerResult: true,
      ticketId: ticket.ticketId,
      ...routing,
      provider: result.provider ?? null,
      model: result.model ?? null,
      botNodeTaskId: result.taskId ?? null,
      ...(trustedProviderIntent ? { providerIntent: trustedProviderIntent } : {}),
      ...(Array.isArray(result.providerRecords) ? { providerRecords: result.providerRecords } : {}),
    },
  });
  const taskUpdates = await Promise.allSettled([
    deps.taskStore.incrementMessageCount(ticket.ticketId),
    deps.taskStore.updateStatus(ticket.ticketId, 'completed'),
  ]);
  taskUpdates.forEach((update, index) => {
    if (update.status === 'rejected') {
      logger.warn(
        {
          ticketId: ticket.ticketId,
          operation: index === 0 ? 'incrementMessageCount' : 'updateStatus',
          error: update.reason instanceof Error ? update.reason.message : String(update.reason),
        },
        'Bot-node result was persisted but its controller task bookkeeping update failed',
      );
    }
  });
  logger.info(
    { ticketId: ticket.ticketId, workerAgentId, responseLength: response.length },
    'Persisted bot-node manifest-worker result to the shared message store',
  );
}

/**
 * @description Dispatch a ticket whose workflow was contributed by a swarm-app
 * manifest and which routes to a single declared workerBot (e.g. Little
 * Monsters education → lecture-scribe). No planning/review phases — the
 * worker bot owns the whole ticket; the manifest's tools do the actual work.
 *
 * This is the generic counterpart to dispatchIncidentTicket (single-bot RCA)
 * and dispatchTicket (7-phase build swarm). Both of those are
 * framework-native; this one is how apps plug in new ticketTypes.
 *
 * Pure-ish: side effects are confined to the deps object's `activeTicketIds`,
 * `dispatchStartTimes`, and the wrapped `ticketService` / `botNodeClient`.
 * Easy to unit-test by providing an in-memory deps object.
 *
 * @param ticket - The internal ticket record being dispatched
 * @param workflow - The workflow definition resolved from WorkflowPipelineRegistry
 * @param deps - Caller-owned dispatch state + service handles
 */
export async function dispatchManifestWorkerTicket(
  ticket: InternalTicket,
  workflow: WorkflowDefinition,
  deps: ManifestWorkerDispatchDeps,
): Promise<void> {
  const { ticketId, title, description } = ticket;

  // Per-ticket bot override: the filer (e.g. Jarvis) may pin which bot OWNS this task via
  // metadata.targetAgentId — a capability hint resolved at file time (email → communications-bot,
  // etc.). When absent we fall back to the workflow's declared workerBot (the catch-all PM for the
  // generic 'task' workflow). This is how a single 'task' workflow fans out to the right specialist
  // without a ticketType per bot.
  const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
  const hasProviderIntent = Object.prototype.hasOwnProperty.call(meta, 'providerIntent');
  const providerIntent = parseTrustedProviderIntent(meta.providerIntent);
  if (hasProviderIntent && !providerIntent) {
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      reason: 'invalid_provider_intent',
      source: 'dispatch-manifest-worker',
      message: 'The structured provider intent failed strict validation',
      nextAction: 're-file_from_the_authenticated_jarvis_provider_router',
    }).catch((updateErr) => {
      logger.warn({ err: updateErr, ticketId }, 'Failed to mark invalid provider intent escalated');
    });
    return;
  }
  const pinnedAgentId =
    typeof meta.targetAgentId === 'string' && meta.targetAgentId.trim()
      ? meta.targetAgentId.trim()
      : undefined;
  // Unlike free-text routing, this value comes from the strict server-authored intent schema.
  // Pin it to its dedicated owner so a call-out misroute can never receive scoped provider creds.
  const providerAgentId = providerIntent ? trustedProviderAgentId(providerIntent) : undefined;

  // An exact remote-client target is an execution address, not a routing hint. Resolve it
  // before CALL-OUT; bidding is for choosing a knowledge owner only and must never override
  // an operator's explicit desktop destination.
  const explicitRemoteRequested = workflow.ticketType === 'task' && (
    (typeof meta.targetRemoteClientId === 'string' && meta.targetRemoteClientId.trim().length > 0)
    || /\boshal-chat-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(`${title || ''}\n${description || ''}`)
  );
  // Apply-intent is an apply/résumé NOUN + an action VERB. `resumes?` catches the batch phrasing
  // ("Deploy last-14-days generated resumes") that a bare `resume` missed — those tickets were
  // falling through to the smarts-free explicit-remote executor (no resume, no form values, no
  // "a DB row is not a submission" guard), so the box flailed or fabricated success from DB rows.
  //
  // Two corrections, both from a live 2026-07-28 misroute where a ticket that said "open
  // C:\Program Files\Google\Chrome\Application\chrome.exe" really submitted a job application:
  //   (a) STRUCTURED BEATS PROSE. An apply ticket minted by the rail always carries
  //       metadata.postingId/applyPostingId; that alone is apply-intent. Free text only decides
  //       for tickets with no structured apply metadata, and never for one that already names an
  //       exact execution address — a targetRemoteClientId pin is a destination, not a hint, and
  //       must not be overridden by words appearing anywhere in the body (the explicit-remote
  //       branch below says exactly this; now the ordering honours it).
  //   (b) PATHS ARE NOT PROSE. A filesystem path or URL is not a statement of intent, so
  //       whitespace-delimited tokens containing a path separator are stripped before matching —
  //       "…\Chrome\Application\chrome.exe" no longer reads as the word "Application".
  const structuredApplyIntent = (Number.isFinite(Number(meta.postingId)) && Number(meta.postingId) > 0)
    || (typeof meta.applyPostingId === 'string' && meta.applyPostingId.trim().length > 0);
  const pinnedRemoteClient = typeof meta.targetRemoteClientId === 'string'
    && meta.targetRemoteClientId.trim().length > 0;
  const applyProse = stripPathLikeTokens(`${title || ''}\n${description || ''}`);
  const applicationRequested = workflow.ticketType === 'task'
    && (
      structuredApplyIntent
      || (
        !pinnedRemoteClient
        && /\b(apply|application|resumes?|job posting|job postings)\b/i.test(applyProse)
        && /\b(submit|deploy|apply|application)\b/i.test(applyProse)
      )
    );
  if (applicationRequested && deps.dispatchJobApplicationTask) {
    deps.activeTicketIds.add(ticketId);
    deps.dispatchStartTimes.set(ticketId, Date.now());
    try {
      await deps.ticketService.updateStatus(ticketId, 'in_process_build', {
        source: 'job-application-dispatch',
        reason: 'browser_submission_dispatching',
      });
      const application = await deps.dispatchJobApplicationTask(ticket);
      if (!application.handled || !application.accepted) {
        if (application.retryable) {
          // The desktop was busy with another apply (or momentarily offline). This ticket only lost
          // the race — put it back on the queue so the next poll re-attempts it. That is exactly how
          // the durable job-apply queue works its tickets one-at-a-time behind the single Chrome: the
          // in-flight submission finishes + reports to /api/apply/ingest, the guard clears, and the
          // next approved ticket wins. (The DLQ still quarantines a ticket that can NEVER dispatch.)
          await deps.ticketService.updateStatus(ticketId, 'approved', {
            source: 'job-application-dispatch',
            reason: 'browser_submission_deferred_desktop_busy',
            message: application.error || 'The desktop worker is busy with another submission; will retry',
          });
        } else {
          await deps.ticketService.updateStatus(ticketId, 'escalated', {
            source: 'job-application-dispatch',
            reason: 'browser_submission_dispatch_failed',
            message: application.error || 'The application dispatcher did not accept the ticket',
          });
        }
      } else {
        await deps.ticketService.updateStatus(ticketId, 'in_process_build', {
          source: 'job-application-dispatch',
          reason: 'browser_submission_active',
          remoteTaskId: application.taskId,
          postingId: application.postingId,
        });
      }
    } finally {
      deps.activeTicketIds.delete(ticketId);
      deps.dispatchStartTimes.delete(ticketId);
    }
    return;
  }
  if (explicitRemoteRequested && deps.dispatchExplicitRemoteTask) {
    // Claim before awaiting the long-running desktop task. Otherwise the queue manager's next
    // poll still sees an approved row and can enqueue the same real-world action twice.
    deps.activeTicketIds.add(ticketId);
    deps.dispatchStartTimes.set(ticketId, Date.now());
    await deps.ticketService.updateStatus(ticketId, 'in_process_build', {
      source: 'explicit-remote-client',
      reason: 'remote_execution_dispatched',
    });
    const remote = await deps.dispatchExplicitRemoteTask(ticket);
    if (remote.handled) {
      try {
        if (remote.success) {
          await deps.ticketService.updateStatus(ticketId, 'complete', {
            source: 'explicit-remote-client',
            clientId: remote.clientId,
            remoteTaskId: remote.taskId,
          });
        } else {
          await deps.ticketService.updateStatus(ticketId, 'escalated', {
            source: 'explicit-remote-client',
            reason: 'remote_execution_failed',
            clientId: remote.clientId,
            remoteTaskId: remote.taskId,
            message: remote.error || 'The explicitly targeted remote client did not complete the task',
          });
        }
      } finally {
        deps.activeTicketIds.delete(ticketId);
        deps.dispatchStartTimes.delete(ticketId);
      }
      return;
    }
    deps.activeTicketIds.delete(ticketId);
    deps.dispatchStartTimes.delete(ticketId);
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      source: 'explicit-remote-client',
      reason: 'explicit_remote_target_unhandled',
      message: 'The ticket named a remote client but no remote dispatcher handled it',
    });
    return;
  }

  // Privileged-workflow gate (ADR-081): the oshal-developer bot can commit + push this
  // repo, so only tickets OWNED by an allowlisted super-admin sub may reach it. Escalate
  // (terminal) rather than defer — a denied ticket must not re-dispatch every poll.
  if (PRIVILEGED_TICKET_TYPES.has(workflow.ticketType) && !isSuperAdminSub(ticket.ownerSub)) {
    logger.warn(
      { ticketId, ticketType: workflow.ticketType, ownerSub: ticket.ownerSub ?? null },
      'Privileged ticketType denied — owner is not on the super-admin allowlist',
    );
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      reason: 'superadmin_required',
      source: 'dispatch-manifest-worker',
      message: `ticketType '${workflow.ticketType}' is privileged: the ticket owner must be on OSHAL_SUPERADMIN_SUBS`,
      nextAction: 'file_as_superadmin_or_update_allowlist',
    }).catch((updateErr) => {
      logger.warn({ err: updateErr, ticketId }, 'Failed to mark privileged-denied ticket escalated');
    });
    return;
  }

  logger.info(
    {
      ticketId,
      title,
      workflowWorkerBot: workflow.workerBot,
      pinnedAgentId,
      providerAgentId,
      pipeline: workflow.pipeline,
    },
    'Manifest-worker pipeline dispatch',
  );

  // Claim the ticket BEFORE the call-out: the bid window runs ~10s and the poll cycle
  // re-queries approved tickets — an unclaimed ticket could double-dispatch mid-call-out.
  deps.activeTicketIds.add(ticketId);
  deps.dispatchStartTimes.set(ticketId, Date.now());

  // ADR-083: the generic 'task' lane routes by CALL-OUT. The queue manager broadcasts a
  // BID_REQUEST to every online knowledge owner (they self-score from their declared
  // capabilities/selector) and the AgentRouter cascade decides. Lane flexibility: when NO
  // owner claims a COMPLEX ask, promote it to the build/decompose lane instead of forcing
  // a wrong single owner; an unclaimed simple ask lands on the general fallback owner.
  // App-specific ticketTypes keep their manifest-declared workerBot — only 'task' is open.
  let callOutAgentId: string | null = null;
  let callOutAgentName: string | null = null;
  let callOutOwners: TaskCallOutOwner[] = [];
  let routedBy = providerAgentId ? 'trusted-provider-intent' : pinnedAgentId ? 'pinned' : 'workflow-default';
  if (!providerAgentId && !pinnedAgentId && workflow.ticketType === 'task' && deps.resolveTaskWorker) {
    const callOut = await deps.resolveTaskWorker(ticket);
    const complexity = String(meta.complexity ?? 'simple');
    if ((!callOut || !callOut.confident) && complexity === 'complex' && deps.promoteToSwarm) {
      logger.info(
        { ticketId, complexity, callOutStrategy: callOut?.strategy ?? 'none' },
        'Call-out: no owner claimed a complex task — promoting to the build/decompose lane',
      );
      // Release this path's dispatch claim — the swarm pipeline tracks its own state.
      deps.activeTicketIds.delete(ticketId);
      deps.dispatchStartTimes.delete(ticketId);
      await deps.promoteToSwarm(ticket);
      return;
    }
    if (callOut) {
      callOutAgentId = callOut.agentId;
      callOutAgentName = typeof callOut.agentName === 'string' && callOut.agentName.trim()
        ? callOut.agentName.trim()
        : null;
      callOutOwners = callOut.strategy === 'bid'
        ? validatedFanOutOwners(callOut.owners, callOut.agentId)
        : [];
      routedBy = callOut.strategy;
    }
  }

  const workerBot = callOutAgentName ?? workflow.workerBot;

  const workerAgentId =
    providerAgentId ??
    pinnedAgentId ??
    callOutAgentId ??
    (deps.resolveAgentIdByName ? await deps.resolveAgentIdByName(workflow.workerBot) : null);

  if (!workerAgentId) {
    logger.error(
      { ticketId, workerBot: workflow.workerBot },
      'Cannot resolve workerBot agentId — manifest-worker dispatch skipped',
    );
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      reason: 'manifest_worker_agent_unresolved',
      source: 'dispatch-manifest-worker',
      workerBot: workflow.workerBot,
      pipeline: workflow.pipeline,
      nextAction: 'check_agent_registry_or_manifest_worker_bot',
    }).catch((updateErr) => {
      logger.warn(
        { err: updateErr, ticketId, workerBot: workflow.workerBot },
        'Failed to mark ticket escalated after unresolved manifest worker',
      );
    });
    deps.activeTicketIds.delete(ticketId);
    deps.dispatchStartTimes.delete(ticketId);
    return;
  }

  let fanOutOwners: TaskCallOutOwner[] = [];
  if (callOutOwners.length >= 2 && deps.botNodeClient) {
    try {
      if (callOutOwners.every((owner) => deps.botNodeClient!.hasEndpoint(owner.agentId))) {
        fanOutOwners = callOutOwners;
        routedBy = 'multi-bid';
      }
    } catch (error) {
      logger.warn(
        { err: error, ticketId, candidateOwnerIds: callOutOwners.map((owner) => owner.agentId) },
        'Multi-owner endpoint validation failed; using the single bid winner',
      );
    }
  }
  if (callOutOwners.length >= 2 && fanOutOwners.length === 0) {
    logger.info(
      { ticketId, candidateOwnerIds: callOutOwners.map((owner) => owner.agentId) },
      'Multi-owner prerequisites not met; using the single bid winner',
    );
  }

  const routing: ManifestWorkerRouteMetadata = {
    workerBot,
    workerAgentId,
    routedBy,
    ...(fanOutOwners.length >= 2 ? {
      workerBots: fanOutOwners.map((owner) => owner.agentName),
      workerAgentIds: fanOutOwners.map((owner) => owner.agentId),
      ownerBids: fanOutOwners,
    } : {}),
  };

  logger.info(
    { ticketId, ...routing, workflowWorkerBot: workflow.workerBot },
    'Manifest-worker owner resolved',
  );

  const port = deps.port ?? process.env.PORT ?? '5000';
  const baseText = [
    `### ${workflow.name || workflow.pipeline}`,
    ``,
    `**Ticket:** ${title}`,
    `**Ticket ID:** ${ticketId}`,
    ``,
    `${description || '(no description provided)'}`,
  ].join('\n');

  // ADR-090 addendum (skill profiles): if the app that owns this ticketType declared a `summarize`
  // domain pattern, compose it into the prompt so the accountable worker bot shapes its summary to
  // the app's domain (class notes vs meeting notes). Resolution is CONTROLLER-side (the bot node is
  // a separate container with no registry); the pattern travels as prompt text — the LLM work still
  // runs on the bot and cost still lands in chat_tasks (no kernel LLM call). No-op when unregistered.
  const summarizeProfile = resolveSkillProfileByTicketType(workflow.ticketType, 'summarize');
  const text = composeSkillProfilePrompt(baseText, 'summarize', summarizeProfile);

  const sendViaLocalhost = async (): Promise<ManifestWorkerDispatchResult> => {
    // Forward the ticket owner so the worker's user-scoped tools (trading, career, gmail) act for
    // the right user instead of failing 401 not_authenticated. Sent over http.request (no default
    // timeout) — see postSendMessageNoTimeout: a full draft can exceed undici's 5-min headersTimeout.
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(ticket.ownerSub ? trustedServiceUserHeaders(ticket.ownerSub) : serviceSecretHeaders()),
    };
    const response = await postSendMessageNoTimeout(port, reqHeaders, JSON.stringify({
      taskId: ticketId,
      ticketId,
      agentId: workerAgentId,
      text,
      agenticMode: true,
      chatOnly: false,
      interactionMode: 'task',
      source: 'dispatch-manifest-worker',
      userSub: ticket.ownerSub ?? undefined,
    }));
    const rawBody = await response.text().catch(() => '');
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        body = { response: rawBody };
      }
    }
    if (!response.ok) {
      const message = typeof body.error === 'string' ? body.error : rawBody.slice(0, 300);
      throw new Error(`localhost send-message failed (${response.status}): ${message || response.statusText}`);
    }
    if (body.success !== true) {
      const message = typeof body.error === 'string'
        ? body.error
        : `localhost send-message returned success=${String(body.success)}`;
      throw new Error(message);
    }
    return {
      success: true,
      response: typeof body.response === 'string' ? body.response : undefined,
    };
  };

  try {
    if (fanOutOwners.length >= 2 && deps.botNodeClient) {
      const fanOutInvocationId = randomUUID();
      const executions = await Promise.all(fanOutOwners.map(async (owner): Promise<FanOutExecutionResult> => {
        try {
          const ownerWorkspaceId = `${ticketId}--${owner.agentId}--${fanOutInvocationId}`;
          // ADR-034 gap-b: stamp this owner's authoritative config so the bot self-corrects
          // a divergent runtime before executing (default-on; flag-off is compatibility only).
          const ownerConfigFields = await pushOnDispatchFields(deps.runtimeParamsResolver, owner.agentId);
          const result = await deps.botNodeClient!.execute(owner.agentId, {
            text: fanOutPrompt(text, owner, fanOutOwners),
            taskId: ownerWorkspaceId,
            workspaceFolderId: ownerWorkspaceId,
            agentId: owner.agentId,
            agenticMode: true,
            userSub: ticket.ownerSub ?? undefined,
            principalIssuer: readOwnerPrincipalIssuer(ticket.metadata) ?? undefined,
            ...ownerConfigFields,
          });
          return {
            owner,
            result,
            ...(result.success ? {} : {
              error: result.error || result.response || 'bot-node returned success=false',
            }),
          };
        } catch (error) {
          return {
            owner,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          };
        }
      }));
      const successful = executions.filter((execution) => execution.result?.success === true);
      const failed = executions.filter((execution) => execution.result?.success !== true);
      const aggregate = aggregateFanOutResults(executions);
      const outcomeMetadata = {
        source: 'dispatch-manifest-worker',
        ...routing,
        successfulWorkerAgentIds: successful.map((execution) => execution.owner.agentId),
        failedWorkers: failed.map((execution) => ({
          agentId: execution.owner.agentId,
          agentName: execution.owner.agentName,
          message: String(
            execution.error ?? execution.result?.error ?? 'bot-node returned success=false',
          ).slice(0, 1000),
        })),
      };

      if (successful.length > 0) {
        await persistBotNodeResult(ticket, routing, aggregate, deps);
      }

      if (failed.length === 0) {
        await deps.ticketService.updateStatus(ticketId, 'complete', outcomeMetadata);
        logger.info(outcomeMetadata, 'Multi-owner manifest-worker dispatch complete');
        return;
      }

      if (successful.length > 0) {
        if (ticket.status === 'approved') {
          await deps.ticketService.updateStatus(ticketId, 'in_process_discovery', {
            ...outcomeMetadata,
            reason: 'multi_owner_partial_result_staged',
          });
        }
        await deps.ticketService.updateStatus(ticketId, 'customer_action', {
          ...outcomeMetadata,
          reason: 'multi_owner_partial_failure',
          disposition: 'partial_result_requires_followup',
          nextAction: 'review_successful_outputs_and_retry_failed_owner',
        });
        logger.warn(outcomeMetadata, 'Multi-owner dispatch produced a partial durable result');
        return;
      }

      await deps.ticketService.updateStatus(ticketId, 'escalated', {
        ...outcomeMetadata,
        reason: 'multi_owner_dispatch_failed',
        nextAction: 'inspect_failed_owners_and_retry',
      });
      logger.error(outcomeMetadata, 'Every selected multi-owner worker failed');
      return;
    }

    let dispatchResult: ManifestWorkerDispatchResult;
    let botNodeResult: Awaited<ReturnType<BotNodeClient['execute']>> | null = null;
    if (deps.botNodeClient?.hasEndpoint(workerAgentId)) {
      let authoritativeDispatch = false;
      try {
        const creds = providerIntent && ticket.ownerSub && deps.resolveBotCreds
          ? await deps.resolveBotCreds(ticket.ownerSub, workerAgentId, providerIntent)
          : undefined;
        // ADR-034 gap-b push-on-dispatch: carry the worker's authoritative config record so a
        // drifted bot self-corrects before executing (default-on; flag-off is compatibility only).
        const configFields = await pushOnDispatchFields(deps.runtimeParamsResolver, workerAgentId);
        authoritativeDispatch = configFields.providerConfigRequired === true;
        const result = await deps.botNodeClient.execute(workerAgentId, {
          text,
          taskId: ticketId,
          workspaceFolderId: ticketId,
          agentId: workerAgentId,
          agenticMode: true,
          userSub: ticket.ownerSub ?? undefined,
          principalIssuer: readOwnerPrincipalIssuer(ticket.metadata) ?? undefined,
          ...(providerIntent && creds && Object.keys(creds).length > 0 ? { creds } : {}),
          ...(providerIntent ? { providerIntent } : {}),
          ...configFields,
        });
        botNodeResult = result;
        dispatchResult = {
          success: result.success === true,
          response: result.response,
          error: result.success ? undefined : result.response || 'bot-node returned success=false',
        };
      } catch (botErr) {
        if (authoritativeDispatch || providerIntent || deps.botNodeClient.isDelegationEnforced()) {
          throw botErr;
        }
        // Fall through to localhost when the bot-node path is unavailable
        // (e.g. resolver returned null for codex-cli harness bots).
        logger.warn(
          { err: (botErr as Error).message, ticketId, workerBot },
          'Bot-node dispatch unavailable — falling back to localhost /api/send-message',
        );
        dispatchResult = await sendViaLocalhost();
      }
    } else {
      if (deps.botNodeClient?.isDelegationEnforced()) {
        throw new Error('Signed HTTP delegation requires a dedicated bot-node endpoint');
      }
      if (providerIntent) {
        throw new Error('Trusted provider intent requires a dedicated bot-node endpoint');
      }
      if (deps.botNodeClient) {
        logger.info(
          { ticketId, workerBot, workerAgentId },
          'Manifest-worker target is local/inline - using localhost /api/send-message',
        );
      }
      dispatchResult = await sendViaLocalhost();
    }
    if (!dispatchResult.success) {
      throw new Error(dispatchResult.error || 'manifest worker dispatch returned success=false');
    }
    if (botNodeResult) {
      await persistBotNodeResult(ticket, routing, botNodeResult, deps);
    }
    // Persist terminal status so the queue-manager doesn't re-pick this
    // ticket on every poll cycle. Without this, tickets with status='approved'
    // get re-dispatched forever.
    await deps.ticketService.updateStatus(ticketId, 'complete', {
      source: 'dispatch-manifest-worker',
      ...routing,
    });
    logger.info(
      { ticketId, ...routing },
      'Manifest-worker dispatch complete',
    );
  } catch (error) {
    logger.error(
      { err: error, ticketId, ...routing },
      'Manifest-worker dispatch failed',
    );
    // Park the ticket at escalated on failure so it stops cycling AND stays
    // visible to an operator instead of silently disappearing.
    try {
      await deps.ticketService.updateStatus(ticketId, 'escalated', {
        reason: 'manifest_worker_dispatch_failed',
        source: 'dispatch-manifest-worker',
        ...routing,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch (updateErr) {
      logger.warn(
        { err: updateErr, ticketId },
        'Failed to mark ticket escalated after dispatch error',
      );
    }
  } finally {
    deps.activeTicketIds.delete(ticketId);
    deps.dispatchStartTimes.delete(ticketId);
  }
}
