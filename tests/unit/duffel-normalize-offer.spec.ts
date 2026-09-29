/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | scripts/oshal-duffel.js normalizeOffer: a Duffel offer flattens to the card the surfaces use (price, currency, airline, cabin, expiry, slices with times, duration, stops, carriers) and keeps the city names of each slice (slice-level city_name first, the segments' otherwise, null when none).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeOffer } = require('../../scripts/oshal-duffel.js') as { normalizeOffer: (offer: unknown) => Record<string, any> };

describe('scripts/oshal-duffel.js normalizeOffer', () => {
  it('flattens a Duffel offer to the card the surfaces use, keeping the city names of each slice', () => {
    const offer = {
      id: 'off_1', total_amount: '218.40', total_currency: 'USD', owner: { name: 'Synthetic Air' }, expires_at: '2030-03-01T12:00:00Z',
      slices: [
        { origin: { iata_code: 'PNS', city_name: 'Pensacola' }, destination: { iata_code: 'LAS', city_name: 'Las Vegas' }, duration: 'PT6H12M',
          segments: [
            { departing_at: '2030-03-01T14:10:00', arriving_at: '2030-03-01T16:00:00', marketing_carrier: { name: 'Synthetic Air' }, origin: { iata_code: 'PNS' }, destination: { iata_code: 'ATL' }, passengers: [{ cabin_class: 'economy' }] },
            { departing_at: '2030-03-01T17:00:00', arriving_at: '2030-03-01T18:22:00', marketing_carrier: { name: 'Synthetic Air' }, origin: { iata_code: 'ATL' }, destination: { iata_code: 'LAS' } },
          ] },
        { duration: 'PT4H30M',
          segments: [{ departing_at: '2030-03-03T18:10:00', arriving_at: '2030-03-03T23:40:00', marketing_carrier: { name: 'Synthetic Air' }, origin: { iata_code: 'LAS', city_name: 'Las Vegas' }, destination: { iata_code: 'PNS', city_name: 'Pensacola' } }] },
      ],
    };
    const card = normalizeOffer(offer);
    expect(card).toMatchObject({ id: 'off_1', price: 218.4, currency: 'USD', airline: 'Synthetic Air', cabin: 'economy', expiresAt: '2030-03-01T12:00:00Z' });
    expect(card.slices[0]).toEqual({ origin: 'PNS', destination: 'LAS', originCity: 'Pensacola', destinationCity: 'Las Vegas', departAt: '2030-03-01T14:10:00', arriveAt: '2030-03-01T18:22:00', duration: '6h 12m', stops: 1, carriers: ['Synthetic Air'] });
    expect(card.slices[1]).toMatchObject({ origin: 'LAS', destination: 'PNS', originCity: 'Las Vegas', destinationCity: 'Pensacola', duration: '4h 30m', stops: 0 });
  });

  it('leaves the city null when neither the slice nor its segments name one, and defaults the currency', () => {
    const card = normalizeOffer({ id: 'off_2', total_amount: '99', slices: [{ segments: [{ origin: { iata_code: 'PNS' }, destination: { iata_code: 'ATL' }, departing_at: '2030-03-01T08:00:00' }] }] });
    expect(card.slices[0]).toMatchObject({ origin: 'PNS', destination: 'ATL', originCity: null, destinationCity: null, duration: null, stops: 0, carriers: [] });
    expect(card).toMatchObject({ price: 99, currency: 'USD', airline: '', cabin: null, expiresAt: null });
  });
});
