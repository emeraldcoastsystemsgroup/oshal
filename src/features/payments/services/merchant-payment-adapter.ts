/**
 * Merchant payment adapter — the provider-agnostic "take a payment" contract.
 *
 * Distinct from `payment-adapter.ts` (which moves the OPERATOR's own money on a
 * platform key). Here the MERCHANT connects their own account (Square / PayPal / …)
 * as an OAuth connector, and OSHAL takes payments ON THEIR BEHALF using their
 * per-user brokered access token. So every method takes a `merchantToken` — the
 * caller's decrypted connector token (from `getValidAccessToken(pool, sub, provider)`),
 * never a platform secret.
 *
 * Each rail charges the way its API actually supports: Square does a direct card
 * charge (a tokenized card nonce); PayPal creates + sends an invoice the customer
 * pays. The shared contract hides that difference behind `charge()` so the route +
 * surface stay provider-neutral. Adding "whatever" = one more adapter in the registry.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — provider-agnostic merchant "take a payment" contract (charge/getCharge) over a connected merchant account's brokered token.
 *
 * @module merchant-payment-adapter
 */

/** The merchant payment rails OSHAL can take payments through. Matches connector ids. */
export type MerchantProviderType = 'square' | 'paypal';

/** A request to take a payment through the merchant's connected account. */
export interface ChargeRequest {
  /** Authenticated caller's OIDC sub — the merchant taking the payment (audit + idempotency). */
  userSub: string;
  /** Amount to charge, in MINOR units (cents). Positive integer. */
  amountCents: number;
  /** ISO 4217 currency (e.g. 'USD'). */
  currency: string;
  /**
   * The rail-specific charge instrument:
   *  - Square: a tokenized card nonce / payment token from the Web Payments SDK
   *    (Sandbox test value `cnon:card-nonce-ok`).
   *  - PayPal: the customer's email address to invoice.
   */
  source: string;
  /** Statement/receipt note + audit memo. */
  note?: string;
  /** Idempotency key — the SAME key MUST never take a second payment. */
  idempotencyKey: string;
}

/** Normalized lifecycle of a payment, rail-independent. */
export type ChargeStatus = 'pending' | 'completed' | 'failed' | 'canceled';

/** The result of taking / inspecting a payment. */
export interface ChargeResult {
  /** Rail-assigned payment/invoice id. */
  id: string;
  /** Normalized status (PayPal invoices sit at 'pending' until the customer pays). */
  status: ChargeStatus;
  /** Amount, minor units. */
  amountCents: number;
  /** ISO 4217 currency. */
  currency: string;
  /** Which rail took the payment. */
  provider: MerchantProviderType;
  /** Rail-native status string, verbatim, for audit/debug. */
  rawStatus?: string;
  /** A customer-facing URL when the rail produces one (e.g. a PayPal invoice link). */
  payerActionUrl?: string;
  /** Failure reason when status is 'failed'. */
  failureReason?: string;
}

/**
 * @description The contract each merchant payment rail implements. Concrete adapters
 * (Square, PayPal) live beside this file and are resolved via the registry. All money
 * moves on the MERCHANT's connected account via `merchantToken` — keep this interface
 * rail-neutral (no Square/PayPal types leak out).
 */
export interface MerchantPaymentAdapter {
  /** Which rail this adapter wraps (also the connector id whose token it needs). */
  readonly provider: MerchantProviderType;

  /** Whether the rail is pointed at sandbox vs live money. Drives UI guardrails. */
  isTestMode(): boolean;

  /** Human label for the `source` field, shown on the surface (rail-specific). */
  readonly sourceLabel: string;

  /**
   * @description Take a payment on the merchant's connected account. MUST be idempotent
   * on `req.idempotencyKey`.
   * @param merchantToken - The caller's decrypted connector access token for this rail.
   * @param req - The normalized charge request.
   * @returns The created charge, normalized.
   */
  charge(merchantToken: string, req: ChargeRequest): Promise<ChargeResult>;

  /**
   * @description Fetch the current status of a previously-created charge.
   * @param merchantToken - The caller's decrypted connector access token for this rail.
   * @param chargeId - The id from `charge`.
   * @returns The charge's current normalized state.
   */
  getCharge(merchantToken: string, chargeId: string): Promise<ChargeResult>;
}
