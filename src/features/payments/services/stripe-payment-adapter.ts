/**
 * Stripe payment adapter — the first concrete money-movement rail.
 *
 * Implements `PaymentAdapter` over the Stripe REST API (api.stripe.com) using
 * `fetch` + form-encoded bodies + Bearer auth — no `stripe` SDK dependency, same
 * style as finance-plaid.ts. Money movement is an ACH debit of the user's own
 * linked bank account via a PaymentIntent with `payment_method_types[]=us_bank_account`:
 * the user authorizes pulling money FROM their bank. The provider-agnostic interface
 * keeps the door open for a true account-to-account rail (Plaid Transfer / Dwolla)
 * as a sibling adapter without touching callers.
 *
 * Test mode is driven entirely by the key: a `sk_test_…` secret key targets Stripe's
 * test environment (fake banks, no real money). `isTestMode()` reports it so the
 * surface can warn before anything goes near live funds.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Stripe PaymentIntent (us_bank_account ACH) create + retrieve, idempotency-keyed, normalized status mapping. fetch-based, no SDK.
 *
 * @module stripe-payment-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  PaymentAdapter, PaymentProviderType, TransferRequest, TransferResult, TransferStatus,
} from './payment-adapter';

const logger = createChildLogger({ module: 'stripe-payment-adapter' });
const STRIPE_BASE = 'https://api.stripe.com/v1';

/** Map Stripe PaymentIntent status → our normalized TransferStatus. */
function normalizeStatus(stripeStatus: string): TransferStatus {
  switch (stripeStatus) {
    case 'succeeded': return 'succeeded';
    case 'processing': return 'processing';
    case 'canceled': return 'canceled';
    case 'requires_payment_method':
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_capture': return 'pending';
    default: return 'failed';
  }
}

/** Shape of the bits of a Stripe PaymentIntent we read. */
interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  last_payment_error?: { message?: string };
}

/** The Stripe-backed money-movement rail. */
export class StripePaymentAdapter implements PaymentAdapter {
  readonly provider: PaymentProviderType = 'stripe';
  private readonly secretKey: string;

  constructor(secretKey = process.env.STRIPE_SECRET_KEY || '') {
    this.secretKey = secretKey;
  }

  /** True once a Stripe secret key is present. */
  configured(): boolean {
    return Boolean(this.secretKey);
  }

  /** Test mode iff the key is a test key (`sk_test_…` / `rk_test_…`). */
  isTestMode(): boolean {
    return /_test_/.test(this.secretKey);
  }

  /**
   * @description Low-level Stripe POST/GET. Form-encodes the body, injects the
   * Bearer key + optional Idempotency-Key, and throws on a non-2xx with Stripe's message.
   * @param method - HTTP method.
   * @param pathname - Stripe API path (e.g. '/payment_intents').
   * @param form - Form fields (omitted for GET).
   * @param idempotencyKey - Optional Stripe Idempotency-Key header.
   * @returns The parsed JSON response.
   */
  private async request<T>(method: 'GET' | 'POST', pathname: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const r = await fetch(`${STRIPE_BASE}${pathname}`, {
      method,
      headers,
      body: method === 'POST' && form ? new URLSearchParams(form).toString() : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
    if (!r.ok) {
      throw new Error(j.error?.message || `stripe ${pathname} ${r.status}`);
    }
    return j as T;
  }

  /**
   * @description Move money by debiting the user's linked bank account via an ACH
   * PaymentIntent. Confirms immediately with the supplied bank PaymentMethod;
   * ACH typically returns 'processing' and settles asynchronously.
   * @param req - The normalized transfer request (amount in cents, source = PaymentMethod id).
   * @returns The created transfer, normalized.
   */
  async createTransfer(req: TransferRequest): Promise<TransferResult> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
      throw new Error('amountCents must be a positive integer (minor units)');
    }
    logger.info({ userSub: req.userSub, amountCents: req.amountCents, currency: req.currency, test: this.isTestMode() }, 'stripe createTransfer');
    const form: Record<string, string> = {
      amount: String(req.amountCents),
      currency: req.currency.toLowerCase(),
      'payment_method_types[]': 'us_bank_account',
      payment_method: req.source.id,
      confirm: 'true',
      'mandate_data[customer_acceptance][type]': 'offline',
      'metadata[user_sub]': req.userSub,
      'metadata[payee]': req.payeeLabel || '',
      description: req.description || 'OSHAL Finance transfer',
    };
    const pi = await this.request<StripePaymentIntent>('POST', '/payment_intents', form, req.idempotencyKey);
    return this.toResult(pi);
  }

  /**
   * @description Retrieve a PaymentIntent and report its current normalized status.
   * @param transferId - The Stripe PaymentIntent id from createTransfer.
   * @returns The transfer's current state.
   */
  async getTransfer(transferId: string): Promise<TransferResult> {
    const pi = await this.request<StripePaymentIntent>('GET', `/payment_intents/${encodeURIComponent(transferId)}`);
    return this.toResult(pi);
  }

  /** Fold a Stripe PaymentIntent into the normalized TransferResult. */
  private toResult(pi: StripePaymentIntent): TransferResult {
    const status = normalizeStatus(pi.status);
    return {
      id: pi.id,
      status,
      amountCents: pi.amount,
      currency: pi.currency,
      provider: this.provider,
      rawStatus: pi.status,
      failureReason: status === 'failed' ? (pi.last_payment_error?.message || 'payment failed') : undefined,
    };
  }
}
