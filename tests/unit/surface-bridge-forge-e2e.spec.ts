/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Activation guard for the chat↔surface bridge on its second kernel adopter (the Forge / codex-packer): the manifest declares a surface.ops allow-list drawn only from the closed vocabulary, the REAL relay gate carries every declared op and refuses the ones the Forge cannot honor (set_field / navigate), one realistic packer reply is parsed identically by the server and the chat-rail client with the fence stripped from the bubble, forge.html actually marks up a host for every declared outbound op and binds the client to the MANIFEST name, and the shared client applies each declared op to a Forge-shaped DOM while an undeclared op is ignored (never thrown). Mirrors surface-bridge-workflow-studio-e2e.spec.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { extractSurfaceDirectives } from '../../src/app/routes/jarvis-directives';
import {
  OutboundEventSchema,
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  resolveRelayTarget,
} from '../../src/features/surface-bridge';
import { isSurfaceBridgeOp } from '../../src/shared/surface-bridge-ops';
// The browser client under test — plain ESM imported directly (vitest transforms it), the same way
// surface-bridge-relay.spec.ts drives it with a fake DOM in the node environment.
import { createSurfaceBridgeClient } from '../../src/shared/ui/js/surface-bridge-client.js';

const APP = 'codex-packer';
const ORIGIN = 'https://oshal.test';
const F = '```';

/** A realistic packer turn: the prose answer plus the optional oshal:surface fence for the dock. */
const REPLY = [
  'Q2 — what does the operator hand the bot to start a task?',
  '',
  `${F}oshal:surface`,
  JSON.stringify({
    ops: [
      { op: 'notify', level: 'success', text: 'Q1 captured: audit an expense report.' },
      { op: 'set_content', region: 'packer-note', content: '1. Task: audit an expense report' },
      { op: 'render_options', prompt: 'What starts a task?', options: [
        { id: 'ticket', label: 'A ticket title + description' },
        { id: 'file', label: 'A file path in the workspace' },
        { id: 'none', label: 'Nothing — it polls a service' },
      ] },
    ],
  }),
  F,
].join('\n');

/** The manifest surface.ops allow-list the cockpit relay enforces for the Forge. */
function forgeAllowList(): string[] {
  const manifest = loadYaml(
    readFileSync(resolve(process.cwd(), 'swarm-apps/codex-packer.yaml'), 'utf8'),
  ) as { surface?: { ops?: string[] } };
  return manifest.surface?.ops ?? [];
}

function forgeHtml(): string {
  return readFileSync(resolve(process.cwd(), 'src/api/forge.html'), 'utf8');
}

describe('chat↔surface bridge — Forge (codex-packer) manifest declaration', () => {
  it('declares a non-empty allow-list drawn ONLY from the closed op vocabulary', () => {
    const ops = forgeAllowList();
    // Fail-closed means an absent block relays nothing at all — the wire IS this declaration.
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(isSurfaceBridgeOp(op)).toBe(true);
    // The loop needs both halves: the ops the packer drives and the ops the click sends back.
    expect(ops).toEqual(expect.arrayContaining(['render_options', 'propose', 'notify', 'set_content', 'custom', 'select', 'submit', 'event']));
  });

  it('does NOT declare ops the Forge cannot honor (no bot-drivable field; no shell navigation)', () => {
    const ops = forgeAllowList();
    // The Forge's only input is <input type=file>, which cannot be set programmatically — declaring
    // set_field/field_change would be an affordance that silently does nothing.
    expect(ops).not.toContain('set_field');
    expect(ops).not.toContain('field_change');
    expect(ops).not.toContain('navigate');
  });

  it('the REAL relay gate carries every declared op and refuses an undeclared one', () => {
    const allowedOps = forgeAllowList();
    const carried = resolveRelayTarget(
      { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP, op: 'set_content', region: 'packer-note', content: 'x' } as never,
      { app: APP, allowedOps },
    );
    expect(carried).toMatchObject({ deliver: true });

    const refused = resolveRelayTarget(
      { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP, op: 'set_field', field: 'anything', value: 'x' } as never,
      { app: APP, allowedOps },
    );
    expect(refused).toMatchObject({ deliver: false, reason: 'op_not_allowed:set_field' });
  });
});

describe('chat↔surface bridge — Forge fence handling', () => {
  it('every op in a realistic packer reply is on the allow-list and passes the contract schema', () => {
    const allow = new Set(forgeAllowList());
    const extracted = extractSurfaceDirectives(REPLY);
    expect(extracted.hadSurfaceFence).toBe(true);
    expect(extracted.ops.map((o) => o.op)).toEqual(['notify', 'set_content', 'render_options']);
    for (const op of extracted.ops) {
      expect(allow.has(op.op)).toBe(true);
      const stamped = { ...op, channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP };
      expect(OutboundEventSchema.safeParse(stamped).success).toBe(true);
    }
  });

  it('the control fence is stripped from the bubble while the interview question survives', () => {
    const extracted = extractSurfaceDirectives(REPLY);
    expect(extracted.cleanAnswer).not.toContain('oshal:surface');
    expect(extracted.cleanAnswer).not.toContain('"render_options"');
    expect(extracted.cleanAnswer).toContain('Q2 — what does the operator hand the bot');
  });

  it('the packer persona declares the hook with the exact op shapes it is trusted to emit', () => {
    const persona = readFileSync(resolve(process.cwd(), 'ai-lab/bot-personas/codex-packer.yaml'), 'utf8');
    expect(persona).toContain('oshal:surface');
    for (const op of ['notify', 'set_content', 'render_options', 'propose', 'custom']) {
      expect(persona).toContain(`"op":"${op}"`);
    }
    // The dock is additive: the chat answer must stand on its own, and inject stays the operator's.
    expect(persona).toContain('Your chat answer must stand on its own');
    expect(persona).toContain('one-click inject stays the operator');
  });
});

describe('chat↔surface bridge — the Forge surface is actually wired', () => {
  it('forge.html includes the shared client, binds the MANIFEST name, and hosts every declared outbound op', () => {
    const html = forgeHtml();
    expect(html).toContain("import { createSurfaceBridgeClient } from '/shared/ui/js/surface-bridge-client.js'");
    // The relay compares the envelope's app to the focused app's profile name — 'forge' is the tool
    // name and would be dropped as app_mismatch.
    expect(html).toContain("createSurfaceBridgeClient({ app: 'codex-packer' })");
    // Markup contract: a host/region must exist for each declared outbound op, or the client returns
    // no_options_host / no_such_region and the op silently does nothing.
    expect(html).toContain('data-bridge-region="packer-note"');   // set_content
    expect(html).toContain('data-bridge-host="options"');          // render_options + propose
    expect(html).toContain('data-bridge-host="notices"');          // notify
    expect(html).toContain("surface-bridge:custom");               // custom
    expect(html).toContain('window.forgeRefresh');                 // the one custom name honored
    expect(html).toContain("emitEvent('app-injected'");            // the inbound `event` half
  });
});

/** Minimal Forge-shaped fake DOM (node env — no jsdom, mirroring surface-bridge-relay.spec.ts). */
function makeForgeDom() {
  const parentPosts: unknown[] = [];
  const customEvents: unknown[] = [];

  function makeEl(tagName: string, attrs: Record<string, string> = {}) {
    const listeners: Record<string, (e?: unknown) => void> = {};
    const node = {
      tagName,
      attrs,
      textContent: '',
      className: '',
      type: '',
      children: [] as Array<ReturnType<typeof makeEl>>,
      getAttribute: (attr: string) => (attr in attrs ? attrs[attr] : null),
      appendChild(child: ReturnType<typeof makeEl>) { node.children.push(child); return child; },
      addEventListener(type: string, fn: (e?: unknown) => void) { listeners[type] = fn; },
      dispatchEvent: () => true,
      remove() {},
      click() { listeners.click?.(); },
    };
    return node;
  }

  const marked = [
    makeEl('DIV', { 'data-bridge-region': 'packer-note' }),
    makeEl('DIV', { 'data-bridge-host': 'options' }),
    makeEl('DIV', { 'data-bridge-host': 'notices' }),
  ];
  const doc = {
    body: makeEl('BODY'),
    querySelectorAll: (sel: string) => {
      const attr = sel.replace('[', '').replace(']', '');
      return marked.filter((el) => el.getAttribute(attr) !== null);
    },
    createElement: (tag: string) => makeEl(tag.toUpperCase()),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (ev: unknown) => { customEvents.push(ev); return true; },
  };
  const win = {
    parent: { postMessage: (m: unknown) => parentPosts.push(m) },
    location: { origin: ORIGIN },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
  };
  const client = createSurfaceBridgeClient({ app: APP, win, doc });
  const region = marked[0];
  const options = marked[1];
  const notices = marked[2];
  return { client, parentPosts, customEvents, region, options, notices };
}

describe('chat↔surface bridge — the shared client applies the Forge ops', () => {
  const base = { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP };

  it('set_content lands in the packer-note region and notify lands in the notices host', () => {
    const dom = makeForgeDom();
    const deliver = (data: unknown) => dom.client.handleMessage({ data, origin: ORIGIN } as MessageEvent);

    expect(deliver({ ...base, op: 'set_content', region: 'packer-note', content: '1. Task: audit' })).toMatchObject({ handled: true });
    expect(dom.region.textContent).toBe('1. Task: audit');

    expect(deliver({ ...base, op: 'notify', level: 'success', text: 'Q1 captured.' })).toMatchObject({ handled: true });
    expect(dom.notices.children.map((c) => c.textContent)).toEqual(['Q1 captured.']);
  });

  it('render_options draws clickable cards and a click emits `select` back to the packer', () => {
    const dom = makeForgeDom();
    dom.client.handleMessage({
      data: { ...base, op: 'render_options', prompt: 'What starts a task?', options: [
        { id: 'ticket', label: 'A ticket title + description' },
        { id: 'file', label: 'A file path' },
      ] },
      origin: ORIGIN,
    } as MessageEvent);

    // prompt + 2 option buttons
    expect(dom.options.children).toHaveLength(3);
    dom.options.children[1].click();
    expect(dom.parentPosts).toEqual([
      { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP, op: 'select', optionId: 'ticket', from: 'render_options' },
    ]);
  });

  it('a custom op is re-dispatched as the DOM event the Forge listens for', () => {
    const dom = makeForgeDom();
    const out = dom.client.handleMessage({ data: { ...base, op: 'custom', name: 'refresh', data: {} }, origin: ORIGIN } as MessageEvent);
    expect(out).toMatchObject({ handled: true });
    expect(dom.customEvents).toHaveLength(1);
    expect((dom.customEvents[0] as { detail: { name: string } }).detail.name).toBe('refresh');
  });

  it('an op the Forge does not host is IGNORED with a reason — never thrown, nothing mutated', () => {
    const dom = makeForgeDom();
    const deliver = (data: unknown) => dom.client.handleMessage({ data, origin: ORIGIN } as MessageEvent);

    // Not in the surface's vocabulary at all (the relay would refuse it first; belt and braces).
    expect(deliver({ ...base, op: 'not_a_real_op' })).toMatchObject({ handled: false, reason: 'unhandled_op:not_a_real_op' });
    // Declared-shape op pointed at a region this surface does not mark.
    expect(deliver({ ...base, op: 'set_content', region: 'nope', content: 'x' })).toMatchObject({ handled: false, reason: 'no_such_region' });
    // A foreign app's envelope never touches this surface.
    expect(deliver({ ...base, app: 'workflow-studio', op: 'set_content', region: 'packer-note', content: 'x' }))
      .toMatchObject({ handled: false, reason: 'app_mismatch' });

    expect(dom.region.textContent).toBe('');
    expect(dom.parentPosts).toHaveLength(0);
  });
});
