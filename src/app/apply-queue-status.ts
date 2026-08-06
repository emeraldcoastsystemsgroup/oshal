/**
 * Apply Queue Status — one snapshot of "what is my desktop actually doing right now".
 *
 * The durable apply rail spreads its state across three places that never agreed with each other on
 * screen: the tickets table (what is queued / in flight / done), the in-flight registry (which
 * submission holds the single per-user slot, incl. entries rehydrated after a restart), and the
 * remote-client registry (whether the desktop box is even connected). An operator watching the
 * cockpit had no way to see any of it, so a wedged worker looked identical to a slow one.
 *
 * This composes all three into the shape a queue surface renders directly — deliberately including
 * the WEDGE signal, because that is the failure this queue actually has. `pickApplyClient` treats a
 * worker with a non-empty task queue as unavailable (it heartbeats but has stopped claiming), which
 * makes the durable queue pause instead of shredding tickets. Correct behaviour, invisible symptom:
 * from the cockpit "paused because the box stopped claiming" and "nothing queued" looked the same.
 * `worker.wedged` names it, so the surface can say "restart the desktop client" instead of nothing.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial apply queue snapshot:
 *   per-user ticket lanes + the live in-flight slot + desktop worker reachability (online/healthy/
 *   claiming), with the wedged-worker case named explicitly rather than shown as an empty queue.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | listApplyWorkers() enumerates
 *   every screen-control-capable leaf node (+ the default) for the target-computer dropdown;
 *   describeApplyWorker(preferredClientId) + the snapshot now reflect the SELECTED node, and each
 *   queue item carries its pinned targetClientId/targetHostname.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: the candidate set is
 *   owner-scoped. These functions feed the target-computer dropdown on a requiresAuth (NOT
 *   operator-gated) mount, so enumerating every registered node handed each signed-in user the
 *   client id of every other user's desktop — and that id is exactly what pins dispatch. All three
 *   entry points now take the requester and filter through filterUsableDevices.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reuse the generic dispatcher's exact browser-control and browser-pilot-consent predicate so unauthorized execution-only nodes are neither listed nor reported ready.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Extract queue-row projection from snapshot orchestration to keep each function below the repository limit without changing RLS reads or lane accounting.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Project exact assigned-worker truth and explicit failed/assist-review states so an idle orphan never renders as active work.
 *
 * @module app/apply-queue-status
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  isAuthorizedBrowserWorker,
  NO_AUTHORIZED_BROWSER_WORKER_ERROR,
} from '@/app/browser-worker-eligibility';
import {
  APPLY_WORKER_ACK_TIMEOUT_MS,
  applyInFlight,
  type ApplyInFlight,
} from '@/app/apply-inflight';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { filterUsableDevices, type DeviceRequester, type RemoteClientRecord } from '@/features/remote-client';

const logger = createChildLogger({ module: 'apply-queue-status' });

/** Ticket status → the lane an operator understands. Anything unmapped lands in `other`. */
const LANE_BY_STATUS: Record<string, ApplyLane> = {
  approved: 'queued',
  backlog: 'queued',
  in_process_build: 'submitting',
  complete: 'applied',
  customer_action: 'needs_you',
  paused: 'needs_you',
  escalated: 'failed',
  dead_letter: 'failed',
  cancelled: 'dismissed',
};

export type ApplyLane = 'queued' | 'submitting' | 'applied' | 'needs_you' | 'failed' | 'dismissed' | 'other';
export type ApplyExecutionState =
  | 'queued' | 'assigned' | 'working' | 'no_worker' | 'callback_pending'
  | 'needs_review' | 'failed' | 'submitted' | 'dismissed' | 'other';

/** One queued/finished submission as the queue surface shows it. */
export interface ApplyQueueItem {
  ticketId: string;
  postingId: number | null;
  lane: ApplyLane;
  status: string;
  title: string;
  company: string | null;
  jobUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Milliseconds this submission has held the desktop slot (submitting lane only). */
  inFlightMs?: number;
  /** How many story beats the worker has reported for this ticket so far. */
  beats?: number;
  /** The leaf node the operator pinned for this submission (null = auto-pick). */
  targetClientId?: string | null;
  /** That node's hostname when it is currently registered, else null (offline / unknown). */
  targetHostname?: string | null;
  /** Exact worker selected by dispatch, not merely the requested/default target. */
  assignedClientId?: string | null;
  assignedHostname?: string | null;
  /** Truthful state derived from the ticket, exact in-flight record, and assigned worker heartbeat. */
  executionState: ApplyExecutionState;
  executionDetail: string;
}

/** Whether the desktop box can actually be handed a submission right now, and if not, why. */
export interface ApplyWorkerStatus {
  connected: boolean;
  clientId: string | null;
  hostname: string | null;
  status: string | null;
  healthy: boolean;
  /** Tasks sitting unclaimed on the node. Non-zero with a live heartbeat == the claim loop is wedged. */
  taskQueueDepth: number;
  lastSeenAt: string | null;
  /** True when the worker is connected but has stopped claiming — the queue is paused, not idle. */
  wedged: boolean;
  /** True when a submission can be dispatched right now. */
  available: boolean;
  /** Operator-facing one-liner: what is true, and what to do about it. */
  detail: string;
}

/** One selectable leaf node in the target-computer dropdown (the operator's desktop or a remote leaf). */
export interface ApplyWorkerOption {
  clientId: string;
  hostname: string | null;
  online: boolean;
  healthy: boolean;
  taskQueueDepth: number;
  wedged: boolean;
  available: boolean;
  /** The node the dispatcher would auto-pick when the operator makes no explicit choice. */
  isDefault: boolean;
  lastSeenAt: string | null;
  /** Short per-node status ("ready" / "busy" / "not claiming — restart it" / "offline"). */
  state: string;
}

/**
 * All explicitly browser-authorized nodes THIS requester may drive (the dropdown's candidate set).
 * Owner-scoped: the dropdown is a list of real people's desktops, so enumerating it unfiltered both
 * leaked the fleet to every signed-in user and offered them a machine they must not be able to pick.
 */
function applyCandidates(requester: DeviceRequester): RemoteClientRecord[] {
  try { return filterUsableDevices(requester, remoteClientRegistry.listClients().filter(isAuthorizedBrowserWorker)); } catch { return []; }
}

const nodeHost = (c: RemoteClientRecord): string =>
  String((c as { tailnetHostname?: string }).tailnetHostname || '').trim().toLowerCase();

/**
 * @description The node the dispatcher auto-picks with no explicit choice — mirrors `pickApplyClient`'s
 * preference order (env pin → preferred hostname → any remote → first), but WITHOUT the draining
 * filter so the default is still identifiable when it is wedged. Exported for the queue snapshot.
 * @param cands - The candidate node set.
 * @returns The default node, or null when nothing can run an apply.
 */
function pickDefaultNode(cands: RemoteClientRecord[]): RemoteClientRecord | null {
  const preferredId = (process.env.APPLY_EDGE_CLIENT_ID || '').trim();
  const preferredHost = (process.env.APPLY_EDGE_HOSTNAME || 'edge-node-1').trim().toLowerCase();
  return (preferredId ? cands.find((c) => c.clientId === preferredId) : undefined) ??
    cands.find((c) => nodeHost(c) === preferredHost) ??
    cands.find((c) => nodeHost(c).length > 0) ??
    cands[0] ?? null;
}

/** Derive the online/wedged/available booleans + a short label for one node. */
function nodeState(c: RemoteClientRecord): { online: boolean; healthy: boolean; depth: number; wedged: boolean; available: boolean; state: string } {
  const status = String(c.status ?? 'online');
  const healthy = c.healthy ?? true;
  const depth = Number((c as { taskQueueDepth?: number }).taskQueueDepth ?? 0);
  const online = status === 'online' && healthy;
  const wedged = online && depth > 0;      // one-at-a-time dispatch → unclaimed tasks == dead claim loop
  const available = online && depth === 0;
  const state = !online ? (healthy ? 'offline' : 'unhealthy')
    : wedged ? 'connected but not claiming — restart it'
      : 'ready';
  return { online, healthy, depth, wedged, available, state };
}

/**
 * @description List the screen-control-capable leaf nodes THIS caller can target, with per-node
 * availability and which one is the default. This is the source for the "target computer" dropdown.
 * Scoped to the caller's own devices — a user must never be shown, or be able to select, someone
 * else's desktop (operators still see the whole fleet, as everywhere else).
 * @param requester - The signed-in caller the list is scoped to.
 * @returns The nodes + the default clientId (null when none are connected).
 */
export function listApplyWorkers(requester: DeviceRequester): { workers: ApplyWorkerOption[]; defaultClientId: string | null } {
  const cands = applyCandidates(requester);
  const def = pickDefaultNode(cands);
  const workers = cands.map((c) => {
    const s = nodeState(c);
    return {
      clientId: c.clientId,
      hostname: (c as { tailnetHostname?: string }).tailnetHostname ?? null,
      online: s.online, healthy: s.healthy, taskQueueDepth: s.depth,
      wedged: s.wedged, available: s.available,
      isDefault: def?.clientId === c.clientId,
      lastSeenAt: (c as { lastSeenAt?: string | null }).lastSeenAt ?? null,
      state: s.state,
    };
  });
  return { workers, defaultClientId: def?.clientId ?? null };
}

export interface ApplyQueueSnapshot {
  worker: ApplyWorkerStatus;
  counts: Record<ApplyLane, number>;
  items: ApplyQueueItem[];
  /** The submission currently holding this user's single desktop slot, if any. */
  active: {
    ticketId: string; postingId: number; ageMs: number;
    clientId: string | null; executionState: ApplyExecutionState;
  } | null;
  at: string;
}

/** Values shared while projecting one RLS-scoped ticket row into its queue item. */
interface ApplyQueueProjectionContext {
  counts: Record<ApplyLane, number>;
  mine: ApplyInFlight[];
  hostById: Map<string, string | null>;
  clientById: Map<string, RemoteClientRecord>;
  now: number;
}

/** Convert the exact assigned worker's public heartbeat into a non-ambiguous UI state. */
function executionProjection(
  lane: ApplyLane,
  inFlight: ApplyInFlight | undefined,
  context: ApplyQueueProjectionContext,
  recoveryState: string,
): { executionState: ApplyExecutionState; executionDetail: string } {
  if (lane === 'queued') return { executionState: 'queued', executionDetail: 'Queued; no worker has claimed it yet.' };
  if (lane === 'needs_you') return { executionState: 'needs_review', executionDetail: recoveryState === 'assist_review'
    ? 'Submission outcome unknown. Confirm it with the employer before retrying.' : 'Human action is required.' };
  if (lane === 'failed') return { executionState: 'failed', executionDetail: 'The run stopped and is not progressing.' };
  if (lane === 'applied') return { executionState: 'submitted', executionDetail: 'A completion record exists; see its provenance.' };
  if (lane === 'dismissed') return { executionState: 'dismissed', executionDetail: 'This application was dismissed.' };
  if (lane !== 'submitting' || !inFlight) return { executionState: 'no_worker', executionDetail: 'No worker picked this up.' };
  if (inFlight.callbackPending) return { executionState: 'callback_pending', executionDetail: 'Worker finished; trusted result settlement is pending.' };
  const worker = inFlight.clientId ? context.clientById.get(inFlight.clientId) : undefined;
  if (worker?.activeTaskId === inFlight.taskId) return { executionState: 'working', executionDetail: 'Claimed and running on the assigned worker.' };
  if (Number(worker?.taskQueueDepth || 0) > 0) return { executionState: 'assigned', executionDetail: 'Assigned; waiting for the worker to claim it.' };
  if (context.now - inFlight.startedAt < APPLY_WORKER_ACK_TIMEOUT_MS) return { executionState: 'assigned', executionDetail: 'Assigned; waiting for the worker acknowledgement window.' };
  return { executionState: 'no_worker', executionDetail: 'No worker picked this up; recovery is moving it to review.' };
}

/** @description Projects one database ticket and increments its canonical lane count. */
function projectApplyQueueItem(
  row: Record<string, unknown>,
  context: ApplyQueueProjectionContext,
): ApplyQueueItem {
  const status = String(row.status || '');
  const lane = LANE_BY_STATUS[status] ?? 'other';
  context.counts[lane] += 1;
  const ticketId = String(row.ticket_id);
  const inFlight = context.mine.find((task) => task.ticketId === ticketId);
  const targetClientId = row.target_client != null ? String(row.target_client) : null;
  const assignedClientId = inFlight?.clientId ?? null;
  const execution = executionProjection(
    lane, inFlight, context, String(row.recovery_state || ''),
  );
  return {
    ticketId,
    postingId: row.posting_id != null ? Number(row.posting_id) : null,
    lane, status, title: String(row.title || ''),
    company: row.company != null ? String(row.company) : null,
    jobUrl: row.job_url != null ? String(row.job_url) : null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
    targetClientId,
    targetHostname: targetClientId ? (context.hostById.get(targetClientId) ?? null) : null,
    assignedClientId,
    assignedHostname: assignedClientId ? (context.hostById.get(assignedClientId) ?? null) : null,
    ...execution,
    ...(inFlight ? { inFlightMs: context.now - inFlight.startedAt } : {}),
  };
}

/**
 * @description Describe ONE target node's reachability the way an operator needs to read it —
 * connected/claiming/available, with the wedged case called out by name. Mirrors the availability
 * rule in `pickApplyClient` (online + healthy + draining + explicit browser capability/consent) so the surface never
 * reports "ready" for a box the dispatcher would refuse.
 * @param preferredClientId - The node the operator explicitly selected in the dropdown. When it is a
 *   live candidate, its status is reported; otherwise (or when omitted) the auto-picked default is.
 * @param requester - The signed-in caller; candidates are scoped to devices they may drive, so a
 *   node belonging to someone else reads as "not connected" rather than reporting its real state.
 * @returns The worker status, including a plain-language detail line.
 */
export function describeApplyWorker(preferredClientId: string | undefined, requester: DeviceRequester): ApplyWorkerStatus {
  const cands = applyCandidates(requester);
  const wanted = (preferredClientId || '').trim();
  const chosen = (wanted ? cands.find((c) => c.clientId === wanted) : undefined) ?? pickDefaultNode(cands);

  if (!chosen) {
    return {
      connected: false, clientId: null, hostname: null, status: null, healthy: false,
      taskQueueDepth: 0, lastSeenAt: null, wedged: false, available: false,
      detail: `${NO_AUTHORIZED_BROWSER_WORKER_ERROR} Install and start an owned OSHAL leaf client with browser control and explicit browser-pilot consent.`,
    };
  }

  const s = nodeState(chosen);
  const host = (chosen as { tailnetHostname?: string }).tailnetHostname;
  const label = host ? `"${host}"` : 'The desktop worker';
  const detail = !s.online
    ? `${label} is ${s.healthy ? String(chosen.status ?? 'offline') : 'unhealthy'} — the queue waits until it reconnects.`
    : s.wedged
      ? `${label} is connected but has stopped claiming work (${s.depth} task${s.depth === 1 ? '' : 's'} unclaimed). The queue is PAUSED, not lost — restart the OSHAL leaf client on that machine to resume.`
      : `${label} is connected and claiming work.`;

  return {
    connected: true,
    clientId: chosen.clientId,
    hostname: host ?? null,
    status: String(chosen.status ?? 'online'), healthy: s.healthy, taskQueueDepth: s.depth,
    lastSeenAt: (chosen as { lastSeenAt?: string | null }).lastSeenAt ?? null,
    wedged: s.wedged, available: s.available, detail,
  };
}

/**
 * @description Build the full queue snapshot for one signed-in user: desktop worker state, their
 * apply tickets bucketed into lanes, and which submission currently holds the desktop slot. Read-only
 * and RLS-scoped — the ticket read runs under the caller's own identity, so a user only ever sees
 * their own submissions.
 * @param ctx - App context (pool).
 * @param userSub - The signed-in caller's OIDC sub.
 * @param limit - Max tickets to return (newest first), default 100.
 * @param preferredClientId - Optional node the operator selected, so `worker` reflects THAT node.
 * @returns The snapshot; on a read failure, an empty queue with the worker status still populated.
 */
export async function getApplyQueueSnapshot(ctx: AppContext, userSub: string, limit = 100, preferredClientId?: string): Promise<ApplyQueueSnapshot> {
  const requester: DeviceRequester = { sub: userSub };
  const worker = describeApplyWorker(preferredClientId, requester);
  const counts: Record<ApplyLane, number> = {
    queued: 0, submitting: 0, applied: 0, needs_you: 0, failed: 0, dismissed: 0, other: 0,
  };
  const at = new Date().toISOString();

  // The single per-user desktop slot (includes entries rehydrated from Postgres after a restart).
  const mine = [...applyInFlight.values()].filter((t) => t.userSub === userSub);
  const now = Date.now();
  const clients = applyCandidates(requester);
  const clientById = new Map(clients.map((client) => [client.clientId, client]));
  const hostById = new Map(clients.map((client) => [
    client.clientId, (client as { tailnetHostname?: string }).tailnetHostname ?? null,
  ]));
  const activeState = mine[0]
    ? executionProjection('submitting', mine[0], { counts, mine, hostById, clientById, now }, '')
    : null;
  const active = mine.length
    ? {
      ticketId: mine[0].ticketId ?? '', postingId: mine[0].postingId,
      ageMs: now - mine[0].startedAt, clientId: mine[0].clientId ?? null,
      executionState: activeState?.executionState ?? 'no_worker',
    }
    : null;

  if (!ctx.pool) return { worker, counts, items: [], active, at };

  try {
    const { rows } = await runWithRequestIdentity({ sub: userSub, isOperator: false }, () => ctx.pool!.query(
      `SELECT ticket_id, title, status, created_at, updated_at,
              metadata->>'applyPostingId'       AS posting_id,
               metadata->>'company'              AS company,
               metadata->>'jobUrl'               AS job_url,
               metadata->>'targetRemoteClientId' AS target_client,
               metadata->>'applyRecoveryState'   AS recovery_state
         FROM tickets
        WHERE metadata->>'source' = 'apply-enqueue'
        ORDER BY updated_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(500, limit))],
    ));

    const projection = { counts, mine, hostById, clientById, now };
    const items = (rows as Array<Record<string, unknown>>)
      .map((row) => projectApplyQueueItem(row, projection));

    return { worker, counts, items, active, at };
  } catch (err) {
    logger.error({ err, userSub }, 'apply queue snapshot: ticket read failed');
    return { worker, counts, items: [], active, at };
  }
}
