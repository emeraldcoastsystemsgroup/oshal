/**
 * Payment adapter — the provider-agnostic money-movement contract.
 *
 * Mirrors how OSHAL keeps LLM execution pluggable (see harness-adapter.ts:
 * one `HarnessAdapter` interface, many concrete runtimes behind it). The rest of
 * OSHAL never talks to Stripe / Plaid Transfer / Dwolla directly — it depends on
 * this `PaymentAdapter` interface and lets `getPaymentAdapter()` pick the concrete
 * one from `PAYMENT_PROVIDER`. Adding a rail = a new adapter, nothing else changes.
 *
 * Scope (finance v1, ADR-048 extension): MOVE THE USER'S MONEY — an ACH debit of
 * the user's own linked bank account. This is money-transmitter territory, so every
 * concrete adapter is responsible for idempotency (via `idempotencyKey`) and never
 * moves money without an explicit, caller-initiated request. No card processing,
 * no crypto. Trade execution remains out of scope.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — provider-agnostic PaymentAdapter contract (createTransfer/getTransfer/configured) + normalized transfer types and status, parallel to the HarnessAdapter pattern.
 *
 * @module payment-adapter
 */

/** The concrete money-movement rails OSHAL can be configured to use. */
export type PaymentProviderType = 'stripe' | 'plaid-transfer' | 'dwolla';

/** Where the money comes from — a rail-specific funding instrument id (e.g. a
 *  Stripe `us_bank_account` PaymentMethod id, a Plaid `account_id`). */
export interface PaymentSource {
  /** The rail-specific funding instrument id (payment_method / account id). */
  id: string;
  /** Optional human label for receipts/audit (e.g. "Checking ····6789"). */
  label?: string;
}

/** A request to move money out of the user's account. Amount is in MINOR units
 *  (cents) to avoid float drift — the same convention every payment rail uses. */
export interface TransferRequest {
  /** Authenticated caller's OIDC sub — the owner of the funds (audit + scoping). */
  userSub: string;
  /** Amount to move, in minor units (cents). Must be a positive integer. */
  amountCents: number;
  /** ISO 4217 currency (e.g. 'usd'). */
  currency: string;
  /** The funding instrument to debit. */
  source: PaymentSource;
  /** Free-text memo shown on the statement / kept for the audit trail. */
  description?: string;
  /** Optional payee label (the biller/recipient) for the audit trail. v1 records
   *  it; true account-to-account routing arrives with the Plaid Transfer/Dwolla rails. */
  payeeLabel?: string;
  /** Idempotency key — the SAME key MUST never create a second transfer. Callers
   *  derive it deterministically (e.g. `${userSub}:${requestId}`) so a retry is safe. */
  idempotencyKey: string;
}

/** Normalized lifecycle of a money movement, rail-independent. */
export type TransferStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled';

/** The result of initiating / inspecting a transfer. */
export interface TransferResult {
  /** Rail-assigned transfer id (used later with `getTransfer`). */
  id: string;
  /** Normalized status. ACH settles asynchronously, so 'processing' is the common initial state. */
  status: TransferStatus;
  /** Amount moved, minor units. */
  amountCents: number;
  /** ISO 4217 currency. */
  currency: string;
  /** Which rail produced this result. */
  provider: PaymentProviderType;
  /** Rail-native status string, kept verbatim for debugging/audit. */
  rawStatus?: string;
  /** Failure reason when status is 'failed'. */
  failureReason?: string;
}

/**
 * @description The contract every money-movement rail implements. Concrete adapters
 * (Stripe, Plaid Transfer, Dwolla) live beside this file and are selected by
 * `getPaymentAdapter()`. Keep this interface rail-neutral — no Stripe/Plaid types leak.
 */
export interface PaymentAdapter {
  /** Which rail this adapter wraps. */
  readonly provider: PaymentProviderType;

  /** True when the rail's credentials are present (else the surface shows a setup note). */
  configured(): boolean;

  /** Whether the rail is pointed at test/sandbox vs live money. Drives UI guardrails. */
  isTestMode(): boolean;

  /**
   * @description Initiate a money movement. MUST be idempotent on `req.idempotencyKey`.
   * @param req - The normalized transfer request.
   * @returns The created transfer (often 'processing' for ACH).
   */
  createTransfer(req: TransferRequest): Promise<TransferResult>;

  /**
   * @description Fetch the current status of a previously-created transfer.
   * @param transferId - The id returned by `createTransfer`.
   * @returns The transfer's current normalized state.
   */
  getTransfer(transferId: string): Promise<TransferResult>;
}
