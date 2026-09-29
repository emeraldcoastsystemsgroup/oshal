/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the actual qualified SmartThings adapter over a named loopback provider double, including OAuth, location binding, bounded bodies and cancellation; no live-provider claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { exchangeQualifiedSmartThings, verifyQualifiedSmartThings } from '@/app/routes/connector-qualified-smartthings';

const diagnostics = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => diagnostics }));

const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
const LOCATIONS_URL = 'https://api.smartthings.com/v1/locations';
const REDIRECT = 'https://qualified.example.test/api/connect/smartthings/callback';
const ACCESS = 'synthetic-access-secret', REFRESH = 'synthetic-refresh-secret';
const CLIENT = 'synthetic-client', SECRET = 'synthetic-client-secret', CODE = 'synthetic-code-secret';
const ACCOUNT = 'smartthings-location:location-a';
const realFetch = globalThis.fetch;
interface Received { method: string; path: string; headers: IncomingHttpHeaders; body: string }
let server: Server, base: string, received: Received[], outbound: { url: string; init?: RequestInit }[];
let tokenPayload: unknown, locationsPayload: unknown, serve: ((response: ServerResponse) => void) | undefined;
let served: Promise<void>, markServed: () => void;

/** Real HTTP listener; synthetic provider data and URL rewriting are the only transport doubles. */
async function startProviderFixture(): Promise<void> {
  received = []; outbound = [];
  served = new Promise<void>(resolve => { markServed = resolve; });
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      if (serve) serve(res);
      else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/oauth/token' ? tokenPayload : locationsPayload));
      }
      markServed();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture address unavailable');
  base = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== TOKEN_URL && url !== LOCATIONS_URL) throw new Error('fixture forbids external request');
    outbound.push({ url, init });
    return realFetch(base + new URL(url).pathname, init);
  }));
}

beforeEach(async () => {
  vi.clearAllMocks(); serve = undefined;
  vi.stubEnv('SMARTTHINGS_CLIENT_ID', CLIENT); vi.stubEnv('SMARTTHINGS_CLIENT_SECRET', SECRET);
  vi.stubEnv('SMARTTHINGS_OAUTH_CLIENT_ID', ''); vi.stubEnv('SMARTTHINGS_OAUTH_CLIENT_SECRET', '');
  vi.stubEnv('SMARTTHINGS_REDIRECT_URI', ''); vi.stubEnv('APP_URL', 'https://qualified.example.test');
  tokenPayload = { access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 3600 };
  locationsPayload = { items: [{ locationId: 'location-z', name: 'Other' }, { locationId: 'location-a', name: 'Home' }] };
  await startProviderFixture();
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function exchange(signal?: AbortSignal) { return exchangeQualifiedSmartThings(CODE, { redirect: REDIRECT, signal }); }
function safeError(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('expected safe error');
  expect(error.name).toBe('QualifiedSmartThingsError');
  expect(error.cause).toBeUndefined();
  return `${error.name}\n${error.message}\n${error.stack}`;
}
function logged(): string {
  return JSON.stringify([diagnostics.debug.mock.calls, diagnostics.info.mock.calls, diagnostics.error.mock.calls],
    (_key, value: unknown) => value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value);
}

describe('SmartThings adapter: loopback protocol proof (not live provider)', () => {
  it('exchanges a fresh code using the exact registered Basic OAuth protocol', async () => {
    const before = Date.now();
    const result = await exchange();
    expect(result).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(Date.parse(result.expiresAt!)).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(Date.parse(result.expiresAt!)).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', path: '/oauth/token', headers: {
      authorization: 'Basic ' + Buffer.from(`${CLIENT}:${SECRET}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
    } });
    expect(Object.fromEntries(new URLSearchParams(received[0].body))).toEqual({
      code: CODE, grant_type: 'authorization_code', client_id: CLIENT, redirect_uri: REDIRECT,
    });
    expect(outbound[0]).toMatchObject({ url: TOKEN_URL, init: { redirect: 'error' } });
    for (const secret of [ACCESS, REFRESH, SECRET, CODE]) expect(logged()).not.toContain(secret);
  });

  it('uses the existing registered callback override, not a browser-chosen callback', async () => {
    const redirect = 'https://callback.example.test/registered';
    vi.stubEnv('SMARTTHINGS_REDIRECT_URI', redirect);
    await exchangeQualifiedSmartThings(CODE, { redirect });
    expect(new URLSearchParams(received[0].body).get('redirect_uri')).toBe(redirect);
  });

  it('preserves absent optional refresh and expiry as null', async () => {
    tokenPayload = { access_token: ACCESS };
    await expect(exchange()).resolves.toEqual({ accessToken: ACCESS, refreshToken: null, expiresAt: null });
  });

  it.each([1, 31_536_000])('accepts the exact bounded integer expiry edge %s', async seconds => {
    tokenPayload = { access_token: ACCESS, expires_in: seconds };
    const before = Date.now(), result = await exchange();
    expect(Date.parse(result.expiresAt!)).toBeGreaterThanOrEqual(before + seconds * 1000);
    expect(Date.parse(result.expiresAt!)).toBeLessThanOrEqual(Date.now() + seconds * 1000);
  });

  it.each([0, -1, 0.5, 31_536_001, Number.MAX_SAFE_INTEGER, '3600', '', null, {}, []])
    ('refuses supplied expiry without coercion or repair: %j', async expiry => {
      tokenPayload = { access_token: ACCESS, expires_in: expiry };
      await expect(exchange()).rejects.toThrow('qualified_smartthings_invalid_response');
    });

  it.each([null, [], {}, { access_token: '' }, { access_token: ' leading' },
    { access_token: 'has whitespace' }, { access_token: 'x'.repeat(16_385) },
    { access_token: ACCESS, token_type: 'Basic' }, { access_token: ACCESS, token_type: 1 },
    { access_token: ACCESS, refresh_token: '' }, { access_token: ACCESS, refresh_token: {} }])
    ('validates unknown token response fields: %j', async payload => {
      tokenPayload = payload;
      await expect(exchange()).rejects.toThrow('qualified_smartthings_invalid_response');
    });

  it('creates a namespaced, deterministic LOCATION grant, ignoring person metadata and pagination links', async () => {
    locationsPayload = { items: [{ locationId: 'location-z' }, { locationId: 'location-a', name: 'Home' }],
      email: 'not-an-identity@example.test', accountId: 'not-an-account',
      _links: { next: { href: 'https://untrusted.example.test/next' } } };
    await expect(verifyQualifiedSmartThings(ACCESS)).resolves.toEqual({ provider: 'smartthings', accountKey: ACCOUNT });
    locationsPayload = { items: [{ locationId: 'location-a' }, { locationId: 'location-z' }] };
    await expect(verifyQualifiedSmartThings(ACCESS)).resolves.toEqual({ provider: 'smartthings', accountKey: ACCOUNT });
    expect(received).toHaveLength(2);
    for (const entry of received) expect(entry).toMatchObject({ method: 'GET', path: '/v1/locations', body: '',
      headers: { authorization: `Bearer ${ACCESS}`, accept: 'application/json' } });
    expect(outbound.every(entry => entry.url === LOCATIONS_URL && entry.init?.redirect === 'error')).toBe(true);
  });

  it('reconnects only the exact expected location, even when it is not the first or sorted candidate', async () => {
    const expectedAccountKey = 'smartthings-location:location-z';
    await expect(verifyQualifiedSmartThings(ACCESS, { expectedAccountKey })).resolves.toEqual({
      provider: 'smartthings', accountKey: expectedAccountKey,
    });
  });

  it.each(['smartthings-location:missing', 'smartthings-location:LOCATION-A'])
    ('refuses reconnect when the exact expected LOCATION grant is absent: %s', async expectedAccountKey => {
      await expect(verifyQualifiedSmartThings(ACCESS, { expectedAccountKey })).rejects.toThrow('qualified_smartthings_account_mismatch');
    });

  it.each(['', 'location-a', 'smartthings:location-a', 'SMARTTHINGS-location:location-a',
    'smartthings-location:', 'smartthings-location: leading', 'smartthings-location:x\n',
    'smartthings-location:' + 'x'.repeat(257)])
    ('rejects nonnamespaced or malformed reconnect input before transport: %s', async expectedAccountKey => {
      await expect(verifyQualifiedSmartThings(ACCESS, { expectedAccountKey })).rejects.toThrow('qualified_smartthings_invalid_input');
      expect(received).toHaveLength(0); expect(outbound).toHaveLength(0);
    });

  it.each([null, [], {}, { items: [] }, { items: {} }, { items: [null] }, { items: [{}] },
    { items: [{ locationId: '' }] }, { items: [{ locationId: ' leading' }] },
    { items: [{ locationId: 'has\ncontrol' }] }, { items: [{ locationId: 42 }] },
    { items: [{ locationId: 'x'.repeat(257) }] }, { items: Array.from({ length: 129 }, (_, i) => ({ locationId: `id-${i}` })) },
    { email: 'no-fallback@example.test', accountId: 'no-fallback' }])
    ('validates the whole unknown bounded locations response: %j', async payload => {
      locationsPayload = payload;
      await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_invalid_response');
    });

  it('accepts exactly 128 valid locations and a 256-character ID', async () => {
    const locationId = 'a'.repeat(256);
    locationsPayload = { items: [{ locationId }, ...Array.from({ length: 127 }, (_, i) => ({ locationId: `z-${i}` }))] };
    await expect(verifyQualifiedSmartThings(ACCESS)).resolves.toEqual({ provider: 'smartthings', accountKey: 'smartthings-location:' + locationId });
  });

  it.each(['', 'bad code', 'x'.repeat(4097)])('rejects malformed fresh code before transport: %s', async code => {
    await expect(exchangeQualifiedSmartThings(code, { redirect: REDIRECT })).rejects.toThrow('qualified_smartthings_invalid_input');
    expect(outbound).toHaveLength(0);
  });

  it.each(['', ' bad', 'bad token', 'x'.repeat(16_385)])('rejects malformed access input before transport: %s', async token => {
    await expect(verifyQualifiedSmartThings(token)).rejects.toThrow('qualified_smartthings_invalid_input');
    expect(outbound).toHaveLength(0);
  });

  it('refuses a callback mismatch without starting an exchange', async () => {
    await expect(exchangeQualifiedSmartThings(CODE, { redirect: REDIRECT + '?next=evil' })).rejects.toThrow('qualified_smartthings_invalid_input');
    expect(outbound).toHaveLength(0);
  });

  it('refuses missing registered credentials without a PAT or other legacy fallback', async () => {
    vi.stubEnv('SMARTTHINGS_CLIENT_SECRET', '');
    await expect(exchange()).rejects.toThrow('qualified_smartthings_unconfigured');
    expect(outbound).toHaveLength(0);
  });
});

describe('SmartThings bounded wire failures and request lifetime', () => {
  it.each([401, 429, 500])('sanitizes provider HTTP %s errors without retry or reading secret response details', async status => {
    serve = res => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: ACCESS, refresh: REFRESH })); };
    const error: unknown = await exchange().catch(caught => caught);
    expect(safeError(error)).toContain('qualified_smartthings_provider_unavailable');
    for (const secret of [ACCESS, REFRESH, SECRET, CODE]) expect(safeError(error) + logged()).not.toContain(secret);
    expect(received).toHaveLength(1);
  });

  it('does not follow even a same-server redirect', async () => {
    serve = res => { res.writeHead(302, { Location: base + '/would-leak-token', 'Content-Type': 'application/json' }); res.end('{}'); };
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_provider_unavailable');
    expect(received.map(entry => entry.path)).toEqual(['/v1/locations']);
  });

  it('rejects a non-JSON content type', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(JSON.stringify(locationsPayload)); };
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_invalid_response');
  });

  it('refuses an oversized declared body before waiting for its content', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 65_537 }); res.flushHeaders(); };
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_invalid_response');
  });

  it('refuses an oversized chunked body without trusting missing Content-Length', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(' '.repeat(65_536)); res.end('{}'); };
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_invalid_response');
  });

  it('accepts an exactly 64 KiB valid JSON body', async () => {
    const json = JSON.stringify({ items: [{ locationId: 'location-a' }] });
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(json.padEnd(65_536, ' ')); };
    await expect(verifyQualifiedSmartThings(ACCESS)).resolves.toEqual({ provider: 'smartthings', accountKey: ACCOUNT });
  });

  it('sanitizes invalid JSON and does not expose parser excerpts', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"access_token":' + ACCESS); };
    const error: unknown = await verifyQualifiedSmartThings(ACCESS).catch(caught => caught);
    expect(safeError(error)).toContain('qualified_smartthings_');
    expect(safeError(error) + logged()).not.toContain(ACCESS);
  });

  it('refuses invalid UTF-8 instead of accepting replacement characters in an ID', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(Buffer.concat([Buffer.from('{"items":[{"locationId":"'), Buffer.from([0xff]), Buffer.from('"}]}')])); };
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_');
  });

  it('sanitizes an arbitrary transport rejection, including its nested cause', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error(ACCESS, { cause: new Error(SECRET) }))));
    const error: unknown = await exchange().catch(caught => caught);
    expect(safeError(error)).toContain('qualified_smartthings_provider_unavailable');
    for (const secret of [ACCESS, SECRET]) expect(safeError(error) + logged()).not.toContain(secret);
  });

  it('honors an already aborted caller before transport without copying its reason', async () => {
    const controller = new AbortController(); controller.abort(new Error(ACCESS));
    const error: unknown = await exchange(controller.signal).catch(caught => caught);
    expect(safeError(error)).toContain('qualified_smartthings_aborted');
    expect(safeError(error) + logged()).not.toContain(ACCESS);
    expect(outbound).toHaveLength(0);
  });

  it('honors caller cancellation while HTTP headers are pending', async () => {
    serve = () => {};
    const controller = new AbortController();
    const refusal = expect(verifyQualifiedSmartThings(ACCESS, { signal: controller.signal })).rejects.toThrow('qualified_smartthings_aborted');
    await served; controller.abort(SECRET); await refusal;
    expect(outbound[0].init?.signal?.aborted).toBe(true);
    expect(logged()).not.toContain(SECRET);
  });

  it('honors caller cancellation after headers while the body is held', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); };
    const controller = new AbortController();
    const refusal = expect(exchange(controller.signal)).rejects.toThrow('qualified_smartthings_aborted');
    await served; controller.abort(ACCESS); await refusal;
    expect(outbound[0].init?.signal?.aborted).toBe(true);
    expect(logged()).not.toContain(ACCESS);
  });

  it('keeps one real ten-second deadline active through a stalled response body', async () => {
    serve = res => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); };
    const before = Date.now();
    await expect(verifyQualifiedSmartThings(ACCESS)).rejects.toThrow('qualified_smartthings_timeout');
    expect(Date.now() - before).toBeGreaterThanOrEqual(9_500);
    expect(outbound[0].init?.signal?.aborted).toBe(true);
  }, 15_000);

  it('snapshots the reconnect key before awaiting provider I/O', async () => {
    let held: ServerResponse | undefined;
    serve = res => { held = res; res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); };
    const options = { expectedAccountKey: 'smartthings-location:missing' };
    const refusal = expect(verifyQualifiedSmartThings(ACCESS, options)).rejects.toThrow('qualified_smartthings_account_mismatch');
    await served; options.expectedAccountKey = ACCOUNT;
    held!.end(JSON.stringify(locationsPayload)); await refusal;
  });
});
