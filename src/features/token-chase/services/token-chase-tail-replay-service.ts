/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase tail-replay consumer (ADR-046 §1/§8, the "Still Proposed" forward-only tail replay): from a chosen frame N, restage the workspace tree as-of that frame from its content-addressed snapshot, then replay frames N..end each on the accountable bot node (replayCall), determinism-gate each replayed frame against its capture, and STOP at the first divergence reporting WHICH frame + why. Pinned tool-reads are served from the captured history (they ride in the sent prompt); unpinned reads fall through with an explicit per-frame warning. Frames captured before the pins/workspaceTree fields landed still single-replay unchanged (backward compat).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The controller no longer restores or replays anything (BACKLOG "Workspace-bound checkpoint and tail replay"): replayForward delegates the whole hermetic no-edit tail — worktree restore from frame N's checkpoint commit, owner-store restore, captured responses served with their workspace tools re-executed, live tools refused, artifact tree + store version compared with final.json — to the bot node that produced the run through BotNodeTailReplayClient (POST /api/token-chase/replay-tail) and relays its verdict. The controller-side restage (restageTree/stageOne, the manifest normalizers and the OS-temp replay root) is gone; 'no-endpoint' stays fail-closed with NO node call. The per-frame prompt re-fire determinism verdict (replayCall + assessDeterminism) is kept as the optional `refire` mode, off by default so a plain tail replay spends nothing.
 */

import { createChildLogger } from '@/shared/logger';
import {
  BotNodeClient,
  BotNodeTailReplayClient,
  createRegistryEndpointResolver,
  type TailReplayNodeArtifacts,
  type TailReplayNodeFrame,
  type TailReplayNodeRequest,
  type TailReplayNodeResponse,
  type TailReplayNodeRestore,
  type TailReplayNodeStatus,
  type TailReplayNodeStore,
  type TailReplayNodeStoreVersion,
} from '@/features/agent-management';
import {
  TokenChaseReadService,
  type TokenChaseAccess,
  type TokenChaseFrameDetail,
} from './token-chase-read-service';
import { assessDeterminism, type DeterminismVerdict } from './determinism-verdict';
import type { ReplayStatus } from './token-chase-replay-service';

const logger = createChildLogger({ module: 'token-chase-tail-replay-service' });

/** @description The per-frame outcome status of the optional prompt re-fire mode — the single-call
 *  determinism verdict widened with the tail's stop pre-conditions (reuses the step-2 status union). */
export type TailFrameStatus = ReplayStatus;

/** @description The freshly re-fired response's accountable metrics, echoed back per re-fired frame. */
export interface TailReplayCallResponse {
  success: boolean;
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: number;
  model: string | null;
  provider: string | null;
  latencyMs: number;
  error?: string;
}

/** @description The narrow bot-node contract the tail replay depends on: the hermetic tail runs on the
 *  accountable node (replayTail), and the optional prompt re-fire lands there too (replayCall). Never the
 *  controller. The real clients satisfy it structurally. */
export interface TailReplayer {
  hasEndpoint(agentId: string): boolean;
  replayTail(agentId: string, request: TailReplayNodeRequest): Promise<TailReplayNodeResponse>;
  replayCall(
    agentId: string,
    request: { history: unknown[]; systemPrompt: string | null; taskId?: string; seq?: number },
  ): Promise<TailReplayCallResponse>;
}

/** @description The narrow frame-store contract the controller reads — ordered frame summaries and one full frame. */
export interface TailFrameSource {
  getFrames(runId: string, access: TokenChaseAccess): Promise<Array<{ seq: number }>>;
  getFrame(runId: string, seq: number, access: TokenChaseAccess): Promise<TokenChaseFrameDetail | null>;
}

/** @description The outcome of re-firing one frame's prompt in refire mode: its determinism verdict + warnings. */
export interface TailFrameOutcome {
  seq: number;
  status: TailFrameStatus;
  verdict: DeterminismVerdict | null;
  reason: string | null;
  warnings: string[];
  pinnedReads: number;
  unpinnedReads: number;
  replay: { model: string | null; provider: string | null; tokensOut: number | null; costUsd: number | null; latencyMs: number | null } | null;
}

/** @description The disposition of the optional prompt re-fire pass. */
export type RefireStatus = 'completed' | 'stopped' | 'empty';

/** @description The optional prompt re-fire pass over the tail: each frame's prompt re-fired on the node and graded. */
export interface RefireResult {
  status: RefireStatus;
  outcomes: TailFrameOutcome[];
  stoppedAtFrame: number | null;
  stopReason: string | null;
  totalCostUsd: number;
}

/** @description The overall tail-replay verdict, as the bot node returned it. */
export type TailReplayStatus = TailReplayNodeStatus;

/** @description The full result of a forward tail replay from a chosen frame. */
export interface TailReplayResult {
  runId: string;
  fromFrame: number;
  agentId: string | null;
  status: TailReplayStatus;
  restore: TailReplayNodeRestore;
  store: TailReplayNodeStore;
  framesInTail: number;
  frames: TailReplayNodeFrame[];
  /** The frame the tail stopped at (live tool / non-replayable / no node), or null when it ran to the end. */
  stoppedAtFrame: number | null;
  stopReason: string | null;
  toolCalls: number;
  artifacts: TailReplayNodeArtifacts;
  storeVersion: TailReplayNodeStoreVersion;
  paidCalls: number;
  totalCostUsd: number;
  /** Present only when the caller asked for the prompt re-fire determinism pass. */
  refire: RefireResult | null;
}

/** @description Options for a tail replay. */
export interface TailReplayOptions {
  /** Also re-fire each tail frame's prompt on the node and grade determinism (spends tokens). Default false. */
  refire?: boolean;
}

/** @description Statuses that faithfully reproduced the baseline and let the re-fire pass continue forward. */
const CONTINUE_STATUSES: ReadonlySet<TailFrameStatus> = new Set(['deterministic', 'equivalent']);

/** @description Builds the production replayer: both calls resolve the agent through the live registry. */
function createDefaultTailReplayer(): TailReplayer {
  const resolver = createRegistryEndpointResolver();
  const tailClient = new BotNodeTailReplayClient(resolver);
  const botClient = new BotNodeClient(resolver);
  return {
    hasEndpoint: (agentId) => tailClient.hasEndpoint(agentId),
    replayTail: (agentId, request) => tailClient.replayTail(agentId, request),
    replayCall: (agentId, request) => botClient.replayCall(agentId, request),
  };
}

/** @description The fail-closed result when the producing agent has no reachable bot node: nothing ran anywhere. */
function noEndpointResult(runId: string, fromFrame: number, agentId: string | null): TailReplayResult {
  const reason = `No reachable bot node for agent ${agentId ?? '(unknown)'} — replay must run on an accountable node.`;
  return {
    runId, fromFrame, agentId, status: 'stopped',
    restore: { source: 'none', workspaceCommit: null, filesRestored: 0, integrity: 'none', treeSha: null, warnings: [] },
    store: { bound: false, restored: false, files: 0, version: null, reason },
    framesInTail: 0, frames: [], stoppedAtFrame: fromFrame, stopReason: reason, toolCalls: 0,
    artifacts: { baselineTreeSha: null, replayTreeSha: null, reproduced: null, differingPaths: [], redactedPaths: [], complete: false, warnings: [] },
    storeVersion: { baseline: null, replay: null, reproduced: null, bound: false },
    paidCalls: 0, totalCostUsd: 0, refire: null,
  };
}

/**
 * @description The Token Chase forward-only TAIL replay (ADR-046 §3). Given a run and a start frame N it
 * asks the bot node that produced the run to restore frame N's checkpoint (worktree + owner store) into
 * isolated roots and walk frames N..end hermetically — captured responses served, their workspace tools
 * re-executed, live tools refused — then compare the resulting artifacts and store version with the run's
 * final checkpoint. The controller does no restore, no execution and no provider call: it relays the
 * node's verdict. With `refire` it additionally re-fires each frame's prompt on the node and grades
 * determinism, which is the only part that spends tokens.
 */
export class TokenChaseTailReplayService {
  private readonly reader: TailFrameSource;
  private readonly botClient: TailReplayer;

  /**
   * @description Builds the tail-replay service over a frame source and the swarm→bot clients.
   * @param reader - Frame store (ordered frames + full frame). Defaults to the read service.
   * @param botClient - Client pair that runs the tail / re-fires a prompt on the owning bot node. Defaults
   *   to registry-resolved clients so every replay lands on a real, accountable node.
   */
  constructor(reader?: TailFrameSource, botClient?: TailReplayer) {
    this.reader = reader ?? new TokenChaseReadService();
    this.botClient = botClient ?? createDefaultTailReplayer();
  }

  /**
   * @description Runs a forward tail replay from frame `fromFrame` to the end of the run on the producing bot node.
   * @param runId - The captured run (task workspace) id.
   * @param fromFrame - The frame to restore-from and start replaying at (inclusive).
   * @param access - Owner-scoping context; a caller may only replay frames they can read.
   * @param options - `refire` adds the prompt re-fire determinism pass.
   * @returns The tail-replay result, or null when the start frame is absent / not visible to the caller.
   */
  async replayForward(
    runId: string, fromFrame: number, access: TokenChaseAccess, options: TailReplayOptions = {},
  ): Promise<TailReplayResult | null> {
    const startedAt = Date.now();
    const start = await this.reader.getFrame(runId, fromFrame, access);
    if (!start) return null;
    const agentId = start.agentId;
    if (!agentId || !this.botClient.hasEndpoint(agentId)) {
      logger.warn({ runId, fromFrame, agentId }, 'Tail replay refused: no accountable bot node for the producing agent');
      return noEndpointResult(runId, fromFrame, agentId);
    }
    logger.info({ runId, fromFrame, agentId, refire: options.refire === true }, 'Tail replay delegated to the bot node');
    const node = await this.botClient.replayTail(agentId, {
      runId, fromFrame, access: { callerSub: access.callerSub, isAdmin: access.isAdmin },
    });
    const refire = options.refire ? await this.refireTail(runId, fromFrame, start, access) : null;
    const result: TailReplayResult = {
      runId, fromFrame, agentId, status: node.status,
      restore: node.restore, store: node.store,
      framesInTail: node.framesInTail, frames: node.frames,
      stoppedAtFrame: node.stoppedAtFrame, stopReason: node.stopReason, toolCalls: node.toolCalls,
      artifacts: node.artifacts, storeVersion: node.storeVersion,
      paidCalls: node.paidCalls + (refire ? refire.outcomes.filter((o) => o.replay !== null).length : 0),
      totalCostUsd: node.costUsd + (refire?.totalCostUsd ?? 0),
      refire,
    };
    logger.info({ runId, fromFrame, status: result.status, stoppedAtFrame: result.stoppedAtFrame, durationMs: Date.now() - startedAt }, 'Tail replay finished');
    return result;
  }

  /**
   * @description The optional prompt re-fire pass: every tail frame's exact captured prompt is re-fired on
   * the producing node and graded against its captured response; stops at the first non-continuing frame.
   * @param runId - The run id.
   * @param fromFrame - The first frame of the tail.
   * @param start - The already-loaded start frame.
   * @param access - Owner-scoping context.
   * @returns The re-fire pass result.
   */
  private async refireTail(runId: string, fromFrame: number, start: TokenChaseFrameDetail, access: TokenChaseAccess): Promise<RefireResult> {
    const tail = (await this.reader.getFrames(runId, access)).map((f) => f.seq).filter((seq) => seq >= fromFrame).sort((a, b) => a - b);
    const outcomes: TailFrameOutcome[] = [];
    let totalCostUsd = 0;
    let stoppedAtFrame: number | null = null;
    let stopReason: string | null = null;
    for (const seq of tail) {
      const frame = seq === fromFrame ? start : await this.reader.getFrame(runId, seq, access);
      const outcome = await this.refireOneFrame(runId, seq, frame);
      outcomes.push(outcome);
      totalCostUsd += outcome.replay?.costUsd ?? 0;
      if (!CONTINUE_STATUSES.has(outcome.status)) {
        stoppedAtFrame = seq;
        stopReason = outcome.reason ?? `Frame ${seq} graded ${outcome.status} — the re-fire pass cannot continue forward.`;
        logger.info({ runId, seq, status: outcome.status }, 'Tail re-fire pass stopped');
        break;
      }
    }
    const status: RefireStatus = tail.length === 0 ? 'empty' : stoppedAtFrame !== null ? 'stopped' : 'completed';
    return { status, outcomes, stoppedAtFrame, stopReason, totalCostUsd };
  }

  /**
   * @description Re-fires one frame and grades it against its captured baseline. Excludes frames that
   * cannot be a controlled experiment (in flight, non-replayable, no reachable node) before spending
   * tokens; classifies the frame's pinned/unpinned reads into per-frame warnings.
   * @param runId - The run id (for the replay call's taskId).
   * @param seq - The frame sequence being re-fired.
   * @param frame - The full captured frame, or null when it became unreadable.
   * @returns The per-frame outcome (status drives whether the pass continues).
   */
  private async refireOneFrame(runId: string, seq: number, frame: TokenChaseFrameDetail | null): Promise<TailFrameOutcome> {
    const { pinnedReads, unpinnedReads, warnings } = classifyPins(frame?.pins);
    const base: TailFrameOutcome = { seq, status: 'replay-error', verdict: null, reason: null, warnings, pinnedReads, unpinnedReads, replay: null };

    if (!frame) return { ...base, reason: `Frame ${seq} became unreadable during the tail.` };
    if (frame.phase === 'open' || frame.responseContent == null) {
      return { ...base, status: 'open-frame', reason: `Frame ${seq} is still in flight — no baseline to grade; tail stops.` };
    }
    if (frame.replayable === false) {
      base.warnings.push('Frame is flagged non-replayable (a live side-effect read) — tail fidelity past it is not guaranteed.');
      return { ...base, status: 'non-replayable', reason: `Frame ${seq} depends on a live/unpinned read — excluded from the tail.` };
    }
    if (!frame.agentId || !this.botClient.hasEndpoint(frame.agentId)) {
      return { ...base, status: 'no-endpoint', reason: `No reachable bot node for agent ${frame.agentId ?? '(unknown)'} — replay must run on an accountable node.` };
    }

    try {
      const res = await this.botClient.replayCall(frame.agentId, { history: frame.history, systemPrompt: frame.systemPrompt, taskId: runId, seq });
      if (!res.success) return { ...base, reason: res.error ?? `Bot node replay of frame ${seq} returned an error.` };
      const verdict = assessDeterminism(frame.responseContent, res.content);
      return {
        ...base,
        status: verdict.status,
        verdict,
        reason: verdict.status === 'divergent' ? `Frame ${seq} diverged from baseline (similarity ${verdict.similarity}).` : null,
        replay: { model: res.model, provider: res.provider, tokensOut: res.usage.outputTokens, costUsd: res.cost, latencyMs: res.latencyMs },
      };
    } catch (error) {
      logger.error({ err: error, runId, seq }, 'Tail frame re-fire failed');
      return { ...base, reason: error instanceof Error ? error.message : `Replay dispatch failed for frame ${seq}.` };
    }
  }
}

/**
 * @description Normalizes a frame's recorded `pins` into pinned/unpinned counts + per-unpinned warnings.
 * Tolerant of the recorded shape: an array of read records where each is pinned unless it explicitly says
 * otherwise (`pinned:false`, `status:'unpinned'`, or `unpinned:true`). Non-array/absent pins yield zeroes
 * (a pre-tail frame simply has no pin signal — it still re-fires).
 * @param raw - The raw `pins` value off the frame.
 * @returns Counts and the human-readable per-frame warnings for any unpinned reads.
 */
function classifyPins(raw: unknown): { pinnedReads: number; unpinnedReads: number; warnings: string[] } {
  if (!Array.isArray(raw)) return { pinnedReads: 0, unpinnedReads: 0, warnings: [] };
  let pinnedReads = 0;
  let unpinnedReads = 0;
  const warnings: string[] = [];
  for (const item of raw) {
    const rec = (item ?? {}) as Record<string, unknown>;
    const unpinned = rec.pinned === false || rec.status === 'unpinned' || rec.unpinned === true;
    if (unpinned) {
      unpinnedReads += 1;
      const label = String(rec.tool ?? rec.target ?? rec.path ?? 'read');
      warnings.push(`Unpinned read (${label}) fell through — its captured content is not served; this frame's replay may drift.`);
    } else {
      pinnedReads += 1;
    }
  }
  return { pinnedReads, unpinnedReads, warnings };
}
