/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the missing Change Log header + a step-2b debugger guard: the surface must keep the call-by-call stepper, the recorded-results (replays/variants/grades) section, and the read-only /observations + /inspect reads — and the routes file must gain NO new POST (the debugger never fires replays; ADR-046 §10).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the honest `free:auto` optimizer surface and route wiring: eligible free lanes rotate or fail closed, selected provider/model evidence is returned, and non-free lanes retain explicit billing language.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard the keep-winner promotion surface (the approved routing switch): the inspector must keep the Promote-winner action with the apply-to-bot-config opt-in and the honest LLM-judged-only bar language, the Promotions view must keep revert wiring, and the promote/revert POSTs must stay on the auth-mounted promotion router — routing switches are operator-approved, never a background re-router.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('token chase optimizer surface', () => {
  const html = readFileSync(resolve(process.cwd(), 'src/api/token-chase.html'), 'utf8');
  const routes = readFileSync(resolve(process.cwd(), 'src/app/routes/token-chase-routes.ts'), 'utf8');

  it('keeps optimizer actions visible before raw captured payloads', () => {
    const renderer = html.slice(
      html.indexOf('function renderFrameInspector'),
      html.indexOf('function summaryCards'),
    );
    expect(html).toContain('renderFrameInspector');
    expect(html).toContain('summary-grid');
    expect(html).toContain('inspect-actions');
    expect(html).toContain('Replay determinism check');
    expect(html).toContain('Demo comparison');
    expect(html).toContain('/demo/comparison');
    expect(html).toContain('loadDemoComparison');
    expect(renderer.indexOf('inspect-actions')).toBeLessThan(renderer.indexOf('Captured payload'));
    expect(renderer.indexOf('optimizerPanel(frame)')).toBeLessThan(renderer.indexOf("field('System prompt'"));
  });

  it('collapses prompt and history dumps behind details controls', () => {
    expect(html).toContain('<details class="field"');
    expect(html).toContain('field(\'Response (baseline)\', baseline, true)');
    expect(html).toContain("field('System prompt', frame.systemPrompt, false)");
    expect(html).toContain("field('Sent history (' + history.length + ' messages)'");
  });

  it('retains owner-visible provider-lane comparison hooks', () => {
    expect(html).toContain('/api/token-chase/connections');
    expect(html).toContain('runVariantBtn');
    expect(html).toContain('runAllBtn');
    expect(html).toContain('Run all available lanes');
    expect(routes).toContain('/demo/comparison');
    expect(routes).toContain('buildTokenChaseDemoComparison');
  });

  it('documents and wires health-qualified free rotation without a paid fallback', () => {
    expect(html).toContain('<b>Free-provider rotation</b>');
    expect(html).toContain('currently eligible, probed free lanes');
    expect(html).toContain('without falling through to a paid platform key');
    expect(routes).toContain('createOptimizerLaneRotation');
    expect(routes).toContain('replayVariantRotating');
    expect(routes).toContain('selection: replay.selection');
    expect(routes).toContain('rotation: laneSelection');
  });

  it('wires the keep-winner promotion surface: approve, apply-to-bot-config opt-in, and revert', () => {
    const promoRoutes = readFileSync(
      resolve(process.cwd(), 'src/app/routes/token-chase-promotion-routes.ts'),
      'utf8',
    );
    // The approved routing switch lives in the frame inspector: an explicit action, never automatic.
    expect(html).toContain('promotePanel()');
    expect(html).toContain('promoteBtn');
    expect(html).toContain('promoteFrame(runId, seq)');
    expect(html).toContain('/promote');
    expect(html).toContain('applyToBotConfig');
    // The bar is stated honestly on the surface: LLM-judged only, nothing re-routes on its own.
    expect(html).toContain('LLM-judged variants only');
    expect(html).toContain('Nothing re-routes on its own');
    // The 422 no-winner answer renders as evidence (bar + per-candidate rejections), not a bare error.
    expect(html).toContain('renderNoWinner');
    expect(html).toContain('rejected because');
    // Promotions view: run-scoped list + audit trail + one-click revert.
    expect(html).toContain('loadPromotions');
    expect(html).toContain('/promotions/');
    expect(html).toContain('data-revert');
    expect(html).toContain('Audit trail');
    // The actions hit the promotion router, which token-chase-routes mounts INSIDE its
    // requiresAuth-wrapped router — promote/revert must never move to an unauthenticated mount.
    expect(routes).toContain('router.use(createTokenChasePromotionRoutes(ctx))');
    expect(promoRoutes).toContain("router.post('/runs/:runId/frames/:seq/promote'");
    expect(promoRoutes).toContain("router.post('/promotions/:promotionId/revert'");
    expect(promoRoutes).toContain("router.get('/runs/:runId/promotions'");
  });

  it('wires the step-2b debugger view: stepper, recorded results, and the read-only endpoints', () => {
    // The debugger walks the timeline call-by-call and renders RECORDED replay/variant/grade
    // history — it must consume the read-only endpoints and never gain its own replay trigger.
    expect(html).toContain('stepFrame(-1)');
    expect(html).toContain('stepFrame(1)');
    expect(html).toContain('recordedResults(');
    expect(html).toContain('badgeRecordedObservations');
    expect(html).toContain('/observations');
    expect(html).toContain('/inspect');
    expect(html).toContain('Recorded results (replays · variants · grades)');
    expect(routes).toContain("router.get('/runs/:runId/observations'");
    expect(routes).toContain("router.get('/runs/:runId/frames/:seq/inspect'");
    // Read-only rule: the DEBUGGER endpoints are GETs (asserted above). POSTs are only the
    // known replay/action set — replay, variant, savings, and the Step-2 forward tail-replay
    // action (a real replay action, not a debugger read). The debugger itself added no POST.
    const postRoutes = routes.match(/router\.post\('[^']+'/g) ?? [];
    expect(postRoutes).toEqual([
      "router.post('/runs/:runId/replay'",
      "router.post('/runs/:runId/tail-replay'",
      "router.post('/runs/:runId/frames/:seq/variant'",
      "router.post('/runs/:runId/savings'",
    ]);
  });
});
