/**
 * Browser-task dispatch — the GENERIC rail for "run a browser-driving task on a chosen swarm leaf
 * node." Domain-agnostic by construction: it picks the worker, builds the `codex.exec` envelope, and
 * enqueues it to the remote-client mesh. The CALLER supplies everything app-specific — the operator
 * bot's `fromAgentId`, the prompt (the browser instructions), and any pre-staged workspace — so no
 * application's vocabulary lives in this path.
 *
 * This is the shared spine under BOTH job-application submission ([apply-dispatch.ts](./apply-dispatch.ts))
 * and LinkedIn profile updates ([profile-studio-dispatch.ts](./profile-studio-dispatch.ts)). Per ADR-036
 * the controller may orchestrate freely (it never calls an LLM — the codex reasoning runs on the leaf
 * node); what it must NOT do is bake one app's domain into a shared path. Before this module those two
 * flows each hand-rolled the same pick+envelope+enqueue with a career-hunter agent id and résumé/ATS
 * wording compiled in. Extracting the mechanics here keeps the rail generic and the domain content at
 * each call site, which is the reusable shape a third browser-driving app would ride unchanged.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the generic
 *   browser-task dispatch rail (pickApplyClient + dispatchBrowserTask + DispatchResult) out of
 *   apply-dispatch, so career-apply and linkedin-profile share ONE domain-agnostic dispatcher and
 *   supply their own agent id + prompt. No behaviour change to either flow — same envelope, same
 *   worker-pick order, same one-at-a-time semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: node selection is now
 *   owner-scoped. Selection filtered ONLY on liveness, so on a multi-user swarm any signed-in user
 *   could drive any other user's desktop: /api/apply-operator is requiresAuth (not operator-gated)
 *   and passes a request-body `targetRemoteClientId` straight through as the pin — giving codex.exec
 *   at sandbox=danger-full-access on someone else's machine, with the requester's résumé staged into
 *   their workspace. Candidates now run through filterUsableDevices(requester) BEFORE the preference
 *   order, so a foreign pin resolves to null instead of executing. Requester = the task's userSub, or
 *   an explicit `system` flag; neither present = fail closed. Operators and (with the existing
 *   OSHAL_ALLOW_LEGACY_UNOWNED escape) unowned devices are unchanged, so the operator's own
 *   single-node setup keeps working. Guard: tests/unit/browser-task-dispatch.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Await PostgreSQL-authoritative task enqueue and cross into system identity only for explicitly platform-originated dispatches; user work retains its request identity for owner RLS.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Carry optional one-use completion capability metadata at the task envelope level so trusted remote runtime code can report strict results without exposing tokens, callback URLs, subjects, or operations to codex arguments.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Add async post-selection callback preparation with a matching enqueue-failure rollback hook, allowing callers to bind capabilities to the exact chosen client without weakening the generic rail.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: require the shared exact browser-worker capability and per-node pilot-consent gate before owner-scoped selection; generic codex/shell devices and marker aliases now fail closed behind one non-enumerating refusal.
 *
 * @module app/browser-task-dispatch
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { A2ATaskCompletionCallback } from '@/shared/types';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import {
  isAuthorizedBrowserWorker,
  NO_AUTHORIZED_BROWSER_WORKER_ERROR,
} from '@/app/browser-worker-eligibility';
import { filterUsableDevices, type DeviceRequester, type RemoteClientRecord } from '@/features/remote-client';

const logger = createChildLogger({ module: 'browser-task-dispatch' });

/** Fallback control-plane URL the box POSTs its result back to (the LAN-reachable controller). A
 *  registered client's own `controlPlaneUrl` is preferred — it's the URL that box proved it can reach. */
const CONTROLLER_URL = (process.env.APPLY_CONTROLLER_URL || process.env.LORA_CONTROLLER_URL || 'http://localhost:35457').replace(/\/+$/, '');

/** The dispatch outcome returned to a route/caller. */
export interface DispatchResult { ok: boolean; clientId?: string; taskId?: string; error?: string; }

/** @description Exact selected-node context supplied to prompt and capability preparation callbacks. */
export interface BrowserTaskSelectionContext {
  controllerUrl: string;
  client: RemoteClientRecord;
}

/** @description Trusted metadata prepared after selection plus rollback for a rejected enqueue. */
export interface BrowserTaskCompletionPreparation {
  completionCallback: A2ATaskCompletionCallback;
  onEnqueueFailure?: () => Promise<void>;
}

/**
 * @description Pick the desktop/remote leaf node to drive — a REAL browser-capable worker
 * (advertises an execution tool, exact `browser_control`, and exact `browser_pilot_consent`, while
 * draining its queue), never the controller's own node.
 * Order: explicit override → `APPLY_EDGE_CLIENT_ID` → hostname match (`APPLY_EDGE_HOSTNAME`) → any
 * online remote box → first online worker.
 *
 * A worker whose task queue is NOT drained has stopped claiming — its heartbeat thread can stay alive
 * (still "online", still healthy) while the claim loop is wedged, which is exactly what happened
 * 2026-07-21: tasks queued, zero claimed, and every dispatch burned a ticket. We dispatch strictly one
 * at a time, so a non-empty queue here always means "the last one was never picked up" → treat it as
 * unavailable, so the caller returns 503 retryable and the durable queue PAUSES rather than shredding
 * itself while the desktop is wedged/asleep. (Kept the historical name `pickApplyClient` — importers
 * and the queue-status describer mirror this exact rule.)
 *
 * OWNERSHIP IS PART OF THE FILTER, not a later check: a leaf node is somebody's real desktop, so the
 * candidate set is narrowed to the devices this requester may drive BEFORE any preference order runs.
 * That is what stops an explicit pin (`preferredClientId`, which arrives from a REQUEST BODY on the
 * apply routes) from naming another user's machine — a foreign pin now resolves to null (clean "no
 * worker" error) instead of executing on their box.
 * @param preferredClientId - Optional exact client id to prefer over the env pin.
 * @param requester - Identity the work is on behalf of; devices are filtered to what it may drive.
 * @returns The chosen worker, or null when no browser-capable node is available to this requester.
 */
export function pickApplyClient(preferredClientId: string | undefined, requester: DeviceRequester): RemoteClientRecord | null {
  const preferredId = (preferredClientId || process.env.APPLY_EDGE_CLIENT_ID || '').trim();
  const preferredHost = (process.env.APPLY_EDGE_HOSTNAME || 'edge-node-1').trim().toLowerCase();
  let clients: RemoteClientRecord[] = [];
  try { clients = remoteClientRegistry.listClients(); } catch { clients = []; }
  const host = (c: RemoteClientRecord): string => String((c as { tailnetHostname?: string }).tailnetHostname || '').trim().toLowerCase();
  const draining = (c: RemoteClientRecord): boolean => Number((c as { taskQueueDepth?: number }).taskQueueDepth ?? 0) === 0;
  const online = filterUsableDevices(requester, clients.filter((c) =>
    (c.status ?? 'online') === 'online' && (c.healthy ?? true) && draining(c) &&
    isAuthorizedBrowserWorker(c)));
  if (preferredId) return online.find((c) => c.clientId === preferredId) ?? null;
  const match = online.find((c) => host(c) === preferredHost);
  if (match) return match;
  return online.find((c) => host(c).length > 0) ?? online[0] ?? null;
}

/** The absolute control-plane URL the given box POSTs results back to (its own registered URL wins). */
export function callbackControllerUrl(client: RemoteClientRecord): string {
  const registered = String((client as { controlPlaneUrl?: string }).controlPlaneUrl || '').trim();
  return (registered || CONTROLLER_URL).replace(/\/+$/, '');
}

/** One browser-driving task to run on a chosen leaf node. Everything app-specific is supplied here. */
export interface BrowserTaskInput {
  /** Unique task id (also the workspace folder id when a packet was pre-staged). */
  taskId: string;
  /** Correlation id for the run (defaults to taskId) — e.g. the originating ticket id. */
  correlationId?: string;
  /** The APP's operator bot identity the task is attributed to (never hardcoded in this rail). */
  fromAgentId: string;
  /** The browser instructions. A function form receives the chosen worker's callback URL, for prompts
   *  that must embed the exact control-plane URL the box will POST results back to. */
  prompt: string | ((ctx: BrowserTaskSelectionContext) => string);
  /** codex sandbox level (OS input needs danger-full-access). */
  sandbox?: string;
  /** Optional codex model override. */
  model?: string;
  /** Set when the caller pre-staged a packet into the task's workspace folder (the node syncs it). */
  workspacePath?: string;
  /** One-use callback metadata consumed only by trusted remote runtime code. Never copied into
   *  `input.arguments`, logs, workspace files, or the model-visible prompt. */
  completionCallback?: A2ATaskCompletionCallback;
  /** Optional async mint/bind hook invoked only after exact node selection. It must roll back any
   *  partial state itself when it throws; a returned rollback runs if durable enqueue then fails. */
  prepareCompletionCallback?: (
    ctx: BrowserTaskSelectionContext,
  ) => Promise<BrowserTaskCompletionPreparation>;
  /** The operator's chosen leaf node; omitted → auto-pick. */
  preferredClientId?: string;
  /** The end-user OIDC sub this task is on behalf of. Two jobs: the leaf-node cost-capture hook
   *  attributes spend per-owner (budget caps), AND it is the identity the device ownership filter
   *  scopes node selection to. Omitted without `system` → NO device is eligible (fail closed). */
  userSub?: string;
  /** Platform-originated work with no end user to scope to (schedulers, maintenance). Set this ONLY
   *  for traffic that originates inside the platform — never for anything carrying user input. */
  system?: boolean;
}

/**
 * @description Enqueue a browser-driving `codex.exec` task to a chosen leaf node. Never throws — a
 * missing/offline/wedged worker returns `{ ok:false, error }` so the caller surfaces a clean message.
 * Results flow back asynchronously via whatever callback the caller's prompt embedded. Domain-agnostic:
 * the app supplies the agent id, the prompt, and any staged workspace; this only does pick+envelope+enqueue.
 * @param input - The task to dispatch.
 * @returns The dispatch outcome (clientId + taskId when enqueued).
 */
export async function dispatchBrowserTask(input: BrowserTaskInput): Promise<DispatchResult> {
  // Fail closed: no user sub and not explicitly platform-originated = unknown requester, which the
  // ownership filter denies outright rather than letting it inherit whichever desktop is online.
  const requester: DeviceRequester = input.system ? { system: true } : { sub: input.userSub ?? null };
  const client = pickApplyClient(input.preferredClientId, requester);
  if (!client) {
    return { ok: false, error: NO_AUTHORIZED_BROWSER_WORKER_ERROR };
  }
  const controllerUrl = callbackControllerUrl(client);
  const selection = { controllerUrl, client };
  let preparation: BrowserTaskCompletionPreparation | undefined;
  try {
    const prompt = typeof input.prompt === 'function' ? input.prompt(selection) : input.prompt;
    preparation = await prepareCompletion(input, selection);
    const envelope = browserTaskEnvelope(input, client, prompt, preparation?.completionCallback);
    const enqueue = () => remoteClientRegistry.enqueueTask(client.clientId, envelope);
    const task = input.system ? await runWithSystemIdentity(enqueue) : await enqueue();
    logger.info(
      { clientId: client.clientId, taskId: task.taskId, fromAgentId: input.fromAgentId, staged: Boolean(input.workspacePath), controllerUrl },
      'browser task dispatched to leaf node',
    );
    return { ok: true, clientId: client.clientId, taskId: task.taskId };
  } catch (err) {
    await rollbackCompletionPreparation(preparation, input.taskId);
    const error = err instanceof Error ? err.message : 'enqueue failed';
    logger.error({ err, clientId: client.clientId }, 'browser task dispatch failed');
    return { ok: false, error };
  }
}

/** @description Resolves exactly one direct or post-selection callback descriptor. */
async function prepareCompletion(
  input: BrowserTaskInput,
  selection: BrowserTaskSelectionContext,
): Promise<BrowserTaskCompletionPreparation | undefined> {
  if (input.completionCallback && input.prepareCompletionCallback) {
    throw new Error('Browser task cannot supply both callback preparation forms');
  }
  if (input.prepareCompletionCallback) return input.prepareCompletionCallback(selection);
  return input.completionCallback ? { completionCallback: input.completionCallback } : undefined;
}

/** @description Builds an envelope whose trusted callback is a sibling, never a tool argument. */
function browserTaskEnvelope(
  input: BrowserTaskInput,
  client: RemoteClientRecord,
  prompt: string,
  completionCallback?: A2ATaskCompletionCallback,
): Record<string, unknown> {
  return {
    taskId: input.taskId,
    correlationId: input.correlationId || input.taskId,
    fromAgentId: input.fromAgentId,
    toAgentId: client.agentId || client.clientId,
    intent: 'mcp.call-tool' as const,
    input: {
      name: 'codex.exec',
      arguments: { prompt, sandbox: input.sandbox ?? 'danger-full-access', ...(input.model ? { model: input.model } : {}) },
    },
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(completionCallback ? { completionCallback } : {}),
    ...(input.userSub ? { userSub: input.userSub } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** @description Runs caller rollback after enqueue refusal and logs rollback failures without secrets. */
async function rollbackCompletionPreparation(
  preparation: BrowserTaskCompletionPreparation | undefined,
  taskId: string,
): Promise<void> {
  if (!preparation?.onEnqueueFailure) return;
  try { await preparation.onEnqueueFailure(); }
  catch (error) { logger.error({ err: error, taskId }, 'browser task callback rollback failed'); }
}
