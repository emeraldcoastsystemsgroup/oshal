/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the DevopsTraceHub's load-bearing security property: OWNER-SCOPED delivery. A frame reaches only sinks under its own actor (never another sub, never an "all" fan-out), unsubscribe stops delivery, a throwing sink can't take down its peers, and an actorless frame goes nowhere. This is the deliberate answer to the old cross-bot SSE fan-out.
 */

import { describe, expect, it } from 'vitest';
import { DevopsTraceHub, type TraceFrame } from '../../src/features/devops-vault';

const frame = (actor: string, action = 'vault.kv.write'): TraceFrame => ({ ts: 1, actor, action, level: 'ok' });

describe('DevopsTraceHub — owner-scoped delivery', () => {
  it('delivers a frame ONLY to sinks registered under its actor', () => {
    const hub = new DevopsTraceHub();
    const alice: TraceFrame[] = [];
    const bob: TraceFrame[] = [];
    hub.subscribe('sub-alice', (f) => alice.push(f));
    hub.subscribe('sub-bob', (f) => bob.push(f));

    hub.publish(frame('sub-alice'));
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(0); // <-- the fan-out bug would put alice's frame here

    hub.publish(frame('sub-bob'));
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
  });

  it('there is no "all" channel — an unknown actor reaches nobody', () => {
    const hub = new DevopsTraceHub();
    const seen: TraceFrame[] = [];
    hub.subscribe('sub-alice', (f) => seen.push(f));
    hub.publish(frame('sub-nobody'));
    expect(seen).toHaveLength(0);
  });

  it('an actorless frame is dropped, never broadcast', () => {
    const hub = new DevopsTraceHub();
    const seen: TraceFrame[] = [];
    hub.subscribe('sub-alice', (f) => seen.push(f));
    hub.publish(frame(''));
    expect(seen).toHaveLength(0);
  });

  it('two sinks for the same actor both receive; unsubscribe stops only that sink', () => {
    const hub = new DevopsTraceHub();
    const a: TraceFrame[] = [];
    const b: TraceFrame[] = [];
    hub.subscribe('sub-alice', (f) => a.push(f));
    const stopB = hub.subscribe('sub-alice', (f) => b.push(f));
    hub.publish(frame('sub-alice'));
    expect([a.length, b.length]).toEqual([1, 1]);
    stopB();
    hub.publish(frame('sub-alice'));
    expect([a.length, b.length]).toEqual([2, 1]);
    expect(hub.subscriberCount('sub-alice')).toBe(1);
  });

  it('a throwing sink does not stop delivery to its peers', () => {
    const hub = new DevopsTraceHub();
    const ok: TraceFrame[] = [];
    hub.subscribe('sub-alice', () => { throw new Error('client gone'); });
    hub.subscribe('sub-alice', (f) => ok.push(f));
    expect(() => hub.publish(frame('sub-alice'))).not.toThrow();
    expect(ok).toHaveLength(1);
  });

  it('unsubscribe is idempotent and clears the actor when the last sink leaves', () => {
    const hub = new DevopsTraceHub();
    const stop = hub.subscribe('sub-alice', () => {});
    stop(); stop();
    expect(hub.subscriberCount('sub-alice')).toBe(0);
  });
});
