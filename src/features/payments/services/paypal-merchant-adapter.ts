/**
 * PayPal merchant payment adapter — invoice the customer on the merchant's account.
 *
 * Implements `MerchantPaymentAdapter` over the PayPal Invoicing API v2 using the
 * connected merchant's brokered OAuth token. PayPal does not expose a simple
 * "charge this card now" call to a connected merchant the way Square does (that needs
 * Advanced Card Payments onboarding); the rail-appropriate "take a payment" is to
 * create + send an invoice the customer pays. So `source` is the customer's email and
 * the result carries the PayPal-hosted invoice URL as `payerActionUrl`.
 *
 * Sandbox vs production is env-selectable (`PAYPAL_ENV`), mirroring the PayPal
 * connector in connectors-routes.ts. fetch-based, no SDK.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — PayPal Invoicing v2 create+send via the merchant's brokered token, status retrieve, normalized status + hosted invoice URL.
 *
 * @module paypal-merchant-adapter
 */

import { createChildLogger } from '@/shared/logger';
import type {
  MerchantPaymentAdapter, MerchantProviderType, ChargeRequest, ChargeResult, ChargeStatus,
} from './merchant-payment-adapter';

const logger = createChildLogger({ module: 'paypal-merchant-adapter' });

const PAYPAL_SANDBOX = (process.env.PAYPAL_ENV || 'sandbox') !== 'production';
const PAYPAL_API = PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

/** Map a PayPal invoice status → normalized ChargeStatus. */
function normalize(status: string): ChargeStatus {
  switch (status) {
    case 'PAID':
    case 'MARKED_AS_PAID': return 'completed';
    case 'DRAFT':
    case 'SENT':
    case 'UNPAID':
    case 'PAYMENT_PENDING':
    case 'PARTIALLY_PAID': return 'pending';
    case 'CANCELLED':
    case 'REFUNDED': return 'canceled';
    default: return 'failed';
  }
}

/** Bits of a PayPal invoice we read. */
interface PayPalInvoice {
  id?: string;
  status?: string;
  detail?: { currency_code?: string; metadata?: { recipient_view_url?: string } };
  amount?: { currency_code?: string; value?: string };
}

/** The PayPal merchant charge rail (invoice-based). */
export class PayPalMerchantAdapter implements MerchantPaymentAdapter {
  readonly provider: MerchantProviderType = 'paypal';
  readonly sourceLabel = "Customer's email address (an invoice is sent)";

  isTestMode(): boolean { return PAYPAL_SANDBOX; }

  /** Low-level PayPal call with the merchant's bearer token. */
  private async call<T>(token: string, method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const r = await fetch(`${PAYPAL_API}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    const j = (text ? JSON.parse(text) : {}) as { message?: string; name?: string } & Record<string, unknown>;
    if (!r.ok) throw new Error(j.message || j.name || `paypal ${pathname} ${r.status}`);
    return j as T;
  }

  /**
   * @description Create + send an invoice for `amountCents` to the customer email in `source`.
   * @param merchantToken - The merchant's brokered PayPal access token.
   * @param req - The normalized charge request (source = customer email).
   * @returns The invoice as a pending charge, with the hosted invoice URL.
   */
  async charge(merchantToken: string, req: ChargeRequest): Promise<ChargeResult> {
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new Error('amountCents must be a positive integer (cents)');
    const currency = req.currency.toUpperCase();
    const value = (req.amountCents / 100).toFixed(2);
    logger.info({ userSub: req.userSub, amountCents: req.amountCents, currency, test: PAYPAL_SANDBOX }, 'paypal invoice charge');
    const created = await this.call<{ href?: string; id?: string }>(merchantToken, 'POST', '/v2/invoicing/invoices', {
      detail: { currency_code: currency, note: req.note || 'OSHAL payment', reference: req.idempotencyKey },
      primary_recipients: [{ billing_info: { email_address: req.source } }],
      items: [{ name: req.note || 'Payment', quantity: '1', unit_amount: { currency_code: currency, value } }],
    });
    const id = created.id || (created.href ? created.href.split('/').pop() || '' : '');
    if (!id) throw new Error('paypal invoice id missing from create response');
    await this.call(merchantToken, 'POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true });
    return this.getCharge(merchantToken, id);
  }

  /**
   * @description Retrieve an invoice's current status + hosted URL.
   * @param merchantToken - The merchant's brokered PayPal access token.
   * @param chargeId - The PayPal invoice id.
   * @returns The invoice's current normalized state.
   */
  async getCharge(merchantToken: string, chargeId: string): Promise<ChargeResult> {
    const inv = await this.call<PayPalInvoice>(merchantToken, 'GET', `/v2/invoicing/invoices/${encodeURIComponent(chargeId)}`);
    const cents = inv.amount?.value ? Math.round(parseFloat(inv.amount.value) * 100) : 0;
    return {
      id: inv.id || chargeId,
      status: normalize(inv.status || ''),
      amountCents: cents,
      currency: inv.amount?.currency_code || inv.detail?.currency_code || 'USD',
      provider: this.provider,
      rawStatus: inv.status,
      payerActionUrl: inv.detail?.metadata?.recipient_view_url,
    };
  }
}
