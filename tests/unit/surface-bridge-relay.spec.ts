/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the surface-bridge BROWSER wiring: the cockpit relay (driven with the REAL contract) drops wrong-channel/version/unknown-op/foreign-origin messages, drops app-mismatch + op-not-allowed events, treats an UNDECLARED allow-list as empty (fail-closed), strips HTML in transit, routes to_surface → the app-surface iframe and to_bot → the chat rail, only accepts each direction from its correct sibling, and hands `navigate` to the ribbon's app-navigate dialect. Plus: manifest surface.ops loads fail-closed, and the surface client's channel/version literals cannot drift from the TS contract.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The ORIGIN fixture follows PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of a hardcoded localhost:35457 — the relay origin and every fake MessageEvent read the same value, so foreign-origin drops stay meaningful under any port (byte-identical under the default env)
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  OUTBOUND_OPS,
  INBOUND_OPS,
  normalizeSurfaceEvent,
  resolveRelayTarget,
} from '../../src/features/surface-bridge';
import { SURFACE_BRIDGE_OPS, isSurfaceBridgeOp } from '../../src/shared/surface-bridge-ops';
import { readManifest } from '../../src/features/swarm-apps';
import { apiOrigin } from '../helpers';
// The browser modules under test — plain ESM, imported directly (vitest transforms them;
// tsc excludes tests/, so the untyped .js imports are vitest-only).
// @ts-expect-error — browser ESM without type declarations
import { createSurfaceBridgeRelay } from '../../src/pages/cockpit/js/surface-bridge-relay.js';
import {
  createSurfaceBridgeClient,
  SURFACE_BRIDGE_CHANNEL as CLIENT_CHANNEL,
  SURFACE_BRIDGE_VERSION as CLIENT_VERSION,
  // @ts-expect-error — browser ESM without type declarations
} from '../../src/shared/ui/js/surface-bridge-client.js';

const ORIGIN = apiOrigin();
const APP = 'presentations';
const base = { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP };

/** Build a relay wired to the REAL contract with recording fake sibling windows. */
function makeRelay(opts: { app?: string | null; allowedOps?: string[] | null } = {}) {
  const surfacePosts: unknown[] = [];
  const chatPosts: unknown[] = [];
  const shellPosts: unknown[] = [];
  const warns: unknown[] = [];
  const surfaceWin = { postMessage: (m: unknown) => surfacePosts.push(m) };
  const chatWin = { postMessage: (m: unknown) => chatPosts.push(m) };
  const relay = createSurfaceBridgeRelay({
    contract: { normalizeSurfaceEvent, resolveRelayTarget },
    getApp: () => (opts.app === undefined ? APP : opts.app),
    getAllowedOps: () =>
      opts.allowedOps === undefined
        ? ['render_options', 'set_field', 'set_content', 'navigate', 'notify', 'select', 'field_change', 'submit']
        : opts.allowedOps,
    getSurfaceWindow: () => surfaceWin,
    getChatWindow: () => chatWin,
    postToShell: (m: unknown) => shellPosts.push(m),
    origin: ORIGIN,
    logger: { debug: () => {}, warn: (...a: unknown[]) => warns.push(a) },
  });
  return { relay, surfaceWin, chatWin, surfacePosts, chatPosts, shellPosts, warns };
}

/** Fake MessageEvent. */
function msg(data: unknown, source: unknown, origin = ORIGIN) {
  return { data, source, origin } as MessageEvent;
}

describe('cockpit relay — fail-closed message validation', () => {
  it('drops wrong-channel, wrong-version, and unknown-op messages without posting anywhere', () => {
    const { relay, chatWin, surfacePosts, chatPosts, shellPosts } = makeRelay();
    expect(relay.handleMessage(msg({ type: 'app-navigate', tool: 'x' }, chatWin)).delivered).toBe(false);
    expect(relay.handleMessage(msg({ ...base, v: 999, op: 'notify', level: 'info', text: 'hi' }, chatWin)))
      .toMatchObject({ delivered: false, reason: 'version_mismatch' });
    expect(relay.handleMessage(msg({ ...base, op: 'delete_everything' }, chatWin)))
      .toMatchObject({ delivered: false, reason: 'unknown_op:delete_everything' });
    expect(surfacePosts).toHaveLength(0);
    expect(chatPosts).toHaveLength(0);
    expect(shellPosts).toHaveLength(0);
  });

  it('drops messages from a foreign origin even when the payload is valid', () => {
    const { relay, chatWin, surfacePosts } = makeRelay();
    const evt = msg({ ...base, op: 'set_content', region: 'outline', content: 'x' }, chatWin, 'https://evil.example');
    expect(relay.handleMessage(evt)).toMatchObject({ delivered: false, reason: 'foreign_origin' });
    expect(surfacePosts).toHaveLength(0);
  });

  it('drops an event whose app claim does not match the TRUSTED iframe binding', () => {
    const { relay, chatWin, surfacePosts } = makeRelay();
    const evt = msg({ ...base, app: 'some-other-app', op: 'set_content', region: 'r', content: 'x' }, chatWin);
    const out = relay.handleMessage(evt);
    expect(out.delivered).toBe(false);
    expect(out.reason).toMatch(/^app_mismatch:/);
    expect(surfacePosts).toHaveLength(0);
  });

  it('drops an op the manifest did not declare (op_not_allowed)', () => {
    const { relay, chatWin, surfacePosts } = makeRelay({ allowedOps: ['set_field'] });
    const out = relay.handleMessage(msg({ ...base, op: 'set_content', region: 'r', content: 'x' }, chatWin));
    expect(out).toMatchObject({ delivered: false, reason: 'op_not_allowed:set_content' });
    expect(surfacePosts).toHaveLength(0);
  });

  it('FAIL-CLOSED: an app with NO declared surface.ops (null allow-list) relays nothing', () => {
    const { relay, chatWin, surfacePosts } = makeRelay({ allowedOps: null });
    const out = relay.handleMessage(msg({ ...base, op: 'set_content', region: 'r', content: 'x' }, chatWin));
    expect(out).toMatchObject({ delivered: false, reason: 'op_not_allowed:set_content' });
    expect(surfacePosts).toHaveLength(0);
  });

  it('drops everything when no app is focused (plain cockpit)', () => {
    const { relay, chatWin, surfacePosts } = makeRelay({ app: null });
    const out = relay.handleMessage(msg({ ...base, op: 'set_content', region: 'r', content: 'x' }, chatWin));
    expect(out).toMatchObject({ delivered: false, reason: 'no_focused_app' });
    expect(surfacePosts).toHaveLength(0);
  });
});

describe('cockpit relay — routing + emitter binding', () => {
  it('delivers a valid to_surface event (from the chat rail) into the app-surface iframe, HTML-stripped', () => {
    const { relay, chatWin, surfacePosts, chatPosts } = makeRelay();
    const evt = msg({ ...base, op: 'set_content', region: 'outline', content: '<b>Hello</b> world<script>x()</script>' }, chatWin);
    expect(relay.handleMessage(evt)).toMatchObject({ delivered: true, target: 'surface' });
    expect(surfacePosts).toHaveLength(1);
    expect(chatPosts).toHaveLength(0);
    const delivered = surfacePosts[0] as { op: string; content: string };
    expect(delivered.op).toBe('set_content');
    expect(delivered.content).toBe('Hello worldx()');
    expect(JSON.stringify(delivered)).not.toContain('<');
  });

  it('delivers a valid to_bot event (from the app surface) into the chat rail', () => {
    const { relay, surfaceWin, surfacePosts, chatPosts } = makeRelay();
    const evt = msg({ ...base, op: 'select', optionId: 'opt-2' }, surfaceWin);
    expect(relay.handleMessage(evt)).toMatchObject({ delivered: true, target: 'chat' });
    expect(chatPosts).toHaveLength(1);
    expect(surfacePosts).toHaveLength(0);
    expect((chatPosts[0] as { optionId: string }).optionId).toBe('opt-2');
  });

  it('refuses a to_surface event emitted by the SURFACE (only the chat rail speaks for the bot)', () => {
    const { relay, surfaceWin, surfacePosts } = makeRelay();
    const out = relay.handleMessage(msg({ ...base, op: 'set_content', region: 'r', content: 'x' }, surfaceWin));
    expect(out).toMatchObject({ delivered: false, reason: 'emitter_not_chat_rail' });
    expect(surfacePosts).toHaveLength(0);
  });

  it('refuses a to_bot event emitted by the CHAT RAIL (only the surface speaks for the user)', () => {
    const { relay, chatWin, chatPosts } = makeRelay();
    const out = relay.handleMessage(msg({ ...base, op: 'submit', actionId: 'a1', confirmed: true }, chatWin));
    expect(out).toMatchObject({ delivered: false, reason: 'emitter_not_surface' });
    expect(chatPosts).toHaveLength(0);
  });

  it('hands navigate to the SHELL as the ribbon app-navigate dialect (RibbonNav stays the navigation authority)', () => {
    const { relay, chatWin, shellPosts, surfacePosts } = makeRelay();
    const out = relay.handleMessage(msg({ ...base, op: 'navigate', to: 'deck-builder' }, chatWin));
    expect(out).toMatchObject({ delivered: true, target: 'shell' });
    expect(shellPosts).toEqual([{ type: 'app-navigate', tool: 'deck-builder' }]);
    expect(surfacePosts).toHaveLength(0);
  });
});

describe('manifest surface.ops — load-time fail-closed validation', () => {
  /** Write a manifest and read it through the real readManifest. */
  function read(body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-surface-'));
    const file = join(dir, 'oshal-app.yaml');
    writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
    try {
      return readManifest(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts a declared allow-list drawn from the closed vocabulary', () => {
    const m = read('surface:\n  ops: [set_field, set_content, custom, event]\n');
    expect(m.surface?.ops).toEqual(['set_field', 'set_content', 'custom', 'event']);
  });

  it('REJECTS an unknown op at load (a typo must not silently never-relay)', () => {
    expect(() => read('surface:\n  ops: [set_field, set_titel]\n')).toThrow(/unknown surface-bridge op/);
  });

  it('REJECTS a surface block without an ops array', () => {
    expect(() => read('surface:\n  ops: set_field\n')).toThrow(/must be an object with an ops array/);
    expect(() => read('surface: {}\n')).toThrow(/must be an object with an ops array/);
  });

  it('absence stays legal — and means the relay carries NOTHING (fail-closed default)', () => {
    expect(read('').surface).toBeUndefined();
  });
});

describe('vocabulary + client-literal drift guards', () => {
  it('the shared op vocabulary IS the contract union — one list, two consumers', () => {
    expect([...SURFACE_BRIDGE_OPS]).toEqual([...OUTBOUND_OPS, ...INBOUND_OPS]);
    expect(isSurfaceBridgeOp('set_content')).toBe(true);
    expect(isSurfaceBridgeOp('set_titel')).toBe(false);
  });

  it("the surface client's channel/version literals equal the TS contract's constants", () => {
    expect(CLIENT_CHANNEL).toBe(SURFACE_BRIDGE_CHANNEL);
    expect(CLIENT_VERSION).toBe(SURFACE_BRIDGE_VERSION);
  });
});

describe('surface client — emits contract envelopes and applies delivered ops', () => {
  /** Minimal fake window/document for the client (node env — no jsdom on purpose). */
  function makeClient(fields: Record<string, { tagName: string; type?: string; value?: string; checked?: boolean }> = {}) {
    const parentPosts: unknown[] = [];
    const els = Object.entries(fields).map(([name, spec]) => ({
      ...spec,
      __bridgeField: name,
      getAttribute: (attr: string) => (attr === 'data-bridge-field' ? name : null),
      dispatchEvent: () => true,
    }));
    const doc = {
      querySelectorAll: (sel: string) => (sel.includes('data-bridge-field') ? els : []),
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: (ev: unknown) => { customEvents.push(ev); return true; },
      createElement: () => { throw new Error('not needed in these tests'); },
    };
    const customEvents: unknown[] = [];
    const win = {
      parent: { postMessage: (m: unknown) => parentPosts.push(m) },
      location: { origin: ORIGIN },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => 0,
    };
    const client = createSurfaceBridgeClient({ app: APP, win, doc });
    return { client, parentPosts, els, customEvents };
  }

  it('emit() posts a channel+version+app envelope the relay/normalizer accepts', () => {
    const { client, parentPosts } = makeClient();
    client.emitEvent('deck-generated', { deckId: 'd1' });
    expect(parentPosts).toHaveLength(1);
    const normalized = normalizeSurfaceEvent(parentPosts[0]);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.direction).toBe('to_bot');
      expect(normalized.event).toMatchObject({ app: APP, op: 'event', name: 'deck-generated' });
    }
  });

  it('applies set_field to the marked control and ignores app-mismatched / non-bridge messages', () => {
    const { client, els } = makeClient({ title: { tagName: 'INPUT', type: 'text', value: '' } });
    const deliver = (data: unknown) => client.handleMessage({ data, origin: ORIGIN } as MessageEvent);
    expect(deliver({ ...base, op: 'set_field', field: 'title', value: 'Q3 Update' })).toMatchObject({ handled: true });
    expect(els[0].value).toBe('Q3 Update');
    expect(deliver({ ...base, app: 'other', op: 'set_field', field: 'title', value: 'nope' }))
      .toMatchObject({ handled: false, reason: 'app_mismatch' });
    expect(deliver({ hello: 'world' })).toMatchObject({ handled: false, reason: 'not_bridge' });
    expect(els[0].value).toBe('Q3 Update');
  });

  it('re-dispatches a delivered custom op as a DOM event for app-specific vocabulary', () => {
    const { client, customEvents } = makeClient();
    const out = client.handleMessage({
      data: { ...base, op: 'custom', name: 'add_slide', data: { title: 'Risks' } },
      origin: ORIGIN,
    } as MessageEvent);
    expect(out).toMatchObject({ handled: true });
    expect(customEvents).toHaveLength(1);
    expect((customEvents[0] as { detail: { name: string } }).detail.name).toBe('add_slide');
  });
});
