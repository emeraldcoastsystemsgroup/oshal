/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Surface-bridge contract: proves the manifest-keyed event union validates + cleans untrusted window messages (fail-closed on wrong channel/version/unknown-op/malformed), STRIPS HTML from every text field (no markup crosses the bridge), classifies direction, and enforces app/op isolation in resolveRelayTarget.
 */

import { describe, expect, it } from 'vitest';
import {
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  normalizeSurfaceEvent,
  resolveRelayTarget,
  stripHtml,
  isOutboundOp,
  isInboundOp,
} from '../../src/features/surface-bridge';

const base = { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'presentations' };

describe('surface-bridge normalize — fail-closed validation', () => {
  it('rejects non-objects, wrong channel, and version mismatch', () => {
    expect(normalizeSurfaceEvent(null)).toMatchObject({ ok: false, reason: 'not_an_object' });
    expect(normalizeSurfaceEvent({ op: 'notify' })).toMatchObject({ ok: false, reason: 'wrong_channel' });
    expect(normalizeSurfaceEvent({ channel: SURFACE_BRIDGE_CHANNEL, v: 999, op: 'notify' }))
      .toMatchObject({ ok: false, reason: 'version_mismatch' });
  });

  it('rejects unknown ops (fail-closed)', () => {
    expect(normalizeSurfaceEvent({ ...base, op: 'delete_everything' }))
      .toMatchObject({ ok: false, reason: 'unknown_op:delete_everything' });
  });

  it('rejects a malformed known-op payload', () => {
    // render_options requires a non-empty options array
    expect(normalizeSurfaceEvent({ ...base, op: 'render_options', options: [] }))
      .toMatchObject({ ok: false });
  });
});

describe('surface-bridge normalize — HTML stripping (no markup crosses the bridge)', () => {
  it('strips tags from text fields but keeps the text', () => {
    const r = normalizeSurfaceEvent({ ...base, op: 'notify', level: 'info', text: 'saved <img src=x onerror=alert(1)> ok' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.op).toBe('notify');
      expect((r.event as { text: string }).text).toBe('saved  ok');
      expect(JSON.stringify(r.event)).not.toContain('<');
      expect(JSON.stringify(r.event)).not.toContain('onerror');
    }
  });

  it('strips nested strings (option labels/descriptions)', () => {
    const r = normalizeSurfaceEvent({
      ...base, op: 'render_options',
      options: [{ id: 'a', label: '<b>Bold</b> pick', description: 'plain <script>x</script>' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.event.op === 'render_options') {
      expect(r.event.options[0].label).toBe('Bold pick');
      // tags removed; the inner text ('x') survives as harmless plain text (rendered, never executed)
      expect(r.event.options[0].description).toBe('plain x');
      expect(JSON.stringify(r.event)).not.toContain('<');
    }
  });

  it('rejects a field that was ONLY markup (empty after strip fails .min(1))', () => {
    expect(normalizeSurfaceEvent({ ...base, op: 'set_content', region: 'title', content: 'ok' }))
      .toMatchObject({ ok: true }); // content has no .min(1) — empty allowed
    expect(normalizeSurfaceEvent({ ...base, op: 'notify', level: 'info', text: '<span></span>' }))
      .toMatchObject({ ok: false }); // notify.text is .min(1) → markup-only becomes empty → rejected
  });
});

describe('surface-bridge normalize — direction classification', () => {
  it('classifies outbound (bot→surface) ops', () => {
    const r = normalizeSurfaceEvent({ ...base, op: 'set_field', field: 'title', value: 'Q3 deck' });
    expect(r).toMatchObject({ ok: true, direction: 'to_surface' });
  });
  it('classifies inbound (surface→bot) ops', () => {
    const r = normalizeSurfaceEvent({ ...base, op: 'select', optionId: 'opt-2' });
    expect(r).toMatchObject({ ok: true, direction: 'to_bot' });
  });
  it('op type guards agree with the schema', () => {
    expect(isOutboundOp('propose')).toBe(true);
    expect(isInboundOp('submit')).toBe(true);
    expect(isOutboundOp('submit')).toBe(false);
  });
});

describe('surface-bridge resolveRelayTarget — app/op isolation', () => {
  const ev = { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app: 'presentations', op: 'set_field', field: 'title', value: 'x' };

  it('delivers an event whose app matches the trusted binding', () => {
    const r = normalizeSurfaceEvent(ev);
    expect(r.ok).toBe(true);
    if (r.ok) expect(resolveRelayTarget(r.event, { app: 'presentations' })).toMatchObject({ deliver: true, direction: 'to_surface' });
  });

  it('DROPS an event that claims to be from another app (no spoofing another surface)', () => {
    const r = normalizeSurfaceEvent(ev);
    if (r.ok) expect(resolveRelayTarget(r.event, { app: 'eats' })).toMatchObject({ deliver: false, reason: expect.stringContaining('app_mismatch') });
  });

  it('DROPS an op the app did not declare in its manifest allow-list', () => {
    const r = normalizeSurfaceEvent(ev);
    if (r.ok) {
      expect(resolveRelayTarget(r.event, { app: 'presentations', allowedOps: ['set_content'] }))
        .toMatchObject({ deliver: false, reason: 'op_not_allowed:set_field' });
      expect(resolveRelayTarget(r.event, { app: 'presentations', allowedOps: ['set_field', 'set_content'] }))
        .toMatchObject({ deliver: true });
    }
  });
});

describe('surface-bridge — superset of the existing presentations {op} shape + Little Monsters events', () => {
  it('carries the presentations set_content (generalizes set_title/set_outline) and propose→submit', () => {
    expect(normalizeSurfaceEvent({ ...base, op: 'set_content', region: 'outline', content: '# Slide 1' })).toMatchObject({ ok: true });
    expect(normalizeSurfaceEvent({ ...base, op: 'propose', actionId: 'publish', summary: 'Publish to LinkedIn' })).toMatchObject({ ok: true });
    expect(normalizeSurfaceEvent({ ...base, op: 'submit', actionId: 'publish', confirmed: true })).toMatchObject({ ok: true });
  });
  it('carries navigate (lm-navigate) and event (lm-classes-changed) generically', () => {
    expect(normalizeSurfaceEvent({ ...base, app: 'little-monsters', op: 'navigate', to: 'classes' })).toMatchObject({ ok: true });
    expect(normalizeSurfaceEvent({ ...base, app: 'little-monsters', op: 'event', name: 'classes-changed', data: { count: 3 } })).toMatchObject({ ok: true });
  });

  it('stripHtml is exported and idempotent on clean text', () => {
    expect(stripHtml('clean text')).toBe('clean text');
    expect(stripHtml('<a href=#>link</a>')).toBe('link');
  });
});
