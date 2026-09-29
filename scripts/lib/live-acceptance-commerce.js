/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Consumer commerce native surfaces": a headless Chromium pass at 390 x 844 over the INSTALLED Rides, Eats and Shopping surfaces, as the caller, up to the confirm gate and never through it. Per surface: the page fits the width; the page's own flow prices a trip (Rides) or puts one item in the cart (Eats, Shopping); the assistant's relayed outward op (request_ride / place_order / checkout, posted the way the cockpit relay delivers it) renders the shared confirm card; the case clicks Cancel. Every hand-off POST is intercepted and ABORTED in the browser, and window.open is stubbed, so a regressed gate is counted and still reaches nothing. Only an empty cart is used; the item the case added is removed through the page's own cart route (a soft delete the product keeps as history) and the cart is proven back to empty.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Shopping is walked whatever the caller's cart holds. The case declined any surface whose cart had lines, so on a box where the acceptance identity's Shopping cart is in use the page was never opened and the case could not read better than degraded. Shopping's own routes answer the line an add wrote and remove one line by its id, so the case now owns exactly its line there: every add its page posts is stamped in the browser with the run's tag (`testlab-live-commerce-<8 hex>`, in the line's free-text reason field), the id the add answered is recorded, the page must show that line before the confirm card is raised, and cleanup removes only lines that were absent from the cart before the run and carry the tag or an answered id. A line the cart already held is never sent a removal; a line that appeared during the run and is not the case's is left and named in the receipt; every held line is read back and compared field by field, and one that is missing or differs is a red cleanup naming the line and the fields, never the values. Eats is unchanged and still declines a cart in use.
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
/** What the receipt says of a line the run added and removed. */
const REMOVED_NOTE = "removed through the page's own cart route; the product keeps it as a removed line";
/** What the receipt says of a line that is new to the cart and is not the run's. */
const NOT_OURS_NOTE = 'appeared in the cart during the run and is not a line the case added; left as it is';

/**
 * The installed surfaces. `handoff` is the outward POST the confirm would fire; `cart` names the
 * page's own cart read and item removal; `prepare` is the page's own path to something to confirm.
 * `cart.ownLine` is set where the cart's routes let the case own exactly its line, so a cart in use
 * can be walked: `add` matches the path of the page's add POST, `answer` is the field of its reply
 * that holds the written line, `tagField` is the free-text field of a line that carries the run's
 * tag, and `shownBy` is the attribute the page puts a line's id in when it shows the line.
 */
const SURFACES = Object.freeze([
  { app: 'rides', path: '/api/rides/app', handoff: '/api/rides/request', confirmOp: 'request_ride', cart: null },
  { app: 'eats', path: '/api/eats/app', handoff: '/api/eats/order', confirmOp: 'place_order',
    cart: { read: '/api/eats/cart', idField: 'row_id', storeField: 'storeId', clear: '/api/eats/cart/clear',
      remove: (_cart, id) => `/api/eats/cart/items/${encodeURIComponent(id)}` } },
  { app: 'purchasing', path: '/api/purchasing/chat', handoff: '/api/purchasing/checkout', confirmOp: 'checkout',
    cart: { read: '/api/purchasing/cart', idField: 'item_id', remove: (cart, id) => `/api/purchasing/lists/${encodeURIComponent(cart.listId)}/items/${encodeURIComponent(id)}`,
      ownLine: { add: /^\/api\/purchasing\/lists\/[^/]+\/items$/, answer: 'item', tagField: 'reason', shownBy: 'data-remove' } } },
]);

/**
 * @description Read a surface's cart through its own route.
 * @param {object} ports - api.
 * @param {object} surface - The surface.
 * @returns {Promise<{status: number, ids: string[], store: unknown, cart: object, lines: Map<string, object>}>} The pending lines, by id.
 */
async function readCart(ports, surface) {
  const res = await ports.api('GET', surface.cart.read);
  const items = Array.isArray(res.json && res.json.items) ? res.json.items : [];
  const store = surface.cart.storeField && res.json ? res.json[surface.cart.storeField] ?? null : null;
  const lines = new Map(items.map((item) => [String(item[surface.cart.idField]), item]));
  return { status: res.status, ids: [...lines.keys()], store, cart: res.json || {}, lines };
}

/**
 * @description One value as text with object keys in order, so two reads of one row compare equal.
 * @param {unknown} value - A field of a cart line.
 * @returns {string} Its canonical text.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return String(JSON.stringify(value));
}

/**
 * @description What became of the lines the cart held before the run: each must still be in the cart
 * with every field as it was. Names lines and fields only, never a value.
 * @param {{ids: string[], lines?: Map<string, object>}} before - The cart before the run.
 * @param {{lines: Map<string, object>}} after - The cart after cleanup.
 * @returns {string[]} One sentence per line that is missing or differs.
 */
function heldLineProblems(before, after) {
  const problems = [];
  for (const id of before.ids) {
    const was = before.lines ? before.lines.get(id) : undefined;
    const is = after.lines.get(id);
    if (!is) problems.push(`line ${id} is no longer in the cart`);
    else if (was) {
      const fields = [...new Set([...Object.keys(was), ...Object.keys(is)])].sort().filter((key) => canonical(was[key]) !== canonical(is[key]));
      if (fields.length) problems.push(`line ${id} differs in ${fields.join(', ')}`);
    }
  }
  return problems;
}

/**
 * @description Sort the lines that are new to the cart into the run's own and everyone else's. A line
 * the cart held before the run is never in either list. Where the surface cannot tell (no `ownLine`)
 * the cart was empty before the run, so every new line is the run's.
 * @param {object} surface - The surface.
 * @param {{ids: string[]}} before - The cart before the run.
 * @param {{ids: string[], lines: Map<string, object>}} now - The cart as it is.
 * @param {{tag: string|null, ids: string[]}} own - The run's tag and the line ids its adds answered.
 * @returns {{mine: string[], others: string[]}} The new lines, sorted.
 */
function sortNewLines(surface, before, now, own) {
  const fresh = now.ids.filter((id) => !before.ids.includes(id));
  const spec = surface.cart.ownLine;
  if (!spec) return { mine: fresh, others: [] };
  const mine = fresh.filter((id) => own.ids.includes(id) || (Boolean(own.tag) && now.lines.get(id)[spec.tagField] === own.tag));
  return { mine, others: fresh.filter((id) => !mine.includes(id)) };
}

/**
 * @description Read the cart back after the removals: none of the run's lines may remain, every line
 * the cart held must be as it was, and the Eats restaurant label goes back to what it was.
 * @param {object} ports - api.
 * @param {object} surface - The surface.
 * @param {{ids: string[], store: unknown, lines?: Map<string, object>}} before - The cart before the run.
 * @param {{tag: string|null, ids: string[]}} own - The run's tag and answered line ids.
 * @param {{unchanged: boolean}} summary - Set `unchanged` once the held lines read back as they were.
 * @returns {Promise<string|null>} What is wrong, or null.
 */
async function cartProblem(ports, surface, before, own, summary) {
  let after = await readCart(ports, surface);
  const left = sortNewLines(surface, before, after, own).mine;
  if (left.length) return `the ${surface.app} cart still holds ${left.length} line(s) the run added (${left.join(', ')})`;
  const held = heldLineProblems(before, after);
  if (held.length) return `the ${surface.app} cart the run found did not read back as it was: ${held.join('; ')}`;
  summary.unchanged = true;
  if (surface.cart.clear && before.store === null && after.store !== null) {
    await ports.api('POST', surface.cart.clear, {});
    after = await readCart(ports, surface);
  }
  if (after.store !== before.store) return `the ${surface.app} cart is labelled ${after.store} after the run; it was ${before.store}`;
  return null;
}

/**
 * @description Remove the lines this run added, and only those, then prove the cart back to what it
 * was: the run's lines gone, every line it held before unchanged, and the Eats cart's restaurant
 * label restored when adding the item set it.
 * @param {object} ports - api.
 * @param {object} surface - The surface.
 * @param {{ids: string[], store: unknown, lines?: Map<string, object>}} before - The cart before the run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {{tag: string|null, ids: string[]}} [own] - The run's tag and the line ids its adds answered.
 * @returns {Promise<{held: number, removed: string[], left: string[], unchanged: boolean}>} What the cart held, what was removed, what was left that is not the run's, and whether the held lines read back as they were.
 */
async function restoreCart(ports, surface, before, ledger, own = { tag: null, ids: [] }) {
  const kind = `${surface.app}-cart-line`;
  const summary = { held: before.ids.length, removed: [], left: [], unchanged: false };
  await ledger.attempt(`${surface.app} cart restore`, async () => {
    const now = await readCart(ports, surface);
    const { mine, others } = sortNewLines(surface, before, now, own);
    for (const id of mine) {
      ledger.created(kind, id);
      const res = await ports.api('DELETE', surface.cart.remove(now.cart, id));
      if (res.status !== 200) return `removing ${surface.app} cart line ${id} answered HTTP ${res.status}`;
      ledger.kept(kind, id, REMOVED_NOTE);
      summary.removed.push(id);
    }
    for (const id of others) ledger.kept(kind, id, NOT_OURS_NOTE);
    summary.left = others;
    return cartProblem(ports, surface, before, own, summary);
  });
  return summary;
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
 * @description Stamp the run's tag on every line the page adds, in the browser, before the request
 * leaves: the page posts its own body and only the line's free-text tag field is replaced. An add
 * whose body cannot be read is aborted, so the run never writes a line it could not tag.
 * @param {object} page - The Playwright page.
 * @param {object} surface - A surface with `cart.ownLine`.
 * @param {{tag: string, untagged: string[]}} own - The run's tag; `untagged` collects why an add was aborted.
 * @returns {Promise<void>} Resolves once the route is set.
 */
function tagAdds(page, surface, own) {
  const { add, tagField } = surface.cart.ownLine;
  return page.route((url) => add.test(new URL(url).pathname), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try {
      const body = JSON.parse(route.request().postData() || '');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('the body is not a JSON object');
      return route.fallback({ postData: JSON.stringify({ ...body, [tagField]: own.tag }) });
    } catch (error) {
      own.untagged.push(common.errorText(error));
      return route.abort();
    }
  });
}

/**
 * @description Put one item in the cart with the page's own Add button. Where the surface lets the
 * case own its line, the line the add answered must carry the run's tag, its id is recorded for the
 * cleanup, and the page must show that line before the walk goes on.
 * @param {object} page - The Playwright page.
 * @param {object} surface - The surface.
 * @param {{tag: string|null, ids: string[]}} own - The run's tag; the answered line id is pushed onto `ids`.
 * @returns {Promise<string>} What was added (for the evidence).
 */
async function addThroughPage(page, surface, own) {
  const add = page.locator('[data-add]').first();
  await add.waitFor({ timeout: UI_TIMEOUT_MS });
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/(cart\/items|lists\/[^/]+\/items)$/.test(new URL(r.url()).pathname), { timeout: UI_TIMEOUT_MS });
  await add.click();
  const response = await posted;
  if (response.status() !== 200) throw new Error(`adding an item answered HTTP ${response.status()}`);
  const spec = surface.cart.ownLine;
  if (!spec) return 'put one item in the cart through the page';
  const line = (await response.json())[spec.answer] || {};
  const id = line[surface.cart.idField] === undefined || line[surface.cart.idField] === null ? '' : String(line[surface.cart.idField]);
  if (!id) throw new Error('the add answered no line id');
  own.ids.push(id);
  if (line[spec.tagField] !== own.tag) throw new Error(`the line the add wrote (${id}) does not carry the run's tag`);
  await page.waitForFunction(({ attribute, value }) => Array.from(document.querySelectorAll(`[${attribute}]`))
    .some((node) => node.getAttribute(attribute) === value), { attribute: spec.shownBy, value: id }, { timeout: UI_TIMEOUT_MS });
  return `put one item in the cart through the page as line ${id}, tagged ${own.tag}, and the page showed it`;
}

/**
 * @description The page's own path to something to confirm.
 * @param {object} page - The Playwright page.
 * @param {object} surface - The surface.
 * @param {unknown} [store] - The restaurant an empty Eats cart is already labelled with, preferred so the label stays.
 * @param {{tag: string|null, ids: string[]}} [own] - The run's tag and answered line ids.
 * @returns {Promise<string>} What was prepared (for the evidence).
 */
async function prepare(page, surface, store = null, own = { tag: null, ids: [] }) {
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
  return addThroughPage(page, surface, own);
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
 * @param {{tag: string|null, ids: string[]}} own - The run's tag and answered line ids.
 * @returns {Promise<{ok: boolean, detail: string}>} The surface's judgement.
 */
async function walkSurface(page, origin, surface, handoffs, store, own) {
  const loaded = await page.goto(`${origin}${surface.path}`, { waitUntil: 'domcontentloaded' });
  if (!loaded || loaded.status() !== 200) return { ok: false, detail: `${surface.path} answered HTTP ${loaded ? loaded.status() : 'none'}` };
  await page.waitForFunction(() => Boolean(window.__bridge && window.__bridgeProducer), null, { timeout: UI_TIMEOUT_MS });
  const fit = await widths(page);
  const prepared = await prepare(page, surface, store, own);
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
 * @description Open one page for the surface, with its hand-off aborted and its adds tagged, walk it
 * and close it. A throw inside the walk is the surface's failure, not the run's.
 * @param {object} session - The browser session (newPage, origin).
 * @param {object} surface - The surface.
 * @param {string} label - The surface's name and installed version.
 * @param {unknown} store - The Eats cart's existing restaurant label, if any.
 * @param {{tag: string|null, ids: string[], untagged: string[]}} own - The run's tag, answered line ids and aborted adds.
 * @returns {Promise<{app: string, state: 'pass'|'fail', detail: string}>} The walk's outcome.
 */
async function walkPage(session, surface, label, store, own) {
  const page = await session.newPage();
  const handoffs = [];
  await page.route((url) => new URL(url).pathname === surface.handoff, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    handoffs.push(route.request().url());
    return route.abort();
  });
  if (own.tag) await tagAdds(page, surface, own);
  try {
    const walked = await walkSurface(page, session.origin, surface, handoffs, store, own);
    return { app: surface.app, state: walked.ok ? 'pass' : 'fail', detail: `${label}: ${walked.detail}` };
  } catch (error) {
    const untagged = own.untagged.length ? `${own.untagged.length} add request(s) could not be tagged and were aborted in the browser (${own.untagged[0]}); ` : '';
    return { app: surface.app, state: 'fail', detail: `${label}: ${untagged}${common.errorText(error).split('\n')[0]}` };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * @description Attach what happened to the cart to a surface's outcome.
 * @param {{app: string, state: string, detail: string}} outcome - The walk's outcome.
 * @param {{held: number, removed: string[], left: string[], unchanged: boolean}} summary - From restoreCart.
 * @param {{tag: string|null}} own - The run's tag.
 * @returns {object} The outcome with its `cart` evidence.
 */
function withCart(outcome, summary, own) {
  const held = summary.held && summary.unchanged ? `; the ${summary.held} line(s) the cart already held read back unchanged` : '';
  return { ...outcome, detail: `${outcome.detail}${held}`, cart: { ...summary, ...(own.tag ? { tag: own.tag } : {}) } };
}

/**
 * @description One surface end to end, with its cart snapshot and restore. A cart in use is walked
 * only where the surface lets the case own its line (`cart.ownLine`); elsewhere it is skipped.
 * @param {object} ports - api.
 * @param {object} session - The browser session (newPage, origin).
 * @param {object} surface - The surface.
 * @param {Map<string, string>} installed - Active app name to version.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{app: string, state: 'pass'|'fail'|'skipped', detail: string, cart?: object}>} The surface's outcome.
 */
async function checkSurface(ports, session, surface, installed, ledger) {
  if (!installed.has(surface.app)) return { app: surface.app, state: 'skipped', detail: 'not installed' };
  const label = `${surface.app} ${installed.get(surface.app)}`;
  if (!surface.cart) return walkPage(session, surface, label, null, { tag: null, ids: [], untagged: [] });
  const before = await readCart(ports, surface);
  if (before.status !== 200) return { app: surface.app, state: 'fail', detail: `${label}: the cart read answered HTTP ${before.status}` };
  if (before.ids.length && !surface.cart.ownLine) {
    return { app: surface.app, state: 'skipped', detail: `${label}: the cart holds ${before.ids.length} line(s); the case does not add to a cart in use` };
  }
  const own = { tag: surface.cart.ownLine ? common.mintTag(KEY) : null, ids: [], untagged: [] };
  const outcome = await walkPage(session, surface, label, before.store, own);
  return withCart(outcome, await restoreCart(ports, surface, before, ledger, own), own);
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

module.exports = { CASE_ID, KEY, TITLE, NEEDS, SURFACES, readCart, restoreCart, decide, checkSurface, run };
