/**
 * Square merchant payment adapter — direct card charge on the merchant's account.
 *
 * Implements `MerchantPaymentAdapter` over the Square Payments API
 * (`POST /v2/payments`) using the connected merchant's brokered OAuth token. The
 * `source` is a tokenized card nonce from the Square Web Payments SDK; in Sandbox the
 * test value `cnon:card-nonce-ok` charges successfully. fetch-based, no SDK — same
 * style as the rest of OSHAL's connectors.
 *
 * Sandbox vs production is env-selectable (`SQUARE_ENV`), mirroring the Square
 * connector in connectors-routes.ts so the connect→charge flow is one environment.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Square /v2/payments create + retrieve via the merchant's brokered token, idempotency-keyed, normalized status.
 *
 * @module square-merchant-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  MerchantPaymentAdapter, MerchantProviderType, ChargeRequest, ChargeResult, ChargeStatus,
} from './merchant-payment-adapter';

const logger = createChildLogger({ module: 'square-merchant-adapter' });

const SQUARE_SANDBOX = (process.env.SQUARE_ENV || 'sandbox') !== 'production';
const SQUARE_BASE = SQUARE_SANDBOX ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-12-18';

/** Map a Square payment status → normalized ChargeStatus. */
function normalize(status: string): ChargeStatus {
  switch (status) {
    case 'COMPLETED': return 'completed';
    case 'APPROVED':
    case 'PENDING': return 'pending';
    case 'CANCELED': return 'canceled';
    default: return 'failed';
  }
}

/** Bits of a Square Payment we read. */
interface SquarePayment {
  id?: string;
  status?: string;
  amount_money?: { amount?: number; currency?: string };
}

/** The Square merchant charge rail. */
export class SquareMerchantAdapter implements MerchantPaymentAdapter {
  readonly provider: MerchantProviderType = 'square';
  readonly sourceLabel = 'Card token (Web Payments SDK nonce)';

  isTestMode(): boolean { return SQUARE_SANDBOX; }

  /** Low-level Square call with the merchant's bearer token + version header. */
  private async call<T>(token: string, method: 'GET' | 'POST', pathname: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json',
    };
    const r = await fetch(`${SQUARE_BASE}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json().catch(() => ({}))) as { errors?: Array<{ detail?: string }> } & Record<string, unknown>;
    if (!r.ok) throw new Error(j.errors?.[0]?.detail || `square ${pathname} ${r.status}`);
    return j as T;
  }

  /**
   * @description Charge a tokenized card on the merchant's account via /v2/payments.
   * @param merchantToken - The merchant's brokered Square access token.
   * @param req - The normalized charge request (source = card nonce).
   * @returns The created payment, normalized.
   */
  async charge(merchantToken: string, req: ChargeRequest): Promise<ChargeResult> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new Error('amountCents must be a positive integer (cents)');
    logger.info({ userSub: req.userSub, amountCents: req.amountCents, currency: req.currency, test: SQUARE_SANDBOX }, 'square charge');
    const j = await this.call<{ payment?: SquarePayment }>(merchantToken, 'POST', '/v2/payments', {
      source_id: req.source,
      idempotency_key: req.idempotencyKey,
      amount_money: { amount: req.amountCents, currency: req.currency.toUpperCase() },
      note: req.note || 'OSHAL payment',
    }, req.idempotencyKey);
    return this.toResult(j.payment || {});
  }

  /**
   * @description Retrieve a payment's current status.
   * @param merchantToken - The merchant's brokered Square access token.
   * @param chargeId - The Square payment id.
   * @returns The payment's current normalized state.
   */
  async getCharge(merchantToken: string, chargeId: string): Promise<ChargeResult> {
    const j = await this.call<{ payment?: SquarePayment }>(merchantToken, 'GET', `/v2/payments/${encodeURIComponent(chargeId)}`);
    return this.toResult(j.payment || {});
  }

  /** Fold a Square Payment into the normalized result. */
  private toResult(p: SquarePayment): ChargeResult {
    const status = normalize(p.status || '');
    return {
      id: p.id || '',
      status,
      amountCents: Number(p.amount_money?.amount ?? 0),
      currency: p.amount_money?.currency || 'USD',
      provider: this.provider,
      rawStatus: p.status,
      failureReason: status === 'failed' ? (p.status || 'payment failed') : undefined,
    };
  }
}
