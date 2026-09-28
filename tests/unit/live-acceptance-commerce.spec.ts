/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the commerce-surfaces live-acceptance case. Unit half: the verdict roll-up, cart restore (the added line removed through the page's own route and recorded as kept-removed, the Eats restaurant label cleared back to none, a failed removal = red cleanup) and the refusals that open no page (not installed, a cart in use, no browser port). Browser half, in real headless Chromium through the host runner's own browser port against a loopback stand-in surface that speaks the bridge envelope: a surface whose confirm card only proposes = pass; a regressed surface that POSTs the hand-off and calls window.open on the proposal = fail, with the POST aborted in the browser so the server never receives it; every same-origin request carries the token and an off-origin request never leaves the browser. The stand-in stands in for the installed Rides page only; the store's own surface.core specs prove the real pages, and `node scripts/operations/live-acceptance.js commerce` on the box is the live companion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fakeApi } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const commerce = requireCjs('../../scripts/lib/live-acceptance-commerce.js');
const common = requireCjs('../../scripts/lib/live-acceptance-common.js');
const runner = requireCjs('../../scripts/operations/live-acceptance.js');

const TOKEN = 'oshal_pat_fixture_commerce_0000';
const eats = commerce.SURFACES.find((s: { app: string }) => s.app === 'eats');

describe('commerce surfaces - verdicts and cart restore', () => {
  it('rolls surface outcomes into one verdict', () => {
    expect(commerce.decide([{ state: 'pass' }, { state: 'pass' }]).state).toBe('pass');
    expect(commerce.decide([{ state: 'pass' }, { state: 'skipped' }]).state).toBe('degraded');
    expect(commerce.decide([{ state: 'skipped' }, { state: 'skipped' }]).state).toBe('unavailable');
    expect(commerce.decide([{ state: 'pass' }, { state: 'fail' }]).state).toBe('fail');
  });

  it('removes the added Eats line through the page route and clears the restaurant label it set', async () => {
    let lines = [{ row_id: 'row-1' }];
    let store: string | null = 'mcdonalds';
    const api = fakeApi({
      'GET /api/eats/cart': () => ({ status: 200, json: { items: lines, storeId: store } }),
      'DELETE /api/eats/cart/items/:id': ({ params }) => { lines = lines.filter((l) => l.row_id !== params.id); return { status: 200 }; },
      'POST /api/eats/cart/clear': () => { store = null; return { status: 200 }; },
    });
    const ledger = new common.CleanupLedger();
    await commerce.restoreCart({ api: api.api }, eats, { ids: [], store: null }, ledger);
    expect(ledger.complete()).toBe(true);
    expect(ledger.receipt().kept).toEqual(["eats-cart-line row-1 (removed through the page's own cart route; the product keeps it as a removed line)"]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/eats/cart/clear');
  });

  it('turns a failed line removal into a red cleanup', async () => {
    const api = fakeApi({
      'GET /api/eats/cart': () => ({ status: 200, json: { items: [{ row_id: 'row-1' }], storeId: null } }),
      'DELETE /api/eats/cart/items/:id': () => ({ status: 500 }),
    });
    const ledger = new common.CleanupLedger();
    await commerce.restoreCart({ api: api.api }, eats, { ids: [], store: null }, ledger);
    expect(ledger.complete()).toBe(false);
    expect(ledger.receipt().outstanding).toEqual(['eats-cart-line row-1']);
  });

  it('opens no page for a surface that is not installed or whose cart is in use', async () => {
    const api = fakeApi({ 'GET /api/eats/cart': () => ({ status: 200, json: { items: [{ row_id: 'mine' }], storeId: 'x' } }) });
    const session = { origin: 'http://127.0.0.1', newPage: () => { throw new Error('no page may open'); } };
    const ledger = new common.CleanupLedger();
    const absent = await commerce.checkSurface({ api: api.api }, session, eats, new Map(), ledger);
    expect(absent).toMatchObject({ state: 'skipped', detail: 'not installed' });
    const busy = await commerce.checkSurface({ api: api.api }, session, eats, new Map([['eats', '1.3.1']]), ledger);
    expect(busy.state).toBe('skipped');
    expect(busy.detail).toContain('the cart holds 1 line(s); the case does not add to a cart in use');
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('writes nothing without a browser port', async () => {
    const api = fakeApi({});
    const result = await commerce.run({ api: api.api });
    expect(result.state).toBe('unavailable');
    expect(api.calls).toEqual([]);
  });
});

/** A loopback stand-in for the Rides page: prices a trip on `estimate`, proposes on `request_ride`. */
function surfaceHtml(leaky: boolean, offOrigin: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="options"></div><div id="bridgeOptions"></div>
<script>
window.__bridge = {}; window.__bridgeProducer = {};
fetch('${offOrigin}/beacon').catch(function () {});
window.addEventListener('message', function (e) {
  var d = e.data || {};
  if (e.origin !== location.origin || d.channel !== 'oshal-surface-bridge' || d.app !== 'rides') return;
  if (d.op === 'custom' && d.name === 'estimate') document.getElementById('options').innerHTML = '<button class="ride-card">UberX $18-23</button>';
  if (d.op === 'custom' && d.name === 'request_ride') {
    ${leaky ? "fetch('/api/rides/request', { method: 'POST', body: '{}' }).catch(function () {}); window.open('https://m.uber.com/ul/');" : ''}
    document.getElementById('bridgeOptions').innerHTML = '<div class="bridge-propose">Open Uber for UberX to Airport?<button class="bridge-confirm">Confirm</button><button class="bridge-cancel">Cancel</button></div>';
    document.querySelector('.bridge-cancel').addEventListener('click', function () { document.getElementById('bridgeOptions').innerHTML = ''; });
  }
});
</script></body></html>`;
}

describe('commerce surfaces - real Chromium through the runner browser port', () => {
  const seen: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  let server: http.Server;
  let origin = '';
  let leaky = false;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      seen.push({ method: req.method || '', path: url.pathname, authorization: req.headers.authorization });
      if (url.pathname === '/api/rides/app') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(surfaceHtml(leaky, origin.replace('127.0.0.1', 'localhost'))); return; }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const installed = fakeApi({ 'GET /api/swarm/apps': () => ({ status: 200, json: { apps: [{ name: 'rides', version: '1.5.1' }] } }) });

  it('passes a surface whose confirm card only proposes, with the token on same-origin requests only', async () => {
    leaky = false;
    seen.length = 0;
    const result = await commerce.run({ api: installed.api, browser: runner.browserPort(origin, TOKEN) }, { only: 'rides' });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('the confirm card read "Open Uber for UberX to Airport?');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.some((r) => r.path === '/beacon')).toBe(false);
  }, 90_000);

  it('fails a surface that hands off on the proposal, and the hand-off never reaches the server', async () => {
    leaky = true;
    seen.length = 0;
    const result = await commerce.run({ api: installed.api, browser: runner.browserPort(origin, TOKEN) }, { only: 'rides' });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('1 hand-off POST(s) were attempted (aborted in the browser)');
    expect(result.detail).toContain('window.open was called 1 time(s)');
    expect(seen.some((r) => r.path === '/api/rides/request')).toBe(false);
  }, 90_000);
});
