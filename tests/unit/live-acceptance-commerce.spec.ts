/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the commerce-surfaces live-acceptance case. Unit half: the verdict roll-up, cart restore (the added line removed through the page's own route and recorded as kept-removed, the Eats restaurant label cleared back to none, a failed removal = red cleanup) and the refusals that open no page (not installed, a cart in use, no browser port). Browser half, in real headless Chromium through the host runner's own browser port against a loopback stand-in surface that speaks the bridge envelope: a surface whose confirm card only proposes = pass; a regressed surface that POSTs the hand-off and calls window.open on the proposal = fail, with the POST aborted in the browser so the server never receives it; every same-origin request carries the token and an off-origin request never leaves the browser. The stand-in stands in for the installed Rides page only; the store's own surface.core specs prove the real pages, and `node scripts/operations/live-acceptance.js commerce` on the box is the live companion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A Shopping cart in use. Unit half: cleanup removes only the line the run added (by the id its add answered, or by the run's tag when that answer was lost), leaves a line that appeared during the run and is not the case's, never sends a removal for a line the cart already held (even one that names the run's tag or id), turns a held line that is missing or differs into a red cleanup naming the line and its fields and none of its content, and is red when its own line survives the removal; with the cart in use the Shopping page is opened, and a walk that fails there removes nothing. Eats still declines a cart in use. Browser half, in real headless Chromium through the runner's own HTTP and browser ports against a loopback stand-in Shopping page over an in-memory cart: with five lines held, the walk reaches the confirm card over six lines and cancels it, the add the server received carries the run's tag, exactly one removal is sent and it names the case's line, the five lines read back identical and no checkout POST reaches the server; with nothing held the same walk passes. The stand-in stands in for the installed Shopping page and its cart routes (read, add, remove by line id); the store's surface.core spec proves the real page, and the live run is the companion.
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
const RUN_TAG = 'testlab-live-commerce-0a1b2c3d';
const REMOVED_NOTE = "removed through the page's own cart route; the product keeps it as a removed line";
const eats = commerce.SURFACES.find((s: { app: string }) => s.app === 'eats');
const shopping = commerce.SURFACES.find((s: { app: string }) => s.app === 'purchasing');

/** One cart line, shaped like a row of GET /api/purchasing/cart. */
type Line = Record<string, unknown> & { item_id: string; status: string; reason: string | null };

/** Five pending lines a caller already has in the cart. */
function heldLines(): Line[] {
  return [1, 2, 3, 4, 5].map((n) => ({
    item_id: `held-${n}`, list_id: 'list-1', user_sub: 'fixture-shopper', retailer: 'walmart',
    product_id: n === 5 ? '44390948' : '10450115', title: n === 5 ? 'Fresh Bananas, each' : 'Great Value 2% Reduced Fat Milk, 1 Gallon',
    brand: null, image_url: null, product_url: null, quantity: 1, unit_price: n === 5 ? '0.24' : '2.78',
    reason: n === 1 ? 'Best match for milk.' : 'Added from marketplace surface.', status: 'pending', created_at: `2026-06-${18 + n}T14:07:31.000Z`,
  }));
}

/** A line written during a run, as the add route stores it. */
function addedLine(id: string, reason: string | null): Line {
  return { ...heldLines()[0], item_id: id, reason, created_at: '2026-09-29T10:00:00.000Z' };
}

/** An in-memory Shopping cart behind the cart read and the removal by line id. */
function shoppingCart(lines: Line[], removal: 'works' | 'ignored' = 'works') {
  const state = { lines };
  const port = fakeApi({
    'GET /api/purchasing/cart': () => ({ status: 200, json: { listId: 'list-1', items: state.lines.filter((l) => l.status === 'pending') } }),
    'DELETE /api/purchasing/lists/:listId/items/:itemId': ({ params }) => {
      if (removal === 'works') state.lines = state.lines.map((l) => (l.item_id === params.itemId ? { ...l, status: 'removed' } : l));
      return { status: 200, json: { ok: true } };
    },
  });
  return { state, api: port.api, calls: port.calls, removals: () => port.calls.filter((c) => c.method === 'DELETE').map((c) => c.path) };
}

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
    expect(ledger.receipt().kept).toEqual([`eats-cart-line row-1 (${REMOVED_NOTE})`]);
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

  it('opens no page for a surface that is not installed, or for Eats with its cart in use', async () => {
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

describe('commerce surfaces - a Shopping cart in use', () => {
  it('removes only the line the run added and reads the held lines back as they were', async () => {
    const cart = shoppingCart(heldLines());
    const before = await commerce.readCart({ api: cart.api }, shopping);
    cart.state.lines.push(addedLine('own-1', RUN_TAG));
    const ledger = new common.CleanupLedger();
    const summary = await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: ['own-1'] });
    expect(ledger.receipt().errors).toEqual([]);
    expect(ledger.complete()).toBe(true);
    expect(cart.removals()).toEqual(['/api/purchasing/lists/list-1/items/own-1']);
    expect(cart.state.lines.filter((l) => l.item_id !== 'own-1')).toEqual(heldLines());
    expect(summary).toEqual({ held: 5, removed: ['own-1'], left: [], unchanged: true });
    expect(ledger.receipt().kept).toEqual([`purchasing-cart-line own-1 (${REMOVED_NOTE})`]);
  });

  it('finds its line by the run tag when the answer to the add was lost', async () => {
    const cart = shoppingCart(heldLines());
    const before = await commerce.readCart({ api: cart.api }, shopping);
    cart.state.lines.push(addedLine('own-1', RUN_TAG));
    const ledger = new common.CleanupLedger();
    await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: [] });
    expect(ledger.complete()).toBe(true);
    expect(cart.removals()).toEqual(['/api/purchasing/lists/list-1/items/own-1']);
    expect(cart.state.lines.filter((l) => l.item_id !== 'own-1')).toEqual(heldLines());
  });

  it('leaves a line that appeared during the run and is not its own', async () => {
    const cart = shoppingCart(heldLines());
    const before = await commerce.readCart({ api: cart.api }, shopping);
    cart.state.lines.push(addedLine('other-1', 'Added from marketplace surface.'), addedLine('own-1', RUN_TAG));
    const ledger = new common.CleanupLedger();
    const summary = await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: ['own-1'] });
    expect(ledger.complete()).toBe(true);
    expect(cart.removals()).toEqual(['/api/purchasing/lists/list-1/items/own-1']);
    expect(cart.state.lines.find((l) => l.item_id === 'other-1')).toEqual(addedLine('other-1', 'Added from marketplace surface.'));
    expect(summary).toMatchObject({ removed: ['own-1'], left: ['other-1'], unchanged: true });
    expect(ledger.receipt().kept).toContain('purchasing-cart-line other-1 (appeared in the cart during the run and is not a line the case added; left as it is)');
  });

  it('never sends a removal for a line the cart already held, even one that names the run', async () => {
    const lines = heldLines();
    lines[1].reason = RUN_TAG;
    const cart = shoppingCart(lines);
    const before = await commerce.readCart({ api: cart.api }, shopping);
    const ledger = new common.CleanupLedger();
    const summary = await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: ['held-1'] });
    expect(cart.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(cart.state.lines.every((l) => l.status === 'pending')).toBe(true);
    expect(summary).toEqual({ held: 5, removed: [], left: [], unchanged: true });
    expect(ledger.complete()).toBe(true);
  });

  it('turns a held line that changed or left the cart into a red cleanup, naming fields and no content', async () => {
    const cart = shoppingCart(heldLines());
    const before = await commerce.readCart({ api: cart.api }, shopping);
    cart.state.lines = cart.state.lines.map((l) => {
      if (l.item_id === 'held-3') return { ...l, quantity: 2 };
      return l.item_id === 'held-4' ? { ...l, status: 'removed' } : l;
    });
    const ledger = new common.CleanupLedger();
    const summary = await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: [] });
    expect(ledger.complete()).toBe(false);
    const errors = ledger.receipt().errors.join(' ');
    expect(errors).toContain('line held-3 differs in quantity');
    expect(errors).toContain('line held-4 is no longer in the cart');
    expect(errors).not.toContain('Milk');
    expect(errors).not.toContain('2.78');
    expect(summary.unchanged).toBe(false);
    expect(cart.removals()).toEqual([]);
  });

  it('is red when the line it removed is still in the cart', async () => {
    const cart = shoppingCart(heldLines(), 'ignored');
    const before = await commerce.readCart({ api: cart.api }, shopping);
    cart.state.lines.push(addedLine('own-1', RUN_TAG));
    const ledger = new common.CleanupLedger();
    await commerce.restoreCart({ api: cart.api }, shopping, before, ledger, { tag: RUN_TAG, ids: ['own-1'] });
    expect(ledger.complete()).toBe(false);
    expect(ledger.receipt().errors).toEqual(['the purchasing cart still holds 1 line(s) the run added (own-1)']);
  });

  it('opens the Shopping page with the cart in use, and a walk that fails there removes nothing', async () => {
    const cart = shoppingCart(heldLines());
    let opened = 0;
    const page = { route: async () => undefined, goto: async () => null, close: async () => undefined };
    const session = { origin: 'http://127.0.0.1', newPage: async () => { opened += 1; return page; } };
    const ledger = new common.CleanupLedger();
    const outcome = await commerce.checkSurface({ api: cart.api }, session, shopping, new Map([['purchasing', '1.3.2']]), ledger);
    expect(opened).toBe(1);
    expect(outcome.state).toBe('fail');
    expect(outcome.detail).toContain('/api/purchasing/chat answered HTTP none');
    expect(outcome.cart).toMatchObject({ held: 5, removed: [], left: [], unchanged: true });
    expect(cart.removals()).toEqual([]);
    expect(cart.state.lines).toEqual(heldLines());
    expect(ledger.complete()).toBe(true);
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

/**
 * A loopback stand-in for the Shopping page: it reads the cart, searches, adds through the list's
 * item route with the page's own reason, shows each cart line with its id, and proposes on `checkout`.
 * Like the installed page it re-reads its cart a moment after an add, so a checkout relayed before
 * that re-read proposes the cart as it was.
 */
function shoppingHtml(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<input id="query"><button id="searchBtn">Search</button><div id="grid"></div><div id="cartItems"></div><div id="bridgeOptions"></div>
<script>
var cart = { listId: '', items: [] };
function loadCart() {
  return fetch('/api/purchasing/cart').then(function (r) { return r.json(); }).then(function (data) {
    cart = data;
    document.getElementById('cartItems').innerHTML = data.items.map(function (i) { return '<button data-remove="' + i.item_id + '">Remove</button>'; }).join('');
  });
}
function addProduct() {
  return fetch('/api/purchasing/lists/' + cart.listId + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: '10450115', title: 'Milk', quantity: 1, itemKey: 'Milk', reason: 'Added from marketplace surface.' }) })
    .then(function () { return new Promise(function (resolve) { setTimeout(resolve, 600); }); }).then(loadCart);
}
document.getElementById('searchBtn').addEventListener('click', function () {
  document.getElementById('grid').innerHTML = '<button data-add="10450115">Add to cart</button>';
  document.querySelector('[data-add]').addEventListener('click', addProduct);
});
window.addEventListener('message', function (e) {
  var d = e.data || {};
  if (e.origin !== location.origin || d.channel !== 'oshal-surface-bridge' || d.app !== 'purchasing') return;
  if (d.op !== 'custom' || d.name !== 'checkout' || !cart.items.length) return;
  document.getElementById('bridgeOptions').innerHTML = '<div class="bridge-propose">Open Walmart checkout for ' + cart.items.length + ' items?<button class="bridge-confirm">Open Walmart checkout</button><button class="bridge-cancel">Not yet</button></div>';
  document.querySelector('.bridge-cancel').addEventListener('click', function () { document.getElementById('bridgeOptions').innerHTML = ''; });
});
loadCart().then(function () { window.__bridge = {}; window.__bridgeProducer = {}; });
</script></body></html>`;
}

/** One request the stand-in Shopping server received. */
interface ShoppingRequest { method: string; path: string; authorization: string | undefined; body: Record<string, unknown> }

describe('commerce surfaces - Shopping in real Chromium through the runner HTTP and browser ports', () => {
  const seen: ShoppingRequest[] = [];
  let server: http.Server;
  let origin = '';
  let lines: Line[] = [];
  /** Whether the stand-in add route stores the reason it was sent. */
  let storesReason = true;

  /** Answer one request of the stand-in: the page, the installed apps, and the three cart routes. */
  function answer(request: ShoppingRequest): { status: number; type: string; body: string } {
    const json = (value: unknown) => ({ status: 200, type: 'application/json', body: JSON.stringify(value) });
    const line = request.path.match(/^\/api\/purchasing\/lists\/list-1\/items(?:\/([^/]+))?$/);
    if (request.method === 'GET' && request.path === '/api/purchasing/chat') return { status: 200, type: 'text/html', body: shoppingHtml() };
    if (request.method === 'GET' && request.path === '/api/swarm/apps') return json({ apps: [{ name: 'purchasing', version: '1.3.2' }] });
    if (request.method === 'GET' && request.path === '/api/purchasing/cart') return json({ listId: 'list-1', items: lines.filter((l) => l.status === 'pending') });
    if (request.method === 'POST' && line && !line[1]) {
      const written = addedLine(`line-${lines.length + 1}`, storesReason && typeof request.body.reason === 'string' ? request.body.reason : null);
      lines.push(written);
      return json({ item: written });
    }
    if (request.method === 'DELETE' && line && line[1]) {
      lines = lines.map((l) => (l.item_id === decodeURIComponent(String(line[1])) ? { ...l, status: 'removed' } : l));
      return json({ ok: true });
    }
    return { status: 404, type: 'application/json', body: '{}' };
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const request = { method: req.method || '', path: new URL(req.url || '/', 'http://x').pathname, authorization: req.headers.authorization,
          body: text.startsWith('{') ? JSON.parse(text) as Record<string, unknown> : {} };
        seen.push(request);
        const reply = answer(request);
        res.writeHead(reply.status, { 'content-type': reply.type });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const ports = () => ({ api: runner.httpPorts(origin, TOKEN).api, browser: runner.browserPort(origin, TOKEN) });
  const adds = () => seen.filter((r) => r.method === 'POST' && /\/lists\/[^/]+\/items$/.test(r.path));
  const removals = () => seen.filter((r) => r.method === 'DELETE').map((r) => r.path);
  const start = (held: Line[], reasonStored = true) => { lines = held; storesReason = reasonStored; seen.length = 0; };

  it('walks Shopping to the confirm card over a cart of five lines and removes only its own line', async () => {
    start(heldLines());
    const result = await commerce.run(ports(), { only: 'purchasing' });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('the confirm card read "Open Walmart checkout for 6 items?');
    expect(result.detail).toContain('the 5 line(s) the cart already held read back unchanged');
    expect(adds()).toHaveLength(1);
    expect(adds()[0].body).toMatchObject({ productId: '10450115', title: 'Milk', quantity: 1, itemKey: 'Milk' });
    expect(adds()[0].body.reason).toMatch(/^testlab-live-commerce-[0-9a-f]{8}$/);
    const own = lines.filter((l) => !l.item_id.startsWith('held-'));
    expect(own.map((l) => [l.item_id, l.status, l.reason])).toEqual([['line-6', 'removed', adds()[0].body.reason]]);
    expect(removals()).toEqual(['/api/purchasing/lists/list-1/items/line-6']);
    expect(lines.filter((l) => l.item_id.startsWith('held-'))).toEqual(heldLines());
    expect(seen.some((r) => r.path === '/api/purchasing/checkout')).toBe(false);
    expect(seen.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.cleanup).toMatchObject({ kept: [`purchasing-cart-line line-6 (${REMOVED_NOTE})`], outstanding: [], errors: [] });
    expect(result.evidence.surfaces[0].cart).toEqual({ held: 5, removed: ['line-6'], left: [], unchanged: true, tag: adds()[0].body.reason });
  }, 90_000);

  it('walks Shopping the same way when the cart holds nothing', async () => {
    start([]);
    const result = await commerce.run(ports(), { only: 'purchasing' });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('the confirm card read "Open Walmart checkout for 1 items?');
    expect(result.detail).not.toContain('already held');
    expect(removals()).toEqual(['/api/purchasing/lists/list-1/items/line-1']);
    expect(lines.map((l) => l.status)).toEqual(['removed']);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
  }, 90_000);

  it('fails when the line the add wrote lost the tag, and still removes that line and no other', async () => {
    start(heldLines(), false);
    const result = await commerce.run(ports(), { only: 'purchasing' });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain("the line the add wrote (line-6) does not carry the run's tag");
    expect(result.detail).not.toContain('the confirm card read');
    expect(removals()).toEqual(['/api/purchasing/lists/list-1/items/line-6']);
    expect(lines.filter((l) => l.item_id.startsWith('held-'))).toEqual(heldLines());
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
  }, 90_000);
});
