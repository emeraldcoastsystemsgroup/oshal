import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// (The walmart-catalog action-POLICY tests — walmartFallbackMetadata /
//  walmartCatalogAllowsActions / enforceWalmartCatalogActionPolicy — moved to the
//  purchasing store package's tests at the ADR-085 Wave 2 #5 carve; those functions
//  are app-owned and left with purchasing-routes. This spec keeps only the
//  framework-resident oshal-walmart.js CLI tests.)

const execFileAsync = promisify(execFile);
const requireModule = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const WALMART_CLI = path.join(ROOT, 'scripts/oshal-walmart.js');
const walmartCliModule = requireModule(WALMART_CLI) as {
  parseCredentialArgument(raw: unknown): Record<string, unknown> | null;
  searchLiveCatalog(
    credential: unknown,
    query: string,
    limit: number,
    options?: { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number },
  ): Promise<Record<string, any>>;
};
let isolatedCwd = '';
let requestScopedCredential = '';

beforeAll(async () => {
  isolatedCwd = await mkdtemp(path.join(tmpdir(), 'oshal-walmart-test-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  requestScopedCredential = JSON.stringify({
    consumerId: 'transport-test-consumer',
    keyVersion: '1',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
});

afterAll(async () => {
  if (isolatedCwd) await rm(isolatedCwd, { recursive: true, force: true });
});

async function runWalmart(args: string[], overrides: NodeJS.ProcessEnv = {}): Promise<Record<string, any>> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete env.DATABASE_URL;
  delete env.PGHOST;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'OSHAL_CRED_WALMART')) {
    delete env.OSHAL_CRED_WALMART;
  }
  const { stdout } = await execFileAsync(process.execPath, [WALMART_CLI, ...args], {
    cwd: isolatedCwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(stdout));
}

describe('Walmart CLI demo fallback diagnostics', () => {
  it('exports an in-process live search that uses only its credential argument and never mutates env', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const requestCredential = JSON.stringify({
      consumerId: 'request-scoped-consumer',
      keyVersion: '1',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publisherId: 'request-scoped-publisher',
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        itemId: 10849069,
        name: 'Tetra TetraMin Tropical Flakes',
        salePrice: 7.97,
        largeImage: 'https://i5.walmartimages.com/asr/tetra.jpeg',
        productTrackingUrl: 'https://goto.walmart.com/c/|PUBID|/568844/9383?u=https%3A%2F%2Fwww.walmart.com%2Fip%2F10849069',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const previousAmbient = process.env.OSHAL_CRED_WALMART;
    process.env.OSHAL_CRED_WALMART = 'ambient-credential-must-not-be-used';

    try {
      const result = await walmartCliModule.searchLiveCatalog(
        requestCredential,
        'fish food',
        1,
        { fetchImpl: fetchImpl as typeof fetch, now: () => new Date('2026-07-12T14:30:00.000Z') },
      );

      expect(fetchImpl).toHaveBeenCalledOnce();
      const [requestUrl, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(requestUrl).toContain('https://developer.api.walmart.com/api-proxy/service/affil/product/v2/search?');
      expect(requestUrl).toContain('query=fish+food');
      expect(requestUrl).toContain('numItems=1');
      expect(requestUrl).toContain('publisherId=request-scoped-publisher');
      expect((requestInit.headers as Record<string, string>)['WM_CONSUMER.ID']).toBe('request-scoped-consumer');
      expect(requestInit.redirect).toBe('manual');
      expect(requestInit.signal).toBeInstanceOf(AbortSignal);
      expect(result).toMatchObject({
        source: 'walmart',
        retrievedAt: '2026-07-12T14:30:00.000Z',
        items: [{
          productId: '10849069', title: 'Tetra TetraMin Tropical Flakes',
          productUrl: 'https://www.walmart.com/ip/10849069',
        }],
      });
      expect(process.env.OSHAL_CRED_WALMART).toBe('ambient-credential-must-not-be-used');
      expect(walmartCliModule.parseCredentialArgument(undefined)).toBeNull();
    } finally {
      if (previousAmbient === undefined) delete process.env.OSHAL_CRED_WALMART;
      else process.env.OSHAL_CRED_WALMART = previousAmbient;
    }

    await expect(walmartCliModule.searchLiveCatalog(
      JSON.stringify({ consumerId: 'missing-key' }),
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('valid request-scoped credential');
    expect(fetchImpl).toHaveBeenCalledOnce();

    const parsedCredential = JSON.parse(requestCredential) as Record<string, unknown>;
    const maliciousBaseCredential = JSON.stringify({
      ...parsedCredential,
      baseUrl: 'http://127.0.0.1:5000',
    });
    expect(walmartCliModule.parseCredentialArgument(maliciousBaseCredential)).toBeNull();
    expect(walmartCliModule.parseCredentialArgument(JSON.stringify({
      ...parsedCredential,
      baseUrl: 'https://developer.api.walmart.com:443',
    }))).toBeNull();
    expect(walmartCliModule.parseCredentialArgument(JSON.stringify({
      ...parsedCredential,
      baseUrl: 'https://developer.api.walmart.com.attacker.example',
    }))).toBeNull();
    await expect(walmartCliModule.searchLiveCatalog(
      maliciousBaseCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('valid request-scoped credential');
    await expect(walmartCliModule.searchLiveCatalog(
      requestCredential,
      'fish food; env',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('query is invalid');
    await expect(walmartCliModule.searchLiveCatalog(
      requestCredential,
      'fish food',
      7,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('integer from 1 to 6');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not follow signed provider redirects and cancels the redirect body', async () => {
    const response = new Response(JSON.stringify({ locationSecret: 'must-not-be-reflected' }), {
      status: 302,
      headers: {
        'Content-Type': 'application/json',
        Location: 'https://attacker.example/credential-capture',
      },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi.fn(async () => response);

    await expect(walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('Walmart provider returned HTTP 302.');

    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestInit.redirect).toBe('manual');
    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects and cancels non-JSON provider responses without reflecting their body', async () => {
    const bodySecret = 'html-provider-secret-that-must-not-leak';
    const response = new Response(`<html>${bodySecret}</html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi.fn(async () => response);

    const error = await walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    ).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Walmart provider returned a non-JSON response.');
    expect(error.message).not.toContain(bodySecret);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects declared provider bodies over four MiB before reading and cancels them', async () => {
    const response = new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String((4 * 1024 * 1024) + 1),
      },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi.fn(async () => response);

    await expect(walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('Walmart provider response exceeded the JSON byte limit.');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('enforces the four MiB ceiling while streaming when Content-Length is absent', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3 * 1024 * 1024));
        controller.enqueue(new Uint8Array((1 * 1024 * 1024) + 1));
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow('Walmart provider response exceeded the JSON byte limit.');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects malformed provider JSON with a fixed body-safe error', async () => {
    const bodySecret = 'malformed-json-secret-that-must-not-leak';
    const fetchImpl = vi.fn(async () => new Response(`{"secret":"${bodySecret}"`, {
      status: 200,
      headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
    }));

    const error = await walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch },
    ).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Walmart provider returned invalid JSON.');
    expect(error.message).not.toContain(bodySecret);
  });

  it('aborts slow provider reads and replaces the transport reason with a fixed safe error', async () => {
    const transportSecret = 'transport-error-secret-that-must-not-leak';
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error(transportSecret)), { once: true });
    }));

    const error = await walmartCliModule.searchLiveCatalog(
      requestScopedCredential,
      'fish food',
      1,
      { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5 },
    ).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Walmart provider request could not be completed.');
    expect(error.message).not.toContain(transportSecret);
    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestInit.signal?.aborted).toBe(true);
  });

  it('timestamps a clean live catalog response at the provider boundary', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          itemId: 10849069,
          name: 'Tetra TetraMin Tropical Flakes',
          brandName: 'Tetra',
          salePrice: 7.97,
          largeImage: 'https://i5.walmartimages.com/asr/tetra.jpeg',
          productUrl: 'https://www.walmart.com/ip/10849069',
        }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runWalmart(['search', 'fish food', '1'], {
        OSHAL_CRED_WALMART: JSON.stringify({
          consumerId: 'catalog-test-consumer',
          keyVersion: '1',
          privateKeyPem,
          baseUrl: `http://127.0.0.1:${port}`,
        }),
      });

      expect(result).toMatchObject({
        source: 'walmart',
        retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        items: [{
          productId: '10849069',
          title: 'Tetra TetraMin Tropical Flakes',
          imageUrl: 'https://i5.walmartimages.com/asr/tetra.jpeg',
          productUrl: 'https://www.walmart.com/ip/10849069',
        }],
      });
      expect(result).not.toHaveProperty('fallbackReason');
      expect(result).not.toHaveProperty('error');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('labels demo results as not_connected only when no credential exists', async () => {
    const result = await runWalmart(['search', 'fish food', '2']);

    expect(result).toMatchObject({
      source: 'demo',
      fallbackReason: 'not_connected',
    });
    expect(result.items).toHaveLength(2);
    expect(result).not.toHaveProperty('providerError');
    expect(result).not.toHaveProperty('error');
  });

  it('labels a signed HTTP failure as provider_error without reflecting provider or credential data', async () => {
    const consumerId = 'consumer-id-that-must-not-leak';
    const responseSecret = 'provider-body-secret-that-must-not-leak';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let receivedHeaders: IncomingHttpHeaders | undefined;
    const server = createServer((req, res) => {
      receivedHeaders = req.headers;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: responseSecret, consumerId, privateKeyPem }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runWalmart(['search', 'fish food', '2'], {
        OSHAL_CRED_WALMART: JSON.stringify({
          consumerId,
          keyVersion: '1',
          privateKeyPem,
          publisherId: 'publisher-id-that-must-not-leak',
          baseUrl: `http://127.0.0.1:${port}`,
        }),
      });

      expect(receivedHeaders?.['wm_consumer.id']).toBe(consumerId);
      expect(receivedHeaders?.['wm_sec.auth_signature']).toBeTruthy();
      expect(result).toMatchObject({
        source: 'demo',
        fallbackReason: 'provider_error',
        providerError: {
          code: 'http_error',
          status: 503,
          message: 'Walmart provider returned HTTP 503.',
        },
        error: 'Walmart provider returned HTTP 503.',
      });
      expect(result.items).toHaveLength(2);
      expect(result.providerError.message.length).toBeLessThanOrEqual(160);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(responseSecret);
      expect(serialized).not.toContain(consumerId);
      expect(serialized).not.toContain('BEGIN PRIVATE KEY');
      expect(serialized).not.toContain('publisher-id-that-must-not-leak');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

});
