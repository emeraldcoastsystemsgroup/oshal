/**
 * Merchant payment registry — resolves the "take a payment" rail by provider.
 *
 * Parallels the connector registry + HARNESS_FACTORIES: one map from
 * `MerchantProviderType` to a constructor. The Payments route reads the provider the
 * caller picked (and has connected), pulls its brokered token, and calls the adapter.
 * Adding "whatever" rail = one entry here + its connector in connectors-routes.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — square + paypal merchant rails; getMerchantAdapter + listMerchantProviders.
 *
 * @module merchant-payment-registry
 */

import type { MerchantPaymentAdapter, MerchantProviderType } from './merchant-payment-adapter';
import { SquareMerchantAdapter } from './square-merchant-adapter';
import { PayPalMerchantAdapter } from './paypal-merchant-adapter';

/** Constructors for every implemented merchant rail, keyed by provider. */
const MERCHANT_FACTORIES: Record<MerchantProviderType, () => MerchantPaymentAdapter> = {
  square: () => new SquareMerchantAdapter(),
  paypal: () => new PayPalMerchantAdapter(),
};

/**
 * @description Resolve the merchant payment rail for a provider.
 * @param provider - The merchant provider id (also the connector id).
 * @returns The adapter, or null if the provider is unknown.
 */
export function getMerchantAdapter(provider: string): MerchantPaymentAdapter | null {
  const factory = MERCHANT_FACTORIES[provider as MerchantProviderType];
  return factory ? factory() : null;
}

/** All merchant provider ids OSHAL can take payments through. */
export function listMerchantProviders(): MerchantProviderType[] {
  return Object.keys(MERCHANT_FACTORIES) as MerchantProviderType[];
}
