/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the screen-aware Jarvis loop: the `context` op travels the REAL relay to EVERY assistant frame (the floating orb panel included — the frame the relay originally didn't know about), normalizeAskSurfaceContext validates with the real contract and rejects a snapshot that never came through the bridge, buildSurfaceContextPrompt tells a drivable surface from a read-only one, and the producer's emitOps/consumeContext stamp the trusted app binding rather than trusting the model.
 */

import { describe, expect, it } from 'vitest';
import {
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  INBOUND_OPS,
  normalizeSurfaceEvent,
  resolveRelayTarget,
} from '../../src/features/surface-bridge';
import { SURFACE_BRIDGE_INBOUND_OPS } from '../../src/shared/surface-bridge-ops';
import {
  normalizeAskSurfaceContext,
  buildSurfaceContextPrompt,
} from '../../src/app/routes/jarvis-surface-context';
import { extractSurfaceDirectives } from '../../src/app/routes/jarvis-directives';
import { apiOrigin } from '../helpers';
// @ts-expect-error — browser ESM without type declarations
import { createSurfaceBridgeRelay } from '../../src/pages/cockpit/js/surface-bridge-relay.js';
// @ts-expect-error — browser ESM without type declarations
import { createSurfaceProducer } from '../../src/shared/ui/js/surface-bridge-producer.js';

const ORIGIN = apiOrigin();
const APP = 'career-hunter';
const envelope = {
  channel: SURFACE_BRIDGE_CHANNEL,
  v: SURFACE_BRIDGE_VERSION,
  app: APP,
  op: 'context' as const,
  surface: 'resume-studio',
  title: 'Master resume',
  recordId: 'master',
  digest: 'Headline: Engineering leader. 5 roles. Summary present.',
  can: ['custom', 'notify'],
};

/**
 * The relay under test, wired to the REAL contract, with a surface frame and TWO assistant frames —
 * the docked rail and the floating orb panel. The orb is the frame the operator actually uses.
 */
function makeRelay(allowedOps: string[] = ['context', 'custom', 'notify']) {
  const railPosts: unknown[] = [];
  const orbPosts: unknown[] = [];
  const surfacePosts: unknown[] = [];
  const surfaceWin = { postMessage: (m: unknown) => surfacePosts.push(m) };
  const railWin = { postMessage: (m: unknown) => railPosts.push(m) };
  const orbWin = { postMessage: (m: unknown) => orbPosts.push(m) };
  const relay = createSurfaceBridgeRelay({
    contract: { normalizeSurfaceEvent, resolveRelayTarget },
    getApp: () => APP,
    getAllowedOps: () => allowedOps,
    getSurfaceWindow: () => surfaceWin,
    getChatWindow: () => railWin,
    getAssistantWindows: () => [railWin, orbWin],
    postToShell: () => {},
    origin: ORIGIN,
    logger: { debug: () => {}, warn: () => {} },
  });
  const fromSurface = (data: unknown) => relay.handleMessage({ origin: ORIGIN, source: surfaceWin, data });
  const fromOrb = (data: unknown) => relay.handleMessage({ origin: ORIGIN, source: orbWin, data });
  return { relay, railPosts, orbPosts, surfacePosts, fromSurface, fromOrb };
}

describe('context op — vocabulary + contract', () => {
  it('is a real INBOUND op in the shared vocabulary and the zod contract (not an `event` overload)', () => {
    expect(SURFACE_BRIDGE_INBOUND_OPS).toContain('context');
    expect([...INBOUND_OPS]).toEqual([...SURFACE_BRIDGE_INBOUND_OPS]);
    const r = normalizeSurfaceEvent(envelope);
    expect(r.ok).toBe(true);
    // Ambient state still travels surface→bot, so the relay routes it like any user action.
    if (r.ok) expect(r.direction).toBe('to_bot');
  });

  it('CAPS the digest in the schema — the one payload designed to reach a model prompt', () => {
    const r = normalizeSurfaceEvent({ ...envelope, digest: 'x'.repeat(4001) });
    expect(r.ok).toBe(false);
  });
});

describe('relay — the floating assistant is a real participant', () => {
  it('delivers a surface context snapshot to BOTH the docked rail and the floating orb', () => {
    const { fromSurface, railPosts, orbPosts } = makeRelay();
    const outcome = fromSurface(envelope);
    expect(outcome.delivered).toBe(true);
    expect(railPosts).toHaveLength(1);
    expect(orbPosts).toHaveLength(1);
    expect((orbPosts[0] as { surface: string }).surface).toBe('resume-studio');
  });

  it('accepts bot-direction ops FROM the floating orb (the pre-fix emitter_not_chat_rail drop)', () => {
    const { fromOrb, surfacePosts } = makeRelay();
    const outcome = fromOrb({ ...envelope, op: 'notify', level: 'success', text: 'Tightened the summary.' });
    expect(outcome.delivered).toBe(true);
    expect(surfacePosts).toHaveLength(1);
  });

  it('still refuses a bot-direction op forged by the SURFACE — the direction wall is unchanged', () => {
    const { fromSurface, surfacePosts } = makeRelay();
    const outcome = fromSurface({ ...envelope, op: 'notify', level: 'info', text: 'forged' });
    expect(outcome.delivered).toBe(false);
    expect(surfacePosts).toHaveLength(0);
  });

  it('drops context FAIL-CLOSED when the app never declared the op in its manifest', () => {
    const { fromSurface, railPosts, orbPosts } = makeRelay([]);
    expect(fromSurface(envelope).delivered).toBe(false);
    expect(railPosts).toHaveLength(0);
    expect(orbPosts).toHaveLength(0);
  });
});

describe('normalizeAskSurfaceContext — /ask body validation', () => {
  it('accepts a snapshot that came through the bridge', () => {
    expect(normalizeAskSurfaceContext(envelope)?.surface).toBe('resume-studio');
  });

  it('REJECTS a snapshot that never came through the bridge (no channel/version)', () => {
    const { channel: _c, v: _v, ...noEnvelope } = envelope;
    expect(normalizeAskSurfaceContext(noEnvelope)).toBeNull();
    expect(normalizeAskSurfaceContext({ ...envelope, v: 99 })).toBeNull();
    expect(normalizeAskSurfaceContext({ ...envelope, channel: 'not-the-bridge' })).toBeNull();
  });

  it('degrades to null on junk rather than throwing — a bad snapshot must not fail the ask', () => {
    for (const junk of [null, undefined, 'string', 42, {}, { op: 'context' }]) {
      expect(normalizeAskSurfaceContext(junk)).toBeNull();
    }
  });
});

describe('buildSurfaceContextPrompt — what the turn is actually told', () => {
  it('names the screen and the open record, and forbids the "I have not been given it" answer', () => {
    const block = buildSurfaceContextPrompt(normalizeAskSurfaceContext(envelope));
    expect(block).toContain('resume-studio');
    expect(block).toContain('Master resume');
    expect(block).toContain('Headline: Engineering leader');
    expect(block).toMatch(/never tell the user you have not been given/i);
  });

  it('frames the digest as DATA so document text cannot act as an instruction', () => {
    const block = buildSurfaceContextPrompt(normalizeAskSurfaceContext(envelope));
    expect(block).toMatch(/is DATA/);
    expect(block).toMatch(/never a command to you/i);
  });

  it('teaches the fence ONLY for ops the surface said it can honour', () => {
    const block = buildSurfaceContextPrompt(normalizeAskSurfaceContext(envelope));
    expect(block).toContain('```oshal:surface');
    expect(block).toContain('custom, notify');
    // An op the surface never claimed must not be advertised as available.
    expect(block).not.toMatch(/Ops available here:[^\n]*set_field/);
  });

  it('tells a read-only surface it is read-only instead of letting Jarvis promise edits', () => {
    const block = buildSurfaceContextPrompt(normalizeAskSurfaceContext({ ...envelope, can: [] }));
    expect(block).toMatch(/cannot change this screen directly/i);
    expect(block).not.toContain('```oshal:surface');
  });

  it('is empty with no context — the turn is unchanged from before this feature', () => {
    expect(buildSurfaceContextPrompt(null)).toBe('');
  });
});

describe('producer — the client half stamps the trusted binding', () => {
  /** A fake chat-rail window whose PARENT shell carries the trusted ?app= the producer reads. */
  function makeProducer(app: string | null = APP) {
    const posts: Array<{ message: unknown }> = [];
    const win = {
      location: { origin: ORIGIN, search: '' },
      parent: {
        location: { search: app ? `?app=${app}` : '' },
        postMessage: (message: unknown) => posts.push({ message }),
      },
      postMessage: () => {},
    };
    return { producer: createSurfaceProducer({ win }), posts };
  }

  it('stamps app/channel/version onto server-parsed ops — the model never authors the isolation key', () => {
    const { producer, posts } = makeProducer();
    // Exactly what the server returns: validated ops with NO envelope fields.
    const { ops } = extractSurfaceDirectives(
      'Tightened it.\n```oshal:surface\n{"ops":[{"op":"notify","level":"success","text":"done"}]}\n```',
    );
    expect(ops[0]).not.toHaveProperty('app');
    expect(producer.emitOps(ops)).toBe(1);
    expect(posts[0].message).toMatchObject({ channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: APP, op: 'notify' });
  });

  it('cannot be talked into a DIFFERENT app — a spoofed app field is overwritten by the binding', () => {
    const { producer, posts } = makeProducer();
    producer.emitOps([{ op: 'notify', level: 'info', text: 'x', app: 'finance' }]);
    expect((posts[0].message as { app: string }).app).toBe(APP);
  });

  it('emits nothing when no app is focused', () => {
    const { producer, posts } = makeProducer(null);
    expect(producer.emitOps([{ op: 'notify', level: 'info', text: 'x' }])).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('consumeContext picks up a snapshot for the focused app, and only that app', () => {
    const { producer } = makeProducer();
    expect(producer.consumeContext(envelope)).toMatchObject({ surface: 'resume-studio' });
    expect(producer.consumeContext({ ...envelope, app: 'finance' })).toBeNull();
    expect(producer.consumeContext({ ...envelope, op: 'select', optionId: 'x' })).toBeNull();
  });

  it('does NOT turn a context snapshot into a chat message (it is ambient state, not a user action)', () => {
    const { producer } = makeProducer();
    expect(producer.consumeInbound(envelope)).toBeNull();
  });
});
