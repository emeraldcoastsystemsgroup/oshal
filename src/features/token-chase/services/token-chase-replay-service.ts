/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2 (slice 1): single-call no-edit replay determinism gate (ADR-046)
 */

import { createChildLogger } from '@/shared/logger';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { TokenChaseReadService, type TokenChaseAccess } from './token-chase-read-service';
import { assessDeterminism, type DeterminismVerdict } from './determinism-verdict';

const logger = createChildLogger({ module: 'token-chase-replay-service' });

/** Longest a captured response preview may run before truncation, to keep the result payload small. */
const PREVIEW_CHARS = 2000;

/**
 * @description The outcome of a replay attempt. `status` widens the determinism verdict with the
 * gate's pre-conditions: a frame can be excluded before any LLM fires (`non-replayable`,
 * `open-frame`, `no-endpoint`) or the bot re-fire can fail (`replay-error`).
 */
export type ReplayStatus = DeterminismVerdict['status'] | 'non-replayable' | 'open-frame' | 'no-endpoint' | 'replay-error';

/** @description The full result of a single-call no-edit replay, returned by the replay route. */
export interface ReplayResult {
  runId: string;
  seq: number;
  status: ReplayStatus;
  /** The determinism verdict, present only when a re-fire actually ran and was graded. */
  verdict: DeterminismVerdict | null;
  /** Human-readable reason for an excluded/errored status (null on a graded verdict). */
  reason: string | null;
  baseline: { preview: string; model: string | null; harnessFired: string | null } | null;
  replay: { preview: string; model: string | null; provider: string | null; tokensOut: number | null; costUsd: number | null; latencyMs: number | null } | null;
}

/** @description Truncates a response body to a bounded preview for the result payload. */
function preview(text: string | null): string {
  const s = text ?? '';
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…[+${s.length - PREVIEW_CHARS} chars]` : s;
}

/**
 * @description Runs the Token Chase single-call determinism gate: it rehydrates one captured frame's
 * exact sent prompt (system prompt + post-truncation history) and re-fires it **through the
 * accountable bot node that produced it** — never on the controller — then grades the fresh response
 * against the captured baseline. This is the precondition (ADR-046 step 2) for every later
 * counterfactual: until a no-edit replay reproduces baseline, no variant comparison is trustworthy.
 */
export class TokenChaseReplayService {
  private readonly reader: TokenChaseReadService;
  private readonly botClient: BotNodeClient;

  /**
   * @description Builds the replay service over a frame reader and the swarm→bot HTTP client.
   * @param reader - Read service that resolves captured frames (baseline + sent prompt).
   * @param botClient - Client that re-fires a captured prompt on the owning bot node. Defaults to a
   *   registry-resolved client so the LLM call always lands on a real, cost-tracked bot node.
   */
  constructor(reader: TokenChaseReadService = new TokenChaseReadService(), botClient?: BotNodeClient) {
    this.reader = reader;
    this.botClient = botClient ?? new BotNodeClient(createRegistryEndpointResolver());
  }

  /**
   * @description Replays one captured frame with no edit and grades determinism. Excludes frames that
   * cannot be a controlled experiment (still in flight, flagged non-replayable, or owned by a bot
   * with no reachable node) before spending any tokens.
   * @param runId - The captured run (task workspace) id.
   * @param seq - The call sequence number within the run.
   * @param access - Owner-scoping context; a caller may only replay frames they can read.
   * @returns The replay result, or null when the frame is absent / not visible to the caller.
   */
  async replayFrame(runId: string, seq: number, access: TokenChaseAccess): Promise<ReplayResult | null> {
    const frame = await this.reader.getFrame(runId, seq, access);
    if (!frame) return null;

    const base = { runId, seq, verdict: null, replay: null };
    const baseline = { preview: preview(frame.responseContent), model: frame.model, harnessFired: frame.harnessFired };

    if (frame.phase === 'open' || frame.responseContent == null) {
      return { ...base, status: 'open-frame', reason: 'Call is still in flight — no baseline response to compare.', baseline: null };
    }
    if (frame.replayable === false) {
      return { ...base, status: 'non-replayable', reason: 'Frame depends on a live/unpinned read — excluded from the determinism gate.', baseline };
    }
    if (!frame.agentId || !this.botClient.hasEndpoint(frame.agentId)) {
      return { ...base, status: 'no-endpoint', reason: `No reachable bot node for agent ${frame.agentId ?? '(unknown)'} — replay must run on an accountable node, not the controller.`, baseline };
    }

    logger.info({ runId, seq, agentId: frame.agentId }, 'Replaying captured frame (no-edit determinism check)');
    try {
      const res = await this.botClient.replayCall(frame.agentId, {
        history: frame.history,
        systemPrompt: frame.systemPrompt,
        taskId: runId,
        seq,
      });
      if (!res.success) {
        return { ...base, status: 'replay-error', reason: res.error ?? 'Bot node replay returned an error.', baseline };
      }
      const verdict = assessDeterminism(frame.responseContent, res.content);
      logger.info({ runId, seq, status: verdict.status, similarity: verdict.similarity }, 'Replay graded');
      return {
        runId, seq,
        status: verdict.status,
        verdict,
        reason: null,
        baseline,
        replay: { preview: preview(res.content), model: res.model, provider: res.provider, tokensOut: res.usage.outputTokens, costUsd: res.cost, latencyMs: res.latencyMs },
      };
    } catch (error) {
      logger.error({ err: error, runId, seq }, 'Frame replay failed');
      return { ...base, status: 'replay-error', reason: error instanceof Error ? error.message : 'Replay dispatch failed.', baseline };
    }
  }
}
