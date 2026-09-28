/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Consumer commerce native surfaces": a headless Chromium pass at 390 x 844 over the INSTALLED Rides, Eats and Shopping surfaces, as the caller, up to the confirm gate and never through it. Per surface: the page fits the width; the page's own flow prices a trip (Rides) or puts one item in the cart (Eats, Shopping); the assistant's relayed outward op (request_ride / place_order / checkout, posted the way the cockpit relay delivers it) renders the shared confirm card; the case clicks Cancel. Every hand-off POST is intercepted and ABORTED in the browser, and window.open is stubbed, so a regressed gate is counted and still reaches nothing. Only an empty cart is used; the item the case added is removed through the page's own cart route (a soft delete the product keeps as history) and the cart is proven back to empty.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'commerce-surfaces-live';
const KEY = 'commerce';
const TITLE = 'Rides, Eats and Shopping at 390 px through the confirm gate (never confirmed)';
const NEEDS = Object.freeze(['api', 'browser']);
const UI_TIMEOUT_MS = 30_000;
/** How many times the outward op is relayed while the page catches up with its own cart. */
const CONFIRM_ATTEMPTS = 5;
const BRIDGE_CHANNEL = 'oshal-surface-bridge';

/**
 * The installed surfaces. `handoff` is the outward POST the confirm would fire; `cart` names the
 * page's own cart read and item removal; `prepare` is the page's own path to something to confirm.
 */
const SURFACES = Object.freeze([
  { app: 'rides', path: '/api/rides/app', handoff: '/api/rides/request', confirmOp: 'request_ride', cart: null },
  { app: 'eats', path: '/api/eats/app', handoff: '/api/eats/order', confirmOp: 'place_order',
    cart: { read: '/api/eats/cart', idField: 'row_id', storeField: 'storeId', clear: '/api/eats/cart/clear',
      remove: (_cart, id) => `/api/eats/cart/items/${encodeURIComponent(id)}` } },
  { app: 'purchasing', path: '/api/purchasing/chat', handoff: '/api/purchasing/checkout', confirmOp: 'checkout',
    cart: { read: '/api/purchasing/cart', idField: 'item_id', remove: (cart, id) => `/api/purchasing/lists/${encodeURIComponent(cart.listId)}/items/${encodeURIComponent(id)}` } },
]);

/**
 * @description Read a surface's cart through its own route.
 * @param {object} ports - api.
 * @param {object} surface - The surface.
 * @returns {Promise<{status: number, ids: string[], cart: object}>} The pending line ids.
 */
async function readCart(ports, surface) {
  const res = await ports.api('GET', surface.cart.read);
  const items = Array.isArray(res.json && res.json.items) ? res.json.items : [];
  const store = surface.cart.storeField && res.json ? res.json[surface.cart.storeField] ?? null : null;
  return { status: res.status, ids: items.map((i) => String(i[surface.cart.idField])), store, cart: res.json || {} };
}

/**
 * @description Remove the lines this run added and prove the cart back to its prior (empty) state,
 * including the Eats cart's restaurant label when adding the item set it.
 * @param {object} ports - api.
 * @param {object} surface - The surface.
 * @param {{ids: string[], store: unknown}} before - The cart before the run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function restoreCart(ports, surface, before, ledger) {
  await ledger.attempt(`${surface.app} cart restore`, async () => {
    const now = await readCart(ports, surface);
    for (const id of now.ids.filter((line) => !before.ids.includes(line))) {
      ledger.created(`${surface.app}-cart-line`, id);
      const res = await ports.api('DELETE', surface.cart.remove(now.cart, id));
      if (res.status !== 200) return `removing ${surface.app} cart line ${id} answered HTTP ${res.status}`;
      ledger.kept(`${surface.app}-cart-line`, id, "removed through the page's own cart route; the product keeps it as a removed line");
    }
    let after = await readCart(ports, surface);
    if (after.ids.length !== before.ids.length || after.ids.some((id) => !before.ids.includes(id))) {
      return `the ${surface.app} cart holds ${after.ids.length} line(s) after the run; it held ${before.ids.length}`;
    }
    if (surface.cart.clear && before.store === null && after.store !== null) {
      await ports.api('POST', surface.cart.clear, {});
      after = await readCart(ports, surface);
    }
    if (after.store !== before.store) return `the ${surface.app} cart is labelled ${after.store} after the run; it was ${before.store}`;
    return null;
  });
}

/**
 * @description Deliver one bridge op to the surface the way the cockpit relay does (same-origin postMessage).
 * @param {object} page - The Playwright page.
 * @param {string} app - The surface's app name.
 * @param {object} op - The op.
 * @returns {Promise<void>} Resolves once posted.
 */
function relay(page, app, op) {
  return page.evaluate(({ channel, appName, message }) => {
    window.postMessage({ channel, v: 1, app: appName, ...message }, window.location.origin);
  }, { channel: BRIDGE_CHANNEL, appName: app, message: op });
}

/**
 * @description The page's own path to something to confirm.
 * @param {object} page - The Playwright page.
 * @param {object} surface - The surface.
 * @param {unknown} [store] - The restaurant an empty Eats cart is already labelled with, preferred so the label stays.
 * @returns {Promise<string>} What was prepared (for the evidence).
 */
async function prepare(page, surface, store = null) {
  if (surface.app === 'rides') {
    await relay(page, 'rides', { op: 'custom', name: 'estimate', data: { dropoff: 'Airport' } });
    await page.waitForFunction(() => document.querySelectorAll('#options .ride-card').length > 0, null, { timeout: UI_TIMEOUT_MS });
    await page.locator('#options .ride-card').first().click();
    return 'priced a trip to Airport and picked the first ride';
  }
  if (surface.app === 'eats') {
    await page.waitForSelector('#grid [data-store]', { timeout: UI_TIMEOUT_MS });
    const same = store ? page.locator(`#grid [data-store="${String(store).replace(/[^A-Za-z0-9-]/g, '')}"]`) : null;
    await (same && await same.count() ? same.first() : page.locator('#grid [data-store]').first()).click();
  } else {
    await page.fill('#query', 'milk');
    await page.click('#searchBtn');
  }
  const add = page.locator('[data-add]').first();
  await add.waitFor({ timeout: UI_TIMEOUT_MS });
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/(cart\/items|lists\/[^/]+\/items)$/.test(new URL(r.url()).pathname), { timeout: UI_TIMEOUT_MS });
  await add.click();
  const response = await posted;
  if (response.status() !== 200) throw new Error(`adding an item answered HTTP ${response.status()}`);
  return 'put one item in the cart through the page';
}

/**
 * @description Relay the outward op until the page shows its confirm card. A page refreshes its cart
 * after an add on its own schedule, and until then answers the op with a toast, so the op is relayed
 * again (it only ever proposes) up to CONFIRM_ATTEMPTS times.
 * @param {object} page - The Playwright page.
 * @param {object} surface - The surface.
 * @returns {Promise<object>} The confirm card locator.
 */
async function raiseConfirmCard(page, surface) {
  const card = page.locator('#bridgeOptions .bridge-propose');
  for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
    await relay(page, surface.app, { op: 'custom', name: surface.confirmOp, data: {} });
    try {
      await card.waitFor({ timeout: UI_TIMEOUT_MS / CONFIRM_ATTEMPTS });
      return card;
    } catch (error) {
      if (attempt === CONFIRM_ATTEMPTS) {
        throw new Error(`no confirm card after ${CONFIRM_ATTEMPTS} relayed ${surface.confirmOp} ops: ${common.errorText(error).split(/\r?\n/)[0]}`);
      }
    }
  }
  return card;
}

/**
 * @description Whether the document is wider than the viewport.
 * @param {object} page - The Playwright page.
 * @returns {Promise<{scroll: number, client: number}>} The widths.
 */
function widths(page) {
  return page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
}

/**
 * @description Open the surface, prepare, raise the confirm card, cancel it, and count leaks.
 * @param {object} page - The Playwright page (390 x 844).
 * @param {string} origin - The server origin.
 * @param {object} surface - The surface.
 * @param {string[]} handoffs - Filled by the page's hand-off interceptor.
 * @param {unknown} store - The Eats cart's existing restaurant label, if any.
 * @returns {Promise<{ok: boolean, detail: string}>} The surface's judgement.
 */
async function walkSurface(page, origin, surface, handoffs, store) {
  const loaded = await page.goto(`${origin}${surface.path}`, { waitUntil: 'domcontentloaded' });
  if (!loaded || loaded.status() !== 200) return { ok: false, detail: `${surface.path} answered HTTP ${loaded ? loaded.status() : 'none'}` };
  await page.waitForFunction(() => Boolean(window.__bridge && window.__bridgeProducer), null, { timeout: UI_TIMEOUT_MS });
  const fit = await widths(page);
  const prepared = await prepare(page, surface, store);
  const card = await raiseConfirmCard(page, surface);
  const cardText = (await card.innerText()).replace(/\s+/g, ' ').trim().slice(0, 160);
  const openedBefore = await page.evaluate(() => (window.__opened || []).length);
  const handoffsBefore = handoffs.length;
  await page.locator('#bridgeOptions .bridge-cancel').click();
  await page.waitForFunction(() => !document.querySelector('#bridgeOptions .bridge-propose'), null, { timeout: UI_TIMEOUT_MS });
  const opened = await page.evaluate(() => (window.__opened || []).length);
  const fitAfter = await widths(page);
  const problems = [];
  if (fit.scroll > fit.client || fitAfter.scroll > fitAfter.client) problems.push(`horizontal overflow (${Math.max(fit.scroll, fitAfter.scroll)} > ${fit.client})`);
  if (handoffsBefore || handoffs.length) problems.push(`${handoffs.length} hand-off POST(s) were attempted (aborted in the browser)`);
  if (openedBefore || opened) problems.push(`window.open was called ${opened} time(s)`);
  const said = `${prepared}; the confirm card read "${cardText}"; Cancel handed off nothing`;
  return problems.length ? { ok: false, detail: `${said} BUT ${problems.join('; ')}` } : { ok: true, detail: `fits 390 px; ${said}` };
}

/**
 * @description One surface end to end, with its cart snapshot and restore.
 * @param {object} ports - api.
 * @param {object} session - The browser session (newPage, origin).
 * @param {object} surface - The surface.
 * @param {Map<string, string>} installed - Active app name to version.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{app: string, state: 'pass'|'fail'|'skipped', detail: string}>} The surface's outcome.
 */
async function checkSurface(ports, session, surface, installed, ledger) {
  if (!installed.has(surface.app)) return { app: surface.app, state: 'skipped', detail: 'not installed' };
  const label = `${surface.app} ${installed.get(surface.app)}`;
  let before = { ids: [], store: null };
  if (surface.cart) {
    const cart = await readCart(ports, surface);
    if (cart.status !== 200) return { app: surface.app, state: 'fail', detail: `${label}: the cart read answered HTTP ${cart.status}` };
    if (cart.ids.length) return { app: surface.app, state: 'skipped', detail: `${label}: the cart holds ${cart.ids.length} line(s); the case does not add to a cart in use` };
    before = { ids: cart.ids, store: cart.store };
  }
  const page = await session.newPage();
  const handoffs = [];
  await page.route((url) => new URL(url).pathname === surface.handoff, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    handoffs.push(route.request().url());
    return route.abort();
  });
  let outcome;
  try {
    const walked = await walkSurface(page, session.origin, surface, handoffs, before.store);
    outcome = { app: surface.app, state: walked.ok ? 'pass' : 'fail', detail: `${label}: ${walked.detail}` };
  } catch (error) {
    outcome = { app: surface.app, state: 'fail', detail: `${label}: ${common.errorText(error).split('\n')[0]}` };
  } finally {
    await page.close().catch(() => undefined);
  }
  if (surface.cart) await restoreCart(ports, surface, before, ledger);
  return outcome;
}

/**
 * @description Roll the per-surface outcomes into one verdict.
 * @param {Array<{app: string, state: string, detail: string}>} outcomes - Per surface.
 * @returns {{state: string, detail: string}} The verdict.
 */
function decide(outcomes) {
  const detail = `${outcomes.map((o) => `[${o.state}] ${o.detail}`).join(' ')}`;
  if (outcomes.some((o) => o.state === 'fail')) return { state: 'fail', detail };
  if (outcomes.every((o) => o.state === 'skipped')) return { state: 'unavailable', detail };
  if (outcomes.some((o) => o.state === 'skipped')) return { state: 'degraded', detail };
  return { state: 'pass', detail };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, browser (session(fn) giving newPage + origin).
 * @param {object} [options] - `only` (one app name), tests only.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port (a headless Chromium on the host); run node scripts/operations/live-acceptance.js ${KEY}.`);
  const apps = await ports.api('GET', '/api/swarm/apps?status=active');
  const installed = new Map((Array.isArray(apps.json && apps.json.apps) ? apps.json.apps : []).map((a) => [a.name, a.version]));
  const surfaces = SURFACES.filter((s) => !options.only || s.app === options.only);
  const ledger = new common.CleanupLedger();
  const outcomes = [];
  let verdict;
  try {
    await ports.browser.session(async (session) => {
      for (const surface of surfaces) outcomes.push(await checkSurface(ports, session, surface, installed, ledger));
    });
    verdict = decide(outcomes);
  } catch (error) {
    verdict = { state: 'fail', detail: `The browser session failed: ${common.errorText(error).split('\n')[0]}` };
  }
  return common.finish(CASE_ID, verdict, ledger, { surfaces: outcomes });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, SURFACES, restoreCart, decide, checkSurface, run };
