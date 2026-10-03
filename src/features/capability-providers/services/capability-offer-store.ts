/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b: the Postgres store over oshal_capability_provider_offers (migration 184): the unit price spend is recorded at and the quota label the options list shows, per (capability, provider). Plain DML over the caller's GUC-wrapped pool, so the table's operator-only write policy is the enforcement. offered_to is read and returned but not written here: the grant control and its enforcement are slice S2.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isCapability, type Capability, type CapabilityOfferAudience, type CapabilityProviderOffer } from '@/shared/capability-providers';

const logger = createChildLogger({ module: 'capability-offer-store' });

/** One row of oshal_capability_provider_offers as Postgres returns it. */
interface OfferRecord {
  capability: string;
  provider_id: string;
  offered_to: string | null;
  unit_price_usd: string | number | null;
  quota_label: string | null;
  updated_by: string | null;
  updated_at: Date | string | null;
}

const AUDIENCES: readonly CapabilityOfferAudience[] = ['operator', 'everyone', 'nobody'];
const COLUMNS = 'capability, provider_id, offered_to, unit_price_usd, quota_label, updated_by, updated_at';

/**
 * @description Shape one table row; NUMERIC arrives as a string and becomes a number.
 * @param record - The row.
 * @returns The offer, or null for a capability no CHECK would admit.
 */
function toOffer(record: OfferRecord): CapabilityProviderOffer | null {
  if (!isCapability(record.capability)) return null;
  const price = record.unit_price_usd === null ? null : Number(record.unit_price_usd);
  const updatedAt = record.updated_at instanceof Date ? record.updated_at.toISOString() : record.updated_at;
  return {
    capability: record.capability,
    providerId: record.provider_id,
    offeredTo: AUDIENCES.includes(record.offered_to as CapabilityOfferAudience) ? record.offered_to as CapabilityOfferAudience : null,
    unitPriceUsd: price !== null && Number.isFinite(price) ? price : null,
    quotaLabel: record.quota_label,
    updatedBy: record.updated_by,
    updatedAt: updatedAt ?? null,
  };
}

/**
 * @description Postgres store for the provider offers. The table's own policy decides who may write.
 */
export class CapabilityOfferStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Every offer row, by capability then provider.
   * @returns All offers.
   */
  async listAll(): Promise<CapabilityProviderOffer[]> {
    const result = await this.pool.query<OfferRecord>(`SELECT ${COLUMNS} FROM oshal_capability_provider_offers ORDER BY capability, provider_id`);
    return result.rows.map(toOffer).filter((offer): offer is CapabilityProviderOffer => offer !== null);
  }

  /**
   * @description Set one provider's price and quota label: ONE upsert. The caller validates the
   * provider against the capability's declarations first.
   * @param capability - The capability.
   * @param providerId - The provider.
   * @param values - The unit price (USD per unit, or null) and the quota label (or null).
   * @param updatedBy - Who wrote it (the operator subject).
   * @returns The offer as stored.
   */
  async upsert(
    capability: Capability,
    providerId: string,
    values: { unitPriceUsd: number | null; quotaLabel: string | null },
    updatedBy: string,
  ): Promise<CapabilityProviderOffer> {
    const result = await this.pool.query<OfferRecord>(
      `INSERT INTO oshal_capability_provider_offers (capability, provider_id, unit_price_usd, quota_label, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (capability, provider_id) DO UPDATE SET
         unit_price_usd = EXCLUDED.unit_price_usd,
         quota_label = EXCLUDED.quota_label,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING ${COLUMNS}`,
      [capability, providerId, values.unitPriceUsd, values.quotaLabel, updatedBy],
    );
    const offer = toOffer(result.rows[0]);
    if (!offer) throw new Error(`capability offer write returned an unreadable row for ${capability}`);
    logger.info({ capability, providerId, unitPriceUsd: offer.unitPriceUsd, quotaLabel: offer.quotaLabel, updatedBy }, 'Capability offer written');
    return offer;
  }

  /**
   * @description Clear one provider's offer row (no price, the class default offer).
   * @param capability - The capability.
   * @param providerId - The provider.
   * @returns True when a row was removed.
   */
  async remove(capability: Capability, providerId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM oshal_capability_provider_offers WHERE capability = $1 AND provider_id = $2', [capability, providerId]);
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) logger.info({ capability, providerId }, 'Capability offer removed');
    return removed;
  }
}
