/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the surface-bridge PARSE LAYER + chat-rail producer: extractSurfaceDirectives parses a reply's oshal:surface fence into VALIDATED bot→surface ops (a declared op survives; an unknown/inbound/malformed op is dropped fail-closed) and strips the fence from the answer; stripSurfaceDirective removes the fence; the producer's parse/strip helpers agree with the server, its literals cannot drift from the TS contract, relayReply is a no-op emit with no focused app and posts a normalizer-valid envelope with one, and consumeInbound turns a relayed selection into a chat message.
 */

import { describe, expect, it } from 'vitest';
import {
  extractSurfaceDirectives,
  stripSurfaceDirective,
} from '../../src/app/routes/jarvis-directives';
import {
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  normalizeSurfaceEvent,
} from '../../src/features/surface-bridge';
import { SURFACE_BRIDGE_OUTBOUND_OPS } from '../../src/shared/surface-bridge-ops';
import { apiOrigin } from '../helpers';
// The browser producer under test — plain ESM, imported directly (vitest transforms it; tsc
// excludes tests/, so the untyped .js import is vitest-only), mirroring surface-bridge-relay.spec.ts.
import {
  createSurfaceProducer,
  parseSurfaceOps,
  stripSurfaceFence,
  SURFACE_PRODUCER_OUTBOUND_OPS,
  SURFACE_BRIDGE_CHANNEL as PRODUCER_CHANNEL,
  SURFACE_BRIDGE_VERSION as PRODUCER_VERSION,
  // @ts-expect-error — browser ESM without type declarations
} from '../../src/shared/ui/js/surface-bridge-producer.js';

const ORIGIN = apiOrigin();
const FENCE_OPEN = '```oshal:surface';
const FENCE_CLOSE = '```';

/** Wrap a JSON body in an `oshal:surface` fence with surrounding prose (what a bot reply looks like). */
function reply(body: string, prose = 'Here are a couple of options:'): string {
  return `${prose}\n\n${FENCE_OPEN}\n${body}\n${FENCE_CLOSE}\n\nLet me know.`;
}

describe('extractSurfaceDirectives — parse + fail-closed validation', () => {
  it('parses + validates a declared render_options op and strips the fence from the answer', () => {
    const r = extractSurfaceDirectives(
      reply('{"ops":[{"op":"render_options","prompt":"Pick a start","options":[{"id":"onboard","label":"Onboarding"},{"id":"rca","label":"Incident RCA"}]}]}'),
    );
    expect(r.hadSurfaceFence).toBe(true);
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({ op: 'render_options', prompt: 'Pick a start' });
    expect((r.ops[0] as { options: Array<{ id: string }> }).options[0].id).toBe('onboard');
    // The op is the DECLARED shape only — the base channel/v/app is stamped downstream, not here.
    expect(r.ops[0]).not.toHaveProperty('channel');
    expect(r.ops[0]).not.toHaveProperty('app');
    // The user-visible answer keeps the prose but never the control syntax.
    expect(r.cleanAnswer).toContain('Here are a couple of options:');
    expect(r.cleanAnswer).toContain('Let me know.');
    expect(r.cleanAnswer).not.toContain('oshal:surface');
    expect(r.cleanAnswer).not.toContain('render_options');
  });

  it('parses multiple declared ops in one fence', () => {
    const r = extractSurfaceDirectives(
      reply('{"ops":[{"op":"set_content","region":"assistant-note","content":"Draft ready."},{"op":"notify","level":"success","text":"Saved"}]}'),
    );
    expect(r.ops.map((o) => o.op)).toEqual(['set_content', 'notify']);
  });

  it('REJECTS an unknown op (fail-closed) but still strips the fence', () => {
    const r = extractSurfaceDirectives(reply('{"ops":[{"op":"delete_everything","target":"all"}]}'));
    expect(r.hadSurfaceFence).toBe(true);
    expect(r.ops).toHaveLength(0);
    expect(r.cleanAnswer).not.toContain('oshal:surface');
    expect(r.cleanAnswer).not.toContain('delete_everything');
  });

  it('REJECTS an INBOUND op declared as a directive (only bot→surface ops drive a surface)', () => {
    const r = extractSurfaceDirectives(reply('{"ops":[{"op":"select","optionId":"onboard"}]}'));
    expect(r.ops).toHaveLength(0);
  });

  it('REJECTS a malformed known-op payload (render_options needs a non-empty options array)', () => {
    const r = extractSurfaceDirectives(reply('{"ops":[{"op":"render_options","options":[]}]}'));
    expect(r.ops).toHaveLength(0);
  });

  it('IGNORES a malformed fence body (invalid JSON) — no ops, fence still stripped', () => {
    const r = extractSurfaceDirectives(reply('not json at all {'));
    expect(r.hadSurfaceFence).toBe(true);
    expect(r.ops).toHaveLength(0);
    expect(r.cleanAnswer).not.toContain('oshal:surface');
    expect(r.cleanAnswer).not.toContain('not json at all');
  });

  it('strips an UNTERMINATED fence too (a truncated stream never leaks control syntax)', () => {
    const truncated = `Working on it.\n\n${FENCE_OPEN}\n{"ops":[{"op":"notify","level":"info","text":"hi"`;
    const r = extractSurfaceDirectives(truncated);
    expect(r.hadSurfaceFence).toBe(true);
    expect(r.ops).toHaveLength(0);
    expect(r.cleanAnswer).toBe('Working on it.');
  });

  it('a reply with no fence yields no ops and no hadSurfaceFence flag', () => {
    const r = extractSurfaceDirectives('Just a normal answer, nothing to render.');
    expect(r.ops).toHaveLength(0);
    expect(r.hadSurfaceFence).toBeUndefined();
    expect(r.cleanAnswer).toBe('Just a normal answer, nothing to render.');
  });

  it('stripSurfaceDirective removes the fence and leaves the prose', () => {
    const text = reply('{"ops":[{"op":"notify","level":"info","text":"hi"}]}');
    const stripped = stripSurfaceDirective(text);
    expect(stripped).not.toContain(FENCE_OPEN);
    expect(stripped).not.toContain('notify');
    expect(stripped).toContain('Here are a couple of options:');
  });
});

describe('surface-bridge producer — parse/strip parity + drift guards', () => {
  it("the producer's literals equal the TS contract's constants (cannot drift)", () => {
    expect(PRODUCER_CHANNEL).toBe(SURFACE_BRIDGE_CHANNEL);
    expect(PRODUCER_VERSION).toBe(SURFACE_BRIDGE_VERSION);
    expect([...SURFACE_PRODUCER_OUTBOUND_OPS]).toEqual([...SURFACE_BRIDGE_OUTBOUND_OPS]);
  });

  it('parseSurfaceOps extracts declared outbound ops and drops unknown ones (name-level, like the client)', () => {
    const ops = parseSurfaceOps(reply('{"ops":[{"op":"render_options","options":[{"id":"a","label":"A"}]},{"op":"delete_everything"}]}'));
    expect(ops.map((o: { op: string }) => o.op)).toEqual(['render_options']);
  });

  it('stripSurfaceFence matches the server strip (one fence format, two consumers)', () => {
    const text = reply('{"ops":[{"op":"notify","level":"info","text":"hi"}]}');
    expect(stripSurfaceFence(text)).toBe(stripSurfaceDirective(text));
  });
});

describe('surface-bridge producer — emit + inbound loop-back', () => {
  /** A fake chat-rail window embedded under a shell whose `?app=` is the focused app. */
  function embedded(app: string) {
    const posts: unknown[] = [];
    const shell = { location: { search: `?app=${app}` }, postMessage: (m: unknown) => posts.push(m) };
    const win = { parent: shell, location: { origin: ORIGIN, search: '' } };
    return { producer: createSurfaceProducer({ win }), posts };
  }

  it('relayReply with NO focused app is a no-op emit but returns the fence-stripped text', () => {
    const posts: unknown[] = [];
    const win: { parent?: unknown; location: { origin: string; search: string }; postMessage: (m: unknown) => void } = {
      location: { origin: ORIGIN, search: '' },
      postMessage: (m: unknown) => posts.push(m),
    };
    win.parent = win; // standalone (popped-out) rail — no app-bearing parent
    const producer = createSurfaceProducer({ win });
    const shown = producer.relayReply(reply('{"ops":[{"op":"notify","level":"info","text":"hi"}]}'));
    expect(posts).toHaveLength(0);
    expect(shown).not.toContain('oshal:surface');
    expect(shown).toContain('Here are a couple of options:');
  });

  it('relayReply posts a normalizer-valid to_surface envelope for the focused app and returns stripped text', () => {
    const { producer, posts } = embedded('workflow-studio');
    const shown = producer.relayReply(reply('{"ops":[{"op":"render_options","prompt":"Pick","options":[{"id":"a","label":"A"}]}]}'));
    expect(posts).toHaveLength(1);
    const normalized = normalizeSurfaceEvent(posts[0]);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.direction).toBe('to_surface');
      expect(normalized.event).toMatchObject({ app: 'workflow-studio', op: 'render_options' });
    }
    expect(shown).not.toContain('oshal:surface');
  });

  it('consumeInbound turns a relayed select for the focused app into a chat message, and ignores others', () => {
    const { producer } = embedded('workflow-studio');
    const msg = producer.consumeInbound({ channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'workflow-studio', op: 'select', optionId: 'rca' });
    expect(msg).toBe('I selected "rca".');
    // Wrong app, wrong channel, and non-bridge payloads are all ignored.
    expect(producer.consumeInbound({ channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'other-app', op: 'select', optionId: 'x' })).toBeNull();
    expect(producer.consumeInbound({ type: 'oshal-cockpit-theme', theme: 'ocean' })).toBeNull();
    expect(producer.consumeInbound(null)).toBeNull();
  });
});
