/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Execute the actual qualified browser script using named in-memory DOM/fetch/navigation doubles; assert exact revision requests, secret clearing and safe refusal. Not browser/server/provider acceptance.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Distinguish embedded and top-level navigation; refuse fallback into the child frame when top navigation fails.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(resolve(__dirname, '../../src/shared/ui/js/qualified-connectors.js'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../src/api/utilities.html'), 'utf8');
const BASE = '/api/connect/qualified';
const TOKEN = 'qualified-ui-fresh-token-sentinel';
const id = (n = 1) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const row = (n = 1, patch = {}) => ({ connectionId: id(n), provider: 'smartthings',
  accountKey: 'smartthings-location:location-' + n, status: 'connected', revision: '9007199254740993',
  expiresAt: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', ...patch });
type EventDouble = { preventDefault: () => void; persisted?: boolean };

/** Named DOM double: only tree/text/attributes/events used by this script; no HTML parser, layout or browser security behavior. */
class DomElementDouble {
  tagName: string; children: DomElementDouble[] = []; dataset: Record<string, string> = {};
  attributes: Record<string, string> = {}; listeners = new Map<string, Array<(event: EventDouble) => unknown>>();
  id = ''; value = ''; type = ''; className = ''; href = ''; target = ''; htmlFor = ''; autocomplete = ''; spellcheck = true;
  disabled = false; hidden = false; maxLength = 0; tabIndex = 0; private text = '';
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error('DOM double refuses HTML injection'); }
  append(...elements: DomElementDouble[]) { this.children.push(...elements); }
  appendChild(element: DomElementDouble) { this.children.push(element); return element; }
  replaceChildren(...elements: DomElementDouble[]) { this.text = ''; this.children = elements; }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); if (name === 'href') this.href = String(value); }
  removeAttribute(name: string) { delete this.attributes[name]; if (name === 'href') this.href = ''; }
  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  addEventListener(name: string, listener: (event: EventDouble) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  async fire(name: string, patch = {}) {
    // Deliberately invoke even disabled controls: production's pending guard must also refuse scripted double-dispatch.
    const event = { preventDefault: vi.fn(), ...patch };
    await Promise.all((this.listeners.get(name) ?? []).map(listener => listener(event)));
    return event;
  }
  matches(selector: string): boolean {
    const match = selector.trim().match(/^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/);
    if (!match) throw new Error('DOM double selector unsupported');
    return (!match[1] || this.tagName === match[1].toUpperCase())
      && (!match[2] || (this.getAttribute(match[2]) !== null && (match[3] === undefined || this.getAttribute(match[2]) === match[3])));
  }
  querySelectorAll(selector: string): DomElementDouble[] {
    return this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
      .filter(child => selector === '*' || selector.split(',').some(part => child.matches(part)));
  }
}
function response(status: number, data: unknown = { connections: [] }) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => data) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
/** Network/navigation/confirmation doubles: no actual fetch, browser, credentials, storage or provider contact. */
function panel(first: unknown = response(200), embedded = true) {
  const root = new DomElementDouble('div'); root.id = 'qualifiedConnectorsPanel';
  const queue: unknown[] = [first], windowEvents = new Map<string, (event: EventDouble) => unknown>();
  const fetch = vi.fn(async (_path: string, _options: Record<string, any>) => {
    if (!queue.length) throw new Error('unexpected fixture request');
    const next = queue.shift(); if (next instanceof Error) throw next; return await next;
  });
  const confirm = vi.fn((_message: string) => true), assign = vi.fn(), topNavigate = vi.fn(), log = vi.fn();
  const document = { getElementById: (name: string) => name === root.id ? root : null,
    createElement: (tag: string) => new DomElementDouble(tag) };
  const window = { fetch, confirm, location: { assign, set href(value: string) { assign(value); } },
    addEventListener: (name: string, listener: (event: EventDouble) => unknown) => windowEvents.set(name, listener),
    localStorage: new Proxy({}, { get: () => { throw new Error('storage is forbidden'); } }) };
  Object.defineProperty(window, 'top', { value: embedded ? { location: { set href(value: string) { topNavigate(value); } } } : window });
  const context = { document, TextEncoder, console: { log, error: log, warn: log }, window };
  runInNewContext(script, context);
  return { root, queue, fetch, confirm, assign, topNavigate, log, context, windowEvents };
}
async function settled() { for (let tick = 0; tick < 20; tick++) await Promise.resolve(); }
function button(root: DomElementDouble, text: string) {
  const found = root.querySelectorAll('button').find(element => element.textContent === text);
  if (!found) throw new Error('fixture button missing: ' + text); return found;
}
function card(root: DomElementDouble, connectionId = id()) {
  const found = root.querySelectorAll('[data-qualified-id]').find(element => element.dataset.qualifiedId === connectionId);
  if (!found) throw new Error('fixture card missing'); return found;
}
function form(root: DomElementDouble) { return root.querySelectorAll('form')[0]; }
function input(root: DomElementDouble) { return root.querySelectorAll('input')[0]; }
const writes = (fixture: ReturnType<typeof panel>) => fixture.fetch.mock.calls.filter(([, options]) => options.method !== 'GET');
function assertSameOrigin(fixture: ReturnType<typeof panel>) {
  for (const [path, options] of fixture.fetch.mock.calls) {
    expect(path.startsWith(BASE)).toBe(true);
    expect(options).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(options.headers).not.toHaveProperty('Authorization'); expect(options.headers).not.toHaveProperty('Origin');
  }
}

describe('actual qualified browser script / named DOM, fetch and navigation doubles', () => {
  it('mounts a plainly separate personal location panel without modifying legacy Utilities entry points', async () => {
    expect(html).toContain('id="qualifiedConnectorsPanel"'); expect(html).toContain('Personal SmartThings — qualified grants');
    expect(html).toContain('not a person account'); expect(html).toContain('cannot be shared with a household here');
    expect(html.match(/src="\/shared\/ui\/js\/qualified-connectors.js"/g)).toHaveLength(1);
    expect(html).toContain('id="tenantSel"'); expect(html).toContain('id="list"'); expect(html).toContain('loadTenants().then(load)');
    const fixture = panel(response(200, { connections: [row(), row(2, { status: 'revoked', revision: '4' })] })); await settled();
    expect(fixture.fetch.mock.calls[0][0]).toBe(BASE + '?limit=50');
    expect(fixture.root.textContent).toContain('Status: revoked · Revision: 4');
    expect(fixture.root.textContent).toContain('Expiry: unknown (not proof of validity)');
    expect(fixture.root.textContent).toContain('Verified location: smartthings-location:location-1');
    expect(fixture.root.querySelectorAll('input').every(element => element.type === 'password' && element.autocomplete === 'off')).toBe(true);
    assertSameOrigin(fixture); expect(writes(fixture)).toHaveLength(0);
    runInNewContext(script, fixture.context); await settled(); expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('clears a new PAT before the await, disables pending controls and ignores double-submit', async () => {
    const fixture = panel(); await settled(); const held = deferred<ReturnType<typeof response>>();
    fixture.queue.push(held.promise, response(200, { connections: [row()] }));
    const originalForm = form(fixture.root), originalInput = input(fixture.root); originalInput.value = TOKEN;
    const submission = originalForm.fire('submit');
    expect(originalInput.value).toBe(''); expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(true);
    expect(fixture.root.querySelectorAll('a[data-qualified-oauth]').every(link => !link.href)).toBe(true);
    originalInput.value = 'second-token-sentinel'; await originalForm.fire('submit');
    expect(originalInput.value).toBe(''); expect(writes(fixture)).toHaveLength(1);
    held.resolve(response(200, { connection: row() })); await submission;
    const [path, options] = writes(fixture)[0]; expect(path).toBe(BASE + '/smartthings/token');
    expect(JSON.parse(options.body)).toEqual({ token: TOKEN }); expect(options.headers).not.toHaveProperty('If-Match');
    expect(fixture.root.textContent).not.toContain(TOKEN); expect(input(fixture.root).value).toBe('');
    expect(fixture.log).not.toHaveBeenCalled(); assertSameOrigin(fixture);
  });

  it('reconnects the displayed UUID with exact quoted string revision and token-only body', async () => {
    const original = row(), fixture = panel(response(200, { connections: [original] })); await settled();
    original.revision = '100'; // Returned transport object cannot mutate the displayed snapshot.
    fixture.queue.push(response(200), response(200, { connections: [row(1, { revision: '9007199254740994' })] }));
    const target = card(fixture.root); input(target).value = TOKEN; await form(target).fire('submit');
    const [path, options] = writes(fixture)[0]; expect(path).toBe(BASE + '/smartthings/' + id() + '/token');
    expect(options.headers['If-Match']).toBe('"9007199254740993"'); expect(JSON.parse(options.body)).toEqual({ token: TOKEN });
    expect(fixture.root.textContent).toContain('Revision: 9007199254740994'); assertSameOrigin(fixture);
  });

  it('requires explicit local revoke confirmation and never claims remote token revocation', async () => {
    const fixture = panel(response(200, { connections: [row()] })); await settled();
    fixture.confirm.mockReturnValueOnce(false); input(card(fixture.root)).value = TOKEN;
    await button(card(fixture.root), 'Revoke local grant').fire('click');
    expect(writes(fixture)).toHaveLength(0); expect(input(card(fixture.root)).value).toBe('');
    expect(fixture.confirm.mock.calls[0][0]).toContain('does not revoke the token at SmartThings or send a device action');
    fixture.queue.push(response(200), response(200, { connections: [row(1, { status: 'revoked', revision: '9007199254740994' })] }));
    await button(card(fixture.root), 'Revoke local grant').fire('click');
    expect(writes(fixture)).toHaveLength(1);
    expect(writes(fixture)[0]).toEqual([BASE + '/' + id(), expect.objectContaining({ method: 'DELETE', headers: { Accept: 'application/json', 'If-Match': '"9007199254740993"' } })]);
    expect(fixture.root.textContent).toContain('Status: revoked'); assertSameOrigin(fixture);
  });

  it.each([404, 409])('refreshes stale %s metadata without retrying the write or retaining PAT', async status => {
    const fixture = panel(response(200, { connections: [row()] })); await settled();
    fixture.queue.push(response(status, { error: TOKEN }), response(200, { connections: [row(1, { revision: '9007199254740994' })] }));
    const target = card(fixture.root); input(target).value = TOKEN; await form(target).fire('submit');
    expect(writes(fixture)).toHaveLength(1); expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.root.textContent).toContain('No write was retried'); expect(fixture.root.textContent).not.toContain(TOKEN);
    expect(input(card(fixture.root)).value).toBe('');
    fixture.queue.push(response(200), response(200, { connections: [row(1, { revision: '9007199254740995' })] }));
    const updated = card(fixture.root); input(updated).value = 'explicit-fresh-token-sentinel'; await form(updated).fire('submit');
    expect(writes(fixture)).toHaveLength(2); expect(writes(fixture)[1][1].headers['If-Match']).toBe('"9007199254740994"');
  });

  it.each([401, 403, 404, 503])('renders unavailable %s honestly and enables only a status refresh', async status => {
    const unavailable = response(status, { error: 'untrusted-' + TOKEN }); const fixture = panel(unavailable); await settled();
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(true);
    expect(button(fixture.root, 'Refresh qualified grants').disabled).toBe(false);
    expect(fixture.root.querySelectorAll('a[data-qualified-oauth]').every(link => link.getAttribute('aria-disabled') === 'true' && !link.href)).toBe(true);
    expect(fixture.root.textContent).not.toContain(TOKEN); expect(unavailable.json).not.toHaveBeenCalled();
    if (status === 503) expect(fixture.root.textContent).toContain('Qualified service unavailable (503)');
    expect(writes(fixture)).toHaveLength(0); expect(fixture.fetch).toHaveBeenCalledTimes(1);
    fixture.queue.push(response(200)); await button(fixture.root, 'Refresh qualified grants').fire('click');
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(false); assertSameOrigin(fixture);
  });

  it.each([400, 422, 500, 503])('clears rejected PAT and never renders server error details (%s)', async status => {
    const fixture = panel(); await settled(); const failed = response(status, { token: TOKEN, error: '<img onerror=secret>' });
    fixture.queue.push(failed); input(fixture.root).value = TOKEN; await form(fixture.root).fire('submit');
    expect(input(fixture.root).value).toBe(''); expect(fixture.root.textContent).not.toContain(TOKEN);
    expect(fixture.root.textContent).not.toContain('<img'); expect(failed.json).not.toHaveBeenCalled();
    expect(writes(fixture)).toHaveLength(1); expect(fixture.log).not.toHaveBeenCalled();
  });

  it('does not report a successful write as rejected when its subsequent metadata read fails', async () => {
    const fixture = panel(); await settled(); fixture.queue.push(response(200), response(503));
    input(fixture.root).value = TOKEN; await form(fixture.root).fire('submit');
    expect(fixture.root.textContent).toContain('Request accepted, but metadata refresh is unavailable');
    expect(writes(fixture)).toHaveLength(1); expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(true);
  });

  it('clears stale visible grant controls if a write encounters service unavailability', async () => {
    const fixture = panel(response(200, { connections: [row()] })); await settled(); fixture.queue.push(response(503));
    const target = card(fixture.root); input(target).value = TOKEN; await form(target).fire('submit');
    expect(fixture.root.querySelectorAll('[data-qualified-id]')).toEqual([]);
    expect(fixture.root.textContent).toContain('Qualified service unavailable (503)');
    expect(button(fixture.root, 'Refresh qualified grants').disabled).toBe(false);
  });

  it('retains explicit needs_reconnect status and marks an expired timestamp, without claiming readiness', async () => {
    const fixture = panel(response(200, { connections: [row(1, { status: 'needs_reconnect', expiresAt: '2000-01-01T00:00:00.000Z' })] }));
    await settled(); expect(fixture.root.textContent).toContain('Status: needs_reconnect');
    expect(fixture.root.textContent).toContain('Expiry: 2000-01-01T00:00:00.000Z (expired)');
    expect(writes(fixture)).toHaveLength(0);
  });

  it('renders potentially hostile location labels as text and filters other qualified providers', async () => {
    const location = 'smartthings-location:<img src=x onerror="bad()">';
    const fixture = panel(response(200, { connections: [row(1, { accountKey: location }), row(2, { provider: 'google', accountKey: 'other-provider-sentinel' })] }));
    await settled(); expect(fixture.root.textContent).toContain(location); expect(fixture.root.querySelectorAll('img')).toEqual([]);
    expect(fixture.root.querySelectorAll('[data-qualified-id]')).toHaveLength(1);
    expect(fixture.root.textContent).not.toContain('other-provider-sentinel'); expect(fixture.log).not.toHaveBeenCalled();
  });

  it('paginates with the last server UUID, even if the last row is another provider; refresh starts over', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
    rows[49] = row(50, { provider: 'google', accountKey: 'other-provider-sentinel' });
    const fixture = panel(response(200, { connections: rows })); await settled();
    expect(button(fixture.root, 'Next page').hidden).toBe(false);
    fixture.queue.push(response(200, { connections: [row(51)] })); await button(fixture.root, 'Next page').fire('click');
    expect(fixture.fetch.mock.calls[1][0]).toBe(BASE + '?limit=50&afterConnectionId=' + id(50));
    expect(fixture.root.querySelectorAll('[data-qualified-id]')).toHaveLength(1); expect(card(fixture.root, id(51))).toBeTruthy();
    expect(button(fixture.root, 'Next page').hidden).toBe(true);
    fixture.queue.push(response(200)); await button(fixture.root, 'Refresh qualified grants').fire('click');
    expect(fixture.fetch.mock.calls[2][0]).toBe(BASE + '?limit=50');
  });

  it.each([false, true])('navigates the TOP window once through registered OAuth (reconnect=%s), without a fetch preflight', async reconnect => {
    const fixture = panel(response(200, { connections: [row()] })); await settled();
    const host = reconnect ? card(fixture.root) : fixture.root;
    const link = host.querySelectorAll('a[data-qualified-oauth]')[0]; input(host).value = TOKEN;
    await link.fire('click'); await link.fire('click');
    expect(fixture.topNavigate).toHaveBeenCalledTimes(1);
    expect(fixture.topNavigate).toHaveBeenCalledWith(BASE + '/smartthings/start' + (reconnect ? '?reconnect=' + id() : ''));
    expect(fixture.assign).not.toHaveBeenCalled(); expect(link.target).toBe('_top');
    expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(input(host).value).toBe('');
    expect(fixture.root.textContent).toContain('If the server returns 503');
    fixture.queue.push(response(200));
    await fixture.windowEvents.get('pageshow')!({ preventDefault: vi.fn(), persisted: true });
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(false); expect(fixture.topNavigate).toHaveBeenCalledTimes(1);
  });

  it('uses the same top-level rail when Utilities itself is the top window', async () => {
    const fixture = panel(response(200), false); await settled();
    const link = fixture.root.querySelectorAll('a[data-qualified-oauth]')[0];
    await link.fire('click'); await link.fire('click');
    expect(fixture.assign).toHaveBeenCalledExactlyOnceWith(BASE + '/smartthings/start');
    expect(fixture.topNavigate).not.toHaveBeenCalled(); expect(link.target).toBe('_top');
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('clears secrets before top navigation and refuses any child-frame fallback if it fails', async () => {
    const fixture = panel(); await settled(); input(fixture.root).value = TOKEN;
    fixture.topNavigate.mockImplementationOnce(() => {
      expect(input(fixture.root).value).toBe('');
      throw new Error('untrusted-navigation-' + TOKEN);
    });
    await fixture.root.querySelectorAll('a[data-qualified-oauth]')[0].fire('click');
    expect(fixture.topNavigate).toHaveBeenCalledTimes(1); expect(fixture.assign).not.toHaveBeenCalled();
    expect(fixture.fetch).toHaveBeenCalledTimes(1); expect(input(fixture.root).value).toBe('');
    expect(fixture.root.textContent).toContain('OAuth navigation could not start. No request was retried.');
    expect(fixture.root.textContent).not.toContain(TOKEN); expect(fixture.log).not.toHaveBeenCalled();
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(false);
  });

  it.each([{ connectionId: 'bad-id' }, { revision: 7 }, { revision: '01' }, { revision: '9223372036854775808' },
    { accountKey: 'not-a-verified-location' }, { status: 'ready' }, { expiresAt: 'invalid' }])('refuses unsafe transport metadata before rendering write targets %#', async patch => {
    const fixture = panel(response(200, { connections: [row(1, patch)] })); await settled();
    expect(fixture.root.querySelectorAll('[data-qualified-id]')).toEqual([]);
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(true); expect(writes(fixture)).toHaveLength(0);
  });

  it('sanitizes network errors and bounds empty/oversized fresh secrets without requests', async () => {
    const failed = panel(new Error('network-secret-' + TOKEN)); await settled();
    expect(failed.root.textContent).not.toContain(TOKEN); expect(failed.log).not.toHaveBeenCalled();
    const fixture = panel(); await settled();
    for (const token of ['', '   ', 'α'.repeat(32769)]) {
      input(fixture.root).value = token; await form(fixture.root).fire('submit'); expect(input(fixture.root).value).toBe('');
    }
    expect(writes(fixture)).toHaveLength(0); expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ connections: [row(), row()] }, { connections: Array.from({ length: 51 }, (_, index) => row(index + 1)) },
    { connections: 'invalid' }])('refuses duplicate/unbounded/malformed metadata pages %#', async data => {
    const fixture = panel(response(200, data)); await settled();
    expect(button(fixture.root, 'Connect fresh PAT').disabled).toBe(true); expect(writes(fixture)).toHaveLength(0);
  });
});
