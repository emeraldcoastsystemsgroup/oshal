/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node tail-replay client (BACKLOG "Workspace-bound checkpoint and tail replay", ADR-046 §3): the controller's ONE call to POST /api/token-chase/replay-tail on the bot that produced a run. The worktree restore, the owner-store restore, the hermetic no-edit tail and the artifact/store comparison all run THERE; the controller only carries the verdict. Kept out of bot-node-client.ts by design (that file is at its size budget) while sharing its node:http POST (no undici header ceiling) and the service-secret header. Also the wire contract both sides type against.
 */

import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import { postJsonNoUndiciCeiling, type BotEndpointResolver } from './bot-node-client';

const logger = createChildLogger({ module: 'bot-node-tail-replay-client' });

/** @description A hermetic tail restores a worktree and re-executes file tools; minutes, not the 60-min harness ceiling. */
export const DEFAULT_TAIL_REPLAY_TIMEOUT_MS = 10 * 60 * 1000;

/** @description The caller's owner-scoping context, forwarded so the bot re-applies the same frame visibility rule. */
export interface TailReplayNodeAccess {
  callerSub: string | null;
  isAdmin: boolean;
}

/** @description The request body of POST /api/token-chase/replay-tail. */
export interface TailReplayNodeRequest {
  runId: string;
  fromFrame: number;
  access: TailReplayNodeAccess;
}

/** @description The overall verdict of a hermetic tail on the node. */
export type TailReplayNodeStatus = 'reproduced' | 'diverged' | 'stopped' | 'empty';

/** @description Per-frame hermetic outcome: `reproduced` continues, `completed` ends the run, the rest stop the tail. */
export type TailReplayNodeFrameStatus = 'reproduced' | 'completed' | 'non-replayable' | 'open-frame' | 'live-tool' | 'tool-error';

/** @description One frame's hermetic outcome. */
export interface TailReplayNodeFrame {
  seq: number;
  status: TailReplayNodeFrameStatus;
  tool: string | null;
  replayClass: string | null;
  /** True/false when the baseline pinned this call's result and the replay matched/differed; null when it recorded no pin. */
  pinVerified: boolean | null;
  servedFromCapture: boolean;
  reason: string | null;
  warnings: string[];
}

/** @description How frame N's workspace was materialized into the isolated worktree. */
export interface TailReplayNodeRestore {
  source: 'commit' | 'objects' | 'none';
  workspaceCommit: string | null;
  filesRestored: number;
  integrity: 'ok' | 'mismatch' | 'unverified' | 'partial' | 'none';
  treeSha: string | null;
  warnings: string[];
}

/** @description Whether and how the owner's encrypted store was restored beside the worktree. */
export interface TailReplayNodeStore {
  bound: boolean;
  restored: boolean;
  files: number;
  version: string | null;
  reason: string | null;
}

/** @description The artifact comparison against final.json (tree digests, differing paths). */
export interface TailReplayNodeArtifacts {
  baselineTreeSha: string | null;
  replayTreeSha: string | null;
  /** True/false when a baseline exists; null when the run recorded no final checkpoint. */
  reproduced: boolean | null;
  differingPaths: string[];
  redactedPaths: string[];
  complete: boolean;
  warnings: string[];
}

/** @description The owner-store version comparison against final.json. */
export interface TailReplayNodeStoreVersion {
  baseline: string | null;
  replay: string | null;
  /** True/false when both sides are known; null when the store was unbound or never restored. */
  reproduced: boolean | null;
  bound: boolean;
}

/** @description The response body of POST /api/token-chase/replay-tail. */
export interface TailReplayNodeResponse {
  success: boolean;
  error?: string;
  runId: string;
  fromFrame: number;
  agentId: string;
  ownerSub: string | null;
  status: TailReplayNodeStatus;
  restore: TailReplayNodeRestore;
  store: TailReplayNodeStore;
  framesInTail: number;
  frames: TailReplayNodeFrame[];
  stoppedAtFrame: number | null;
  stopReason: string | null;
  toolCalls: number;
  artifacts: TailReplayNodeArtifacts;
  storeVersion: TailReplayNodeStoreVersion;
  /** A hermetic tail never calls a provider; both stay 0 and are reported so the controller can assert it. */
  paidCalls: number;
  costUsd: number;
  durationMs: number;
}

/**
 * @description Thin HTTP client for the bot-node tail executor. The controller never restores, re-executes
 * or compares anything itself: it asks the accountable node and relays the verdict.
 */
export class BotNodeTailReplayClient {
  private readonly resolveEndpoint: BotEndpointResolver;
  private readonly timeoutMs: number;

  /**
   * @description Binds the client to the swarm's endpoint resolver.
   * @param resolveEndpoint - Maps an agent id to its bot-node base URL (null when it has none).
   * @param timeoutMs - Overall bound on one tail call; the request is destroyed when it elapses.
   */
  constructor(resolveEndpoint: BotEndpointResolver, timeoutMs: number = DEFAULT_TAIL_REPLAY_TIMEOUT_MS) {
    this.resolveEndpoint = resolveEndpoint;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @description Whether the agent has a reachable bot-node endpoint. Without one the tail must not run anywhere.
   * @param agentId - The bot that produced the run.
   * @returns True when an endpoint resolves.
   */
  hasEndpoint(agentId: string): boolean {
    return this.resolveEndpoint(agentId) !== null;
  }

  /**
   * @description Runs the hermetic no-edit tail of a run on the bot node that produced it.
   * @param agentId - The bot that produced the captured run (resolves the target endpoint).
   * @param request - The run, the start frame and the caller's owner-scoping context.
   * @returns The node's verdict: restore, per-frame outcomes, artifact and store comparison.
   * @throws Error when the bot node is unreachable, refuses the call, or the HTTP call fails/times out.
   */
  async replayTail(agentId: string, request: TailReplayNodeRequest): Promise<TailReplayNodeResponse> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) {
      throw new Error(`No endpoint found for agent ${agentId} — a tail replay must run on an accountable bot node`);
    }
    const startedAt = Date.now();
    logger.info({ agentId, runId: request.runId, fromFrame: request.fromFrame }, 'Delegating Token Chase tail replay to the bot node');
    try {
      const response = await postJsonNoUndiciCeiling(
        `${endpoint}/api/token-chase/replay-tail`,
        JSON.stringify(request),
        { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        this.timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Bot node tail replay returned ${response.status}: ${response.text || 'No response body'}`);
      }
      const parsed = JSON.parse(response.text) as TailReplayNodeResponse;
      logger.info({ agentId, runId: request.runId, status: parsed.status, durationMs: Date.now() - startedAt }, 'Bot node tail replay returned');
      return parsed;
    } catch (error) {
      logger.error({ err: error, agentId, runId: request.runId, fromFrame: request.fromFrame }, 'Bot node tail replay failed');
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Bot node tail replay timed out after ${this.timeoutMs}ms for agent ${agentId}`);
      }
      throw error;
    }
  }
}
