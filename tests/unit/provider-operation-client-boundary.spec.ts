/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Prove the four application provider
 *     | operations are import-safe, accept credentials only as request-scoped arguments, ignore
 *     | ambient credential state, and keep standalone CLI resolution behind require.main guards.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireModule = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const scriptPath = (name: string): string => path.join(ROOT, 'scripts', name);

interface OperationModule {
  [name: string]: unknown;
}

const walmart = requireModule(scriptPath('oshal-walmart.js')) as OperationModule & {
  executeWalmartOperation(credential: unknown, args: string[]): Promise<Record<string, any>>;
};
const rides = requireModule(scriptPath('oshal-uber-rides.js')) as OperationModule & {
  executeUberRidesOperation(
    credential: unknown,
    args: string[],
    options?: Record<string, unknown>,
  ): Promise<Record<string, any>>;
};
const eats = requireModule(scriptPath('oshal-uber.js')) as OperationModule & {
  executeUberEatsOperation(credential: unknown, args: string[]): Promise<Record<string, any>>;
};
const duffel = requireModule(scriptPath('oshal-duffel.js')) as OperationModule & {
  executeDuffelOperation(
    credential: unknown,
    args: string[],
    options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
  ): Promise<Record<string, any>>;
};

const AMBIENT_NAMES = [
  'OSHAL_CRED_WALMART',
  'OSHAL_CRED_UBER_RIDES',
  'OSHAL_CRED_UBER',
  'OSHAL_CRED_DUFFEL',
  'DUFFEL_ACCESS_TOKEN',
] as const;
const previousAmbient = new Map<string, string | undefined>();

beforeEach(() => {
  previousAmbient.clear();
  for (const name of AMBIENT_NAMES) previousAmbient.set(name, process.env[name]);
  process.env.OSHAL_CRED_WALMART = 'ambient-walmart-must-not-be-read';
  process.env.OSHAL_CRED_UBER_RIDES = 'ambient-rides-must-not-be-read';
  process.env.OSHAL_CRED_UBER = 'ambient-eats-must-not-be-read';
  process.env.OSHAL_CRED_DUFFEL = 'duffel_live_ambientmustnotberead';
  process.env.DUFFEL_ACCESS_TOKEN = 'duffel_live_ambientfallbackmustnotberead';
});

afterEach(() => {
  for (const [name, value] of previousAmbient) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('request-scoped provider operation boundary', () => {
  it('treats an absent explicit credential as absent even when every ambient carrier is populated', async () => {
    await expect(walmart.executeWalmartOperation(undefined, ['status'])).resolves.toMatchObject({
      configured: false,
      mode: 'demo',
    });
    await expect(rides.executeUberRidesOperation(undefined, ['status'])).resolves.toMatchObject({
      configured: false,
      service: 'uber-rides',
    });
    await expect(eats.executeUberEatsOperation(undefined, ['status'])).resolves.toMatchObject({
      configured: false,
      affiliate: false,
    });
    await expect(duffel.executeDuffelOperation(undefined, ['status'])).resolves.toMatchObject({
      configured: false,
      mode: 'demo',
      live: false,
    });
  });

  it('fails closed on malformed explicit credentials instead of falling back to ambient state', async () => {
    await expect(walmart.executeWalmartOperation(JSON.stringify({
      consumerId: 'request',
      privateKeyPem: 'not-used-by-status',
      baseUrl: 'http://127.0.0.1:5000',
    }), ['status'])).rejects.toThrow('valid request-scoped credential');
    await expect(rides.executeUberRidesOperation(JSON.stringify({
      clientId: 'request',
      baseUrl: 'https://m.uber.com.attacker.example',
    }), ['status'])).rejects.toThrow('valid request-scoped credential');
    await expect(eats.executeUberEatsOperation(JSON.stringify({
      affiliateId: 'request',
      baseUrl: 'https://attacker.example',
    }), ['status'])).rejects.toThrow('valid request-scoped credential');
    await expect(duffel.executeDuffelOperation('not-a-duffel-token', ['status']))
      .rejects.toThrow('valid request-scoped token');
  });

  it('runs catalog and handoff operations directly without a subprocess', async () => {
    const walmartResult = await walmart.executeWalmartOperation(undefined, ['search', 'milk', '2']);
    expect(walmartResult).toMatchObject({ source: 'demo', fallbackReason: 'not_connected' });
    expect(walmartResult.items).toHaveLength(2);

    const eatsResult = await eats.executeUberEatsOperation(
      JSON.stringify({ affiliateId: 'request-campaign' }),
      ['order', 'chipotle'],
    );
    expect(eatsResult.tracked).toBe(true);
    expect(eatsResult.checkoutUrl).toMatch(/^https:\/\/www\.ubereats\.com\/store\/chipotle-mexican-grill\?/u);
    expect(new URL(eatsResult.checkoutUrl).searchParams.get('utm_campaign')).toBe('request-campaign');

    const links = vi.fn(async () => ({
      webUrl: 'https://m.uber.com/go/product-selection',
      appUrl: 'https://m.uber.com/ul/?action=setPickup',
      geocoded: { pickup: true, dropoff: true },
    }));
    const ridesResult = await rides.executeUberRidesOperation(
      JSON.stringify({ clientId: 'request-client' }),
      ['ride', 'VPS airport', 'Destin, FL', 'uberx'],
      { buildRideLinks: links },
    );
    expect(links).toHaveBeenCalledOnce();
    expect(links.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'request-client',
      baseUrl: 'https://m.uber.com',
    });
    expect(ridesResult).toMatchObject({ source: 'uber', rideType: 'uberx' });
  });

  it('sends only the explicit Duffel token to the fixed provider origin', async () => {
    const explicitToken = 'duffel_test_requestscoped123456';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        offers: [{
          id: 'off_1',
          total_amount: '142.30',
          total_currency: 'USD',
          owner: { name: 'Boundary Air' },
          expires_at: '2026-09-01T00:00:00Z',
          slices: [{
            origin: { iata_code: 'VPS' },
            destination: { iata_code: 'DFW' },
            duration: 'PT2H10M',
            segments: [{
              origin: { iata_code: 'VPS' },
              destination: { iata_code: 'DFW' },
              departing_at: '2026-09-01T08:00:00',
              arriving_at: '2026-09-01T10:10:00',
              marketing_carrier: { name: 'Boundary Air' },
              passengers: [{ cabin_class: 'economy' }],
            }],
          }],
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await duffel.executeDuffelOperation(
      explicitToken,
      ['flights', 'VPS', 'DFW', '2026-09-01', '1', 'economy'],
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toMatchObject({ source: 'duffel', items: [{ id: 'off_1', price: 142.3 }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.duffel.com/air/offer_requests?return_offers=true');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${explicitToken}`);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not follow Duffel redirects or reflect provider bodies into the demo fallback', async () => {
    const providerSecret = 'provider-body-secret-must-not-cross-the-boundary';
    const response = new Response(JSON.stringify({ error: providerSecret }), {
      status: 302,
      headers: {
        'Content-Type': 'application/json',
        Location: 'https://attacker.example/capture',
      },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi.fn(async () => response);

    const result = await duffel.executeDuffelOperation(
      'duffel_test_requestscoped123456',
      ['flights', 'VPS', 'DFW', '2026-09-01', '1', 'economy'],
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result.source).toBe('demo');
    expect(result.note).toBe('Duffel provider returned HTTP 302.');
    expect(JSON.stringify(result)).not.toContain(providerSecret);
    expect(cancel).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('manual');
  });
});

describe('import and controller bridge shape', () => {
  const scripts = [
    ['oshal-walmart.js', 'executeWalmartOperation'],
    ['oshal-uber-rides.js', 'executeUberRidesOperation'],
    ['oshal-uber.js', 'executeUberEatsOperation'],
    ['oshal-duffel.js', 'executeDuffelOperation'],
  ] as const;

  it('keeps all ambient credential loaders behind explicit CLI main guards', () => {
    for (const [fileName, exportName] of scripts) {
      const source = readFileSync(scriptPath(fileName), 'utf8');
      expect(source, fileName).toMatch(/if\s*\(require\.main\s*===\s*module\)/u);
      expect(source, fileName).toMatch(new RegExp(`module\\.exports[\\s\\S]*${exportName}`));
    }
  });

  it('uses one typed in-process bridge and contains no subprocess transport', () => {
    const source = readFileSync(path.join(ROOT, 'src/app/routes/provider-operation-clients.ts'), 'utf8');
    for (const [, exportName] of scripts) expect(source).toContain(exportName);
    expect(source).not.toMatch(/child_process|execFile|spawn\s*\(/u);
    expect(source).not.toMatch(/process\.env|OSHAL_CRED_[A-Z0-9_]+/u);
  });
});
