/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost-unit classification for the oshal_cost_events ledger. ADR-127 records that a CLI turn's cost_usd is a price-equivalent (a subscription already paid for the call) and that a BYO hosted turn records $0 by design (the caller's endpoint bills the caller, so only tokens are known). A surface that sums cost_usd across providers is adding three different units; this module names the unit for a provider id so every cost surface can say which is which instead of presenting one total as spend.
 */

/**
 * @description The three units a `cost_usd` figure can be in, keyed by the provider that produced it.
 * - `billed`: a metered API call that costs money per token — the only unit that is a bill.
 * - `price-equivalent`: a subscription-backed CLI turn; the figure is what the same tokens WOULD
 *   have cost on the metered API, not money that changed hands (ADR-127).
 * - `byo`: a caller-owned hosted endpoint; the platform records tokens only and cost_usd is $0
 *   by design, because the caller's own account is billed outside this ledger.
 */
export type CostUnit = 'billed' | 'price-equivalent' | 'byo';

/** @description Operator-facing label for each unit, for cost surfaces that render the ledger. */
export const COST_UNIT_LABELS: Readonly<Record<CostUnit, string>> = Object.freeze({
  billed: 'billed',
  'price-equivalent': 'price-equivalent (subscription)',
  byo: 'BYO (tokens only)',
});

/** @description Spend for one scope and window, split by unit; `total` is the plain ledger sum. */
export interface SpendByUnit {
  billed: number;
  priceEquivalent: number;
  byo: number;
  total: number;
}

/**
 * Provider ids whose turns run on a subscription-backed local CLI. `claude-code` and
 * `openai-codex` are the ids the CLI providers stamp on chat_tasks / oshal_cost_events today
 * (observed on the running box); `codex-cli` / `gemini-cli` are the HarnessType spellings.
 */
const PRICE_EQUIVALENT_PROVIDERS: ReadonlySet<string> = new Set([
  'claude-code',
  'openai-codex',
  'codex-cli',
  'gemini-cli',
]);

/** Harness adapters name themselves `harness:<HarnessType>`; only the CLI types are subscription-backed. */
const PRICE_EQUIVALENT_HARNESS_TYPES: ReadonlySet<string> = new Set(['cline', 'codex-cli', 'claude-code', 'gemini-cli']);

/**
 * @description Classifies a ledger provider id into the unit its `cost_usd` is expressed in.
 * A failover provider (`failover:<primary>-><fallback>`) is classified by the primary, which is
 * the provider that answered unless the failover log says otherwise. Unknown, empty and null ids
 * classify as `billed`: the metered reading is the conservative one for a budget surface, and the
 * ledger's existing `image-provider:*` and hosted vendor ids all fall there correctly.
 * @param providerId - The `provider_id` stamped on the ledger row (or chat_tasks row).
 * @returns The cost unit the row's `cost_usd` is expressed in.
 */
export function classifyCostUnit(providerId: string | null | undefined): CostUnit {
  const id = unwrapFailover((providerId ?? '').trim().toLowerCase());
  if (id.startsWith('byo-')) return 'byo';
  if (PRICE_EQUIVALENT_PROVIDERS.has(id)) return 'price-equivalent';
  if (id.startsWith('harness:') && PRICE_EQUIVALENT_HARNESS_TYPES.has(id.slice('harness:'.length))) {
    return 'price-equivalent';
  }
  if (id.endsWith('-harness-adapter') && PRICE_EQUIVALENT_HARNESS_TYPES.has(id.slice(0, -'-harness-adapter'.length))) {
    return 'price-equivalent';
  }
  return 'billed';
}

/**
 * @description Reduces per-provider spend rows into the three units plus their plain sum.
 * @param rows - `(provider_id, spend)` pairs, e.g. a `GROUP BY provider_id` over the ledger.
 * @returns The split; every field is a finite non-negative number even for an empty input.
 */
export function splitSpendByUnit(rows: ReadonlyArray<{ providerId: string | null; spend: number }>): SpendByUnit {
  const split: SpendByUnit = { billed: 0, priceEquivalent: 0, byo: 0, total: 0 };
  for (const row of rows) {
    const spend = Number.isFinite(row.spend) ? row.spend : 0;
    switch (classifyCostUnit(row.providerId)) {
      case 'byo': split.byo += spend; break;
      case 'price-equivalent': split.priceEquivalent += spend; break;
      default: split.billed += spend;
    }
    split.total += spend;
  }
  return split;
}

/** @description Strips a `failover:` wrapper down to the primary provider id. */
function unwrapFailover(id: string): string {
  if (!id.startsWith('failover:')) return id;
  const chain = id.slice('failover:'.length);
  const arrow = chain.indexOf('->');
  return arrow === -1 ? chain : chain.slice(0, arrow);
}
