/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic coverage for the
 *            | expanded AI Test Lab: every visual kind renders valid SVG, the registry covers the
 *            | full app roster, and the stale presentations path can never regress.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | AI Office carved to the app
 *            | store (ADR-085 Wave 2): 'presentations' left the smoke roster and the deck-path
 *            | arm flipped to assert core scenarios never target the packaged route.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Video Studio carved to the
 *            | app store (ADR-085 Wave 3): 'video' joined the intentionally-absent carved list.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Vids Studio carved to the
 *            | app store (ADR-085 Wave 3): 'vids' joined the intentionally-absent carved list.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | gov-contracting carved to the
 *            | app store (ADR-085 Wave 3): joined the intentionally-absent carved list.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | email-summarizer carved to the
 *            | app store (ADR-085 Wave 3): 'email' left the smoke roster and joined the
 *            | intentionally-absent carved list. The 'priority-email' VISUAL kind is untouched
 *            | on purpose — VISUAL_RESPONSE_KINDS is framework-level, not the app surface.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | kalshi carved to the app
 *            | store (ADR-085 Wave 3): 'kalshi' left the smoke roster and joined the
 *            | intentionally-absent carved list; the prediction-markets engine stays core.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | world carved to the app
 *            | store (ADR-085 Wave 3): 'world' left the smoke roster and joined the
 *            | intentionally-absent carved list; the world-data engine stays core.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | trading carved to the app
 *            | store (ADR-085 Wave 3): 'trading' left the smoke roster and joined the
 *            | intentionally-absent carved list; the engine + autopilot loops stay core,
 *            | guarded by the tests/unit/trading-*.spec.ts family.
 */

import { describe, expect, it } from 'vitest';
import { VISUAL_RESPONSE_KINDS } from '@/features/visual-response';
import { VISUAL_CATALOG, renderCatalogVisual, getCatalogEntry } from '@/app/routes/test-lab-visual-catalog';
import { SCENARIOS, renderVisualStep, rollup } from '@/app/routes/test-lab-scenarios';

describe('AI Test Lab — rich-visual catalog', () => {
  it('covers every declared visual kind exactly once', () => {
    const kinds = VISUAL_CATALOG.map((e) => e.kind).sort();
    expect(kinds).toEqual([...VISUAL_RESPONSE_KINDS].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it.each(VISUAL_CATALOG.map((e) => e.kind))('renders a valid SVG for kind "%s"', (kind) => {
    const rendered = renderCatalogVisual(kind)!;
    expect(rendered).toBeTruthy();
    expect(rendered.mimeType).toBe('image/svg+xml');
    expect(rendered.content.byteLength).toBeGreaterThan(200);
    expect(rendered.content.toString('utf8')).toContain('<svg');
    expect(rendered.alt.length).toBeGreaterThan(0);
    expect(rendered.alt.length).toBeLessThanOrEqual(420); // the UI's trusted-metadata bound
  });

  it('the three provider-bound kinds carry a live Jarvis ask', () => {
    const withAsk = VISUAL_CATALOG.filter((e) => e.liveAsk).map((e) => e.kind).sort();
    expect(withAsk).toEqual(['gallery', 'priority-email', 'weather']);
  });

  it('renderVisualStep returns pass + a lab-scoped image url per kind', () => {
    for (const entry of VISUAL_CATALOG) {
      const r = renderVisualStep(entry.kind);
      expect(r.state).toBe('pass');
      expect(r.visual?.url).toBe(`/api/test-lab/visual/${entry.kind}.svg`);
      expect(r.visual?.kind).toBe(entry.kind);
    }
  });

  it('renderVisualStep fails closed for an unknown kind', () => {
    expect(renderVisualStep('does-not-exist').state).toBe('gap');
    expect(getCatalogEntry('does-not-exist')).toBeUndefined();
  });
});

describe('AI Test Lab — scenario registry', () => {
  it('has all four groups populated', () => {
    for (const group of ['visual', 'tool', 'jarvis', 'coupled'] as const) {
      expect(SCENARIOS.some((s) => s.group === group)).toBe(true);
    }
  });

  it('exposes one visual scenario per kind', () => {
    const visualIds = SCENARIOS.filter((s) => s.group === 'visual').map((s) => s.id).sort();
    expect(visualIds).toEqual(VISUAL_CATALOG.map((e) => `visual-${e.kind}`).sort());
  });

  it('smoke-tests the full app roster (no domain silently dropped)', () => {
    const smokedApps = new Set(
      SCENARIOS.filter((s) => s.group === 'tool').flatMap((s) => s.steps.map((st) => st.app)),
    );
    // 'storage', 'presentations', 'home', 'social', 'feeds', 'identity', 'travel',
    // 'video', 'vids', 'gov-contracting', 'email', 'kalshi', 'world', and 'trading' are
    // intentionally absent: all carved to the app store (ADR-085 Waves 2-3), so their smokes
    // moved out of the core test-lab roster with the rips.
    for (const app of [
      'rag', 'search', 'security',
    ]) {
      expect(smokedApps, `missing smoke for ${app}`).toContain(app);
    }
  });

  it('never targets the stale /api/bot-presentations path again (regression guard)', () => {
    const serialized = JSON.stringify(SCENARIOS.map((s) => ({ id: s.id, labels: s.steps.map((st) => st.label) })));
    expect(serialized).not.toContain('bot-presentations');
    // (The "must include /api/presentations/sections/pptx" arm removed: AI Office carved to
    //  the app store, ADR-085 Wave 2 — core scenarios no longer target packaged routes.)
    expect(serialized).not.toContain('/api/presentations/sections');
  });

  it('every scenario + step has a stable id, app, and label', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
      for (const st of s.steps) {
        expect(st.id.length).toBeGreaterThan(0);
        expect(st.app.length).toBeGreaterThan(0);
        expect(st.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('AI Test Lab — rollup', () => {
  it('takes the worst state (fail > gap > degraded > pass)', () => {
    expect(rollup(['pass', 'pass'])).toBe('pass');
    expect(rollup(['pass', 'degraded'])).toBe('degraded');
    expect(rollup(['degraded', 'gap'])).toBe('gap');
    expect(rollup(['gap', 'fail'])).toBe('fail');
    expect(rollup([])).toBe('pass');
  });
});
