/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 3: single-variant model-swap replay + baseline-vs-variant cost/accuracy diff (ADR-046)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 5: runSavings — replay EVERY replayable frame of a captured run on a cheaper lane and roll the real cost deltas into an estimated-vs-actual SavingsSummary (the end-to-end loop over a real run).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Spend gate (BACKLOG "per-run judge budget cap"): runSavings consults a TokenChaseBudgetGate BEFORE each round — a finite TOKEN_CHASE_BUDGET_USD ceiling on the run's accumulated measured replay spend plus the injected cost-governance probe — and stops cleanly (log + budget status in the return, no throw) when exhausted. A gate is default-constructed when the caller passes none, so the ceiling always exists. Capture/determinism semantics untouched: already-replayed frames keep their grades; the gate only decides whether the NEXT round may spend.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Re-baseline support (ADR-046 keep-winner → re-baseline; BACKLOG "auto keep-winner"): replayVariant/runSavings accept an optional promoted-lane BaselineOverride (per frame seq). When a frame has an ACTIVE promotion, the COST baseline becomes the promoted lane's recorded provider/model/cost — so future optimizer runs and the persisted corpus rows (which the savings report reads) measure savings against the new baseline, not the retired one. The QUALITY reference deliberately stays the captured response text: the promoted lane won by reproducing that deliverable, and it remains the only reference text on disk — the override swaps cost identity, never the judge's anchor.
 */

import { createChildLogger } from '@/shared/logger';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { resolveUsageCost } from '@/features/llm-provider';
import { TokenChaseReadService, type TokenChaseAccess } from './token-chase-read-service';
import { assessDeterminism, EQUIVALENT_SIMILARITY_THRESHOLD } from './determinism-verdict';
import type { ReplayStatus } from './token-chase-replay-service';
import { resultsToSavingsRows, aggregateSavingsRows, type SavingsSummary } from './token-chase-savings';
import { TokenChaseBudgetGate, type TokenChaseBudgetStatus } from './token-chase-budget-gate';

const logger = createChildLogger({ module: 'token-chase-optimize-service' });

/** Longest a captured/replayed response preview may run before truncation, to keep the payload small. */
const PREVIEW_CHARS = 2000;

/**
 * @description A counterfactual lane for a variant replay: the provider+model to re-fire ONE captured
 * call against. These are the SAME provider/model ids the bot Settings dropdown uses (`GET /api/providers`),
 * so any provider the bot can run through its harness is selectable. The optimizer switches the owning
 * bot to this provider/model for the single replay, then restores its prior config. `label` is the human
 * name shown in the diff (defaults to the model id).
 */
export interface VariantLane {
  label: string;
  providerId: string;
  modelId: string;
}

/** @description Cost/usage/latency snapshot for one side of a baseline-vs-variant comparison. */
export interface LaneMetrics {
  label: string;
  model: string | null;
  provider: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number;
  /** True when costUsd is a pricing estimate (provider reported $0 but tokens were present). */
  costEstimated: boolean;
  latencyMs: number | null;
  preview: string;
}

/**
 * @description The result of replaying one captured frame on a different model. The baseline side is
 * reconstructed from the captured frame (its tokens priced via the shared resolver); the variant side
 * is a fresh, accountable re-fire on the chosen lane. `accuracy` is how close the variant output came
 * to the captured baseline output (Jaccard similarity) — a near-1.0 that is cheaper+faster is the win.
 */
export interface VariantReplayResult {
  runId: string;
  seq: number;
  status: ReplayStatus;
  reason: string | null;
  baseline: LaneMetrics | null;
  variant: LaneMetrics | null;
  diff: {
    /** Variant cost minus baseline cost (negative = cheaper). */
    costDeltaUsd: number;
    /** Percent change in cost vs baseline (negative = cheaper); null when baseline cost is 0. */
    costPct: number | null;
    /** Variant latency minus baseline latency (negative = faster); null when either is unknown. */
    latencyDeltaMs: number | null;
    /** Jaccard similarity of the variant output to the captured baseline output, [0,1]. */
    accuracy: number;
    /** True when the variant output is within semantic tolerance of the baseline. */
    equivalent: boolean;
  } | null;
  /**
   * The optimizer verdict for this lane:
   *  - `equivalent-cheaper`: same answer (within tolerance), lower cost — a zero-risk swap (Tier 1).
   *  - `equivalent-pricier`: same answer but costs more — keep the baseline.
   *  - `divergent`: the answer drifted past tolerance — a trade-off, not a swap (Tier 2).
   */
  tier: 'equivalent-cheaper' | 'equivalent-pricier' | 'divergent' | null;
  /** Coarse descriptors of the captured call, for the optimizer corpus / selection policy. */
  meta: OptimizerObservationMeta;
}

/**
 * @description A promoted lane standing in as a frame's COST baseline (ADR-046 re-baseline).
 * Built from an ACTIVE token_chase_promotions row: after a keep-winner promotion, savings for
 * that frame are measured against the promoted lane's recorded cost, not the retired captured
 * lane. The captured response text remains the quality reference (see replayVariant).
 */
export interface BaselineOverride {
  /** The promoted lane's provider id (null when the promoting replay reported none). */
  provider: string | null;
  /** The promoted lane's model id. */
  model: string | null;
  /** The promoted lane's measured cost in USD — the new baseline cost. */
  costUsd: number;
  /** Human lane label for the diff payload. */
  label?: string | null;
}

/** @description Coarse, heuristic descriptors of a captured call used to bucket corpus observations. */
export interface OptimizerObservationMeta {
  /** Best-effort class of the call (v1 uses the capture source; refined by a judge later). Nullable. */
  queryType: string | null;
  /** Rough size/effort bucket from prompt size + tool count: low | medium | high. */
  complexity: 'low' | 'medium' | 'high';
  /** The baseline harness that produced the captured call. */
  harness: string | null;
  /** Tool names available on the captured call. */
  tools: string[];
}

/** @description Builds the no-token sample comparison used by the UI and live-safe demos. */
export function buildTokenChaseDemoComparison(): VariantReplayResult {
  const runId = 'demo-token-chase';
  const seq = 1;
  const baselineText = 'The root cause is a failed disk on node three. Replace the disk and rebalance the cluster.';
  const variantText = baselineText;
  const baselinePrice = priceTokens(1000, 200, 'harness:claude-code-cli', 'claude-sonnet-4-6');
  const variantCostUsd = 0.0001;
  const verdict = assessDeterminism(baselineText, variantText);
  const baseline: LaneMetrics = {
    label: 'baseline',
    model: 'claude-sonnet-4-6',
    provider: 'harness:claude-code-cli',
    tokensIn: 1000,
    tokensOut: 200,
    costUsd: baselinePrice.costUsd,
    costEstimated: baselinePrice.estimated,
    latencyMs: 1500,
    preview: baselineText,
  };
  const variant: LaneMetrics = {
    label: 'demo cheaper lane',
    model: 'gpt-5',
    provider: 'openai-codex',
    tokensIn: 1000,
    tokensOut: 200,
    costUsd: variantCostUsd,
    costEstimated: false,
    latencyMs: 900,
    preview: variantText,
  };
  const costDeltaUsd = variant.costUsd - baseline.costUsd;
  const latencyDeltaMs = (variant.latencyMs ?? 0) - (baseline.latencyMs ?? 0);
  return {
    runId,
    seq,
    status: verdict.status,
    reason: null,
    baseline,
    variant,
    diff: {
      costDeltaUsd,
      costPct: baseline.costUsd > 0 ? Math.round((costDeltaUsd / baseline.costUsd) * 100) : null,
      latencyDeltaMs,
      accuracy: verdict.similarity,
      equivalent: verdict.similarity >= EQUIVALENT_SIMILARITY_THRESHOLD,
    },
    tier: costDeltaUsd < 0 ? 'equivalent-cheaper' : 'equivalent-pricier',
    meta: {
      queryType: 'demo',
      complexity: 'low',
      harness: 'harness:claude-code-cli',
      tools: [],
    },
  };
}

/** @description Derives the coarse corpus descriptors from a captured frame (heuristic, cheap). */
function deriveMeta(frame: {
  source: string | null; harnessFired: string | null; tools: string[];
  tokensIn: number | null; inputMessages: number | null;
}): OptimizerObservationMeta {
  const tokensIn = frame.tokensIn ?? 0;
  const toolCount = frame.tools?.length ?? 0;
  const complexity: 'low' | 'medium' | 'high' =
    tokensIn > 8000 || toolCount > 10 ? 'high'
    : tokensIn < 1500 && toolCount < 3 ? 'low'
    : 'medium';
  return { queryType: frame.source ?? null, complexity, harness: frame.harnessFired, tools: frame.tools ?? [] };
}

/** @description Truncates a response body to a bounded preview for the result payload. */
function preview(text: string | null): string {
  const s = text ?? '';
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…[+${s.length - PREVIEW_CHARS} chars]` : s;
}

/** @description Prices a token count for a given provider/model via the shared resolver (estimate when needed). */
function priceTokens(
  inputTokens: number,
  outputTokens: number,
  providerId: string | null,
  modelId: string | null,
): { costUsd: number; estimated: boolean } {
  const resolved = resolveUsageCost({
    providerCost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    providerId: providerId ?? undefined,
    modelId: modelId ?? undefined,
  });
  return { costUsd: resolved.totalCost, estimated: resolved.estimated };
}

/**
 * @description Token Chase optimizer (ADR-046 step 3). Replays ONE captured frame's exact sent prompt
 * against a different model — an ephemeral per-call swap routed through the same accountable bot node
 * that produced it (never the controller) — then diffs the variant's cost/latency/accuracy against the
 * captured baseline. This is the building block of the playback optimizer: one captured call, swapped
 * model, measured trade-off. Multi-step runs loop this per frame; nothing is chained (no state replay).
 */
export class TokenChaseOptimizeService {
  private readonly reader: TokenChaseReadService;
  private readonly botClient: BotNodeClient;

  /**
   * @description Builds the optimizer over a frame reader and the swarm→bot HTTP client.
   * @param reader - Read service that resolves captured frames (baseline tokens + sent prompt).
   * @param botClient - Client that re-fires a captured prompt on the owning bot node, carrying the lane.
   */
  constructor(reader: TokenChaseReadService = new TokenChaseReadService(), botClient?: BotNodeClient) {
    this.reader = reader;
    this.botClient = botClient ?? new BotNodeClient(createRegistryEndpointResolver());
  }

  /**
   * @description Replays one captured frame against a single variant lane and grades the trade-off.
   * Excludes frames that cannot be a controlled experiment (still in flight, flagged non-replayable, or
   * owned by a bot with no reachable node) before spending any tokens — same preconditions as the
   * determinism gate.
   * @param runId - The captured run (task workspace) id.
   * @param seq - The call sequence number within the run.
   * @param lane - The resolved variant lane (endpoint+key+model + display label).
   * @param access - Owner-scoping context; a caller may only replay frames they can read.
   * @param baselineOverride - Optional promoted lane (an ACTIVE frame promotion) to measure cost
   *   against instead of the captured lane — the ADR-046 re-baseline. The captured response text
   *   still anchors the accuracy/judge comparison (it is the deliverable the promoted lane won by
   *   reproducing, and the only reference text on disk).
   * @returns The baseline-vs-variant comparison, or null when the frame is absent / not visible.
   */
  async replayVariant(
    runId: string,
    seq: number,
    lane: { label: string; byo?: { baseUrl: string; apiKey: string; model: string } },
    access: TokenChaseAccess,
    baselineOverride?: BaselineOverride,
  ): Promise<VariantReplayResult | null> {
    const frame = await this.reader.getFrame(runId, seq, access);
    if (!frame) return null;

    const meta = deriveMeta(frame);
    const base = { runId, seq, baseline: null, variant: null, diff: null, tier: null, meta };

    if (frame.phase === 'open' || frame.responseContent == null) {
      return { ...base, status: 'open-frame', reason: 'Call is still in flight — no baseline response to compare.' };
    }
    if (frame.replayable === false) {
      return { ...base, status: 'non-replayable', reason: 'Frame depends on a live/unpinned read — excluded from optimization.' };
    }
    // Run on the bot that produced the capture when it's reachable; otherwise fall back to ANY reachable
    // bot node — a variant replay just needs an accountable harness to fire on, not the original bot.
    const agentId = (frame.agentId && this.botClient.hasEndpoint(frame.agentId))
      ? frame.agentId
      : this.botClient.firstReachableAgentId();
    if (!agentId) {
      return { ...base, status: 'no-endpoint', reason: 'No reachable bot node to run the replay on — start a worker bot, then try again.' };
    }

    // Reconstruct the baseline cost from the captured tokens (frames store usage, not cost).
    const baseInTok = frame.tokensIn ?? 0;
    const baseOutTok = frame.tokensOut ?? 0;
    const baseProviderId = frame.providerRequested ?? frame.harnessFired;
    const basePrice = priceTokens(baseInTok, baseOutTok, baseProviderId, frame.model);
    const captured: LaneMetrics = {
      label: 'baseline',
      model: frame.model,
      provider: baseProviderId,
      tokensIn: frame.tokensIn,
      tokensOut: frame.tokensOut,
      costUsd: basePrice.costUsd,
      costEstimated: basePrice.estimated,
      latencyMs: frame.latencyMs,
      preview: preview(frame.responseContent),
    };
    // Re-baseline (ADR-046): with an ACTIVE promotion, the promoted lane's recorded cost is the
    // frame's baseline going forward. Its response text was not persisted, so the captured text
    // stays the quality reference — the override swaps COST identity only, and says so in the label.
    const baseline: LaneMetrics = baselineOverride
      ? {
          label: `baseline (promoted: ${baselineOverride.label ?? baselineOverride.model ?? baselineOverride.provider ?? 'lane'})`,
          model: baselineOverride.model,
          provider: baselineOverride.provider,
          tokensIn: null,
          tokensOut: null,
          costUsd: baselineOverride.costUsd,
          costEstimated: false,
          latencyMs: null,
          preview: captured.preview,
        }
      : captured;

    // Fire ONE replay on the bot node's /api/token-chase/replay-call — the framework's native variant
    // path (ADR-046). With `byo`, the bot uses an ephemeral OpenAI-compatible provider; without it, the
    // bot's own configured provider. No switchProvider, nothing persisted (the lean bot-node runtime has
    // no /api/llm-provider — switching it would 404).
    logger.info({ runId, seq, agentId, lane: lane.label, byo: !!lane.byo }, 'Replaying captured frame via bot replay-call');
    let res: Awaited<ReturnType<BotNodeClient['replayCall']>>;
    try {
      res = await this.botClient.replayCall(agentId, {
        history: frame.history,
        systemPrompt: frame.systemPrompt,
        taskId: runId,
        seq,
        variantLabel: lane.label,
        byoLlmConnection: lane.byo,
      });
    } catch (error) {
      logger.error({ err: error, runId, seq, lane: lane.label }, 'Variant replay failed');
      return { ...base, status: 'replay-error', reason: error instanceof Error ? error.message : 'Variant replay dispatch failed.', baseline };
    }
    if (!res.success) {
      return { ...base, status: 'replay-error', reason: res.error ?? 'Bot node variant replay returned an error.', baseline };
    }

    // Prefer the provider-reported cost; fall back to a pricing estimate when it reports $0 with tokens.
    const variantCost = res.cost > 0
      ? { costUsd: res.cost, estimated: false }
      : priceTokens(res.usage.inputTokens, res.usage.outputTokens, res.provider ?? null, res.model ?? lane.byo?.model ?? null);
    const variant: LaneMetrics = {
      label: lane.label,
      model: res.model ?? lane.byo?.model ?? null,
      provider: res.provider ?? null,
      tokensIn: res.usage.inputTokens,
      tokensOut: res.usage.outputTokens,
      costUsd: variantCost.costUsd,
      costEstimated: variantCost.estimated,
      latencyMs: res.latencyMs,
      preview: preview(res.content),
    };

    // Accuracy = how close the variant output came to the captured baseline (Jaccard similarity).
    const verdict = assessDeterminism(frame.responseContent, res.content);
    const equivalent = verdict.similarity >= EQUIVALENT_SIMILARITY_THRESHOLD;
    const costDeltaUsd = variant.costUsd - baseline.costUsd;
    const costPct = baseline.costUsd > 0 ? Math.round((costDeltaUsd / baseline.costUsd) * 100) : null;
    const latencyDeltaMs = baseline.latencyMs != null && variant.latencyMs != null ? variant.latencyMs - baseline.latencyMs : null;
    const tier = !equivalent ? 'divergent' : (costDeltaUsd < 0 ? 'equivalent-cheaper' : 'equivalent-pricier');

    logger.info({ runId, seq, lane: lane.label, accuracy: verdict.similarity, costDeltaUsd, tier }, 'Variant replay graded');
    return {
      runId, seq,
      status: verdict.status,
      reason: null,
      baseline,
      variant,
      diff: { costDeltaUsd, costPct, latencyDeltaMs, accuracy: verdict.similarity, equivalent },
      tier,
      meta,
    };
  }

  /**
   * @description End-to-end savings loop over a REAL captured run: replay every replayable frame on the
   * chosen cheaper lane, grade each (reusing replayVariant), optionally persist each graded observation
   * to the corpus, and roll the real cost deltas into an estimated-vs-actual SavingsSummary. Only the
   * zero-risk equivalent-cheaper swaps count toward realizable savings.
   * Each round is spend-gated: the budget gate is consulted BEFORE every frame replay, and an
   * exhausted budget (per-run TOKEN_CHASE_BUDGET_USD ceiling, or a cost-governance hard cap via
   * the gate's injected probe) stops the loop CLEANLY — frames already replayed keep their
   * grades, the summary covers what actually ran, and the budget status says why it stopped.
   * Never a throw: an exhausted budget is a status, not an error.
   * @param runId - the captured run id
   * @param lane - the resolved variant lane (label + optional BYO endpoint) to price against
   * @param access - owner-scoping; the caller may only replay frames they can read
   * @param onObservation - optional sink for each graded result (e.g. corpus recorder)
   * @param budget - optional per-run spend gate; default-constructed (env-cap only) when absent
   *   so the finite ceiling ALWAYS exists — the route passes one with governance wired.
   * @param baselineOverrides - optional per-frame promoted lanes (seq → override): frames with an
   *   ACTIVE promotion measure savings against the promoted lane (the ADR-046 re-baseline)
   * @returns the per-frame results, the aggregate savings summary, and the run's budget status
   */
  async runSavings(
    runId: string,
    lane: { label: string; byo?: { baseUrl: string; apiKey: string; model: string } },
    access: TokenChaseAccess,
    onObservation?: (result: VariantReplayResult) => void | Promise<void>,
    budget?: TokenChaseBudgetGate,
    baselineOverrides?: ReadonlyMap<number, BaselineOverride>,
  ): Promise<{ results: VariantReplayResult[]; summary: SavingsSummary; budget: TokenChaseBudgetStatus }> {
    const gate = budget ?? new TokenChaseBudgetGate({ userSub: access.callerSub });
    const frames = await this.reader.getFrames(runId, access);
    const results: VariantReplayResult[] = [];
    for (const frame of frames) {
      const verdict = await gate.check();
      if (verdict.exhausted) {
        logger.warn(
          { runId, lane: lane.label, replayed: results.length, remaining: frames.length - results.length, reason: verdict.reason, spentUsd: verdict.spentUsd, capUsd: verdict.capUsd },
          'Token Chase budget exhausted — savings loop stopped cleanly before the next round',
        );
        break;
      }
      const result = await this.replayVariant(runId, frame.seq, lane, access, baselineOverrides?.get(frame.seq));
      if (!result) continue;
      if (result.variant) gate.record(result.variant.costUsd);
      results.push(result);
      if (onObservation && result.tier) await onObservation(result);
    }
    const summary = aggregateSavingsRows(resultsToSavingsRows(results), 'run', runId);
    logger.info(
      { runId, lane: lane.label, frames: results.length, realizableSavedUsd: summary.realizableSavedUsd, cheaper: summary.tiers.equivalentCheaper, budget: gate.status() },
      'Token Chase savings loop completed',
    );
    return { results, summary, budget: gate.status() };
  }
}
