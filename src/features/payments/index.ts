/**
 * payments feature — provider-agnostic money movement.
 *
 * Public surface: the `PaymentAdapter` contract + its normalized types, the concrete
 * Stripe rail, and `getPaymentAdapter()` (PAYMENT_PROVIDER-selected). Import ONLY from
 * this barrel (`@/features/payments`) — no deep imports (Feature-Sliced Design).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel — PaymentAdapter contract, StripePaymentAdapter, getPaymentAdapter factory.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the merchant "take a payment" rails — MerchantPaymentAdapter contract, Square + PayPal adapters, getMerchantAdapter/listMerchantProviders.
 *
 * @module payments
 */

export type {
  PaymentAdapter, PaymentProviderType, PaymentSource,
  TransferRequest, TransferResult, TransferStatus,
} from './services/payment-adapter';
export { StripePaymentAdapter } from './services/stripe-payment-adapter';
export { getPaymentAdapter } from './services/payment-provider';

// Merchant "take a payment" rails (Square, PayPal) — charge on a connected merchant
// account using the caller's brokered token.
export type {
  MerchantPaymentAdapter, MerchantProviderType,
  ChargeRequest, ChargeResult, ChargeStatus,
} from './services/merchant-payment-adapter';
export { SquareMerchantAdapter } from './services/square-merchant-adapter';
export { PayPalMerchantAdapter } from './services/paypal-merchant-adapter';
export { getMerchantAdapter, listMerchantProviders } from './services/merchant-payment-registry';
