/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | NEW: additive, off-by-default cost-aware model selection. When enforcement is off, returns the requested model unchanged. Pure + unit-testable.
 */

/**
 * @description
 * Policy-driven, cost-aware model selection (downshift ladder).
 *
 * ADDITIVE and OFF BY DEFAULT: when `OSHAL_LLM_BUDGETS` is off, {@link selectModel}
 * returns the requested model UNCHANGED. When enforcement is on AND a budget
 * signal says we are near/over cap (or a policy hint requests the cheapest path),
 * it downshifts to the next cheaper model on a configured ladder.
 *
 * Pricing knowledge mirrors the fallback pricing in
 * `src/features/llm-provider/services/usage-cost-resolver.ts`. Those maps
 * (CLAUDE_CODE_FALLBACK_PRICING / CODEX_FALLBACK_PRICING) are module-private and
 * not exported, so this file defines a PARALLEL ladder + per-tier pricing here.
 * KEEP IN SYNC with usage-cost-resolver.ts when prices or model families change.
 */

/**
 * @description Per-million-token pricing used only to ORDER the ladder cheap->
 * expensive. Mirrors usage-cost-resolver.ts fallback maps. KEEP IN SYNC.
 */
interface TierPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * @description A single rung on a downshift ladder: the canonical model id plus
 * its (approximate) pricing tier. Ladders are ordered MOST EXPENSIVE first.
 */
export interface LadderRung {
  model: string;
  pricing: TierPricing;
}

/**
 * @description Default downshift ladders, keyed by family.
 *
 * Anthropic (Claude) — KEEP IN SYNC with CLAUDE_CODE_FALLBACK_PRICING:
 *   opus  ($15 / $75)  ->  sonnet ($3 / $15)  ->  haiku ($1 / $5)
 *
 * OpenAI Codex / GPT — KEEP IN SYNC with CODEX_FALLBACK_PRICING:
 *   gpt-4.5 ($75 / $150) -> gpt-5.4 ($2 / $8) -> gpt-5.3 ($2 / $8) -> gpt-4.5?
 *   The gpt-5.x family is uniformly priced ($2 / $8) in the resolver, so the
 *   "cheaper" step inside that family is a capability downshift at equal cost
 *   (5.4 -> 5.3 -> 5.2 -> 5.1). gpt-4.5 is far MORE expensive and sits at the
 *   top of the ladder.
 */
export const DEFAULT_LADDERS: Record<string, LadderRung[]> = {
  claude: [
    { model: 'opus', pricing: { inputPerMillion: 15, outputPerMillion: 75 } },
    { model: 'sonnet', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
    { model: 'haiku', pricing: { inputPerMillion: 1, outputPerMillion: 5 } },
  ],
  codex: [
    { model: 'gpt-4.5', pricing: { inputPerMillion: 75, outputPerMillion: 150 } },
    { model: 'gpt-5.4', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
    { model: 'gpt-5.3', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
    { model: 'gpt-5.2', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
    { model: 'gpt-5.1', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
  ],
};

/** @description Policy hint that can force the routing decision. */
export type RoutingPolicy =
  | 'auto' // downshift only when near/over cap (default)
  | 'cheapest' // always pick the cheapest rung in the family
  | 'never'; // never downshift (honor the requested model)

/** @description Input for {@link selectModel}. */
export interface SelectModelInput {
  requestedModel: string;
  scope?: string;
  key?: string;
  /** Free-form task difficulty hint; reserved for future capability gating. */
  taskHint?: string;
  /**
   * Budget pressure signal in [0,1]: fraction of the cap already consumed
   * (spent / cap). >= nearCapThreshold triggers a downshift under 'auto'.
   * Omit/undefined = unknown pressure (no downshift under 'auto').
   */
  budgetPressure?: number;
  /** Override the resolved config (tests). */
  config?: RoutingConfig;
}

/** @description Result of model selection. */
export interface SelectModelResult {
  model: string;
  downshiftedFrom: string | null;
  reason:
    | 'enforcement-off'
    | 'policy-never'
    | 'unknown-family'
    | 'no-cheaper-model'
    | 'not-under-pressure'
    | 'downshifted-near-cap'
    | 'downshifted-cheapest';
}

/** @description Resolved routing configuration from env. */
export interface RoutingConfig {
  enabled: boolean;
  policy: RoutingPolicy;
  /** Budget pressure at/above which 'auto' downshifts (0..1). Default 0.85. */
  nearCapThreshold: number;
}

/**
 * @description Reads routing configuration from the environment.
 *
 * Off by default: gated behind OSHAL_LLM_BUDGETS (shared master switch).
 *
 * Recognized env vars:
 *  - OSHAL_LLM_BUDGETS               : master switch (off by default)
 *  - OSHAL_ROUTING_POLICY            : 'auto' | 'cheapest' | 'never' (default 'auto')
 *  - OSHAL_ROUTING_NEAR_CAP_PCT      : near-cap threshold 0..1 (default 0.85)
 *
 * @param env - Environment bag (defaults to process.env). Injectable for tests.
 */
export function readRoutingConfig(env: NodeJS.ProcessEnv = process.env): RoutingConfig {
  return {
    enabled: isEnforcementOn(env.OSHAL_LLM_BUDGETS),
    policy: parsePolicy(env.OSHAL_ROUTING_POLICY),
    nearCapThreshold: parseFraction(env.OSHAL_ROUTING_NEAR_CAP_PCT, 0.85),
  };
}

/**
 * @description Selects a model for a call, applying cost-aware downshift policy.
 * PURE: depends only on its inputs + (optionally injected) config.
 *
 * OFF BY DEFAULT: when enforcement is off, returns `requestedModel` unchanged.
 *
 * @param input - {@link SelectModelInput}.
 * @returns {@link SelectModelResult} with the chosen model + provenance.
 */
export function selectModel(input: SelectModelInput): SelectModelResult {
  const config = input.config ?? readRoutingConfig();
  const requested = input.requestedModel;

  // ── Off path: provably current behavior (model unchanged) ─────────────────
  if (!config.enabled) {
    return { model: requested, downshiftedFrom: null, reason: 'enforcement-off' };
  }
  if (config.policy === 'never') {
    return { model: requested, downshiftedFrom: null, reason: 'policy-never' };
  }

  const family = familyOf(requested);
  const ladder = family ? DEFAULT_LADDERS[family] : undefined;
  if (!family || !ladder) {
    return { model: requested, downshiftedFrom: null, reason: 'unknown-family' };
  }

  const currentIdx = rungIndexFor(requested, ladder);

  // 'cheapest' policy: jump straight to the cheapest rung in the family.
  if (config.policy === 'cheapest') {
    const cheapest = ladder[ladder.length - 1];
    if (currentIdx === ladder.length - 1 || isSameRung(requested, cheapest.model)) {
      return { model: requested, downshiftedFrom: null, reason: 'no-cheaper-model' };
    }
    return { model: cheapest.model, downshiftedFrom: requested, reason: 'downshifted-cheapest' };
  }

  // 'auto' policy: only downshift when under budget pressure.
  const pressure = typeof input.budgetPressure === 'number' ? input.budgetPressure : undefined;
  if (pressure === undefined || pressure < config.nearCapThreshold) {
    return { model: requested, downshiftedFrom: null, reason: 'not-under-pressure' };
  }

  // Under pressure: step down one rung to the next cheaper model, if one exists.
  if (currentIdx < 0 || currentIdx >= ladder.length - 1) {
    // Requested model is already the cheapest in its family (or unrecognized
    // within the family); nothing cheaper to fall back to.
    return { model: requested, downshiftedFrom: null, reason: 'no-cheaper-model' };
  }
  const next = ladder[currentIdx + 1];
  return { model: next.model, downshiftedFrom: requested, reason: 'downshifted-near-cap' };
}

// ── family + ladder helpers ──────────────────────────────────────────────────

/**
 * @description Resolves the ladder family for a model id by substring, matching
 * the same family logic usage-cost-resolver uses (claude opus/sonnet/haiku;
 * gpt-* -> codex). Returns null when the family is unknown.
 */
export function familyOf(modelId: string): keyof typeof DEFAULT_LADDERS | null {
  const id = (modelId || '').toLowerCase();
  if (!id) return null;
  if (id.includes('opus') || id.includes('sonnet') || id.includes('haiku') || id.includes('claude')) {
    return 'claude';
  }
  if (id.includes('gpt-') || id.includes('codex') || id.startsWith('o1') || id.startsWith('o3')) {
    return 'codex';
  }
  return null;
}

/**
 * @description Finds the ladder rung index for a (possibly fully-versioned)
 * model id, matching by rung token substring (e.g. 'claude-opus-4-1' -> 'opus';
 * 'gpt-5.4-codex' -> 'gpt-5.4'). Returns -1 when no rung matches.
 */
export function rungIndexFor(modelId: string, ladder: LadderRung[]): number {
  const id = (modelId || '').toLowerCase();
  for (let i = 0; i < ladder.length; i += 1) {
    if (id.includes(ladder[i].model.toLowerCase())) {
      return i;
    }
  }
  return -1;
}

function isSameRung(modelId: string, rungModel: string): boolean {
  return (modelId || '').toLowerCase().includes(rungModel.toLowerCase());
}

function isEnforcementOn(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return ['on', 'true', '1', 'yes', 'enabled'].includes(value.trim().toLowerCase());
}

function parsePolicy(value: string | undefined): RoutingPolicy {
  const v = (value || '').trim().toLowerCase();
  if (v === 'cheapest' || v === 'never') return v;
  return 'auto';
}

function parseFraction(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}
