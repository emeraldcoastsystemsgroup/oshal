/**
 * Payment provider factory — selects the active money-movement rail.
 *
 * Parallels HARNESS_FACTORIES in provider-runtime.ts: a single registry maps each
 * `PaymentProviderType` to a constructor, and `getPaymentAdapter()` returns the one
 * named by `PAYMENT_PROVIDER` (default 'stripe'). Adding a rail = register a sibling
 * adapter here; callers (finance-routes) never branch on the provider.
 *
 * Only the Stripe rail is built today. Plaid Transfer and Dwolla are registered as
 * NOT-yet-implemented so an explicit `PAYMENT_PROVIDER=dwolla` fails loudly with a
 * clear message rather than silently doing nothing.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — PAYMENT_PROVIDER-selected factory; stripe wired, plaid-transfer/dwolla declared as not-yet-implemented.
 *
 * @module payment-provider
 */

import { createChildLogger } from '@/shared/logger';
import type { PaymentAdapter, PaymentProviderType } from './payment-adapter';
import { StripePaymentAdapter } from './stripe-payment-adapter';

const logger = createChildLogger({ module: 'payment-provider' });

/** Rails not yet implemented — registered so an explicit selection fails clearly. */
const NOT_IMPLEMENTED: Record<string, string> = {
  'plaid-transfer': 'Plaid Transfer rail is not implemented yet — set PAYMENT_PROVIDER=stripe.',
  dwolla: 'Dwolla rail is not implemented yet — set PAYMENT_PROVIDER=stripe.',
};

/** Constructors for the implemented rails, keyed by provider type. */
const FACTORIES: Partial<Record<PaymentProviderType, () => PaymentAdapter>> = {
  stripe: () => new StripePaymentAdapter(),
};

/**
 * @description Resolve the configured money-movement rail.
 * @returns The active `PaymentAdapter`.
 * @throws If `PAYMENT_PROVIDER` names a known-but-unimplemented or unknown rail.
 */
export function getPaymentAdapter(): PaymentAdapter {
  const name = (process.env.PAYMENT_PROVIDER || 'stripe') as PaymentProviderType;
  const factory = FACTORIES[name];
  if (!factory) {
    const known = NOT_IMPLEMENTED[name];
    logger.error({ provider: name }, 'unavailable payment provider requested');
    throw new Error(known || `Unknown PAYMENT_PROVIDER '${name}'. Supported: ${Object.keys(FACTORIES).join(', ')}.`);
  }
  return factory();
}
